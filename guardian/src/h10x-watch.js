// @ts-check
// Avisos de H10X: el guardián vigila, en el mirror PÚBLICO de mainnet, el topic de la DAO de H10X y los eventos de la
// bóveda de H10X, y devuelve lo que merece un aviso:
//   - DAO: ronda nueva (propuestas abiertas), empieza la votación, últimas 24 h para votar y resultado publicado;
//   - cesta: un token entra o sale, o cambian los pesos.
// Solo lectura de datos públicos: no usa la clave del guardián, no firma ni paga nada. Cuentan solo los mensajes de la
// DAO que paga la cuenta oficial (como en el recuento de la web). La primera vez solo toma nota de lo que ya hay: no
// manda avisos de cosas pasadas.
import { H10X_MAINNET, parseDaoMessage, vaultBasketEvent } from "@boveda/core";

const DAY = 86_400;
const ID_RE = /^0\.0\.\d{1,12}$/;

/**
 * @typedef {{ proposeEnd: number, voteStart: number, voteEnd: number, sent: { open?: boolean, vote?: boolean, last24?: boolean, result?: boolean } }} WatchedRound
 * @typedef {{ init?: boolean, topicSeq?: number, logTs?: string | null, rounds?: Record<string, WatchedRound> }} H10xWatchState
 * @typedef {{ kind: "dao-open", round: string, proposeEnd: number, voteStart: number, voteEnd: number }
 *   | { kind: "dao-vote", round: string, voteEnd: number }
 *   | { kind: "dao-last24", round: string, voteEnd: number }
 *   | { kind: "dao-result", round: string, winners: string[], quorum: boolean }
 *   | { kind: "basket", added: string[], removed: string[], weights: boolean }} H10xEvent
 */

/**
 * @param {{ mirrorUrl?: string, topic?: string, ops?: string, vault?: string, fetchImpl?: typeof fetch, maxPages?: number }} [opts]
 */
