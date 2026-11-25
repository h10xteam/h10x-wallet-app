// Almacén clave→bytes de DeRec en el llavero del móvil (expo-secure-store), solo en este dispositivo y sin copias de
// seguridad. Lo usan los almacenes del SDK (core/src/derec/stores.js) y el buzón.
//  - Cada wallet y red tiene su zona: lo de una nunca se mezcla con otra.
//  - El llavero no sabe listar: se lleva un índice de claves. Los valores grandes se parten en trozos (máx. 1800).
//  - Caché en memoria y escrituras en fila (nunca dos a la vez sobre el índice).
import * as SecureStore from "expo-secure-store";
import { Buffer } from "buffer";

export type DerecKV = {
  get(k: string): Promise<Uint8Array | null>;
  set(k: string, v: Uint8Array): Promise<void>;
  del(k: string): Promise<boolean>;
  keys(prefix: string): Promise<string[]>;
};

const OPTS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const CHUNK = 1800;

async function readBig(k: string): Promise<string | null> {
  const head = await SecureStore.getItemAsync(k, OPTS);
  if (head == null) return null;
  if (!head.startsWith("~")) return head;
  const n = Number(head.slice(1));
  let s = "";
  for (let i = 0; i < n; i++) s += (await SecureStore.getItemAsync(`${k}_${i}`, OPTS)) ?? "";
  return s;
}

async function chunksOf(k: string): Promise<number> {
  const head = await SecureStore.getItemAsync(k, OPTS).catch(() => null);
  return head?.startsWith("~") ? Number(head.slice(1)) || 0 : 0;
}

async function writeBig(k: string, s: string): Promise<void> {
  const before = await chunksOf(k);
  let now = 0;
  if (s.length <= CHUNK) await SecureStore.setItemAsync(k, s, OPTS);
  else {
    now = Math.ceil(s.length / CHUNK);
    for (let i = 0; i < now; i++) await SecureStore.setItemAsync(`${k}_${i}`, s.slice(i * CHUNK, (i + 1) * CHUNK), OPTS);
    await SecureStore.setItemAsync(k, `~${now}`, OPTS);
  }
  for (let i = now; i < before; i++) await SecureStore.deleteItemAsync(`${k}_${i}`, OPTS).catch(() => undefined);
}

async function delBig(k: string): Promise<void> {
  const n = await chunksOf(k);
  for (let i = 0; i < n; i++) await SecureStore.deleteItemAsync(`${k}_${i}`, OPTS).catch(() => undefined);
  await SecureStore.deleteItemAsync(k, OPTS).catch(() => undefined);
}

/** `zone`: p. ej. derec_testnet_<walletId>. */
export async function secureKV(zone: string): Promise<DerecKV & { wipe(): Promise<void> }> {
  const base = zone.replace(/[^A-Za-z0-9._-]/g, "_");
  const idxKey = `${base}_idx`;
  const sk = (k: string) => `${base}_${Buffer.from(k, "utf8").toString("hex")}`;
  let index = new Set<string>();
  try {
    const raw = await readBig(idxKey);
    const arr: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr)) index = new Set(arr.filter((x): x is string => typeof x === "string"));
  } catch {
    index = new Set();
  }
  const cache = new Map<string, Uint8Array | null>();
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };
  const saveIndex = () => writeBig(idxKey, JSON.stringify([...index]));
  return {
    async get(k) {
      if (cache.has(k)) return cache.get(k) ?? null;
      if (!index.has(k)) return null;
      const s = await readBig(sk(k));
      const v = s == null ? null : Uint8Array.from(Buffer.from(s, "base64"));
      cache.set(k, v);
      return v;
    },
    set(k, v) {
      const copy = Uint8Array.from(v);
      cache.set(k, copy);
      return serial(async () => {
        await writeBig(sk(k), Buffer.from(copy).toString("base64"));
        if (!index.has(k)) {
          index.add(k);
          await saveIndex();
        }
      });
    },
    del(k) {
      const had = index.has(k);
      cache.delete(k);
      return serial(async () => {
        await delBig(sk(k));
        if (had) {
          index.delete(k);
          await saveIndex();
        }
        return had;
      });
    },
    async keys(prefix) {
      return [...index].filter((k) => k.startsWith(prefix)).sort();
    },
    /** Borra toda la zona (al borrar la wallet de este móvil). */
    wipe() {
      return serial(async () => {
        for (const k of [...index]) await delBig(sk(k));
        index.clear();
        cache.clear();
        await delBig(idxKey);
      });
    },
  };
}
