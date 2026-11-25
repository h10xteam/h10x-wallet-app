// @ts-check
// Acciones tokenizadas (swap ampliado, fase 3): comprar y vender con HBAR o USDC las acciones de Robinhood que SODAX
// trae a Hedera como tokens HTS, y que lo comprado llegue a la Cartera o directo a la bóveda.
//
// Cómo funciona (docs.sodax.com → Hedera, Swaps API y Robinhood stocks, revisado el 25-nov-2026):
//   - SODAX solo funciona en MAINNET. Es una capa de «intenciones»: la Cartera firma UNA transacción EVM (ECDSA,
//     chainId 295) que llama a transfer(token, to, amount, data) del SpokeAssetManager de SODAX en Hedera. Ese
//     contrato guarda lo pagado y avisa a su red (hub en Sonic); un «solver» compra la acción y la entrega en Hedera
//     a la dirección de destino (dstAddress). Si nadie la completa, la intención caduca (deadline).
//   - La API HTTP (api.sodax.com/v1/swaps) cotiza y PREPARA la transacción. La app no se fía de lo que llega: antes de
//     firmar lo decodifica y comprueba contrato, importe, token, origen, destino, mínimo y plazo
//     (verifyIntentBuild). Si algo no cuadra, no se firma nada.
//   - Cada acción es un token HTS de 8 decimales, sin KYC, sin congelar, sin borrar, sin pausa y sin comisiones,
//     emitido desde la tesorería de SODAX (STOCK_TREASURY). La lista va fija aquí (STOCK_TOKENS) y la app la vuelve a
//     comprobar en la red cada vez (checkStockToken).
//   - Sin comisión de servicio: no se manda partnerFee.
// Condiciones de SODAX para ofrecer estas acciones (API Terms 6.3 y 6.5): comprobar que el usuario puede (no en EE. UU.
// ni personas de EE. UU., ni países restringidos), que lo confirme y enseñar el aviso del emisor (STOCK_NOTICE).
// Fuera de la lista: fondos cotizados (la app no los ofrece) y empresas que no cotizan en bolsa.
import { AccountAllowanceApproveTransaction, AccountId, EthereumTransaction, Hbar, Long, TokenAssociateTransaction, TokenId } from "@hiero-ledger/sdk";
import { AbiCoder, Interface, Wallet, concat, dataSlice, getAddress, getBytes, getCreate2Address, hexlify, keccak256, solidityPacked } from "ethers";
import { nowSeconds } from "./format.js";
import { tr } from "./i18n.js";
import { submit, WalletError } from "./wallet.js";
import { ROBINHOOD_TREASURY, checkSwapToken } from "./swaptokens.js";

const coder = AbiCoder.defaultAbiCoder();
const ZERO = "0x0000000000000000000000000000000000000000";

/** Contratos y datos fijos de SODAX en Hedera mainnet (docs.sodax.com → Deployments → Mainnet; comprobados en el mirror). */
export const SODAX = Object.freeze({
  network: "mainnet",
  api: "https://api.sodax.com/v1/swaps",
  /** Diario on-chain de SODAX (independiente de la API de swaps): GET /intent/{intentHash} → abierta, completada o cancelada. */
  journal: "https://api.sodax.com/v1/be",
  chainKey: "hedera",
  evmChainId: 295,
  /** SpokeAssetManager (0.0.10495847): el único contrato al que la app deja firmar para acciones. */
  assetManager: "0x0df73542cc68bdc01b361d231c60f726b0e0bc05",
  assetManagerId: "0.0.10495847",
  /** Identificador de Hedera dentro de SODAX (srcChain/dstChain de la intención y sal de la cartera del hub). */
  hederaChainId: 18501n,
  /** Hub (Sonic): fábrica de carteras de usuario e Intents. */
  walletFactory: "0xA0ed3047D358648F2C0583B415CffCA571FDB544",
  intents: "0x6382D6ccD780758C5e8A6123c33ee8F4472F96ef",
});

/** Tesorería desde la que SODAX emite todas las acciones en Hedera (0.0.10495816). */
export const STOCK_TREASURY = ROBINHOOD_TREASURY;

/** Con qué se paga (y en qué se cobra al vender). HBAR nativo va como dirección cero en SODAX. */
export const STOCK_PAY = Object.freeze({
  HBAR: Object.freeze({ symbol: "HBAR", tokenId: null, address: ZERO, decimals: 8, hub: "0x5c18c543b6b6ea97de739f48c49cfc291b3ad465" }),
  USDC: Object.freeze({ symbol: "USDC", tokenId: "0.0.456858", address: "0x000000000000000000000000000000000006f89a", decimals: 6, hub: "0xafafae0c1476424c4b81f09095bd7dcb858047c8" }),
});

/**
 * @typedef {{ symbol: string, name: string, id: string, onChainName: string, hub: string }} StockEntry
 *   name: el nombre corto que enseña la app · onChainName: el que tiene el token en la red (si cambia, se bloquea)
 *   hub: su activo en el hub de SODAX (Sonic), el que va dentro de la intención (GET /v1/swaps/tokens/hedera)
 */
/** @param {string} symbol @param {string} name @param {string} id @param {string} onChainName @param {string} hub @returns {Readonly<StockEntry>} */
const s = (symbol, name, id, onChainName, hub) => Object.freeze({ symbol, name, id, onChainName, hub });

/**
 * Acciones de empresas que cotizan en bolsa, revisadas el 25-nov-2026: están en la lista de SODAX para Hedera
 * (GET /v1/swaps/tokens/hedera) y en la red son tokens de 8 decimales de STOCK_TREASURY, sin llaves de KYC, congelar,
 * borrar, pausar ni comisiones.
 */