export function createH10xWatcher({ mirrorUrl = H10X_MAINNET.mirror, topic = H10X_MAINNET.daoTopic, ops = H10X_MAINNET.daoOps, vault = H10X_MAINNET.vaultId, fetchImpl = fetch, maxPages = 20 } = {}) {
  const base = mirrorUrl.replace(/\/$/, "");
  /** @type {Map<string, string>} */
  const symbols = new Map();

  /** @param {string} path */
  async function get(path) {
    const res = await fetchImpl(`${base}${path}`, { signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`mirror de mainnet ${res.status}`);
    return res.json();
  }

  /** Mensajes del topic con número mayor que `after` (todos, por páginas). */
  async function messagesAfter(/** @type {number} */ after) {
    const out = [];
    let path = `/api/v1/topics/${topic}/messages?sequencenumber=gt:${after}&order=asc&limit=100`;
    for (let page = 0; page < maxPages && path; page++) {
      const body = await get(path);
      if (!body) break;
      for (const m of body.messages ?? []) {
        const p = parseDaoMessage(m);
        out.push({ seq: Number(m.sequence_number), parsed: p });
      }
      path = body.links?.next ?? "";
    }
    return out;
  }

  /** Eventos de la bóveda después de `ts` (marca de tiempo del mirror). */
  async function logsAfter(/** @type {string | null} */ ts) {
    const out = [];
    let path = `/api/v1/contracts/${vault}/results/logs?order=asc&limit=100${ts ? `&timestamp=gt:${ts}` : ""}`;
    for (let page = 0; page < maxPages && path; page++) {
      const body = await get(path);
      if (!body) break;
      for (const l of body.logs ?? []) out.push({ topics: l.topics ?? [], timestamp: String(l.timestamp) });
      path = body.links?.next ?? "";
    }
    return out;
  }

  /** Símbolo de un token de mainnet (o su ID si no se puede leer). */
  async function symbolOf(/** @type {string} */ id) {
    if (!ID_RE.test(id)) return "?";
    const known = symbols.get(id);
    if (known) return known;
    try {
      const t = await get(`/api/v1/tokens/${id}`);
      const s = String(t?.symbol ?? "")
        .replace(/[^\w.\-$]/g, "")
        .slice(0, 12);
      if (s) {
        symbols.set(id, s);
        return s;
      }
    } catch {
      // sin símbolo: se enseña el ID
    }
    return id;
  }

  /**
   * Una vuelta: lee lo nuevo y devuelve los avisos. Modifica `st` (se guarda en el estado del guardián).
   * @param {H10xWatchState} st @param {number} nowSec
   * @returns {Promise<H10xEvent[]>}
   */
  async function poll(st, nowSec) {
    st.rounds ??= {};
    /** @type {H10xEvent[]} */
    const events = [];
    const first = !st.init;

    // 1. Topic de la DAO
    const msgs = await messagesAfter(st.topicSeq ?? 0);
    for (const { seq, parsed } of msgs) {
      if (Number.isSafeInteger(seq)) st.topicSeq = Math.max(st.topicSeq ?? 0, seq);
      if (!parsed || parsed.payer !== ops) continue;
      const b = /** @type {any} */ (parsed.body);
      if (b.type === "round" && !st.rounds[b.round]) {
        st.rounds[b.round] = { proposeEnd: b.proposeEnd, voteStart: b.voteStart, voteEnd: b.voteEnd, sent: { open: true } };
        if (!first && nowSec < b.voteEnd) events.push({ kind: "dao-open", round: b.round, proposeEnd: b.proposeEnd, voteStart: b.voteStart, voteEnd: b.voteEnd });
      } else if (b.type === "result") {
        const r = st.rounds[b.round];
        if (r && !r.sent.result && parsed.ts >= r.voteEnd) {
          r.sent.result = true;
          if (!first) events.push({ kind: "dao-result", round: b.round, winners: b.winners, quorum: b.quorum });
        }
      }
    }

    // 2. Plazos (solo dentro de su ventana: si el guardián estuvo parado, no se avisa tarde)
    for (const [id, r] of Object.entries(st.rounds)) {
      const voting = nowSec >= r.voteStart && nowSec < r.voteEnd;
      if (voting && !r.sent.vote) {
        r.sent.vote = true;
        if (!first) events.push({ kind: "dao-vote", round: id, voteEnd: r.voteEnd });
      }
      if (voting && nowSec >= r.voteEnd - DAY && !r.sent.last24) {
        r.sent.last24 = true;
        if (!first && r.voteEnd - r.voteStart > 2 * DAY) events.push({ kind: "dao-last24", round: id, voteEnd: r.voteEnd });
      }
      if (nowSec >= r.voteEnd) {
        r.sent.vote = true;
        r.sent.last24 = true;
      }
      if (nowSec > r.voteEnd + 60 * DAY) delete st.rounds[id];
    }

    // 3. Cesta de la bóveda (la primera vez solo se toma la última marca de tiempo)
    if (first) {
      const body = await get(`/api/v1/contracts/${vault}/results/logs?order=desc&limit=1`);
      st.logTs = body?.logs?.[0]?.timestamp ? String(body.logs[0].timestamp) : null;
    } else {
      const logs = await logsAfter(st.logTs ?? null);
      const added = [];
      const removed = [];
      let weights = false;
      for (const l of logs) {
        st.logTs = l.timestamp;
        const e = vaultBasketEvent(l);
        if (!e) continue;
        if (e.kind === "added" && e.token) added.push(e.token);
        else if (e.kind === "removed" && e.token) removed.push(e.token);
        else if (e.kind === "weights") weights = true;
      }
      if (added.length || removed.length || weights) events.push({ kind: "basket", added, removed, weights });
    }

    st.init = true;
    return events;
  }

  return { poll, symbolOf };
}
