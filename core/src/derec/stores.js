// H10X Wallet · DeRec: los cinco almacenes que pide el SDK de DeRec, guardados en un almacén clave→bytes (KV).
//
// La lógica sigue los almacenes en memoria de las pruebas oficiales de lib-derec (smoke-tests/nodejs/protocol.ts,
// v0.1.0, Apache-2.0, © 2026 DeRec Alliance), cambiando la memoria por un KV persistente: el mismo código sirve en el
// VPS (archivo) y en el móvil (llavero cifrado). Nada de aquí importa el SDK de DeRec ni el de Hedera.
//
// Reglas del SDK que se respetan:
//  - Los ids son cadenas decimales (u64): nunca se pasan por JSON.parse como número.
//  - Los registros de canal se guardan tal cual (bytes opacos {"Helper":{…}}) y la lista se monta empalmando texto.
//  - listHelpers/listReplicas pueden devolver de más (el SDK vuelve a filtrar), nunca de menos: solo se filtra por ids.
//  - keepVersion devuelve la versión anterior a la que se reparte (se conserva una vieja por si acaso).
import { decodeBase64, encodeBase64 } from "ethers";

/**
 * Almacén clave→bytes. Las claves son texto con [A-Za-z0-9/_.:-]; quien lo implementa decide dónde y cómo guarda.
 * @typedef {{ get(k: string): Promise<Uint8Array | null>, set(k: string, v: Uint8Array): Promise<void>,
 *   del(k: string): Promise<boolean>, keys(prefix: string): Promise<string[]> }} DerecKV
 */

const te = new TextEncoder();
const td = new TextDecoder();
/** @param {unknown} v @returns {Uint8Array} */
const toBytes = (v) => (v instanceof Uint8Array ? v : Uint8Array.from(/** @type {ArrayLike<number>} */ (v ?? [])));
/** @param {Uint8Array} b */
const b64 = (b) => encodeBase64(b);
/** @param {string} s @returns {Uint8Array} */
const unb64 = (s) => Uint8Array.from(decodeBase64(s));
/** @param {any} o */
const jsonBytes = (o) => te.encode(JSON.stringify(o));
/** @param {Uint8Array | null} b @returns {any} */
const parseBytes = (b) => (b ? JSON.parse(td.decode(b)) : null);
/** @param {unknown} id */
const dec = (id) => {
  const s = String(id ?? "");
  if (!/^\d{1,20}$/.test(s)) throw new Error(`DeRec: id no decimal (${s.slice(0, 24)})`);
  return s;
};

