// H10X Wallet · DeRec: buzones en Hedera (HCS). Cada móvil tiene un topic propio como buzón de entrada; los demás le
// escriben ahí y él lo lee del mirror node. El contenido ya va cifrado por DeRec (de extremo a extremo): en la red solo
// se ve quién escribe a qué buzón y cuándo.
//
// Para DeRec, un buzón es un «endpoint https» con esta forma (el SDK lo trata como texto opaco):
//   https://derec.h10xindex.xyz/hcs/<red>/<topic>
// Si un día hace falta, esa misma dirección puede servir de pasarela HTTPS → HCS.
import { TopicCreateTransaction, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";
import { decodeBase64, sha256 } from "ethers";

export const DEREC_INBOX_BASE = "https://derec.h10xindex.xyz/hcs/";
const NETS = ["mainnet", "testnet", "previewnet"];
/** Marca al principio de cada mensaje: lo que no la lleva no es de DeRec y se ignora. */
const MAGIC = Uint8Array.from([0x48, 0x58, 0x44, 0x01]); // «HXD» + versión 1
/** HCS: 1024 bytes por trozo, hasta 20 trozos. */
export const DEREC_MAX_MESSAGE = 20 * 1024 - MAGIC.length;

/** @param {string} network @param {string} topicId */
export function inboxUri(network, topicId) {
  if (!NETS.includes(network) || !/^0\.0\.\d{1,12}$/.test(topicId)) throw new Error("DeRec: buzón no válido");
  return `${DEREC_INBOX_BASE}${network}/${topicId}`;
}

/** @param {unknown} uri @returns {{ network: string, topicId: string } | null} */
export function parseInboxUri(uri) {
  const m = String(uri ?? "").match(/^https:\/\/derec\.h10xindex\.xyz\/hcs\/(mainnet|testnet|previewnet)\/(0\.0\.\d{1,12})$/);
  return m ? { network: /** @type {string} */ (m[1]), topicId: /** @type {string} */ (m[2]) } : null;
}

/**
 * Crea el buzón de este móvil: un topic sin llave de administración ni de envío (cualquiera puede escribir; lo que no
 * sea un mensaje válido de DeRec se descarta). Lo paga la Cartera.
 * @param {{ client: any, memo?: string }} p @returns {Promise<string>} id del topic
 */
export async function createInbox({ client, memo = "H10X Wallet · DeRec" }) {
  const resp = await new TopicCreateTransaction().setTopicMemo(memo.slice(0, 100)).execute(client);
  const receipt = await resp.getReceipt(client);
  const id = receipt.topicId?.toString();
  if (!id) throw new Error("DeRec: no se pudo crear el buzón");
  return id;
}

/**
 * Transporte para el SDK de DeRec: manda cada mensaje al buzón del otro móvil (el primer endpoint de la misma red).
 * @param {{ client: any, network: string, onSend?: (info: { topicId: string, bytes: number, chunks: number }) => void }} p
 */
export function hcsTransport({ client, network, onSend }) {
  return {
    /** @param {ReadonlyArray<{ uri: string, protocol: string }>} endpoints @param {Uint8Array} message */
    async send(endpoints, message) {
      const target = endpoints.map((e) => parseInboxUri(e?.uri)).find((x) => x && x.network === network);
      if (!target) throw new Error(`DeRec: el otro móvil no tiene buzón en ${network}`);
      if (message.length > DEREC_MAX_MESSAGE) throw new Error("DeRec: mensaje demasiado grande para HCS");
      const data = new Uint8Array(MAGIC.length + message.length);
      data.set(MAGIC, 0);
      data.set(message, MAGIC.length);
      const tx = new TopicMessageSubmitTransaction().setTopicId(target.topicId).setMessage(data).setMaxChunks(20).setChunkSize(1024);
      const resps = await tx.executeAll(client);
      await Promise.all(resps.map((/** @type {any} */ r) => r.getReceipt(client)));
      onSend?.({ topicId: target.topicId, bytes: message.length, chunks: resps.length });
    },
  };
}

/**
 * Lector del buzón: trae del mirror los mensajes nuevos, junta los trozos y devuelve cada mensaje de DeRec una sola vez
 * (el cursor y lo ya visto se guardan en el KV: sobrevive a cerrar la app).
 * @param {{ mirrorBase: string, topicId: string, kv: import("./stores.js").DerecKV, fetch?: typeof fetch, pageLimit?: number }} p
 */
export function hcsInbox({ mirrorBase, topicId, kv, fetch: f = fetch, pageLimit = 5 }) {
  const te = new TextEncoder();
  const td = new TextDecoder();
  const CUR = `ib/${topicId}/cursor`;
  const SEEN = `ib/${topicId}/seen`;
  return {
    topicId,
    /** @returns {Promise<{ seq: number, at: string, from: string, bytes: Uint8Array }[]>} */
    async poll() {
      const curRaw = await kv.get(CUR);
      const cursor = curRaw ? Number(td.decode(curRaw)) || 0 : 0;
      const seenRaw = await kv.get(SEEN);
      /** @type {string[]} */
      const seen = seenRaw ? JSON.parse(td.decode(seenRaw)) : [];
      const seenSet = new Set(seen);
      /** @type {any[]} */
      const rows = [];
      // El mirror rechaza «gt:0» (400): siempre «gte:» el siguiente número.
      let url = `${mirrorBase}/api/v1/topics/${topicId}/messages?sequencenumber=gte:${cursor + 1}&limit=100&order=asc`;
      for (let page = 0; page < pageLimit && url; page++) {
        const res = await f(url, { headers: { accept: "application/json" } });
        if (res.status === 404) break; // topic aún no indexado
        if (!res.ok) throw new Error(`DeRec: el mirror respondió ${res.status}`);
        const j = /** @type {any} */ (await res.json());
        rows.push(...(j?.messages ?? []));
        const next = j?.links?.next;
        url = next ? (String(next).startsWith("http") ? String(next) : `${mirrorBase}${next}`) : "";
      }
      /** @type {Map<string, { first: number, total: number, parts: Map<number, Uint8Array>, at: string, from: string }>} */
      const groups = new Map();
      /** @type {{ seq: number, at: string, from: string, bytes: Uint8Array, id: string }[]} */
      const done = [];
      let last = cursor;
      for (const r of rows) {
        const seq = Number(r.sequence_number);
        if (!Number.isFinite(seq) || seq <= cursor) continue;
        last = Math.max(last, seq);
        const ci = r.chunk_info;
        const body = Uint8Array.from(decodeBase64(String(r.message ?? "")));
        const at = String(r.consensus_timestamp ?? "");
        const from = String(r.payer_account_id ?? "");
        if (!ci || Number(ci.total ?? 1) <= 1) {
          done.push({ seq, at, from, bytes: body, id: `s${seq}` });
          continue;
        }
        const t = ci.initial_transaction_id ?? {};
        const gid = `${t.account_id}@${t.transaction_valid_start}#${t.nonce ?? 0}`;
        const g = groups.get(gid) ?? { first: seq, total: Number(ci.total), parts: new Map(), at, from };
        g.parts.set(Number(ci.number), body);
        g.at = at;
        groups.set(gid, g);
        if (g.parts.size === g.total) {
          const len = [...g.parts.values()].reduce((n, b) => n + b.length, 0);
          const all = new Uint8Array(len);
          let o = 0;
          for (let i = 1; i <= g.total; i++) {
            const p = g.parts.get(i);
            if (!p) break;
            all.set(p, o);
            o += p.length;
          }
          done.push({ seq, at: g.at, from: g.from, bytes: all, id: gid });
          groups.delete(gid);
        }
      }
      // El cursor no pasa de un mensaje a medias: la próxima vez se vuelve a leer desde su primer trozo.
      const pendingFirst = Math.min(...[...groups.values()].map((g) => g.first), Infinity);
      const next = Number.isFinite(pendingFirst) ? pendingFirst - 1 : last;
      const out = [];
      for (const m of done) {
        if (m.bytes.length < MAGIC.length || !MAGIC.every((b, i) => m.bytes[i] === b)) continue;
        const payload = m.bytes.slice(MAGIC.length);
        const h = sha256(payload).slice(2, 34);
        if (seenSet.has(m.id) || seenSet.has(h)) continue;
        seenSet.add(m.id);
        seenSet.add(h);
        out.push({ seq: m.seq, at: m.at, from: m.from, bytes: payload });
      }
      // Solo se escribe si algo cambió (en el móvil, cada escritura va al llavero).
      if (out.length) await kv.set(SEEN, te.encode(JSON.stringify([...seenSet].slice(-600))));
      if (next > cursor) await kv.set(CUR, te.encode(String(next)));
      return out.sort((a, b) => a.seq - b.seq);
    },
  };
}
