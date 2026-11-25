// @ts-check
// Precios en euros y dólares. HBAR: CoinGecko (sin clave) y, si falla, la tasa oficial de Hedera
// más el cambio dólar→euro del BCE. Tokens: SaucerSwap, solo con clave de API (la usa el guardián).
//
// En testnet los HBAR no valen nada: la app enseña el valor con el precio real de mainnet como
// referencia y lo dice.

/** @typedef {{ usd: number, eur: number }} FiatPrice */
/** @typedef {{ hbar: FiatPrice, tokens: Record<string, FiatPrice>, at: number, source: string }} Prices */

const COINGECKO = "https://api.coingecko.com/api/v3/simple/price?ids=hedera-hashgraph&vs_currencies=usd,eur";
const HEDERA_RATE = "https://mainnet.mirrornode.hedera.com/api/v1/network/exchangerate";
const USD_EUR = ["https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR", "https://api.frankfurter.app/latest?from=USD&to=EUR"];

/** API de SaucerSwap por red. */
export const SAUCERSWAP_API = { testnet: "https://test-api.saucerswap.finance", previewnet: "https://test-api.saucerswap.finance", local: "", mainnet: "https://api.saucerswap.finance" };

/**
 * GET con tiempo límite. Devuelve el JSON o lanza.
 * @param {typeof fetch} fetchImpl @param {string} url @param {Record<string, string>} [headers] @param {number} [ms]
 */
async function getJson(fetchImpl, url, headers = {}, ms = 8000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetchImpl(url, { headers: { accept: "application/json", ...headers }, signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const positive = (/** @type {unknown} */ v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

/**
 * Precio del HBAR en dólares y euros.
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<FiatPrice & { source: string }>}
 */
export async function fetchHbarPrice(fetchImpl = fetch) {
  try {
    const body = await getJson(fetchImpl, COINGECKO);
    const usd = positive(Number(body?.["hedera-hashgraph"]?.usd));
    const eur = positive(Number(body?.["hedera-hashgraph"]?.eur));
    if (usd && eur) return { usd, eur, source: "coingecko" };
  } catch {
    // se prueba la otra vía
  }
  const rate = await getJson(fetchImpl, HEDERA_RATE);
  const cents = Number(rate?.current_rate?.cent_equivalent);
  const hbars = Number(rate?.current_rate?.hbar_equivalent);
  const usd = positive(cents / hbars / 100);
  if (!usd) throw new Error("sin precio del HBAR");
  for (const url of USD_EUR) {
    try {
      const fx = await getJson(fetchImpl, url);
      const eurPerUsd = positive(Number(fx?.rates?.EUR));
      if (eurPerUsd) return { usd, eur: usd * eurPerUsd, source: "hedera+bce" };
    } catch {
      // siguiente
    }
  }
  throw new Error("sin cambio dólar→euro");
}

/**
 * Precios en dólares de los tokens listados en SaucerSwap (hace falta su clave de API).
 * @param {{ fetchImpl?: typeof fetch, apiKey: string, baseUrl: string }} p
 * @returns {Promise<Record<string, number>>}
 */
export async function fetchTokenPricesUsd({ fetchImpl = fetch, apiKey, baseUrl }) {
  if (!apiKey || !baseUrl) return {};
  const list = await getJson(fetchImpl, `${baseUrl.replace(/\/$/, "")}/tokens`, { "x-api-key": apiKey }, 12000);
  /** @type {Record<string, number>} */
  const out = {};
  for (const t of Array.isArray(list) ? list : []) {
    const price = positive(Number(t?.priceUsd ?? t?.price_usd));
    if (t?.id && price) out[String(t.id)] = price;
  }
  return out;
}

/**
 * HBAR y, si hay clave, tokens. Los euros de los tokens salen del cambio implícito en el HBAR.
 * @param {{ fetchImpl?: typeof fetch, saucerswapKey?: string, network?: keyof typeof SAUCERSWAP_API }} [p]
 * @returns {Promise<Prices>}
 */
export async function fetchPrices({ fetchImpl = fetch, saucerswapKey = "", network = "testnet" } = {}) {
  const hbar = await fetchHbarPrice(fetchImpl);
  /** @type {Record<string, FiatPrice>} */
  const tokens = {};
  if (saucerswapKey) {
    try {
      const usd = await fetchTokenPricesUsd({ fetchImpl, apiKey: saucerswapKey, baseUrl: SAUCERSWAP_API[network] ?? "" });
      const eurPerUsd = hbar.eur / hbar.usd;
      for (const [id, p] of Object.entries(usd)) tokens[id] = { usd: p, eur: p * eurPerUsd };
    } catch {
      // sin precios de tokens: se muestran sin valor
    }
  }
  return { hbar: { usd: hbar.usd, eur: hbar.eur }, tokens, at: Math.floor(Date.now() / 1000), source: hbar.source };
}

/**
 * Valor en moneda de un importe en unidades mínimas.
 * @param {bigint} amount @param {number} decimals @param {number} unitPrice
 */
export function fiatOf(amount, decimals, unitPrice) {
  const scale = 10 ** Math.min(decimals, 8);
  const reduced = decimals > 8 ? amount / 10n ** BigInt(decimals - 8) : amount;
  return (Number(reduced) / scale) * unitPrice;
}
