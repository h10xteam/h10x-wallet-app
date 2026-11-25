// @ts-check
// Formato de importes, monedas y tiempos para la interfaz (español o inglés).
import { coreLanguage, localeOf, tr } from "./i18n.js";

/**
 * Importe en unidades mínimas → texto. 123456789n con 8 decimales → "1,2345" (es) o "1.2345" (en).
 * @param {bigint} amount @param {number} decimals @param {number} [maxDecimals] @param {import("./i18n.js").Lang} [lang]
 */
export function formatUnits(amount, decimals, maxDecimals = 4, lang = coreLanguage()) {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const unit = 10n ** BigInt(decimals);
  const whole = abs / unit;
  const frac = decimals > 0 ? (abs % unit).toString().padStart(decimals, "0").slice(0, maxDecimals).replace(/0+$/, "") : "";
  const [thousands, point] = lang === "en" ? [",", "."] : [".", ","];
  const wholeText = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, thousands);
  return `${neg ? "-" : ""}${wholeText}${frac ? `${point}${frac}` : ""}`;
}

/**
 * 123456789n → "1,2345" (es) / "1.2345" (en), sin ceros de sobra.
 * @param {bigint} tinybars @param {number} [maxDecimals] @param {import("./i18n.js").Lang} [lang]
 */
export const formatHbar = (tinybars, maxDecimals = 4, lang = coreLanguage()) => formatUnits(tinybars, 8, maxDecimals, lang);

/**
 * Lee un importe escrito por una persona: "1,5", "1.5", "1.000,5" o "1,000.5".
 * Devuelve null si no es un importe válido y positivo con como mucho `decimals` decimales.
 * @param {string} text @param {number} decimals
 */
export function parseUnits(text, decimals) {
  let t = text.trim().replace(/[\s_]/g, "");
  if (!t) return null;
  const lastComma = t.lastIndexOf(",");
  const lastDot = t.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    // Los dos signos: el último es el decimal y el otro separa miles.
    const decimal = lastComma > lastDot ? "," : ".";
    const thousands = decimal === "," ? "." : ",";
    t = t.split(thousands).join("").replace(decimal, ".");
  } else {
    t = t.replace(",", ".");
  }
  const re = decimals > 0 ? new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`) : /^\d+$/;
  if (!re.test(t)) return null;
  const [w, f = ""] = t.split(".");
  const value = BigInt(w) * 10n ** BigInt(decimals) + (decimals > 0 ? BigInt((f + "0".repeat(decimals)).slice(0, decimals)) : 0n);
  return value > 0n ? value : null;
}

/** "1,5" o "1.5" → 150000000n. @param {string} text */
export const parseHbar = (text) => parseUnits(text, 8);

/**
 * Segundos que faltan → "1 h 05 min", "3 min 20 s", "ya" / "now".
 * @param {number} seconds @param {import("./i18n.js").Lang} [lang]
 */
export function formatCountdown(seconds, lang = coreLanguage()) {
  if (seconds <= 0) return tr("ya", "now", lang);
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")} min`;
  if (m > 0) return `${m} min ${String(s).padStart(2, "0")} s`;
  return `${s} s`;
}

/**
 * Duración legible de un retardo: 120 → "2 minutos" / "2 minutes", 172800 → "48 horas" / "48 hours".
 * @param {number} seconds @param {import("./i18n.js").Lang} [lang]
 */
export function formatDelay(seconds, lang = coreLanguage()) {
  const plural = (/** @type {number} */ n, /** @type {string} */ one, /** @type {string} */ many) => `${n} ${n === 1 ? one : many}`;
  if (seconds % 86400 === 0 && seconds >= 3 * 86400) return plural(seconds / 86400, tr("día", "day", lang), tr("días", "days", lang));
  if (seconds % 3600 === 0) return plural(seconds / 3600, tr("hora", "hour", lang), tr("horas", "hours", lang));
  if (seconds % 60 === 0) return plural(seconds / 60, tr("minuto", "minute", lang), tr("minutos", "minutes", lang));
  return plural(seconds, tr("segundo", "second", lang), tr("segundos", "seconds", lang));
}

/**
 * Fecha y hora cortas en el idioma de la interfaz.
 * @param {number} unix @param {import("./i18n.js").Lang} [lang] @param {string} [timeZone]
 */
export function formatDateTime(unix, lang = coreLanguage(), timeZone) {
  try {
    return new Date(unix * 1000).toLocaleString(localeOf(lang), { dateStyle: "short", timeStyle: "short", ...(timeZone ? { timeZone } : {}) });
  } catch {
    return new Date(unix * 1000).toISOString().slice(0, 16).replace("T", " ");
  }
}

/** @typedef {"EUR" | "USD"} Fiat */

/**
 * Valor en euros o dólares: 1234.5 → "1.234,50 €" (es) / "€1,234.50" (en).
 * @param {number} value @param {Fiat} currency @param {import("./i18n.js").Lang} [lang]
 */
export function formatFiat(value, currency, lang = coreLanguage()) {
  const digits = value !== 0 && Math.abs(value) < 1 ? 4 : 2;
  try {
    return new Intl.NumberFormat(localeOf(lang), { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: digits }).format(value);
  } catch {
    // Sin Intl completo: formato sencillo.
    const cents = BigInt(Math.round(value * 10 ** digits));
    const text = formatUnits(cents, digits, digits, lang);
    return currency === "EUR" ? `${text} €` : `$${text}`;
  }
}

/** Hora actual en segundos. */
export const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Valida un destino: ID de cuenta 0.0.x o dirección EVM 0x… de 40 caracteres.
 * @param {string} text
 */
export function isValidDestination(text) {
  const t = text.trim();
  return /^0\.0\.\d+$/.test(t) || /^0x[0-9a-fA-F]{40}$/.test(t);
}

