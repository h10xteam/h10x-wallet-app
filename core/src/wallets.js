// @ts-check
// Varias wallets en la misma app (0.10). Cada wallet es lo de siempre (Cartera + bóveda + notario + kit) y guarda lo
// suyo aparte en el móvil. La primera conserva los nombres de almacenamiento de siempre: actualizar no mueve ninguna
// llave (moverla pediría Face ID y, si fallara a mitad, se perdería). Sin dependencias: lo prueban los tests sin red.

/** @typedef {{ id: string, createdAt: number }} WalletEntry */
/** @typedef {{ version: 1, active: string, wallets: WalletEntry[] }} WalletRegistry */
/** @typedef {{ profile: string, pocketKey: string, wcSessions: string }} StorageNames */

/** La wallet de antes de la 0.10 (y la primera de un móvil nuevo): usa los nombres de siempre. */
export const FIRST_WALLET_ID = "w1";
/** Cuántas wallets puede tener la app a la vez. */
export const MAX_WALLETS = 8;

/** @param {unknown} id */
const validId = (id) => typeof id === "string" && /^w[1-9]\d{0,3}$/.test(id);

/**
 * Nombres con los que guarda sus datos una wallet. La primera, los de siempre; las demás, con su id al final (también
 * la llave del kit pendiente, que sale del de la llave del móvil).
 * @param {StorageNames} base los de storageKeys(red) @param {string} id
 * @returns {StorageNames}
 */
export function walletStorageNames(base, id) {
  if (!validId(id)) throw new Error("wallet no válida");
  if (id === FIRST_WALLET_ID) return base;
  return { profile: `${base.profile}.${id}`, pocketKey: `${base.pocketKey}.${id}`, wcSessions: base.wcSessions };
}

/** Registro de un móvil sin nada guardado (o de antes de la 0.10): una sola wallet, la de siempre. @returns {WalletRegistry} */
export const initialRegistry = () => ({ version: 1, active: FIRST_WALLET_ID, wallets: [{ id: FIRST_WALLET_ID, createdAt: 0 }] });

/**
 * Registro leído del almacenamiento. Si falta o está roto, el inicial (la wallet de siempre). Nunca lanza.
 * @param {string | null | undefined} raw
 * @returns {WalletRegistry}
 */
export function parseRegistry(raw) {
  /** @type {any} */
  let j = null;
  try {
    j = raw ? JSON.parse(raw) : null;
  } catch {
    j = null;
  }
  if (!j || j.version !== 1 || !Array.isArray(j.wallets)) return initialRegistry();
  /** @type {WalletEntry[]} */
  const wallets = [];
  for (const w of j.wallets) {
    if (!w || !validId(w.id) || wallets.some((x) => x.id === w.id)) continue;
    wallets.push({ id: w.id, createdAt: Number.isFinite(w.createdAt) ? Number(w.createdAt) : 0 });
    if (wallets.length >= MAX_WALLETS) break;
  }
  if (wallets.length === 0) return initialRegistry();
  const active = wallets.some((w) => w.id === j.active) ? j.active : wallets[0].id;
  return { version: 1, active, wallets };
}

/** Id libre para una wallet nueva. @param {WalletRegistry} reg */
function nextId(reg) {
  const max = reg.wallets.reduce((m, w) => Math.max(m, Number(w.id.slice(1))), 0);
  return `w${max + 1}`;
}

/**
 * Añade una wallet vacía (la app la estrena con la bienvenida) y la deja activa.
 * @param {WalletRegistry} reg @param {number} now segundos
 * @returns {{ registry: WalletRegistry, id: string }}
 */
export function addWallet(reg, now) {
  if (reg.wallets.length >= MAX_WALLETS) throw new Error(`como mucho ${MAX_WALLETS} wallets`);
  const id = nextId(reg);
  return { registry: { version: 1, active: id, wallets: [...reg.wallets, { id, createdAt: now }] }, id };
}

/**
 * Cambia la wallet activa.
 * @param {WalletRegistry} reg @param {string} id
 * @returns {WalletRegistry}
 */
export function selectWallet(reg, id) {
  if (!reg.wallets.some((w) => w.id === id)) throw new Error("esa wallet no existe");
  return { ...reg, active: id };
}

/**
 * Quita una wallet del registro (sus datos los borra quien llama, antes). Si era la activa, pasa a otra; si era la
 * última, queda la de siempre vacía (con los nombres de siempre: la app enseña la bienvenida, como antes de la 0.10).
 * @param {WalletRegistry} reg @param {string} id @param {number} now
 * @returns {WalletRegistry}
 */
export function removeWallet(reg, id, now) {
  const rest = reg.wallets.filter((w) => w.id !== id);
  if (rest.length === 0) return { version: 1, active: FIRST_WALLET_ID, wallets: [{ id: FIRST_WALLET_ID, createdAt: now }] };
  return { version: 1, active: reg.active === id ? rest[0].id : reg.active, wallets: rest };
}

/**
 * Clave (AsyncStorage) del registro de lo firmado para dApps de una wallet: el historial lo usa para decir «vía X».
 * @param {StorageNames} base los de storageKeys(red) @param {string} id
 */
export function dappLogKey(base, id) {
  if (!validId(id)) throw new Error("wallet no válida");
  return `${base.profile.replace(/profile\.v1$/, "dapplog.v1")}.${id}`;
}

/**
 * Añade una firma para una dApp al registro (lo más nuevo primero, 200 como mucho). Nunca lanza.
 * @param {string | null | undefined} raw lo guardado @param {DappLogEntry} entry
 * @returns {DappLogEntry[]}
 */
export function appendDappLog(raw, entry) {
  return [entry, ...parseDappLog(raw)].slice(0, 200);
}

/**
 * @typedef {{ at: number, dapp: string, method: string, txId: string | null }} DappLogEntry
 *   at: segundos · txId: la transacción (formato del mirror) si la hay; un mensaje firmado no tiene
 */

/** Registro de firmas para dApps leído del almacenamiento (lo que no tenga forma, fuera). @param {string | null | undefined} raw @returns {DappLogEntry[]} */
export function parseDappLog(raw) {
  /** @type {any} */
  let j = null;
  try {
    j = raw ? JSON.parse(raw) : null;
  } catch {
    j = null;
  }
  if (!Array.isArray(j)) return [];
  return j
    .filter((e) => e && Number.isFinite(e.at) && typeof e.dapp === "string" && typeof e.method === "string" && (e.txId === null || typeof e.txId === "string"))
    .map((e) => ({ at: Number(e.at), dapp: String(e.dapp).slice(0, 60), method: String(e.method).slice(0, 60), txId: e.txId }))
    .slice(0, 200);
}
