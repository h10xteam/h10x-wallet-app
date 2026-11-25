// @ts-check
// Aviso de emergencia del guardián y topes de la beta.
//
// Aviso: quien administra el guardián puede publicar un aviso para todas las bóvedas (p. ej. «hemos encontrado un
// fallo: evacúa con el móvil y el kit»). La bóveda no tiene llave de administrador, así que avisar es lo único que se
// puede hacer. Por eso el aviso solo lleva texto: sin enlaces, sin cuentas y sin direcciones. Si alguien llegara a
// controlar el servidor, no podría usarlo para mandar a nadie a una web falsa ni a «evacuar a la cuenta 0.0.X». La app
// solo ofrece abrir su propia pantalla de Evacuar, que por defecto manda los fondos a la Cartera del dueño.
//
// Topes: durante la beta, cada bóveda puede guardar como mucho cierto número de HBAR (0 = sin tope). La app no deja
// guardar más y el guardián avisa al dueño si, aun así, alguien le manda más.
import { HBAR } from "./config.js";
import { hideLinks } from "./scamtext.js";

/** Niveles de aviso: «info» (informativo, se puede cerrar) y «evacuar» (pide evacuar; no se puede cerrar). */
export const NOTICE_LEVELS = /** @type {const} */ (["info", "evacuar"]);
/** Largo máximo de cada texto del aviso. */
export const NOTICE_MAX_TEXT = 280;

/** IDs de cuenta de Hedera (también con espacios: «0. 0. 123»). */
const ACCOUNT = /\b0\s*\.\s*0\s*\.\s*\d+\b/g;
/** Direcciones EVM y claves en hexadecimal. */
const HEX = /\b0x[0-9a-fA-F]{6,}\b|\b[0-9a-fA-F]{40,}\b/g;

/**
 * @typedef {{ id: string, level: "info" | "evacuar", es: string, en: string, at: number }} GuardianNotice
 * @typedef {{ maxVaultHbar: number, maxVaults: number }} BetaLimits
 */

/**
 * Un texto del aviso, limpio: sin caracteres de control, sin enlaces (ni disimulados), sin cuentas ni direcciones, y
 * con un largo máximo.
 * @param {unknown} text @param {"es" | "en"} lang
 */
export function cleanNoticeText(text, lang) {
  if (typeof text !== "string") return "";
  let s = text.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
  s = String(hideLinks(s, lang));
  s = s.replace(ACCOUNT, lang === "en" ? "[account hidden]" : "[cuenta oculta]").replace(HEX, lang === "en" ? "[address hidden]" : "[dirección oculta]");
  return s.length > NOTICE_MAX_TEXT ? `${s.slice(0, NOTICE_MAX_TEXT - 1)}…` : s;
}

/**
 * Valida y limpia un aviso (el fichero del guardián o lo que responde por la red). null si no vale.
 * @param {unknown} raw
 * @returns {GuardianNotice | null}
 */
export function cleanNotice(raw) {
  if (!raw || typeof raw !== "object") return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  const level = r.level === "evacuar" || r.level === "info" ? r.level : null;
  if (!level) return null;
  const id = typeof r.id === "string" ? r.id : "";
  if (!/^[a-z0-9-]{4,40}$/i.test(id)) return null;
  const es = cleanNoticeText(r.es, "es");
  const en = cleanNoticeText(r.en, "en");
  if (!es && !en) return null;
  const at = Number(r.at);
  return { id, level, es: es || en, en: en || es, at: Number.isFinite(at) && at > 0 ? Math.floor(at) : 0 };
}

/**
 * Topes de la beta, limpios (0 = sin tope).
 * @param {unknown} raw
 * @returns {BetaLimits}
 */
export function cleanLimits(raw) {
  const r = raw && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : {};
  const n = (/** @type {unknown} */ v) => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0;
  };
  return { maxVaultHbar: n(r.maxVaultHbar), maxVaults: n(r.maxVaults) };
}

/**
 * Tope que aplica la app: el más bajo entre el que trae la compilación y el que publica el guardián (0 = sin tope).
 * En mainnet la compilación siempre trae uno, así que un guardián caído o sin tope no lo levanta.
 * @param {number} buildCap tope de la compilación en HBAR (0 = ninguno)
 * @param {number} guardianCap tope que publica el guardián en HBAR (0 = ninguno)
 */
export function effectiveCap(buildCap, guardianCap) {
  const caps = [buildCap, guardianCap].map((x) => (Number.isFinite(x) && x > 0 ? Math.floor(x) : 0)).filter((x) => x > 0);
  return caps.length ? Math.min(...caps) : 0;
}

/**
 * Cuánto cabe aún en la bóveda (tinybars) con el tope de la beta; null si no hay tope.
 * @param {bigint | null | undefined} vaultTinybars saldo actual de la bóveda
 * @param {number} maxVaultHbar tope en HBAR (0 = sin tope)
 */
export function vaultRoom(vaultTinybars, maxVaultHbar) {
  if (!(maxVaultHbar > 0)) return null;
  const room = BigInt(Math.floor(maxVaultHbar)) * HBAR - (vaultTinybars ?? 0n);
  return room > 0n ? room : 0n;
}

/**
 * Lee el aviso guardado en un fichero (JSON). null si no hay o no vale.
 * @param {(path: string) => string} readText @param {string} path
 */
export function readNoticeFile(readText, path) {
  try {
    return cleanNotice(JSON.parse(readText(path)));
  } catch {
    return null;
  }
}
