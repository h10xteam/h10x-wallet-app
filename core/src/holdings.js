// @ts-check
// Lo que tienes, como lo enseñan las listas de la app (al estilo de HashPack): precio de cada activo, su cambio en 24 h,
// su valor, el orden de la lista y los avisos de cada token.
//
// Precios, por este orden:
//   - HBAR: el de siempre (guardián o CoinGecko). Su cambio en 24 h, el del WHBAR de la cesta de H10X (1 WHBAR = 1 HBAR).
//   - H10X: su NAV (nav.json de la web de H10X) y su cambio en 24 h.
//   - Tokens de la cesta de H10X (solo en mainnet, donde sus IDs son esos): el precio y el cambio de nav.json.
//   - Cualquier otro: el del guardián, si tiene clave de SaucerSwap (sin cambio en 24 h).
// Un token sin precio sale sin valor y con su ID: nunca se le pone el precio de otro token que se llame igual.

import { tr, localeOf, coreLanguage } from "./i18n.js";
import { tokenRisks } from "./risks.js";
import { fakesHbar, hasLink } from "./scamtext.js";

/** WHBAR de SaucerSwap en mainnet: su cambio en 24 h es el del HBAR. */
export const WHBAR_MAINNET = "0.0.1456986";

/** @typedef {{ price: number | null, change24h: number | null }} Quote */