export const STOCK_TOKENS = Object.freeze([
  s("AAPL", "Apple", "0.0.10840033", "Apple • Robinhood Token", "0xfdff1e1bec68fc9c75a2c89474c848a31be49242"),
  s("NVDA", "NVIDIA", "0.0.10839711", "NVIDIA • Robinhood Token", "0xfef4b7437485062d07efdc46c667163e4beaa451"),
  s("TSLA", "Tesla", "0.0.10840034", "Tesla • Robinhood Token", "0x1ff47b26bfd9019671f543e6dd8c61b06f1358b4"),
  s("MSFT", "Microsoft", "0.0.10880466", "Microsoft • Robinhood Token", "0x5b9838715bbeff2e8752961c418f64cab3e7b2ed"),
  s("AMZN", "Amazon", "0.0.10880464", "Amazon • Robinhood Token", "0x13e3e4eaaa02bbd0a32094c6c7078d4aba24cd04"),
  s("GOOGL", "Alphabet Class A", "0.0.10880462", "Alphabet Class A • Robinhood Token", "0xa4942e1ede99034b11657c8a0978f8e2342980b4"),
  s("META", "Meta", "0.0.10880467", "Meta Platforms • Robinhood Token", "0xbe8a7cafabe2399b4d751a5545017cc09d83ffc9"),
  s("NFLX", "Netflix", "0.0.10933024", "Netflix • Robinhood Token", "0x9a3936491230df8f9cc31a359e01f9b7ae39734f"),
  s("AMD", "AMD", "0.0.10880475", "AMD • Robinhood Token", "0x26b9c3af52e764b8362cdd273b443e576f960e36"),
  s("TSM", "Taiwan Semiconductor", "0.0.10880473", "Taiwan Semiconductor Manufacturing • Robinhood Token", "0x87fb178434b5832df1defa3e3e51da3e4f1ecb10"),
  s("COIN", "Coinbase", "0.0.10880470", "Coinbase • Robinhood Token", "0x4d82303a0cf66f3d98e8140a1668567e748685de"),
  s("MSTR", "Strategy", "0.0.10840032", "Strategy Inc. • Robinhood Token", "0xa8b6f37fdc7d084a6c2530cc1de597ccec526570"),
  s("PLTR", "Palantir", "0.0.10880471", "Palantir Technologies • Robinhood Token", "0xec98d565853064667ec5512bc6b7183d54b9ef40"),
  s("CRCL", "Circle", "0.0.10880468", "Circle Internet Group • Robinhood Token", "0x13c16a6a19a637fbf370cca8d7f4bd38d207b620"),
  s("INTC", "Intel", "0.0.10880476", "Intel • Robinhood Token", "0xb4fe614a0566e64a0352645485bb4ebcaf8f3a9e"),
  s("MU", "Micron", "0.0.10840035", "Micron Technology • Robinhood Token", "0x3b94e6d81fa505f20dda3cc25a18b80e921b8580"),
  s("SNDK", "SanDisk", "0.0.10840037", "Sandisk Corporation • Robinhood Token", "0x2d27112f45275f3b6b00a2a8a1434ca0e36488ef"),
  s("SKHY", "SK hynix", "0.0.10933028", "SK hynix Inc. American Depositary Shares • Robinhood Token", "0x09023c636a3dc9c12c6e5673e17b6c0c4fa04eed"),
  s("BABA", "Alibaba", "0.0.10880477", "Alibaba • Robinhood Token", "0x5e69df859f7c2b170e5fdadbd59d06c2cd287753"),
  s("IBM", "IBM", "0.0.10933014", "IBM • Robinhood Token", "0xd05531715d7dac111d964763549b96592ad517be"),
  s("NET", "Cloudflare", "0.0.10933027", "Cloudflare, Inc. Class A common stock • Robinhood Token", "0x923b3cd076c856e4f4f9a3bcc1849e5e5b166c7b"),
  s("LLY", "Eli Lilly", "0.0.10933010", "Eli Lilly • Robinhood Token", "0x31fc4a71799de07e901ea0b93ad8f641f0b89b6e"),
  s("JNJ", "Johnson & Johnson", "0.0.10933031", "Johnson & Johnson • Robinhood Token", "0xb2fd95f47ccd1e120a66a56ff4e147db7aa08cfb"),
  s("MRNA", "Moderna", "0.0.10933015", "Moderna • Robinhood Token", "0x85677b9b106f5aac4a299bf877e1f9d5aaab32af"),
  s("HIMS", "Hims & Hers Health", "0.0.10933009", "Hims & Hers Health • Robinhood Token", "0x28a4d8ef8f19e38b0c5c7ebfc865bb489e7c45d9"),
  s("COST", "Costco", "0.0.10933011", "Costco • Robinhood Token", "0x475248affc8646323eb610090751cb40b3204122"),
  s("UPS", "UPS", "0.0.10933032", "UPS • Robinhood Token", "0xc99c1fa55072b9e5a4616655b2d1a3fe7c9e990d"),
  s("LULU", "Lululemon", "0.0.10933016", "Lululemon • Robinhood Token", "0xceb98ab1fcaf8730b52e620bdf76142809fc918f"),
  s("TTWO", "Take-Two Interactive", "0.0.10933012", "Take-Two Interactive Software • Robinhood Token", "0xa56e033e2df215d1f7d3bb82b8fbdc5564ce1f80"),
  s("RBLX", "Roblox", "0.0.10933013", "Roblox • Robinhood Token", "0xdbfeb85cc06de2bb219b053aa17e04f92921e340"),
  s("SNAP", "Snap", "0.0.10933017", "Snap • Robinhood Token", "0xc49a760e018f0beb56af90965e933766e95b33eb"),
  s("RDDT", "Reddit", "0.0.10840029", "Reddit • Robinhood Token", "0xa32abca3605d1d84812f68e6c8bb773cab8c2764"),
  s("RIVN", "Rivian", "0.0.10933022", "Rivian Automotive • Robinhood Token", "0xfbab60a36f411f9fe480470375a9d874d44b0c30"),
  s("GME", "GameStop", "0.0.10840025", "GameStop • Robinhood Token", "0x074b3035d7046d5f75dfc8e2ad1848a915bd308e"),
  s("AMC", "AMC Entertainment", "0.0.10933008", "AMC Entertainment • Robinhood Token", "0xb86ace2530e54c98088566dd39550b4b061f47bd"),
  s("DJT", "Trump Media & Technology", "0.0.10840027", "Trump Media & Technology Group • Robinhood Token", "0xd07524eeba69a5026597837eb46849f76de1c187"),
  s("BULL", "Webull", "0.0.10933025", "Webull • Robinhood Token", "0x4f2aa602a0ac19fbb522b92ad0d38ceca2fc339b"),
  s("QUBT", "Quantum Computing", "0.0.10933026", "Quantum Computing • Robinhood Token", "0xbd94dd5d028cdc2ab9d6ab3e2e1a7f437971aab4"),
  s("WYFI", "WhiteFiber", "0.0.10933018", "WhiteFiber, Inc. • Robinhood Token", "0x40b8db998c3adb40d3d70840a61d1e5a429b9ee9"),
]);

/** Decimales de todas las acciones en Hedera. */
export const STOCK_DECIMALS = 8;

/** Plazo de la intención: si ningún solver la completa en este tiempo, caduca. */
export const STOCK_DEADLINE_S = 10 * 60;
/** Tope de la comisión de red de la transacción EVM (en HBAR). */
export const STOCK_MAX_FEE_HBAR = 5;
/** Gas: lo estimado +25 %, entre estos topes (Hedera cobra al menos el 80 % del gas reservado). */
export const STOCK_GAS_MIN = 200_000;
export const STOCK_GAS_MAX = 2_500_000;
/** La transacción EVM firmada no puede pasar de esto (más grande, Hedera exige subirla antes como archivo). */
export const STOCK_MAX_RAW_BYTES = 5_000;
/** Hasta cuándo se espera a que un solver complete la compra. */
export const STOCK_SETTLE_TIMEOUT_MS = 6 * 60_000;
/**
 * Después de «solved», lo que tarda en verse en Hedera lo entregado (el hub de SODAX lo manda de vuelta a Hedera).
 * En mainnet, 25-nov-2026: a la Cartera en menos de un minuto; a una bóveda, unos tres minutos.
 */
export const STOCK_DELIVERY_TIMEOUT_MS = 5 * 60_000;

/** Lo que tiene que aceptar el usuario la primera vez (condiciones de SODAX para estas acciones). */
export const STOCK_ELIGIBILITY = Object.freeze({
  version: 1,
  /** Países donde no se ofrecen (ISO 3166-1 alfa-2): EE. UU. y sus territorios, y países con sanciones. */
  blockedCountries: Object.freeze(["US", "PR", "GU", "VI", "AS", "MP", "UM", "CU", "IR", "KP", "SY", "RU", "BY"]),
});

/** Aviso del emisor (resumen de docs.sodax.com → Robinhood stocks due diligence). */
export const STOCK_NOTICE = Object.freeze({
  es: [
    "Las emite Robinhood Assets (Jersey) Limited. Son valores de deuda tokenizados que siguen el precio de la acción: no te hacen accionista (sin voto ni derechos sobre la acción).",
    "SODAX las trae a Hedera con respaldo 1:1 en Robinhood Chain y las cambia a través de su red. H10X no es el emisor ni un bróker, no las custodia y no cobra nada por el cambio.",
    "No se ofrecen en EE. UU. ni a personas de EE. UU., ni en países con restricciones. Su precio puede bajar y el cambio puede no completarse fuera del horario del mercado.",
  ],
  en: [
    "Issued by Robinhood Assets (Jersey) Limited. They are tokenised debt securities that track the share price: they don't make you a shareholder (no votes or rights in the share).",
    "SODAX brings them to Hedera, backed 1:1 on Robinhood Chain, and swaps them through its network. H10X is not the issuer or a broker, doesn't hold them and charges nothing for the swap.",
    "Not offered in the US or to US persons, nor in restricted countries. Their price can fall and a swap may not complete outside market hours.",
  ],
});

/**
 * ¿Puede ver y usar las acciones? La app guarda lo aceptado (país y las dos confirmaciones) y lo pasa aquí.
 * @param {{ country?: string | null, notUsPerson?: boolean, readNotice?: boolean, version?: number } | null | undefined} e
 * @returns {{ ok: boolean, reason: "" | "MISSING" | "COUNTRY" | "US_PERSON" | "NOTICE" | "OUTDATED" }}
 */