/** KV en memoria (pruebas y caché). @returns {DerecKV & { dump(): Map<string, Uint8Array> }} */
export function memoryKV() {
  /** @type {Map<string, Uint8Array>} */
  const m = new Map();
  return {
    async get(k) {
      return m.get(k) ?? null;
    },
    async set(k, v) {
      m.set(k, Uint8Array.from(v));
    },
    async del(k) {
      return m.delete(k);
    },
    async keys(prefix) {
      return [...m.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
    dump() {
      return m;
    },
  };
}

/** El mismo KV con un prefijo delante de cada clave (una zona por wallet o por red). @param {DerecKV} kv @param {string} prefix @returns {DerecKV} */
export function prefixedKV(kv, prefix) {
  return {
    get: (k) => kv.get(prefix + k),
    set: (k, v) => kv.set(prefix + k, v),
    del: (k) => kv.del(prefix + k),
    keys: async (p) => (await kv.keys(prefix + p)).map((k) => k.slice(prefix.length)),
  };
}

/**
 * Los cinco almacenes de DeRec sobre un KV. `refusal` es shareStoreRefusal del SDK (para negarse a guardar de más).
 * @param {DerecKV} kv
 * @param {{ refusal?: (reason: "too_frequent" | "size_limit_exceeded" | "rejected") => Error, maxShareBytes?: number, now?: () => number }} [opts]
 */
export function derecStores(kv, { refusal, maxShareBytes = 64 * 1024, now = Date.now } = {}) {
  // ---- Canales ----------------------------------------------------------------------------------------------------
  // Un canal de ayudante es único por channelId; un miembro de réplica, por replicaId (cambia de canal al entrar).
  /** @param {string} replicaId */
  const zone = (replicaId) => (String(replicaId) === "0" ? "h" : "r");
  /** @param {string} channelId @param {string} replicaId */
  const idFor = (channelId, replicaId) => (String(replicaId) === "0" ? dec(channelId) : dec(replicaId));
  /** @param {string} s @param {string} channelId @param {string} replicaId */
  const chKey = (s, channelId, replicaId) => `ch/${zone(replicaId)}/${dec(s)}/${idFor(channelId, replicaId)}`;
  /** @param {string} s @param {"Helper" | "Replica"} variant @param {any} filter */
  const list = async (s, variant, filter) => {
    const z = variant === "Helper" ? "h" : "r";
    const prefix = `ch/${z}/${dec(s)}/`;
    const tag = `{"${variant}":`;
    const ids = new Set((filter?.ids ?? []).map(String));
    const exclude = new Set((filter?.exclude ?? []).map(String));
    const inner = [];
    for (const k of await kv.keys(prefix)) {
      const id = k.slice(prefix.length);
      if ((ids.size && !ids.has(id)) || exclude.has(id)) continue;
      const v = await kv.get(k);
      if (!v) continue;
      const text = td.decode(v);
      if (!text.startsWith(tag) || !text.endsWith("}")) continue;
      inner.push(text.slice(tag.length, -1));
    }
    return te.encode(`[${inner.join(",")}]`);
  };
  /** @param {string} s @param {string} c */
  const linkKey = (s, c) => `ln/${dec(s)}/${dec(c)}`;
  /** @param {string} k @returns {Promise<string[]>} */
  const readLinks = async (k) => parseBytes(await kv.get(k)) ?? [];

  const channelStore = {
    /** @param {string} s @param {string} c @param {string} r */
    async load(s, c, r) {
      return kv.get(chKey(s, c, r));
    },
    /** @param {string} s @param {string} c @param {string} r @param {Uint8Array} bytes */
    async save(s, c, r, bytes) {
      await kv.set(chKey(s, c, r), toBytes(bytes));
    },
    /** @param {string} s @param {string} c @param {string} r */
    async remove(s, c, r) {
      return kv.del(chKey(s, c, r));
    },
    /** @param {string} s @param {any} filter */
    async listHelpers(s, filter) {
      return list(s, "Helper", filter);
    },
    /** @param {string} s @param {any} filter */
    async listReplicas(s, filter) {
      return list(s, "Replica", filter);
    },
    /** @param {string} s @param {string} a @param {string} b */
    async linkChannel(s, a, b) {
      if (String(a) === String(b)) return;
      for (const [x, y] of [
        [a, b],
        [b, a],
      ]) {
        const k = linkKey(s, x);
        const cur = await readLinks(k);
        if (!cur.includes(String(y))) await kv.set(k, jsonBytes([...cur, dec(y)]));
      }
    },
    /** Cierre transitivo de `c`, incluido él mismo. @param {string} s @param {string} c @returns {Promise<string[]>} */
    async linkedChannels(s, c) {
      const seen = new Set();
      const queue = [dec(c)];
      while (queue.length) {
        const cur = /** @type {string} */ (queue.shift());
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const l of await readLinks(linkKey(s, cur))) if (!seen.has(l)) queue.push(l);
      }
      return [...seen];
    },
  };

  // ---- Partes (lo que guarda un ayudante) ---------------------------------------------------------------------------
  /** @param {string} s @param {string} c @param {number} v */
  const shKey = (s, c, v) => `sh/${dec(s)}/${dec(c)}/${Number(v)}`;
  /** @param {any} j @returns {any} */
  const toShare = (j) => ({ secretId: String(j.s), version: Number(j.v), bytes: unb64(j.b), subshares: j.n ?? null, threshold: j.t ?? null });
  /** @param {string} s @param {string} c @param {number[]} versions */
  const loadShares = async (s, c, versions) => {
    const want = versions?.length ? new Set(versions.map(Number)) : null;
    const prefix = `sh/${dec(s)}/${dec(c)}/`;
    const out = [];
    for (const k of await kv.keys(prefix)) {
      const v = Number(k.slice(prefix.length));
      if (want && !want.has(v)) continue;
      const j = parseBytes(await kv.get(k));
      if (j) out.push(toShare(j));
    }
    return out.sort((a, b) => a.version - b.version);
  };
  const shareStore = {
    /** @param {string} s @param {string} c @param {number[]} versions */
    async load(s, c, versions) {
      return loadShares(s, c, versions);
    },
    /** @param {string} s @param {string[]} cs @param {number[]} versions */
    async loadMany(s, cs, versions) {
      const out = [];
      for (const c of cs) out.push(...(await loadShares(s, c, versions)));
      return out;
    },
    /** @param {string} s @param {string[]} cs */
    async loadAll(s, cs) {
      const out = [];
      for (const c of cs) out.push(...(await loadShares(s, c, [])));
      return out;
    },
    /** @param {string} s @param {string} c @param {any} share */
    async save(s, c, share) {
      const bytes = toBytes(share.bytes);
      if (bytes.length > maxShareBytes) {
        if (refusal) throw refusal("size_limit_exceeded");
        throw new Error("DeRec: parte demasiado grande");
      }
      await kv.set(shKey(s, c, share.version), jsonBytes({ s: String(share.secretId ?? s), v: Number(share.version), b: b64(bytes), n: share.subshares ?? null, t: share.threshold ?? null, at: now() }));
    },
    // Como en las pruebas oficiales: sin versión propia anotada (el SDK lo trata como «no se sabe»).
    /** @param {string} _s @returns {Promise<number | null>} */
    async latestVersion(_s) {
      return null;
    },
    /** @param {string} s @param {string} c */
    async removeChannel(s, c) {
      for (const k of await kv.keys(`sh/${dec(s)}/${dec(c)}/`)) await kv.del(k);
    },
    /** @param {string} s @param {string} c @param {number[]} versions */
    async removeVersions(s, c, versions) {
      for (const v of versions) await kv.del(shKey(s, c, v));
    },
    /** Al repartir la versión `version`, los ayudantes guardan también la anterior. @param {string} _s @param {number} version */
    async keepVersion(_s, version) {
      return Math.max(0, Number(version) - 1);
    },
    /** Apunta cuándo se comprobó por última vez (para enseñarlo en «Ayudar»). @param {string} s @param {string} c @param {number} version */
    async recordVerification(s, c, version) {
      await kv.set(`vf/${dec(s)}/${dec(c)}`, jsonBytes({ v: Number(version), at: now() }));
    },
  };

  // ---- Llaves de cada canal ---------------------------------------------------------------------------------------
  /** @param {string} s @param {string} c @param {number} kind */
  const skKey = (s, c, kind) => `sk/${dec(s)}/${dec(c)}/${Number(kind)}`;
  const secretStore = {
    /** @param {string} s @param {string} c @param {0 | 1 | 2} kind */
    async load(s, c, kind) {
      return kv.get(skKey(s, c, kind));
    },
    /** @param {string} s @param {string[]} cs @param {0 | 1 | 2} kind */
    async loadMany(s, cs, kind) {
      const out = [];
      for (const c of cs) out.push(await kv.get(skKey(s, c, kind)));
      return out;
    },
    /** @param {string} s @param {string} c @param {0 | 1 | 2} kind @param {Uint8Array} value */
    async save(s, c, kind, value) {
      await kv.set(skKey(s, c, kind), toBytes(value));
    },
    /** @param {string} s @param {string} c @param {0 | 1 | 2} kind */
    async remove(s, c, kind) {
      await kv.del(skKey(s, c, kind));
    },
  };

  // ---- Lo último que el dueño protegió ------------------------------------------------------------------------------
  const userSecretStore = {
    /** @param {string} s */
    async loadLatest(s) {
      const j = parseBytes(await kv.get(`us/${dec(s)}`));
      if (!j) return null;
      return {
        version: Number(j.version),
        secrets: (j.secrets ?? []).map((/** @type {any} */ x) => ({ id: unb64(x.id), name: String(x.name), data: unb64(x.data) })),
        ...(j.description != null ? { description: String(j.description) } : {}),
        ...(j.author_replica_id != null ? { author_replica_id: String(j.author_replica_id) } : {}),
        threshold: j.threshold ?? null,
      };
    },
    /** @param {string} s @param {any} value */
    async saveLatest(s, value) {
      await kv.set(
        `us/${dec(s)}`,
        jsonBytes({
          version: Number(value.version),
          secrets: (value.secrets ?? []).map((/** @type {any} */ x) => ({ id: b64(toBytes(x.id)), name: String(x.name), data: b64(toBytes(x.data)) })),
          description: value.description ?? null,
          author_replica_id: value.author_replica_id != null ? String(value.author_replica_id) : null,
          threshold: value.threshold ?? null,
        }),
      );
    },
    /** @param {string} s */
    async remove(s) {
      await kv.del(`us/${dec(s)}`);
    },
  };

  // ---- Flujos a medias (sobreviven a cerrar la app) -----------------------------------------------------------------
  /** @param {Uint8Array} bytes */
  const rec = (bytes) => parseBytes(toBytes(bytes)) ?? {};
  /** @param {string} s @param {any} r */
  const stKey = (s, r) => `st/${dec(s)}/${Number(r.kind)}/${r.channel_id ?? ""}/${r.secret_id ?? ""}/${r.version ?? ""}`;
  const stateStore = {
    /** @param {string} s @param {Uint8Array} itemJson */
    async save(s, itemJson) {
      await kv.set(stKey(s, rec(itemJson)), toBytes(itemJson));
    },
    /** @param {string} s @param {Uint8Array} keyJson */
    async load(s, keyJson) {
      return kv.get(stKey(s, rec(keyJson)));
    },
    /** @param {string} s @param {Uint8Array} keyJson */
    async remove(s, keyJson) {
      return kv.del(stKey(s, rec(keyJson)));
    },
    /** @param {string} s @param {number} kind */
    async loadAll(s, kind) {
      const out = [];
      for (const k of await kv.keys(`st/${dec(s)}/${Number(kind)}/`)) {
        const v = await kv.get(k);
        if (v) out.push(v);
      }
      return out;
    },
  };

  return { channelStore, shareStore, secretStore, userSecretStore, stateStore };
}

/**
 * Qué guarda este móvil como ayudante (para la pantalla «Ayudar»): por secreto y canal, versiones y última comprobación.
 * @param {DerecKV} kv
 * @returns {Promise<{ secretId: string, channelId: string, versions: number[], verifiedAt: number | null }[]>}
 */
export async function heldShares(kv) {
  /** @type {Map<string, { secretId: string, channelId: string, versions: number[], verifiedAt: number | null }>} */
  const m = new Map();
  for (const k of await kv.keys("sh/")) {
    const [, s, c, v] = k.split("/");
    if (!s || !c) continue;
    const id = `${s}/${c}`;
    const cur = m.get(id) ?? { secretId: s, channelId: c, versions: [], verifiedAt: null };
    cur.versions.push(Number(v));
    m.set(id, cur);
  }
  for (const cur of m.values()) {
    const j = parseBytes(await kv.get(`vf/${cur.secretId}/${cur.channelId}`));
    cur.verifiedAt = j?.at ?? null;
    cur.versions.sort((a, b) => a - b);
  }
  return [...m.values()];
}

/** Canales de ayudante guardados para un secreto (ids). @param {DerecKV} kv @param {string} secretId */
export async function helperChannelIds(kv, secretId) {
  const prefix = `ch/h/${dec(secretId)}/`;
  return (await kv.keys(prefix)).map((k) => k.slice(prefix.length));
}

/** Zonas (secretIds) en las que existe el canal `channelId`. @param {DerecKV} kv @param {string} channelId */
export async function secretIdsWithChannel(kv, channelId) {
  const c = dec(channelId);
  return (await kv.keys("ch/h/")).filter((k) => k.endsWith(`/${c}`)).map((k) => k.split("/")[2] ?? "").filter(Boolean);
}