const positive = (/** @type {unknown} */ v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
const finite = (/** @type {unknown} */ v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Precio (en la moneda elegida) y cambio en 24 h de cada activo. `tokenId` null = HBAR.
 * @param {{ prices: import("./prices.js").Prices | null, nav: import("./h10x.js").H10xNav | null, currency?: "EUR" | "USD", network: string, h10xTokenId?: string | null }} p
 * @returns {(tokenId: string | null) => Quote}
 */
export function makeQuote({ prices, nav, currency = "EUR", network, h10xTokenId = null }) {
  const key = currency === "USD" ? "usd" : "eur";
  const hbarUsd = positive(prices?.hbar?.usd);
  const hbarFiat = positive(prices?.hbar?.[key]);
  // De dólares a la moneda elegida, con el cambio implícito en el precio del HBAR.
  const rate = hbarUsd && hbarFiat ? hbarFiat / hbarUsd : null;
  /** @type {Map<string, import("./h10x.js").H10xComponent>} */
  const basket = new Map();
  if (nav && network === "mainnet") for (const c of nav.components) if (c.tokenId) basket.set(c.tokenId, c);
  const whbar = nav?.components.find((c) => c.tokenId === WHBAR_MAINNET) ?? nav?.components.find((c) => /^W?HBAR$/i.test(c.symbol)) ?? null;
  return (tokenId) => {
    if (!tokenId) return { price: hbarFiat, change24h: finite(whbar?.change24h) };
    if (h10xTokenId && tokenId === h10xTokenId && nav && rate) return { price: nav.nav * rate, change24h: finite(nav.change24h) };
    const c = basket.get(tokenId);
    if (c && positive(c.priceUsd) && rate) return { price: c.priceUsd * rate, change24h: finite(c.change24h) };
    const g = positive(prices?.tokens?.[tokenId]?.[key]);
    return { price: g, change24h: null };
  };
}

/**
 * Cambio de hoy de un conjunto de activos: lo que ha subido o bajado en dinero y en %. Solo cuentan los que tienen
 * valor y cambio en 24 h; si ninguno lo tiene, null.
 * @param {{ value: number | null, change24h: number | null }[]} items
 * @returns {{ abs: number, pct: number } | null}
 */
export function dayChange(items) {
  let now = 0;
  let before = 0;
  let any = false;
  for (const x of items) {
    if (x.value == null || x.change24h == null || x.change24h <= -100) continue;
    any = true;
    now += x.value;
    before += x.value / (1 + x.change24h / 100);
  }
  if (!any || before <= 0) return null;
  return { abs: now - before, pct: ((now - before) / before) * 100 };
}

/**
 * Precio de una unidad: 81.240 € · 134,21 € · 1,084 € · 0,1652 € · 0,0089 €.
 * @param {number} value @param {"EUR" | "USD"} currency @param {import("./i18n.js").Lang} [lang]
 */
export function formatPrice(value, currency, lang = coreLanguage()) {
  const a = Math.abs(value);
  /** @type {Intl.NumberFormatOptions} */
  const opts =
    a >= 1000
      ? { maximumFractionDigits: 0 }
      : a >= 10
        ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
        : a >= 1
          ? { minimumFractionDigits: 2, maximumFractionDigits: 3 }
          : a > 0
            ? { maximumSignificantDigits: 4 }
            : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  try {
    return new Intl.NumberFormat(localeOf(lang), { style: "currency", currency, ...opts }).format(value);
  } catch {
    const text = a >= 1 ? value.toFixed(a >= 1000 ? 0 : 2) : value.toPrecision(4);
    return currency === "EUR" ? `${text} €` : `$${text}`;
  }
}

/**
 * Cambio en %: +2,4 % · −3,2 % (con el signo menos de verdad, que se lee mejor).
 * @param {number} value @param {number} [digits] @param {import("./i18n.js").Lang} [lang]
 */
export function formatPct(value, digits = 1, lang = coreLanguage()) {
  const n = Math.abs(value).toLocaleString(localeOf(lang), { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return lang === "en" ? `${sign}${n}%` : `${sign}${n} %`;
}

/**
 * Orden de las listas: HBAR primero; luego por valor (los que no tienen precio, al final) y por símbolo.
 * @template {{ tokenId: string | null, symbol: string, value: number | null }} T
 * @param {T[]} list
 * @returns {T[]}
 */
export function sortHoldings(list) {
  return [...list].sort((a, b) => {
    if (!a.tokenId !== !b.tokenId) return a.tokenId ? 1 : -1;
    const va = a.value ?? -1;
    const vb = b.value ?? -1;
    if (va !== vb) return vb - va;
    return a.symbol.localeCompare(b.symbol);
  });
}

/**
 * Avisos de un token para la lista (una palabra) y para su ficha (frases). `level`: "danger" (estafa o te cobra al
 * moverlo), "warn" (su emisor puede intervenir en tu saldo) o null.
 * @param {{ symbol: string, name: string, info?: import("./mirror.js").TokenInfo | null, lang?: import("./i18n.js").Lang, formatHbar?: (v: bigint) => string }} p
 */
export function tokenWarnings({ symbol, name, info, lang = coreLanguage(), formatHbar = (v) => (Number(v) / 1e8).toString() }) {
  /** @type {string[]} */
  const lines = [];
  /** @type {"danger" | "warn" | null} */
  let level = null;
  const t = (/** @type {string} */ es, /** @type {string} */ en) => tr(es, en, lang);
  if (hasLink(symbol) || hasLink(name)) {
    level = "danger";
    lines.push(t("Trae una web en el nombre: típico de estafas. No la busques.", "Has a website in its name: typical of scams. Don't look it up."));
  } else if (fakesHbar(symbol) || fakesHbar(name)) {
    level = "danger";
    lines.push(t("Se hace llamar HBAR, pero no es HBAR.", "Calls itself HBAR, but it isn't HBAR."));
  }
  if (info) {
    const r = tokenRisks(info);
    if (r.chargesOnMove) {
      level = "danger";
      lines.push(r.fixedHbar > 0n ? t(`Cobra ${formatHbar(r.fixedHbar)} HBAR cada vez que lo mueves.`, `Charges ${formatHbar(r.fixedHbar)} HBAR every time you move it.`) : t("Cobra otro token cada vez que lo mueves.", "Charges another token every time you move it."));
    } else if (r.anyFixedFee) {
      lines.push(t("Cobra una pequeña comisión al moverlo.", "Charges a small fee to move it."));
    }
    if (r.takesShare) lines.push(t("Se queda una parte del propio token al moverlo.", "Keeps a share of the token when you move it."));
    const powers = r.issuerCan.filter((k) => k !== "feeSchedule");
    if (powers.length) {
      level = level ?? "warn";
      const words = powers.map((k) => (k === "freeze" ? t("congelarlo", "freeze it") : k === "wipe" ? t("borrarlo", "wipe it") : k === "pause" ? t("pausarlo", "pause it") : t("exigir KYC", "require KYC")));
      lines.push(t(`Su emisor puede ${listOf(words, "es")}.`, `Its issuer can ${listOf(words, "en")}.`));
    }
    if (r.canChangeFees) {
      level = level ?? "warn";
      lines.push(t("Su emisor puede ponerle comisiones cuando quiera.", "Its issuer can add fees whenever it wants."));
    }
    if (!lines.length) lines.push(t("Sin comisión al moverlo. Nadie puede congelarlo, borrarlo ni pausarlo.", "No fee to move it. Nobody can freeze, wipe or pause it."));
  }
  const short = level === "danger" ? t("Cuidado", "Careful") : level === "warn" ? t("Revisar", "Check") : null;
  return { level, short, lines };
}

/** «a, b y c» · «a, b and c». @param {string[]} words @param {"es" | "en"} lang */
function listOf(words, lang) {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} ${lang === "en" ? "and" : "y"} ${words[words.length - 1]}`;
}