export function stockEligibility(e) {
  if (!e) return { ok: false, reason: "MISSING" };
  if (e.version !== STOCK_ELIGIBILITY.version) return { ok: false, reason: "OUTDATED" };
  const c = String(e.country ?? "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return { ok: false, reason: "MISSING" };
  if (STOCK_ELIGIBILITY.blockedCountries.includes(c)) return { ok: false, reason: "COUNTRY" };
  if (e.notUsPerson !== true) return { ok: false, reason: "US_PERSON" };
  if (e.readNotice !== true) return { ok: false, reason: "NOTICE" };
  return { ok: true, reason: "" };
}

/** @param {string} id */
export const stockById = (id) => STOCK_TOKENS.find((t) => t.id === id) ?? null;
/** @param {string} id */
export const isStockToken = (id) => STOCK_TOKENS.some((t) => t.id === id);

/** ID 0.0.X → dirección long-zero (minúsculas). @param {string} id */
export const stockAddress = (id) => `0x${BigInt(String(id).split(".")[2]).toString(16).padStart(40, "0")}`;

/**
 * Comprobación en la red de una acción de la lista: la de cualquier token (swaptokens.js) y además, como la lista va
 * fija, todo lo que se revisó: nombre, tesorería de SODAX, 8 decimales y sin llaves de congelar, borrar ni pausar.
 * @param {StockEntry} entry @param {import("./mirror.js").TokenInfo | null} info
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function checkStockToken(entry, info) {
  const base = checkSwapToken({ id: entry.id, symbol: entry.symbol, name: entry.name }, info);
  const problems = [...base.problems];
  if (!info) return { ok: false, problems };
  if (info.name !== entry.onChainName) problems.push(tr("El token ha cambiado de nombre: no se deja cambiar hasta revisarlo.", "The token has been renamed: swapping is blocked until it's reviewed."));
  if (info.treasury !== STOCK_TREASURY) problems.push(tr("No lo emite la tesorería de SODAX: no es la acción de la lista.", "It isn't issued by SODAX's treasury: it's not the listed stock."));
  if (info.decimals !== STOCK_DECIMALS) problems.push(tr("Sus decimales no son los de la acción revisada.", "Its decimals don't match the reviewed stock."));
  for (const k of ["freeze", "wipe", "pause", "kyc", "feeSchedule"]) {
    if ((info.issuerKeys ?? []).includes(k)) {
      problems.push(tr("Su emisor ha cambiado las llaves del token: no se deja cambiar hasta revisarlo.", "Its issuer changed the token's keys: swapping is blocked until it's reviewed."));
      break;
    }
  }
  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}

// ---- Cliente de la API de SODAX -------------------------------------------------------------------------------------

/**
 * @typedef {{ intentId: string, creator: string, inputToken: string, outputToken: string, inputAmount: string,
 *   minOutputAmount: string, deadline: string, allowPartialFill: boolean, srcChain: string, dstChain: string,
 *   srcAddress: string, dstAddress: string, solver: string, data: string }} SodaxIntent
 * @typedef {{ tx: { from?: string, to: string, value?: string, data: string }, intent: SodaxIntent, relayData: any }} SodaxBuild
 * @typedef {{ status: string, failureReason?: string, userMessage?: string, intentCancelled?: boolean, result?: { dstIntentTxHash?: string, fillTxHash?: string } }} SodaxStatus
 */

/** Respuesta de la API que no es lo que debería. */
export class SodaxError extends Error {
  /** @param {string} message @param {string} code @param {number} [status] */
  constructor(message, code, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** @param {unknown} v */
const isDec = (v) => typeof v === "string" && /^\d{1,78}$/.test(v);
/** @param {unknown} v */
const isHex = (v) => typeof v === "string" && /^0x([0-9a-fA-F]{2})*$/.test(v);
/** @param {unknown} v */
const isAddr = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

/**
 * Cliente mínimo de la API de swaps de SODAX (sin dependencias). Cada respuesta se valida antes de usarla.
 * @param {{ fetch?: typeof fetch, base?: string, journalBase?: string, timeoutMs?: number }} [opts]
 */
export function sodaxApi({ fetch: f = fetch, base = SODAX.api, journalBase = SODAX.journal, timeoutMs = 20_000 } = {}) {
  /** @param {string} path @param {any} [body] @param {string} [root] */
  const call = async (path, body, root = base) => {
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    try {
      const res = await f(`${root}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? { accept: "application/json" } : { "content-type": "application/json", accept: "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(ctl ? { signal: ctl.signal } : {}),
      });
      const text = await res.text();
      /** @type {any} */
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      if (res.status === 429) throw new SodaxError(tr("SODAX está saturado ahora mismo. Prueba en un minuto.", "SODAX is busy right now. Try again in a minute."), "RATE_LIMITED", 429);
      if (!res.ok) {
        const msg = String(json?.message ?? json?.error ?? text ?? "").slice(0, 200);
        throw new SodaxError(msg || `SODAX ${res.status}`, "HTTP", res.status);
      }
      return json;
    } catch (e) {
      if (e instanceof SodaxError) throw e;
      throw new SodaxError(tr("No se ha podido hablar con SODAX. Mira la conexión y prueba otra vez.", "Couldn't reach SODAX. Check your connection and try again."), "NETWORK");
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  /** Algunas rutas envuelven la respuesta en { success, data }. @param {any} j */
  const unwrap = (j) => (j && typeof j === "object" && "data" in j && j.data && typeof j.data === "object" && !("tx" in j) && !("quotedAmount" in j) ? j.data : j);

  return {
    /** Tokens de SODAX en Hedera. @returns {Promise<{ symbol: string, address: string, decimals: number, hubAsset: string, vault: string }[]>} */
    async tokens() {
      const j = unwrap(await call(`/tokens/${SODAX.chainKey}`));
      if (!Array.isArray(j)) throw new SodaxError("tokens: formato inesperado", "SHAPE");
      return j
        .filter((t) => t && isAddr(t.address) && Number.isInteger(t.decimals))
        .map((t) => ({ symbol: String(t.symbol), address: String(t.address).toLowerCase(), decimals: Number(t.decimals), hubAsset: String(t.hubAsset ?? "").toLowerCase(), vault: String(t.vault ?? "").toLowerCase() }));
    },
    /**
     * Cotización (exact_input) de Hedera a Hedera.
     * @param {{ tokenSrc: string, tokenDst: string, amount: bigint }} p
     * @returns {Promise<bigint>}
     */
    async quote({ tokenSrc, tokenDst, amount }) {
      const j = unwrap(await call("/quote", { tokenSrc, tokenSrcChainKey: SODAX.chainKey, tokenDst, tokenDstChainKey: SODAX.chainKey, amount: amount.toString(), quoteType: "exact_input" }));
      const q = j?.quotedAmount ?? j?.quoted_amount;
      if (!isDec(q)) throw new SodaxError("quote: formato inesperado", "SHAPE");
      return BigInt(q);
    },
    /**
     * Prepara la intención (no firma ni envía nada).
     * @param {{ inputToken: string, outputToken: string, inputAmount: bigint, minOutputAmount: bigint, deadline: number, srcAddress: string, dstAddress: string }} p
     * @returns {Promise<SodaxBuild>}
     */
    async buildIntent(p) {
      const j = unwrap(
        await call("/intents", {
          srcChainKey: SODAX.chainKey,
          dstChainKey: SODAX.chainKey,
          inputToken: p.inputToken,
          outputToken: p.outputToken,
          inputAmount: p.inputAmount.toString(),
          minOutputAmount: p.minOutputAmount.toString(),
          deadline: String(p.deadline),
          allowPartialFill: false,
          srcAddress: p.srcAddress,
          dstAddress: p.dstAddress,
          solver: ZERO,
          data: "0x",
        }),
      );
      if (!j || typeof j !== "object" || !j.tx || !j.intent || !isAddr(j.tx.to) || !isHex(j.tx.data)) throw new SodaxError("intents: formato inesperado", "SHAPE");
      return /** @type {SodaxBuild} */ (j);
    },
    /**
     * Avisa a SODAX de la transacción ya ejecutada en Hedera.
     * @param {{ txHash: string, walletAddress: string, intent: SodaxIntent, relayData: any }} p
     */
    async submitTx({ txHash, walletAddress, intent, relayData }) {
      const rd = typeof relayData === "string" ? relayData : isHex(relayData?.payload) ? String(relayData.payload) : "0x";
      const j = await call("/submit-tx", { txHash, srcChainKey: SODAX.chainKey, walletAddress, intent, relayData: rd });
      const st = j?.data?.status ?? j?.status;
      if (st !== "inserted" && st !== "duplicate") throw new SodaxError("submit-tx: respuesta inesperada", "SHAPE");
      return st;
    },
    /** @param {string} txHash @returns {Promise<SodaxStatus>} */
    async status(txHash) {
      const j = await call(`/submit-tx/status?txHash=${encodeURIComponent(txHash)}&srcChainKey=${SODAX.chainKey}`);
      const d = j?.data ?? j;
      if (!d || typeof d.status !== "string") throw new SodaxError("status: formato inesperado", "SHAPE");
      return d;
    },
    /**
     * ¿Sigue abierta la orden creada con esta transacción? (GET /intents/{txHash}/fill)
     * @param {string} txHash @returns {Promise<{ exists: boolean, remainingInput: bigint, receivedOutput: bigint, pendingPayment: boolean }>}
     */
    async fill(txHash) {
      const j = unwrap(await call(`/intents/${encodeURIComponent(txHash)}/fill`));
      if (!j || typeof j.exists !== "boolean" || !isDec(String(j.remainingInput ?? "")) || !isDec(String(j.receivedOutput ?? ""))) throw new SodaxError("fill: formato inesperado", "SHAPE");
      return { exists: j.exists, remainingInput: BigInt(j.remainingInput), receivedOutput: BigInt(j.receivedOutput), pendingPayment: j.pendingPayment === true };
    },
    /**
     * Prepara la cancelación de una orden abierta (no firma nada). @param {SodaxIntent} intent
     * @returns {Promise<{ tx: { from?: string, to: string, value?: string, data: string } }>}
     */
    async cancel(intent) {
      const j = unwrap(await call("/intents/cancel", { srcChainKey: SODAX.chainKey, intent }));
      const tx = j?.tx;
      if (!tx || !isAddr(tx.to) || !isHex(tx.data)) throw new SodaxError("cancel: formato inesperado", "SHAPE");
      return { tx };
    },
    /**
     * Diario on-chain de SODAX para una orden (por su intentHash). Responde aunque /fill falle (25-nov-2026, Hedera).
     * 404 = todavía no está en el diario. Vida de una orden: 404 → abierta → completada o cancelada.
     * @param {string} hash @returns {Promise<SodaxJournal>}
     */
    async journal(hash) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash))) throw new SodaxError("journal: hash inválido", "SHAPE");
      /** @type {any} */
      let j;
      try {
        j = await call(`/intent/${hash.toLowerCase()}`, undefined, journalBase);
      } catch (e) {
        if (e instanceof SodaxError && e.status === 404) return { found: false, open: false, cancelled: false, filled: false, events: [] };
        throw e;
      }
      const d = unwrap(j);
      if (!d || typeof d.open !== "boolean" || (d.intentHash != null && String(d.intentHash).toLowerCase() !== hash.toLowerCase())) throw new SodaxError("journal: formato inesperado", "SHAPE");
      /** @type {{ type: string, txHash: string }[]} */
      const events = (Array.isArray(d.events) ? d.events : []).map((/** @type {any} */ e) => ({ type: String(e?.eventType ?? ""), txHash: String(e?.txHash ?? "") }));
      return { found: true, open: d.open, cancelled: events.some((/** @type {{ type: string }} */ e) => /cancel/i.test(e.type)), filled: events.some((/** @type {{ type: string }} */ e) => /fill/i.test(e.type)), events };
    },
  };
}

/** @typedef {{ found: boolean, open: boolean, cancelled: boolean, filled: boolean, events: { type: string, txHash: string }[] }} SodaxJournal */

const INTENT_TUPLE =
  "tuple(uint256 intentId, address creator, address inputToken, address outputToken, uint256 inputAmount, uint256 minOutputAmount, uint256 deadline, bool allowPartialFill, uint256 srcChain, uint256 dstChain, bytes srcAddress, bytes dstAddress, address solver, bytes data)";

/**
 * Identificador de una orden en SODAX: keccak256(abi.encode(intent)). Comprobado con una orden real del 25-nov-2026
 * (0x2379406f…b035). Sirve para seguirla en el diario sin depender de lo que conteste la API.
 * @param {SodaxIntent} intent @returns {string}
 */
export function intentHash(intent) {
  const i = /** @type {any} */ (intent);
  return keccak256(
    coder.encode(
      [INTENT_TUPLE],
      [[BigInt(i.intentId), low(i.creator), low(i.inputToken), low(i.outputToken), BigInt(i.inputAmount), BigInt(i.minOutputAmount), BigInt(i.deadline), i.allowPartialFill === true, BigInt(i.srcChain), BigInt(i.dstChain), low(i.srcAddress), low(i.dstAddress), low(i.solver), i.data ?? "0x"]],
    ),
  ).toLowerCase();
}

/**
 * ¿En qué está una orden? Primero el diario on-chain de SODAX; si no contesta, /fill; si nada contesta, «unknown».
 * open = se puede cancelar · cancelled = cancelada (por ti o, si caducó, por SODAX) · filled = completada ·
 * closed = ya no está abierta (sin saber por qué) · unknown = sin respuesta o aún no está en el diario.
 * Si nadie la completa, SODAX la cancela sola al caducar y devuelve el importe a la dirección de origen
 * (visto en mainnet el 25-nov-2026: 2 min y medio después del plazo).
 * @param {any} api @param {SodaxIntent} intent @param {string} [txHash]
 * @returns {Promise<{ state: "open" | "cancelled" | "filled" | "closed" | "unknown", intentHash: string, expired: boolean }>}
 */
export async function stockOrderState(api, intent, txHash, nowS = nowSeconds()) {
  const ih = intentHash(intent);
  const dl = Number(/** @type {any} */ (intent).deadline ?? 0);
  const expired = dl > 0 && nowS > dl;
  const j = typeof api.journal === "function" ? await api.journal(ih).catch(() => null) : null;
  if (j?.found) return { state: j.cancelled ? "cancelled" : j.filled ? "filled" : j.open ? "open" : "closed", intentHash: ih, expired };
  if (txHash && typeof api.fill === "function") {
    const f = await api.fill(txHash).catch(() => null);
    if (f) return { state: f.exists && f.remainingInput > 0n ? "open" : "closed", intentHash: ih, expired };
  }
  return { state: "unknown", intentHash: ih, expired };
}

// ---- Comprobación de lo que prepara la API ------------------------------------------------------------------------

export const assetManagerAbi = new Interface(["function transfer(address token, bytes to, uint256 amount, bytes data) payable"]);
/** Lo que ejecuta la cartera del hub con lo depositado (comprobado con intenciones reales de SODAX el 25-nov-2026). */
export const hubCallsAbi = ["tuple(address addr, uint256 value, bytes data)[]"];
export const hubApproveAbi = new Interface(["function approve(address spender, uint256 amount) returns (bool)"]);
export const intentsAbi = new Interface([
  "function createIntent((uint256 intentId, address creator, address inputToken, address outputToken, uint256 inputAmount, uint256 minOutputAmount, uint256 deadline, bool allowPartialFill, uint256 srcChain, uint256 dstChain, bytes srcAddress, bytes dstAddress, address solver, bytes data) intent)",
  "function cancelIntent((uint256 intentId, address creator, address inputToken, address outputToken, uint256 inputAmount, uint256 minOutputAmount, uint256 deadline, bool allowPartialFill, uint256 srcChain, uint256 dstChain, bytes srcAddress, bytes dstAddress, address solver, bytes data) intent)",
]);

/** Hash del código del «proxy» de CREATE3 (solmate/solady). */
const CREATE3_PROXY_HASH = keccak256("0x67363d3d37363d34f03d5260086018f3");

/**
 * Cartera del usuario en el hub de SODAX (Sonic): getWallet(chainId, user) de su WalletFactory, con CREATE3 y
 * sal keccak256(abi.encodePacked(factory, chainId, user)) (docs.sodax.com → Hub Wallet Abstraction). Comprobado con lo
 * que prepara SODAX para Hedera (chainId 18501).
 * @param {bigint | number} chainId identificador de Hedera en SODAX @param {string} user dirección EVM (20 bytes)
 * @param {string} [factory]
 */
export function hubWalletAddress(chainId, user, factory = SODAX.walletFactory) {
  const salt = keccak256(solidityPacked(["address", "uint256", "bytes"], [getAddress(factory), BigInt(chainId), user]));
  const proxy = getCreate2Address(getAddress(factory), salt, CREATE3_PROXY_HASH);
  return getAddress(dataSlice(keccak256(concat(["0xd694", proxy, "0x01"])), 12)).toLowerCase();
}

/** @param {unknown} v */
const low = (v) => String(v ?? "").toLowerCase();

/** Activo del hub que corresponde a un token de Hedera (pago o acción de la lista); "" si no es de los nuestros. @param {string} address */
export function hubAssetOf(address) {
  const a = low(address);
  const pay = Object.values(STOCK_PAY).find((p) => p.address === a);
  if (pay) return pay.hub;
  const st = STOCK_TOKENS.find((t) => stockAddress(t.id) === a);
  return st ? st.hub : "";
}

/**
 * Todo lo que se puede leer de la transacción preparada, para comprobarlo (y para el informe de scripts/acciones.mjs).
 * @param {SodaxBuild} built
 */
export function inspectIntentBuild(built) {
  /** @type {any} */
  const out = { to: low(built?.tx?.to), from: low(built?.tx?.from), value: String(built?.tx?.value ?? "0"), selector: String(built?.tx?.data ?? "").slice(0, 10), transfer: null, hookCalls: null, hookBytes20: [], approve: null, intent: null };
  try {
    const p = assetManagerAbi.parseTransaction({ data: built.tx.data });
    if (p && p.name === "transfer") {
      out.transfer = { token: low(p.args[0]), to: low(p.args[1]), amount: BigInt(p.args[2]), data: String(p.args[3]) };
    }
  } catch {
    out.transfer = null;
  }
  if (!out.transfer) return out;
  try {
    const [calls] = coder.decode(hubCallsAbi, out.transfer.data);
    out.hookCalls = calls.map((/** @type {any} */ c) => ({ addr: low(c[0]), value: BigInt(c[1]), selector: String(c[2]).slice(0, 10), data: String(c[2]) }));
  } catch {
    out.hookCalls = null;
  }
  out.hookBytes20 = bytes20Fields(out.transfer.data);
  const calls = out.hookCalls ?? [];
  try {
    const a = calls[0] ? hubApproveAbi.parseTransaction({ data: calls[0].data }) : null;
    if (a && a.name === "approve") out.approve = { token: calls[0].addr, spender: low(a.args[0]), amount: BigInt(a.args[1]) };
  } catch {
    out.approve = null;
  }
  try {
    const c = calls[1] ? intentsAbi.parseTransaction({ data: calls[1].data }) : null;
    if (c && c.name === "createIntent") {
      const i = c.args[0];
      out.intent = {
        target: calls[1].addr,
        intentId: BigInt(i[0]),
        creator: low(i[1]),
        inputToken: low(i[2]),
        outputToken: low(i[3]),
        inputAmount: BigInt(i[4]),
        minOutputAmount: BigInt(i[5]),
        deadline: BigInt(i[6]),
        allowPartialFill: Boolean(i[7]),
        srcChain: BigInt(i[8]),
        dstChain: BigInt(i[9]),
        srcAddress: low(i[10]),
        dstAddress: low(i[11]),
        solver: low(i[12]),
        data: low(i[13]),
      };
    }
  } catch {
    out.intent = null;
  }
  return out;
}

/**
 * Campos `bytes` de 20 bytes (direcciones de Hedera dentro de la intención) en un bloque ABI: palabra de longitud 20
 * seguida de 20 bytes y 12 ceros de relleno. Se buscan también dentro de los `bytes` anidados.
 * @param {string} hex
 * @returns {string[]}
 */
export function bytes20Fields(hex) {
  const h = String(hex ?? "").replace(/^0x/, "").toLowerCase();
  /** @type {Set<string>} */
  const found = new Set();
  const LEN20 = "0000000000000000000000000000000000000000000000000000000000000014";
  for (let i = 0; i + 128 <= h.length; i += 2) {
    if (h.slice(i, i + 64) !== LEN20) continue;
    const body = h.slice(i + 64, i + 128);
    if (/^[0-9a-f]{40}0{24}$/.test(body)) found.add(`0x${body.slice(0, 40)}`);
  }
  return [...found];
}

/**
 * Antes de firmar: ¿lo que ha preparado SODAX es exactamente lo que el usuario pidió? Se decodifica entero (la llamada
 * al SpokeAssetManager y lo que hará la cartera del hub con lo depositado) y se compara campo a campo. Con un solo
 * problema, no se firma.
 * @param {SodaxBuild} built
 * @param {{ payToken: string, outputToken: string, inputAmount: bigint, minOutputAmount: bigint, srcAddress: string,
 *   dstAddress: string, hbarIn: boolean, now?: number }} expect  payToken/outputToken: direcciones en Hedera
 * @returns {{ ok: boolean, problems: string[], valueTinybars: bigint }}
 */
export function verifyIntentBuild(built, expect) {
  /** @type {string[]} */
  const problems = [];
  const now = expect.now ?? nowSeconds();
  const src = low(expect.srcAddress);
  const dst = low(expect.dstAddress);
  const hubIn = hubAssetOf(expect.payToken);
  const hubOut = hubAssetOf(expect.outputToken);
  const myHub = /^0x[0-9a-f]{40}$/.test(src) ? hubWalletAddress(SODAX.hederaChainId, src) : "";
  const x = inspectIntentBuild(built);
  const it = built?.intent ?? /** @type {any} */ ({});
  const inWindow = (/** @type {bigint} */ d) => d > BigInt(now) && d <= BigInt(now + 30 * 60);

  if (!hubIn || !hubOut) problems.push("tokens: no son los de la lista");
  // 1. La transacción: transfer() al SpokeAssetManager de SODAX, con lo pagado y hacia tu cartera del hub.
  if (x.to !== SODAX.assetManager) problems.push("contrato: no es el SpokeAssetManager de SODAX");
  if (x.from && x.from !== src) problems.push("remitente: no es tu Cartera");
  if (!x.transfer) problems.push("llamada: no es transfer() del SpokeAssetManager");
  else {
    if (x.transfer.token !== low(expect.payToken)) problems.push("token pagado: no es el elegido");
    if (x.transfer.amount !== expect.inputAmount) problems.push("importe: no es el que has puesto");
    if (x.transfer.to !== myHub) problems.push("destino en el hub: no es tu cartera de SODAX");
    // 2. En el hub, exactamente dos pasos: permiso a Intents por lo depositado y crear la intención.
    if (!x.hookCalls || x.hookCalls.length !== 2) problems.push("hub: no son los dos pasos de siempre");
    else {
      const [c0, c1] = x.hookCalls;
      if (c0.value !== 0n || c1.value !== 0n) problems.push("hub: un paso lleva valor");
      if (!x.approve || x.approve.token !== hubIn || x.approve.spender !== low(SODAX.intents) || x.approve.amount !== expect.inputAmount) problems.push("hub: el permiso no es el de la intención");
      const i = x.intent;
      if (!i || i.target !== low(SODAX.intents)) problems.push("hub: no crea la intención en Intents");
      else {
        if (i.creator !== myHub) problems.push("intención: el creador no es tu cartera de SODAX");
        if (i.inputToken !== hubIn) problems.push("intención: entrada distinta");
        if (i.outputToken !== hubOut) problems.push("intención: no compra lo elegido");
        if (i.inputAmount !== expect.inputAmount) problems.push("intención: importe distinto");
        if (i.minOutputAmount < expect.minOutputAmount) problems.push("intención: mínimo por debajo del acordado");
        if (!inWindow(i.deadline)) problems.push("intención: plazo fuera de lo normal");
        if (i.allowPartialFill) problems.push("intención: admite entregas parciales");
        if (i.srcChain !== SODAX.hederaChainId || i.dstChain !== SODAX.hederaChainId) problems.push("intención: no es de Hedera a Hedera");
        if (i.srcAddress !== src) problems.push("intención: origen distinto");
        if (i.dstAddress !== dst) problems.push("intención: destino distinto");
        if (i.solver !== ZERO) problems.push("intención: lleva un solver fijo");
        if (i.data !== "0x") problems.push("intención: lleva datos extra");
        // Lo que cuenta la API tiene que ser lo mismo que va firmado.
        const same =
          isDec(it.intentId) && BigInt(it.intentId) === i.intentId &&
          isDec(it.inputAmount) && BigInt(it.inputAmount) === i.inputAmount &&
          isDec(it.minOutputAmount) && BigInt(it.minOutputAmount) === i.minOutputAmount &&
          isDec(it.deadline) && BigInt(it.deadline) === i.deadline &&
          low(it.creator) === i.creator && low(it.inputToken) === i.inputToken && low(it.outputToken) === i.outputToken &&
          low(it.srcAddress) === i.srcAddress && low(it.dstAddress) === i.dstAddress && low(it.solver) === i.solver &&
          it.allowPartialFill === i.allowPartialFill && String(it.srcChain) === i.srcChain.toString() && String(it.dstChain) === i.dstChain.toString() &&
          low(it.data || "0x") === i.data;
        if (!same) problems.push("intención: lo que cuenta SODAX no es lo que va firmado");
      }
    }
    // Y nada más: dentro solo pueden aparecer tus direcciones.
    if (x.hookBytes20.some((/** @type {string} */ a) => a !== src && a !== dst)) problems.push("intención: lleva otra dirección de Hedera que no es tuya");
  }

  // Importe en HBAR: se calcula aquí (tinybars). La API lo da en weibars (×10¹⁰), como para el relay JSON-RPC.
  const v = /^\d{1,78}$/.test(x.value) ? BigInt(x.value) : -1n;
  let valueTinybars = 0n;
  if (expect.hbarIn) {
    if (v !== expect.inputAmount * 10_000_000_000n) problems.push("HBAR enviado: no es el importe");
    valueTinybars = expect.inputAmount;
  } else if (v !== 0n) problems.push("HBAR enviado: esta operación no debería llevar HBAR");
  return { ok: problems.length === 0, problems: [...new Set(problems)], valueTinybars };
}

/**
 * Antes de firmar una cancelación: tiene que ser un mensaje al SpokeAssetManager que no mueve nada (importe 0 y sin
 * HBAR), hacia tu cartera del hub, que solo cancela ESTA orden (cancelIntent con la misma intención, campo a campo).
 * Formato supuesto a partir del de createIntent: si SODAX la prepara de otra forma, no se firma y se revisa.
 * @param {{ tx: { from?: string, to: string, value?: string, data: string } }} built
 * @param {{ intent: SodaxIntent, srcAddress: string }} expect
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function verifyCancelBuild(built, expect) {
  /** @type {string[]} */
  const problems = [];
  const src = low(expect.srcAddress);
  const myHub = /^0x[0-9a-f]{40}$/.test(src) ? hubWalletAddress(SODAX.hederaChainId, src) : "";
  const it = expect.intent;
  if (low(built?.tx?.to) !== SODAX.assetManager) problems.push("contrato: no es el SpokeAssetManager de SODAX");
  if (built?.tx?.from && low(built.tx.from) !== src) problems.push("remitente: no es tu Cartera");
  if (String(built?.tx?.value ?? "0") !== "0") problems.push("una cancelación no lleva HBAR");
  /** @type {any} */
  let t = null;
  try {
    const p = assetManagerAbi.parseTransaction({ data: built.tx.data });
    if (p && p.name === "transfer") t = { amount: BigInt(p.args[2]), to: low(p.args[1]), data: String(p.args[3]) };
  } catch {
    t = null;
  }
  if (!t) problems.push("llamada: no es un mensaje del SpokeAssetManager");
  else {
    if (t.amount !== 0n) problems.push("una cancelación no mueve fondos");
    if (t.to !== myHub) problems.push("destino en el hub: no es tu cartera de SODAX");
    /** @type {any[]} */
    let calls = [];
    try {
      [calls] = coder.decode(hubCallsAbi, t.data);
    } catch {
      calls = [];
    }
    if (calls.length !== 1) problems.push("hub: no es un solo paso");
    else {
      const c = calls[0];
      /** @type {any} */
      let d = null;
      try {
        d = intentsAbi.parseTransaction({ data: String(c[2]) });
      } catch {
        d = null;
      }
      if (low(c[0]) !== low(SODAX.intents) || BigInt(c[1]) !== 0n || !d || d.name !== "cancelIntent") problems.push("hub: no es cancelIntent en Intents");
      else {
        const i = d.args[0];
        const same =
          BigInt(i[0]) === BigInt(it.intentId) && low(i[1]) === low(it.creator) && low(i[2]) === low(it.inputToken) && low(i[3]) === low(it.outputToken) &&
          BigInt(i[4]) === BigInt(it.inputAmount) && BigInt(i[5]) === BigInt(it.minOutputAmount) && BigInt(i[6]) === BigInt(it.deadline) &&
          Boolean(i[7]) === it.allowPartialFill && BigInt(i[8]).toString() === String(it.srcChain) && BigInt(i[9]).toString() === String(it.dstChain) &&
          low(i[10]) === low(it.srcAddress) && low(i[11]) === low(it.dstAddress) && low(i[12]) === low(it.solver) && low(i[13]) === low(it.data || "0x");
        if (!same) problems.push("cancela otra orden, no la tuya");
        if (low(i[1]) !== myHub) problems.push("la orden no es de tu cartera de SODAX");
      }
    }
  }
  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}

// ---- Firma y envío --------------------------------------------------------------------------------------------------

/**
 * Firma una transacción EVM (tipo 2, chainId 295) con la llave ECDSA de la Cartera. Lo que firma el relay JSON-RPC de
 * Hedera, pero enviado con el SDK (EthereumTransaction) y pagado por la propia Cartera.
 * @param {{ key: import("@hiero-ledger/sdk").PrivateKey, nonce: number, to: string, data: string, valueTinybars: bigint, gasLimit: number, gasPriceTinybars: bigint }} p
 * @returns {Promise<{ raw: string, hash: string, from: string }>}
 */
export async function signStockTx({ key, nonce, to, data, valueTinybars, gasLimit, gasPriceTinybars }) {
  if (String(/** @type {any} */ (key).type ?? "").toLowerCase() !== "secp256k1") throw new WalletError(tr("Esta Cartera no tiene llave ECDSA: no puede usar SODAX.", "This Wallet has no ECDSA key: it can't use SODAX."), "STOCKS_NEED_ECDSA");
  const wallet = new Wallet(hexlify(key.toBytesRaw()));
  const fee = (gasPriceTinybars * 125n * 10_000_000_000n) / 100n;
  const raw = await wallet.signTransaction({
    type: 2,
    chainId: SODAX.evmChainId,
    nonce,
    to: getAddress(to),
    data,
    value: valueTinybars * 10_000_000_000n,
    gasLimit: BigInt(gasLimit),
    maxFeePerGas: fee,
    maxPriorityFeePerGas: 0n,
  });
  return { raw, hash: keccak256(raw), from: wallet.address.toLowerCase() };
}

/**
 * @typedef {"check" | "associate" | "quote" | "prepare" | "approve" | "sign" | "relay" | "settle" | "deliver" | "done"} StockStep
 * @typedef {{ side: "buy" | "sell", stock: StockEntry, pay: "HBAR" | "USDC" }} StockTrade
 *   buy: pay → stock · sell: stock → pay
 */

/** @param {number} ms */
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Compra o venta de una acción desde la Cartera, paso a paso. Nada se firma si alguna comprobación falla:
 *   1. solo mainnet, con lo aceptado por el usuario, Cartera ECDSA y la acción comprobada en la red;
 *   2. destino: la Cartera o la bóveda (tiene que poder recibirlo sola). La Cartera se asocia el token, si hace falta,
 *      solo cuando todo lo demás ha cuadrado (paso 4b): si el precio se mueve o la intención no cuadra, no se gasta nada;
 *   3. cotización nueva: si no llega al mínimo que aceptó el usuario, para;
 *   4. SODAX prepara la intención y la app la comprueba entera (verifyIntentBuild);
 *   5. al pagar con un token: permiso exacto al SpokeAssetManager (se quita si algo falla después);
 *   6. simulación en el mirror: si revierte, no se firma;
 *   7. firma EVM y envío; aviso a SODAX y espera a que un solver lo complete.
 * @param {{
 *   client: import("@hiero-ledger/sdk").Client, key: import("@hiero-ledger/sdk").PrivateKey, accountId: AccountId,
 *   network: string, mirror: any, api: ReturnType<typeof sodaxApi>, trade: StockTrade, amountIn: bigint,
 *   agreedOut: bigint, slippageBps: number, eligibility: Parameters<typeof stockEligibility>[0],
 *   recipientId?: string | null, submitTx?: typeof submit,
 *   sleep?: (ms: number) => Promise<void>, onStep?: (s: StockStep) => void, now?: () => number,
 * }} p
 * @returns {Promise<{ txHash: string, txId: string, status: string, recipientId: string, minOut: bigint, received: bigint | null, delivered: boolean }>}
 *   status: "solved" (SODAX lo completó) o "pending" (todavía no) · delivered: ya se ve en el destino · received: lo que
 *   ha subido el saldo del destino
 */
export async function stockSwapFromPocket({ client, key, accountId, network, mirror, api, trade, amountIn, agreedOut, slippageBps, eligibility, recipientId = null, submitTx = submit, sleep = realSleep, onStep = () => {}, now = Date.now }) {
  const step = (/** @type {StockStep} */ s) => {
    try {
      onStep(s);
    } catch {
      /* la pantalla no puede parar el cambio */
    }
  };
  step("check");
  if (network !== SODAX.network) throw new WalletError(tr("Las acciones solo están en mainnet.", "Stocks are only on mainnet."), "STOCKS_MAINNET_ONLY");
  if (!stockEligibility(eligibility).ok) throw new WalletError(tr("Antes tienes que aceptar las condiciones de las acciones.", "You must accept the stock conditions first."), "STOCKS_NOT_ELIGIBLE");
  if (!(amountIn > 0n)) throw new WalletError(tr("Pon una cantidad.", "Enter an amount."), "BAD_AMOUNT");
  const entry = stockById(trade.stock.id);
  if (!entry) throw new WalletError(tr("Esa acción no está en la lista revisada.", "That stock isn't on the reviewed list."), "STOCK_NOT_LISTED");
  const pay = STOCK_PAY[trade.pay];
  if (!pay) throw new WalletError(tr("Solo se paga con HBAR o USDC.", "You can only pay with HBAR or USDC."), "BAD_PAY");
  const info = await mirror.tokenInfo(entry.id, { fresh: true }).catch(() => null);
  const check = checkStockToken(entry, info);
  if (!check.ok) throw new WalletError(check.problems[0], "STOCK_CHECK");

  const owner = accountId.toString();
  const me = await mirror.account(owner).catch(() => null);
  const src = low(me?.evmAddress);
  if (!/^0x[0-9a-f]{40}$/.test(src) || src === stockAddress(owner)) throw new WalletError(tr("Esta Cartera no tiene dirección EVM propia: no puede usar SODAX.", "This Wallet has no EVM address of its own: it can't use SODAX."), "STOCKS_NEED_ECDSA");
  if (low(key.publicKey.toEvmAddress()).replace(/^(?!0x)/, "0x") !== src) throw new WalletError(tr("La llave no es la de esta Cartera.", "The key isn't this Wallet's."), "STOCKS_KEY_MISMATCH");

  const elsewhere = recipientId != null && recipientId !== owner;
  if (elsewhere && !/^0\.0\.\d+$/.test(String(recipientId))) throw new WalletError(tr("Cuenta de destino no válida.", "Invalid destination account."));
  const destId = elsewhere ? String(recipientId) : owner;
  const dst = elsewhere ? stockAddress(destId) : src;
  const inputToken = trade.side === "buy" ? pay.address : stockAddress(entry.id);
  const outputToken = trade.side === "buy" ? stockAddress(entry.id) : pay.address;
  /** Token HTS que recibe el destino (null: HBAR). */
  const receivedTokenId = trade.side === "buy" ? entry.id : pay.tokenId;

  // 2. Destino (solo se mira: la asociación, si hace falta, va justo antes de firmar).
  let needsAssociation = false;
  if (receivedTokenId) {
    const held = await mirror.accountTokens(destId).catch(() => /** @type {{ tokenId: string }[]} */ ([]));
    const has = held.some((/** @type {{ tokenId: string }} */ t) => t.tokenId === receivedTokenId);
    if (elsewhere) {
      const acc = await mirror.account(destId).catch(() => null);
      if (acc?.maxAutoAssociations !== -1 && !has) {
        throw new WalletError(
          tr("Tu bóveda no puede recibir esta acción directamente (no la tiene asociada). Recíbela en la Cartera y guárdala después en la bóveda.", "Your vault can't receive this stock directly (it isn't associated). Receive it in the Wallet and store it in the vault afterwards."),
          "DESTINATION_NOT_ASSOCIATED",
        );
      }
    } else needsAssociation = !has;
  }

  // 3. Cotización nueva.
  step("quote");
  const minOut = (agreedOut * BigInt(10_000 - Math.max(0, Math.min(5_000, Math.trunc(slippageBps))))) / 10_000n;
  if (!(minOut > 0n)) throw new WalletError(tr("La cantidad es demasiado pequeña.", "The amount is too small."), "BAD_AMOUNT");
  const fresh = await api.quote({ tokenSrc: inputToken, tokenDst: outputToken, amount: amountIn });
  if (fresh < minOut) throw new WalletError(tr("El precio ha cambiado más que tu tolerancia. Revisa la nueva cotización y vuelve a intentarlo.", "The price moved more than your tolerance. Check the new quote and try again."), "PRICE_MOVED");

  // 4. Intención preparada por SODAX, comprobada entera.
  step("prepare");
  const deadline = Math.floor(now() / 1000) + STOCK_DEADLINE_S;
  const built = await api.buildIntent({ inputToken, outputToken, inputAmount: amountIn, minOutputAmount: minOut, deadline, srcAddress: src, dstAddress: dst });
  const v = verifyIntentBuild(built, { payToken: inputToken, outputToken, inputAmount: amountIn, minOutputAmount: minOut, srcAddress: src, dstAddress: dst, hbarIn: inputToken === ZERO, now: Math.floor(now() / 1000) });
  if (!v.ok) throw new WalletError(tr(`Lo que ha preparado SODAX no coincide con lo que pediste (${v.problems[0]}). No se ha firmado nada.`, `What SODAX prepared doesn't match your request (${v.problems[0]}). Nothing was signed.`), "INTENT_MISMATCH");

  // 4b. Ahora sí: la Cartera se asocia la acción (o el USDC) que va a recibir. Antes no se gasta nada.
  if (needsAssociation && receivedTokenId) {
    step("associate");
    const assoc = new TokenAssociateTransaction().setAccountId(accountId).setTokenIds([TokenId.fromString(receivedTokenId)]);
    const out = await submitTx(client, assoc);
    if (!out.ok && out.status !== "TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT") throw new WalletError(tr(`No se pudo añadir el token a la Cartera: ${out.status}`, `Could not add the token to the Wallet: ${out.status}`), out.status, out.txId);
  }

  // La API escribe parte de los datos con mayúsculas (direcciones con suma EIP-55): se firma y simula en minúsculas.
  const callData = built.tx.data.toLowerCase();

  // 5. Permiso exacto al pagar con un token.
  const approveTokenId = inputToken === ZERO ? null : trade.side === "buy" ? pay.tokenId : entry.id;
  const assetManagerId = AccountId.fromString(SODAX.assetManagerId);
  const revoke = async () => {
    if (!approveTokenId) return;
    const zero = new AccountAllowanceApproveTransaction().approveTokenAllowance(TokenId.fromString(approveTokenId), accountId, assetManagerId, 0);
    await submitTx(client, zero).catch(() => undefined);
  };
  if (approveTokenId) {
    step("approve");
    const tx = new AccountAllowanceApproveTransaction().approveTokenAllowance(TokenId.fromString(approveTokenId), accountId, assetManagerId, Long.fromString(amountIn.toString()));
    const out = await submitTx(client, tx);
    if (!out.ok) throw new WalletError(tr(`No se pudo dar el permiso a SODAX: ${out.status}`, `Could not give SODAX permission: ${out.status}`), out.status, out.txId);
  }

  // 6. Simulación (si revierte, no se firma) y gas.
  let gas = 0;
  for (let i = 0; i < 4 && !gas; i++) {
    // El mirror público rechaza (429) a veces las simulaciones que reservan mucho gas: se repite con menos.
    const r = await mirror.simulate({ from: src, to: SODAX.assetManager, data: callData, value: v.valueTinybars, estimate: true, gas: i === 0 ? STOCK_GAS_MAX : 1_000_000 });
    if (r.ok) {
      const g = Number(BigInt(r.result || "0x0"));
      gas = Math.min(Math.max(Math.ceil(g * 1.25), STOCK_GAS_MIN), STOCK_GAS_MAX);
    } else if (i < 3 && (approveTokenId || r.status === 429)) {
      await sleep(4000); // el mirror tarda unos segundos en ver un permiso recién dado
    } else {
      await revoke();
      throw new WalletError(tr("La simulación falla: no se ha firmado nada.", "The simulation fails: nothing was signed."), "SIMULATION_REVERT");
    }
  }
  if (!gas) {
    await revoke();
    throw new WalletError(tr("La simulación falla: no se ha firmado nada.", "The simulation fails: nothing was signed."), "SIMULATION_REVERT");
  }

  // Saldo del destino antes de firmar, para ver después lo que llega.
  /** @returns {Promise<bigint>} */
  const balanceAt = async () => {
    if (receivedTokenId) {
      const held = await mirror.accountTokens(destId).catch(() => []);
      const row = held.find((/** @type {{ tokenId: string, balance?: bigint }} */ t) => t.tokenId === receivedTokenId);
      return row && typeof row.balance === "bigint" ? row.balance : 0n;
    }
    const a = await mirror.account(destId).catch(() => null);
    return typeof a?.balance === "bigint" ? a.balance : 0n;
  };
  const before = await balanceAt();

  // 7. Firma, envío y aviso a SODAX.
  step("sign");
  const gasPrice = (await mirror.contractGasPrice().catch(() => null)) ?? 154n;
  /** @type {{ raw: string, hash: string, from: string }} */
  let signed = { raw: "", hash: "", from: "" };
  /** @type {Awaited<ReturnType<typeof submit>>} */
  let out = { ok: false, status: "", txId: "", receipt: null, response: null };
  // El nonce EVM lo da el mirror; si va unos segundos atrasado (WRONG_NONCE), se vuelve a leer y a firmar una vez.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await sleep(5000);
    const fresher = await mirror.account(owner).catch(() => null);
    signed = await signStockTx({ key, nonce: Number(fresher?.ethereumNonce ?? 0), to: SODAX.assetManager, data: callData, valueTinybars: v.valueTinybars, gasLimit: gas, gasPriceTinybars: gasPrice });
    if (signed.from !== src) throw new WalletError(tr("La llave no es la de esta Cartera.", "The key isn't this Wallet's."), "STOCKS_KEY_MISMATCH");
    const rawBytes = getBytes(signed.raw);
    if (rawBytes.length > STOCK_MAX_RAW_BYTES) {
      await revoke();
      throw new WalletError(tr("La operación es demasiado grande para enviarla.", "The operation is too large to send."), "TOO_LARGE");
    }
    const eth = new EthereumTransaction().setEthereumData(rawBytes).setMaxGasAllowanceHbar(new Hbar(0)).setMaxTransactionFee(new Hbar(STOCK_MAX_FEE_HBAR));
    out = await submitTx(client, eth);
    if (out.ok || out.status !== "WRONG_NONCE") break;
  }
  if (!out.ok) {
    await revoke();
    throw new WalletError(tr(`La operación no ha salido (${out.status}). Solo se cobra la comisión de red.`, `The operation failed (${out.status}). Only the network fee is charged.`), out.status, out.txId);
  }
  step("relay");
  for (let i = 0; i < 3; i++) {
    try {
      await api.submitTx({ txHash: signed.hash, walletAddress: src, intent: built.intent, relayData: built.relayData });
      break;
    } catch (e) {
      if (i === 2) break; // SODAX también lo ve en la red: se sigue esperando el estado
      await sleep(3000);
    }
  }

  // 8. Espera a que un solver lo complete.
  step("settle");
  const t0 = now();
  /** @type {SodaxStatus | null} */
  let st = null;
  while (now() - t0 < STOCK_SETTLE_TIMEOUT_MS) {
    await sleep(3000);
    st = await api.status(signed.hash).catch(() => null);
    if (st && (st.status === "solved" || st.status === "failed")) break;
  }
  if (st?.status === "failed") {
    throw new WalletError(
      tr(`SODAX no ha completado el cambio${st.userMessage ? `: ${st.userMessage}` : ""}. Mira tu saldo en un rato.`, `SODAX didn't complete the swap${st.userMessage ? `: ${st.userMessage}` : ""}. Check your balance in a while.`),
      "SODAX_FAILED",
      out.txId,
    );
  }
  // 9. Hasta que se ve en el destino (o se acaba el tiempo: entonces llegará después).
  /** @type {bigint | null} */
  let received = null;
  let delivered = false;
  if (st?.status === "solved") {
    step("deliver");
    // Cobrando en HBAR en la propia Cartera, el gas de la transacción ya ha salido de ese mismo saldo.
    const slack = !receivedTokenId && !elsewhere ? BigInt(STOCK_MAX_FEE_HBAR) * 100_000_000n : 0n;
    const t1 = now();
    for (;;) {
      const after = await balanceAt();
      const delta = after - before;
      received = delta;
      delivered = delta + slack >= minOut;
      if (delivered || now() - t1 >= STOCK_DELIVERY_TIMEOUT_MS) break;
      await sleep(5000);
    }
  }
  step("done");
  return { txHash: signed.hash, txId: out.txId, status: st?.status ?? "pending", recipientId: destId, minOut, received, delivered };
}

/**
 * Simula, firma y envía una transacción EVM de la Cartera al SpokeAssetManager (ya comprobada por quien llama).
 * Lo mismo que hace stockSwapFromPocket en sus pasos 6 y 7, para la cancelación.
 * @param {{ client: import("@hiero-ledger/sdk").Client, key: import("@hiero-ledger/sdk").PrivateKey, owner: string, src: string,
 *   mirror: any, callData: string, valueTinybars: bigint, submitTx?: typeof submit, sleep?: (ms: number) => Promise<void> }} p
 * @returns {Promise<{ hash: string, txId: string }>}
 */
export async function sendStockEvmTx({ client, key, owner, src, mirror, callData, valueTinybars, submitTx = submit, sleep = realSleep }) {
  let gas = 0;
  for (let i = 0; i < 4 && !gas; i++) {
    const r = await mirror.simulate({ from: src, to: SODAX.assetManager, data: callData, value: valueTinybars, estimate: true, gas: i === 0 ? STOCK_GAS_MAX : 1_000_000 });
    if (r.ok) gas = Math.min(Math.max(Math.ceil(Number(BigInt(r.result || "0x0")) * 1.25), STOCK_GAS_MIN), STOCK_GAS_MAX);
    else if (i < 3 && r.status === 429) await sleep(4000);
    else break;
  }
  if (!gas) throw new WalletError(tr("La simulación falla: no se ha firmado nada.", "The simulation fails: nothing was signed."), "SIMULATION_REVERT");
  const gasPrice = (await mirror.contractGasPrice().catch(() => null)) ?? 154n;
  /** @type {Awaited<ReturnType<typeof submit>>} */
  let out = { ok: false, status: "", txId: "", receipt: null, response: null };
  let hash = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await sleep(5000);
    const acc = await mirror.account(owner).catch(() => null);
    const signed = await signStockTx({ key, nonce: Number(acc?.ethereumNonce ?? 0), to: SODAX.assetManager, data: callData, valueTinybars, gasLimit: gas, gasPriceTinybars: gasPrice });
    if (signed.from !== low(src)) throw new WalletError(tr("La llave no es la de esta Cartera.", "The key isn't this Wallet's."), "STOCKS_KEY_MISMATCH");
    const raw = getBytes(signed.raw);
    if (raw.length > STOCK_MAX_RAW_BYTES) throw new WalletError(tr("La operación es demasiado grande para enviarla.", "The operation is too large to send."), "TOO_LARGE");
    hash = signed.hash;
    out = await submitTx(client, new EthereumTransaction().setEthereumData(raw).setMaxGasAllowanceHbar(new Hbar(0)).setMaxTransactionFee(new Hbar(STOCK_MAX_FEE_HBAR)));
    if (out.ok || out.status !== "WRONG_NONCE") break;
  }
  if (!out.ok) throw new WalletError(tr(`La operación no ha salido (${out.status}). Solo se cobra la comisión de red.`, `The operation failed (${out.status}). Only the network fee is charged.`), out.status, out.txId);
  return { hash, txId: out.txId };
}

/**
 * Cancela una orden de SODAX que sigue abierta (nadie la ha completado). Según SODAX, cancelar es la forma de
 * recuperar lo pagado. Nada se firma si la orden ya no está abierta o si la cancelación que prepara la API no es
 * exactamente la de esta orden (verifyCancelBuild).
 * @param {{ client: import("@hiero-ledger/sdk").Client, key: import("@hiero-ledger/sdk").PrivateKey, accountId: AccountId,
 *   network: string, mirror: any, api: ReturnType<typeof sodaxApi>, intent: SodaxIntent, txHash: string,
 *   submitTx?: typeof submit, sleep?: (ms: number) => Promise<void>, now?: () => number }} p
 *   txHash: la transacción que creó la orden
 * @returns {Promise<{ cancelTxHash: string, txId: string, closed: boolean, relay: string, state: string }>}  closed: SODAX ya no la ve
 *   abierta (o ha completado la cancelación) · relay: estado de la cancelación en SODAX
 */
export async function cancelStockOrder({ client, key, accountId, network, mirror, api, intent, txHash, submitTx = submit, sleep = realSleep, now = Date.now }) {
  if (network !== SODAX.network) throw new WalletError(tr("Las acciones solo están en mainnet.", "Stocks are only on mainnet."), "STOCKS_MAINNET_ONLY");
  const owner = accountId.toString();
  const me = await mirror.account(owner).catch(() => null);
  const src = low(me?.evmAddress);
  if (!/^0x[0-9a-f]{40}$/.test(src)) throw new WalletError(tr("Esta Cartera no tiene dirección EVM propia: no puede usar SODAX.", "This Wallet has no EVM address of its own: it can't use SODAX."), "STOCKS_NEED_ECDSA");
  if (low(intent.srcAddress) !== src) throw new WalletError(tr("Esa orden no es de esta Cartera.", "That order isn't from this Wallet."), "ORDER_NOT_MINE");
  // ¿Sigue abierta? Diario on-chain de SODAX (/fill da error con Hedera desde el 25-nov-2026). Si dice que ya no lo
  // está, no se cancela; si nadie contesta, se sigue: la comprobación de la cancelación ya impide firmar otra cosa.
  const s0 = await stockOrderState(api, intent, txHash, Math.floor(now() / 1000));
  if (s0.state === "cancelled" || s0.state === "filled" || s0.state === "closed") throw new WalletError(tr("Esa orden ya no está abierta: no hay nada que cancelar.", "That order is no longer open: nothing to cancel."), "ORDER_NOT_OPEN");
  const built = await api.cancel(intent);
  const v = verifyCancelBuild(built, { intent, srcAddress: src });
  if (!v.ok) throw new WalletError(tr(`La cancelación que ha preparado SODAX no cuadra (${v.problems[0]}). No se ha firmado nada.`, `The cancellation SODAX prepared doesn't match (${v.problems[0]}). Nothing was signed.`), "CANCEL_MISMATCH");
  const callData = built.tx.data.toLowerCase();
  const sent = await sendStockEvmTx({ client, key, owner, src, mirror, callData, valueTinybars: 0n, submitTx, sleep });
  // Aviso a SODAX (como en la creación): el mensaje de la cancelación es lo que va dentro de transfer().
  const hook = (() => {
    try {
      const p = assetManagerAbi.parseTransaction({ data: callData });
      return p ? String(p.args[3]) : "0x";
    } catch {
      return "0x";
    }
  })();
  if (typeof api.submitTx === "function") await api.submitTx({ txHash: sent.hash, walletAddress: src, intent, relayData: { payload: hook } }).catch(() => undefined);
  const t0 = now();
  let closed = false;
  /** @type {string} */
  let relay = "";
  /** @type {string} */
  let state = s0.state;
  while (!closed && now() - t0 < STOCK_SETTLE_TIMEOUT_MS) {
    await sleep(5000);
    const s = await stockOrderState(api, intent, txHash, Math.floor(now() / 1000));
    const st = typeof api.status === "function" ? await api.status(sent.hash).catch(() => null) : null;
    relay = st?.status ?? relay;
    state = s.state;
    closed = s.state === "cancelled" || s.state === "closed" || s.state === "filled" || relay === "solved";
  }
  return { cancelTxHash: sent.hash, txId: sent.txId, closed, relay, state };
}

/**
 * Rehace la orden (la intención) a partir de la transacción que la creó, leída de la red: para poder cancelarla aunque
 * la app ya no la tenga guardada. Solo vale para transacciones al SpokeAssetManager de SODAX enviadas por `src`.
 * @param {any} mirror @param {string} txHash @param {string} src dirección EVM de la Cartera
 * @returns {Promise<SodaxIntent>}
 */
export async function intentFromCreateTx(mirror, txHash, src) {
  const r = await mirror.evmTx(txHash);
  if (!r) throw new WalletError(tr("No encuentro esa transacción en la red.", "I can't find that transaction on the network."), "TX_NOT_FOUND");
  const toOk = r.to === SODAX.assetManager || r.to === stockAddress(SODAX.assetManagerId);
  if (!toOk) throw new WalletError(tr("Esa transacción no es una orden de SODAX.", "That transaction isn't a SODAX order."), "NOT_SODAX");
  // El mirror puede dar la dirección larga de la cuenta en vez de la EVM: el dueño se comprueba con la intención.
  const x = inspectIntentBuild({ tx: { to: SODAX.assetManager, data: r.input, value: "0" }, intent: /** @type {any} */ ({}), relayData: null });
  const i = x.intent;
  if (!i || i.target !== low(SODAX.intents)) throw new WalletError(tr("No se puede leer la orden de esa transacción.", "Can't read the order from that transaction."), "NOT_SODAX");
  if (i.srcAddress !== low(src)) throw new WalletError(tr("Esa orden no es de esta Cartera.", "That order isn't from this Wallet."), "ORDER_NOT_MINE");
  return {
    intentId: i.intentId.toString(),
    creator: i.creator,
    inputToken: i.inputToken,
    outputToken: i.outputToken,
    inputAmount: i.inputAmount.toString(),
    minOutputAmount: i.minOutputAmount.toString(),
    deadline: i.deadline.toString(),
    allowPartialFill: i.allowPartialFill,
    srcChain: i.srcChain.toString(),
    dstChain: i.dstChain.toString(),
    srcAddress: i.srcAddress,
    dstAddress: i.dstAddress,
    solver: i.solver,
    data: i.data,
  };
}
