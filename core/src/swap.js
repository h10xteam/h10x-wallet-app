// @ts-check
// Swap HBAR ↔ token en SaucerSwap desde la Cartera (mainnet: H10X por defecto; desde 0.10.2, cualquier token de la
// lista revisada de core/src/swaptokens.js, y lo comprado puede ir directo a la bóveda).
//
// Lo mismo que hace la web de H10X para comprar y vender H10X (web/src/trade-tx.js), siguiendo la documentación de
// SaucerSwap (docs.saucerswap.finance → Developers):
//   - Pools: la V1 (x·y=k) sale de su factory (getPair) y las V2 (liquidez concentrada) de la suya (getPool), una por
//     comisión. Siempre contra WHBAR: el HBAR entra y sale envuelto por el propio router.
//   - Cotización: V1 con getAmountsOut del router y V2 con el QuoterV2, las dos con una simulación gratuita en el
//     mirror (eth_call). Se usa la pool que más da. El mirror público rechaza el QuoterV2 (429 «Invalid request»,
//     aunque llegue una sola consulta): entonces la V2 se cotiza con el estado de la pool (core/src/swapv3.js, el
//     mismo cálculo que hace el QuoterV2 por dentro).
//   - Transacción: V2 compra multicall([exactInput(WHBAR→token), refundETH()]) con el HBAR como importe; V2 venta
//     allowance exacta al router y multicall([exactInput(token→WHBAR, destinatario = router), unwrapWHBAR(mínimo,
//     usuario)]); V1 swapExactETHForTokens / swapExactTokensForETH.
// Las direcciones de SaucerSwap van fijas aquí, por red: la app no se fía de otras que lleguen por datos.
import { AccountAllowanceApproveTransaction, AccountId, ContractExecuteTransaction, ContractId, Hbar, Long, TokenAssociateTransaction, TokenId } from "@hiero-ledger/sdk";
import { AbiCoder, Interface, getAddress, solidityPacked } from "ethers";
import { nowSeconds } from "./format.js";
import { tr } from "./i18n.js";
import { submit, WalletError } from "./wallet.js";
import { POOL_READS, decodeSlot0, encodeInt256, quoteExactInputLocal, signedWordAt, wordAt } from "./swapv3.js";

/** Contratos oficiales de SaucerSwap (docs.saucerswap.finance → Developers → Contracts). */
export const SAUCERSWAP = Object.freeze({
  mainnet: Object.freeze({ factoryV1: "0.0.1062784", routerV1: "0.0.3045981", factoryV2: "0.0.3946833", routerV2: "0.0.3949434", quoterV2: "0.0.3949424", whbar: "0.0.1456986" }),
  testnet: Object.freeze({ factoryV1: "0.0.9959", routerV1: "0.0.19264", factoryV2: "0.0.1197038", routerV2: "0.0.1414040", quoterV2: "0.0.1390002", whbar: "0.0.15058" }),
});

/**
 * Token del swap por defecto en cada red. Mainnet: H10X. Testnet: SAUCE, porque H10X no tiene pool con HBAR en la red
 * de pruebas (sus pools usan un WHBAR de prueba); así se prueba el mismo camino con liquidez real de SaucerSwap.
 */
export const SWAP_DEFAULT_TOKEN = Object.freeze({ mainnet: "0.0.10907484", testnet: "0.0.1183558" });
/** H10X en mainnet. */
export const H10X_TOKEN_ID = "0.0.10907484";
/** Comisiones de las pools V2 de SaucerSwap (en millonésimas). */
export const V2_FEES = Object.freeze([500, 1500, 3000, 10000]);
/** Tolerancias que ofrece la app, en puntos básicos (0,5 %, 1 % y 3 %). */
export const SLIPPAGE_CHOICES_BPS = Object.freeze([50, 100, 300]);
/**
 * Pools de SaucerSwap ya conocidas (las devolvieron sus fábricas). Solo se usan si la fábrica no contesta a la
 * búsqueda tras los reintentos: así una pool no desaparece de la app por un fallo puntual del mirror. Si la fábrica
 * contesta, manda lo que diga ella.
 * @type {Readonly<Record<string, Readonly<Record<string, ReadonlyArray<{ venue: "V1", address: string } | { venue: "V2", address: string, fee: number }>>>>>}
 */
export const KNOWN_POOLS = Object.freeze({
  mainnet: Object.freeze({
    "0.0.10907484": Object.freeze([
      Object.freeze({ venue: "V1", address: "0xe22466ad145dc52ca813767d35f62ccf0d5d9a0c" }),
      Object.freeze({ venue: "V2", address: "0x2b594ee52b87616c7f59c83901949e4300c08cf0", fee: 3000 }),
    ]),
  }),
});
/**
 * Gas si el mirror no lo estima. SaucerSwap pone 1.120.000 en su web y un cambio con HBAR gasta unos 900.000.
 * Hedera cobra al menos el 80 % del límite aunque falle, así que no conviene pasarse.
 */
export const SWAP_GAS_FALLBACK = Object.freeze({ V1: 1_200_000, V2: 1_200_000 });
/** Precio del gas en tinybars si el mirror no lo da (mainnet, nov-2026). */
export const SWAP_GAS_PRICE_FALLBACK_TINYBARS = 154n;
/** Lo máximo que cuesta un cambio que falla en la red: el 80 % del gas más un margen para la transacción. */
export const swapFailureCostTinybars = (/** @type {number} */ gas, /** @type {bigint} */ gasPrice = SWAP_GAS_PRICE_FALLBACK_TINYBARS) =>
  (BigInt(Math.ceil(gas)) * 8n * gasPrice) / 10n + 10_000_000n;
export const SWAP_GAS_MIN = 400_000;
export const SWAP_GAS_MAX = 3_000_000;
/**
 * Gas con el que se cotiza en el QuoterV2 (una cotización de un salto gasta unos 200.000). El mirror público rechaza
 * el QuoterV2 con cualquier gas (429 «Invalid request», comprobado el 24-nov-2026 con una sola consulta): allí la V2 se
 * cotiza con el estado de la pool (quoteV2FromPool).
 */
export const QUOTE_GAS = 600_000;
/** Gas con el que se repite una estimación que el mirror rechaza (429) o una cotización que se queda sin gas. */
export const SWAP_GAS_RETRY = 1_200_000;
/** Gas para cada lectura del estado de una pool V2 (vistas sencillas: precio, liquidez, ticks). */
export const POOL_READ_GAS = 150_000;
/** Tiempo durante el que no se vuelve a preguntar al QuoterV2 de un mirror que lo ha rechazado (ms). */
export const QUOTER_REFUSED_MS = 30 * 60_000;
/** @type {WeakMap<object, number>} mirror → hasta cuándo se cotiza la V2 directamente con el estado de la pool */
const quoterRefusedUntil = new WeakMap();
/** ¿Ha rechazado este mirror el QuoterV2 hace poco? @param {object} mirror @param {() => number} [now] */
export const isQuoterRefused = (mirror, now = Date.now) => (quoterRefusedUntil.get(mirror) ?? 0) > now();
/** Apunta que este mirror rechaza el QuoterV2 (durante QUOTER_REFUSED_MS). @param {object} mirror @param {() => number} [now] */
export const markQuoterRefused = (mirror, now = Date.now) => void quoterRefusedUntil.set(mirror, now() + QUOTER_REFUSED_MS);
/**
 * ¿Ha rechazado el mirror la consulta por su límite (429)? `status` lo pone Mirror.simulate; el texto, por si acaso.
 * @param {{ status?: number, error?: string } | null | undefined} r
 */
export const isRateLimited = (r) => r?.status === 429 || /\b429\b|too many requests/i.test(String(r?.error ?? ""));
/** ¿Se ha quedado sin gas la simulación? @param {{ error?: string } | null | undefined} r */
const isOutOfGas = (r) => /INSUFFICIENT_GAS|out of gas/i.test(String(r?.error ?? ""));
/** Plazo de la transacción en el router (segundos). */
export const SWAP_DEADLINE_S = 15 * 60;
/** HBAR que se dejan en la Cartera para comisiones al pulsar «Máx» en una compra. */
export const SWAP_FEE_RESERVE_TINYBARS = 3n * 100_000_000n;
/** Impacto en el precio a partir del cual se avisa y a partir del cual hace falta confirmarlo aparte (en %). */
export const IMPACT_WARN_PCT = 3;
export const IMPACT_CONFIRM_PCT = 10;

const coder = AbiCoder.defaultAbiCoder();
const factoryV1 = new Interface(["function getPair(address tokenA, address tokenB) view returns (address pair)"]);
const factoryV2 = new Interface(["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)"]);
const routerV1Views = new Interface(["function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)"]);
const quoterV2 = new Interface([
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);
export const v2Router = new Interface([
  "function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  "function refundETH() payable",
  "function unwrapWHBAR(uint256 amountMinimum, address recipient) payable",
]);
export const v1Router = new Interface([
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
]);
const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * @typedef {"mainnet" | "testnet"} SwapNetwork
 * @typedef {{ network: SwapNetwork, tokenId: string, factoryV1: string, routerV1: string, factoryV2: string, routerV2: string, quoterV2: string, whbar: string }} SwapSetup
 * @typedef {{ venue: "V1", address: string } | { venue: "V2", address: string, fee: number }} SwapPool
 * @typedef {"buy" | "sell"} SwapSide  buy: HBAR → token · sell: token → HBAR
 * @typedef {{ venue: "V1" | "V2", fee: number, address: string, amountIn: bigint, amountOut: bigint }} SwapQuote  fee en millonésimas (V1: 3000)
 * @typedef {{ simulate: (p: { to?: string, from?: string, data: string, gas?: number, value?: bigint, estimate?: boolean }) => Promise<{ ok: boolean, result: string, error: string }> }} SimulatingMirror
 */

/** ID 0.0.X → dirección long-zero. @param {string} id */
export const longZero = (id) => `0x${BigInt(String(id).split(".")[2]).toString(16).padStart(40, "0")}`;

/**
 * Configuración del swap para una red (null si la red no tiene SaucerSwap o el token no vale).
 * @param {string} network @param {string | null | undefined} [tokenOverride] otro token (0.0.X) en lugar del de por defecto
 * @returns {SwapSetup | null}
 */
export function swapSetup(network, tokenOverride) {
  if (network !== "mainnet" && network !== "testnet") return null;
  const tokenId = tokenOverride && /^0\.0\.\d+$/.test(tokenOverride.trim()) ? tokenOverride.trim() : SWAP_DEFAULT_TOKEN[network];
  if (tokenId === SAUCERSWAP[network].whbar) return null;
  return { network, tokenId, ...SAUCERSWAP[network] };
}

/** Ruta V2 empaquetada: token, comisión (3 bytes), token. @param {string} tokenIn @param {number} fee @param {string} tokenOut */
export const v2Path = (tokenIn, fee, tokenOut) => solidityPacked(["address", "uint24", "address"], [getAddress(tokenIn), fee, getAddress(tokenOut)]);

/** Tokens de entrada y salida (direcciones) según el lado. @param {SwapSetup} setup @param {SwapSide} side */
function legs(setup, side) {
  const w = longZero(setup.whbar);
  const t = longZero(setup.tokenId);
  return side === "buy" ? { tokenIn: w, tokenOut: t } : { tokenIn: t, tokenOut: w };
}

/** Dirección devuelta por una vista (o null si es la dirección 0 o no se puede leer). @param {string} hex */
function addressResult(hex) {
  try {
    const [a] = coder.decode(["address"], hex);
    return a && a !== ZERO ? String(a).toLowerCase() : null;
  } catch {
    return null;
  }
}

/** @param {number} ms */
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Pools de SaucerSwap entre WHBAR y el token: la V1 (si existe) y las V2 de cada comisión.
 * Primero se pregunta todo a la vez; lo que falle (el mirror público corta si llegan muchas peticiones juntas) se
 * repite de una en una con una pausa. Si aun así una fábrica no contesta, se usa la pool conocida de KNOWN_POOLS.
 * @param {SimulatingMirror} mirror @param {SwapSetup} setup
 * @param {{ sleep?: (ms: number) => Promise<void>, tries?: number }} [opts]
 * @returns {Promise<SwapPool[]>}
 */
export async function findSwapPools(mirror, setup, { sleep = realSleep, tries = 3 } = {}) {
  const w = longZero(setup.whbar);
  const t = longZero(setup.tokenId);
  /** @type {{ venue: "V1" | "V2", fee: number, to: string, data: string }[]} */
  const slots = [
    { venue: "V1", fee: 3000, to: longZero(setup.factoryV1), data: factoryV1.encodeFunctionData("getPair", [w, t]) },
    ...V2_FEES.map((fee) => ({ venue: /** @type {"V2"} */ ("V2"), fee, to: longZero(setup.factoryV2), data: factoryV2.encodeFunctionData("getPool", [w, t, fee]) })),
  ];
  const ask = (/** @type {{ to: string, data: string }} */ s) => mirror.simulate({ to: s.to, data: s.data }).catch(() => ({ ok: false, result: "0x", error: "red" }));
  const first = await Promise.all(slots.map(ask));
  /** @type {(string | null | undefined)[]} undefined: la fábrica no contestó · null: no hay pool · dirección: la pool */
  const found = first.map((r) => (r.ok ? addressResult(r.result) : undefined));
  for (let i = 0; i < slots.length; i++) {
    for (let k = 1; k < tries && found[i] === undefined; k++) {
      await sleep(400 * k);
      const r = await ask(slots[i]);
      if (r.ok) found[i] = addressResult(r.result);
    }
  }
  const known = KNOWN_POOLS[setup.network]?.[setup.tokenId] ?? [];
  /** @type {SwapPool[]} */
  const pools = [];
  slots.forEach((s, i) => {
    let address = found[i];
    if (address === undefined) {
      const k = known.find((p) => p.venue === s.venue && (p.venue === "V1" || ("fee" in p && p.fee === s.fee)));
      address = k ? k.address : null;
    }
    if (!address) return;
    pools.push(s.venue === "V1" ? { venue: "V1", address } : { venue: "V2", address, fee: s.fee });
  });
  return pools;
}

/**
 * @typedef {{ ok: boolean, result: string, error: string, status?: number }} SimResult
 * @typedef {(p: { to?: string, data: string, gas?: number }, giveUpOn429?: boolean) => Promise<SimResult>} MirrorCall
 * @typedef {{ state: Promise<import("./swapv3.js").PoolState | null>, getWord: (w: number) => Promise<bigint>, getLiquidityNet: (t: number) => Promise<bigint> }} PoolReader
 * @typedef {Map<string, PoolReader>} PoolCache  lecturas de pools compartidas dentro de una misma cotización
 */

/**
 * Llamada de solo lectura al mirror (eth_call) con reintentos: si falla sin ser un revert (red, límite…), se repite
 * hasta dos veces. Con `giveUpOn429`, un 429 no se repite (se pasa al cálculo con la pool).
 * @param {SimulatingMirror} mirror @param {(ms: number) => Promise<void>} [sleep]
 * @returns {MirrorCall}
 */
export function makeMirrorCall(mirror, sleep = realSleep) {
  return async (p, giveUpOn429 = false) => {
    /** @type {SimResult} */
    let r = { ok: false, result: "0x", error: "" };
    for (let k = 0; k < 3; k++) {
      if (k > 0) await sleep(500 * k);
      r = await mirror.simulate(p).catch(() => ({ ok: false, result: "0x", error: "red" }));
      if (r.ok || revertReasonFromMirror(r.error)) break;
      if (giveUpOn429 && isRateLimited(r)) break;
    }
    return r;
  };
}

/**
 * Pools de SaucerSwap entre dos tokens cualesquiera (0.10.2, para cambios de token a token): la V1 y las V2 de cada
 * comisión. Igual que findSwapPools, con reintentos de uno en uno, pero sin pools conocidas de reserva.
 * @param {SimulatingMirror} mirror @param {{ factoryV1: string, factoryV2: string }} setup @param {string} a @param {string} b IDs 0.0.X
 * @param {{ sleep?: (ms: number) => Promise<void>, tries?: number }} [opts]
 * @returns {Promise<SwapPool[]>}
 */
export async function findPoolsBetween(mirror, setup, a, b, { sleep = realSleep, tries = 3 } = {}) {
  const x = longZero(a);
  const y = longZero(b);
  /** @type {{ venue: "V1" | "V2", fee: number, to: string, data: string }[]} */
  const slots = [
    { venue: "V1", fee: 3000, to: longZero(setup.factoryV1), data: factoryV1.encodeFunctionData("getPair", [x, y]) },
    ...V2_FEES.map((fee) => ({ venue: /** @type {"V2"} */ ("V2"), fee, to: longZero(setup.factoryV2), data: factoryV2.encodeFunctionData("getPool", [x, y, fee]) })),
  ];
  const ask = (/** @type {{ to: string, data: string }} */ s) => mirror.simulate({ to: s.to, data: s.data }).catch(() => ({ ok: false, result: "0x", error: "red" }));
  const first = await Promise.all(slots.map(ask));
  const found = first.map((r) => (r.ok ? addressResult(r.result) : undefined));
  for (let i = 0; i < slots.length; i++) {
    for (let k = 1; k < tries && found[i] === undefined; k++) {
      await sleep(400 * k);
      const r = await ask(slots[i]);
      if (r.ok) found[i] = addressResult(r.result);
    }
  }
  /** @type {SwapPool[]} */
  const pools = [];
  slots.forEach((s, i) => {
    const address = found[i];
    if (!address) return;
    pools.push(s.venue === "V1" ? { venue: "V1", address } : { venue: "V2", address, fee: s.fee });
  });
  return pools;
}

/**
 * Lector del estado de una pool V2 por el mirror (slot0, liquidity, tickSpacing, tickBitmap, ticks), cada dato una
 * sola vez. Una lectura que falla hace fallar la cotización (null), nunca da un número a medias.
 * @param {MirrorCall} call @param {string} address dirección EVM de la pool (la que dio la fábrica)
 * @returns {PoolReader}
 */
function poolReader(call, address) {
  /** @param {string} data */
  const read = async (data) => {
    const r = await call({ to: address, data, gas: POOL_READ_GAS });
    if (!r.ok) throw new Error(`lectura de la pool: ${r.status ?? ""} ${r.error}`.trim());
    return r.result;
  };
  /** @type {Map<number, Promise<bigint>>} */
  const words = new Map();
  /** @type {Map<number, Promise<bigint>>} */
  const nets = new Map();
  const state = Promise.all([read(POOL_READS.slot0), read(POOL_READS.liquidity), read(POOL_READS.tickSpacing)])
    .then(([s, l, t]) => ({ ...decodeSlot0(s), liquidity: wordAt(l, 0), tickSpacing: Number(signedWordAt(t, 0)) }))
    .catch(() => null);
  return {
    state,
    getWord(w) {
      let p = words.get(w);
      if (!p) words.set(w, (p = read(POOL_READS.tickBitmap + encodeInt256(w)).then((h) => wordAt(h, 0))));
      return p;
    },
    getLiquidityNet(t) {
      let p = nets.get(t);
      if (!p) nets.set(t, (p = read(POOL_READS.ticks + encodeInt256(t)).then((h) => signedWordAt(h, 1))));
      return p;
    },
  };
}

/**
 * Cotización de una pool V2 con su estado, sin el QuoterV2 (core/src/swapv3.js).
 * @param {MirrorCall} call @param {{ address: string, fee: number }} pool @param {string} tokenIn @param {string} tokenOut
 * @param {bigint} amountIn @param {PoolCache | undefined} cache
 * @returns {Promise<bigint | null>}
 */
export async function quoteV2FromPool(call, pool, tokenIn, tokenOut, amountIn, cache) {
  const key = pool.address.toLowerCase();
  let reader = cache?.get(key);
  if (!reader) {
    reader = poolReader(call, pool.address);
    cache?.set(key, reader);
  }
  const state = await reader.state;
  if (!state || state.sqrtPriceX96 === 0n) return null;
  const zeroForOne = BigInt(tokenIn) < BigInt(tokenOut);
  const q = await quoteExactInputLocal(state, reader, { zeroForOne, amountIn, feePips: pool.fee });
  return q && q.amountOut > 0n ? q.amountOut : null;
}

/**
 * Cotización en una pool: lo que sale por `amountIn`. null si la pool no puede (sin liquidez, revierte…).
 * Si el mirror falla sin que sea un revert (red, límite de peticiones…), se repite hasta dos veces.
 * V2: primero el QuoterV2; si el mirror lo rechaza (429), con el estado de la pool, y durante QUOTER_REFUSED_MS a ese
 * mirror ya no se le pregunta al QuoterV2.
 * @param {SimulatingMirror} mirror @param {SwapSetup} setup @param {SwapPool} pool @param {SwapSide} side @param {bigint} amountIn
 * @param {{ sleep?: (ms: number) => Promise<void>, cache?: PoolCache, now?: () => number }} [opts]
 * @returns {Promise<SwapQuote | null>}
 */
export async function quotePool(mirror, setup, pool, side, amountIn, { sleep = realSleep, cache, now = Date.now } = {}) {
  if (amountIn <= 0n) return null;
  const { tokenIn, tokenOut } = legs(setup, side);
  const call = makeMirrorCall(mirror, sleep);
  try {
    if (pool.venue === "V1") {
      const r = await call({ to: longZero(setup.routerV1), data: routerV1Views.encodeFunctionData("getAmountsOut", [amountIn, [tokenIn, tokenOut]]) });
      if (!r.ok) return null;
      const [amounts] = routerV1Views.decodeFunctionResult("getAmountsOut", r.result);
      const out = BigInt(amounts[amounts.length - 1]);
      return out > 0n ? { venue: "V1", fee: 3000, address: pool.address, amountIn, amountOut: out } : null;
    }
    /** @param {bigint | null} out */
    const v2 = (out) => (out != null && out > 0n ? /** @type {SwapQuote} */ ({ venue: "V2", fee: pool.fee, address: pool.address, amountIn, amountOut: out }) : null);
    if (isQuoterRefused(mirror, now)) return v2(await quoteV2FromPool(call, pool, tokenIn, tokenOut, amountIn, cache));
    const quoteData = quoterV2.encodeFunctionData("quoteExactInput", [v2Path(tokenIn, pool.fee, tokenOut), amountIn]);
    let r = await call({ to: longZero(setup.quoterV2), data: quoteData, gas: QUOTE_GAS }, true);
    // Una ruta que gaste más de lo normal: una vez más con más gas (sin llegar a lo que el mirror rechaza).
    if (!r.ok && isOutOfGas(r)) r = await call({ to: longZero(setup.quoterV2), data: quoteData, gas: SWAP_GAS_RETRY }, true);
    if (!r.ok && isRateLimited(r)) {
      // El mirror público no deja usar el QuoterV2: el mismo cálculo con el estado de la pool.
      markQuoterRefused(mirror, now);
      return v2(await quoteV2FromPool(call, pool, tokenIn, tokenOut, amountIn, cache));
    }
    if (!r.ok) return null;
    const [out] = quoterV2.decodeFunctionResult("quoteExactInput", r.result);
    return v2(BigInt(out));
  } catch {
    return null;
  }
}

/**
 * Mejor cotización entre todas las pools, con el impacto en el precio (comparando con una cotización de 1/100 del
 * importe en la misma pool: así no cuenta la comisión, solo lo que mueve el precio).
 * @param {SimulatingMirror} mirror @param {SwapSetup} setup @param {SwapPool[]} pools @param {SwapSide} side @param {bigint} amountIn
 * @param {{ sleep?: (ms: number) => Promise<void>, now?: () => number }} [options]
 * @returns {Promise<{ best: SwapQuote, impactPct: number | null, all: SwapQuote[], failed: SwapPool[] } | null>}
 *   all: las cotizaciones, de la que más da a la que menos · failed: las pools que no se pudieron cotizar
 */
export async function bestSwapQuote(mirror, setup, pools, side, amountIn, options = {}) {
  // El estado de cada pool V2 se lee una vez por cotización (también para la pequeña del impacto).
  const opts = { ...options, cache: /** @type {PoolCache} */ (new Map()) };
  const raw = await Promise.all(pools.map((p) => quotePool(mirror, setup, p, side, amountIn, opts)));
  const quotes = /** @type {SwapQuote[]} */ (raw.filter((q) => q !== null));
  const failed = pools.filter((_, i) => raw[i] === null);
  if (quotes.length === 0) return null;
  quotes.sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0));
  const best = quotes[0];
  const pool = pools.find((p) => p.address === best.address);
  const small = amountIn / 100n;
  let impactPct = null;
  if (pool && small > 0n) {
    const ref = await quotePool(mirror, setup, pool, side, small, opts);
    if (ref) impactPct = priceImpactPct(best, ref);
  }
  return { best, impactPct, all: quotes, failed };
}

/**
 * Impacto en el precio (%) de una cotización frente a otra pequeña en la misma pool.
 * @param {{ amountIn: bigint, amountOut: bigint }} q @param {{ amountIn: bigint, amountOut: bigint }} ref
 */
export function priceImpactPct(q, ref) {
  if (q.amountIn <= 0n || ref.amountIn <= 0n || ref.amountOut <= 0n) return null;
  // (out/in) / (refOut/refIn), con 12 cifras de precisión antes de pasar a número
  const ratio = Number((q.amountOut * ref.amountIn * 1_000_000_000_000n) / (q.amountIn * ref.amountOut)) / 1e12;
  return Math.max(0, (1 - ratio) * 100);
}

/** Mínimo a recibir con una tolerancia en puntos básicos (redondeo hacia abajo). @param {bigint} amountOut @param {number} slippageBps */
export function swapMinOut(amountOut, slippageBps) {
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 2000) throw new Error("tolerancia no válida");
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

/**
 * Datos de la transacción del swap (sin firmar).
 * @param {{ setup: SwapSetup, side: SwapSide, quote: SwapQuote, minOut: bigint, recipient: string, routerV2Evm: string, deadline: number }} p
 *   recipient: dirección EVM de la Cartera · routerV2Evm: la del router V2 (recibe el WHBAR en una venta para desenvolverlo)
 * @returns {{ contractId: string, data: string, payableTinybars: bigint, approve: null | { tokenId: string, spenderId: string, amount: bigint } }}
 */
export function buildSwapTx({ setup, side, quote, minOut, recipient, routerV2Evm, deadline }) {
  const amountIn = BigInt(quote.amountIn);
  const min = BigInt(minOut);
  if (amountIn <= 0n || min <= 0n) throw new Error("importe o mínimo no válido");
  const to = getAddress(recipient);
  const { tokenIn, tokenOut } = legs(setup, side);
  if (quote.venue === "V2") {
    if (!V2_FEES.includes(quote.fee)) throw new Error(`comisión V2 desconocida: ${quote.fee}`);
    if (side === "buy") {
      const swap = v2Router.encodeFunctionData("exactInput", [{ path: v2Path(tokenIn, quote.fee, tokenOut), recipient: to, deadline, amountIn, amountOutMinimum: min }]);
      const data = v2Router.encodeFunctionData("multicall", [[swap, v2Router.encodeFunctionData("refundETH", [])]]);
      return { contractId: setup.routerV2, data, payableTinybars: amountIn, approve: null };
    }
    const router = getAddress(routerV2Evm);
    const swap = v2Router.encodeFunctionData("exactInput", [{ path: v2Path(tokenIn, quote.fee, tokenOut), recipient: router, deadline, amountIn, amountOutMinimum: min }]);
    const data = v2Router.encodeFunctionData("multicall", [[swap, v2Router.encodeFunctionData("unwrapWHBAR", [min, to])]]);
    return { contractId: setup.routerV2, data, payableTinybars: 0n, approve: { tokenId: setup.tokenId, spenderId: setup.routerV2, amount: amountIn } };
  }
  if (side === "buy") {
    const data = v1Router.encodeFunctionData("swapExactETHForTokens", [min, [tokenIn, tokenOut], to, deadline]);
    return { contractId: setup.routerV1, data, payableTinybars: amountIn, approve: null };
  }
  const data = v1Router.encodeFunctionData("swapExactTokensForETH", [amountIn, min, [tokenIn, tokenOut], to, deadline]);
  return { contractId: setup.routerV1, data, payableTinybars: 0n, approve: { tokenId: setup.tokenId, spenderId: setup.routerV1, amount: amountIn } };
}

/**
 * Gas para el swap: estimación del mirror +30 % (entre 400 000 y 3 000 000). Si la simulación revierte, se devuelve
 * el motivo: así no se firma una transacción que va a fallar.
 * @param {SimulatingMirror} mirror @param {{ from: string, to: string, data: string, value: bigint, venue: "V1" | "V2" }} p
 * @returns {Promise<{ gas: number, estimated: boolean, revert: string | null }>}
 */
export async function estimateSwapGas(mirror, { from, to, data, value, venue }) {
  try {
    let r = await mirror.simulate({ from, to, data, value, estimate: true, gas: SWAP_GAS_MAX });
    // El mirror público rechaza (429) las simulaciones que reservan mucho gas: se repite con menos.
    if (!r.ok && isRateLimited(r)) r = await mirror.simulate({ from, to, data, value, estimate: true, gas: SWAP_GAS_RETRY });
    if (!r.ok) {
      const reason = revertReasonFromMirror(r.error);
      if (reason) return { gas: SWAP_GAS_FALLBACK[venue], estimated: false, revert: reason };
      return { gas: SWAP_GAS_FALLBACK[venue], estimated: false, revert: null };
    }
    const g = Number(BigInt(r.result));
    if (!(g > 0)) return { gas: SWAP_GAS_FALLBACK[venue], estimated: false, revert: null };
    return { gas: Math.min(Math.max(Math.ceil(g * 1.3), SWAP_GAS_MIN), SWAP_GAS_MAX), estimated: true, revert: null };
  } catch {
    return { gas: SWAP_GAS_FALLBACK[venue], estimated: false, revert: null };
  }
}

/** Motivo de un revert (Error(string) de Solidity, en hex) o el texto tal cual. @param {string} msg */
export function revertReason(msg) {
  const s = String(msg || "");
  const hex = /0x08c379a0[0-9a-fA-F]*/.exec(s)?.[0];
  if (hex) {
    try {
      return String(coder.decode(["string"], `0x${hex.slice(10)}`)[0]);
    } catch {
      return s;
    }
  }
  return s;
}

/**
 * Motivo de un revert en la respuesta de error del mirror (JSON con _status.messages[].detail / data), o null si el
 * error no es un revert (red, límite de peticiones…).
 * @param {string} body
 */
export function revertReasonFromMirror(body) {
  const s = String(body || "");
  if (!/CONTRACT_REVERT_EXECUTED|revert/i.test(s)) return null;
  try {
    const j = JSON.parse(s);
    const m = j?._status?.messages?.[0] ?? {};
    const reason = revertReason(String(m.data ?? "")) || String(m.detail ?? "");
    return reason && !/^0x$/.test(reason) ? reason : String(m.detail || m.message || "revert");
  } catch {
    return revertReason(s) || "revert";
  }
}

/** ¿El revert es por el mínimo a recibir (el precio se movió más que la tolerancia)? @param {string | null | undefined} reason */
export const isMinOutRevert = (reason) => /too little received|insufficient_output_amount|insufficient output/i.test(String(reason || ""));

/**
 * Lo que recibió la Cartera según lo que devolvió el router (call_result del mirror), o null.
 * @param {"V1" | "V2"} venue @param {string} hex
 */
export function decodeSwapAmountOut(venue, hex) {
  try {
    if (!hex || hex === "0x") return null;
    if (venue === "V2") {
      const [results] = v2Router.decodeFunctionResult("multicall", hex);
      return BigInt(v2Router.decodeFunctionResult("exactInput", results[0])[0]);
    }
    const [amounts] = coder.decode(["uint256[]"], hex);
    return BigInt(amounts[amounts.length - 1]);
  } catch {
    return null;
  }
}

/** "0x…" → bytes (para setFunctionParameters). @param {string} hex */
export function swapHexToBytes(hex) {
  const h = String(hex).replace(/^0x/, "");
  if (h.length % 2 || /[^0-9a-f]/i.test(h)) throw new Error("hex no válido");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** Comisión máxima de red que se acepta por la llamada al router (se cobra lo que cueste de verdad). */
export const SWAP_MAX_FEE_HBAR = 10;

/**
 * @typedef {{ reason: string, venue: "V1" | "V2", gas: number, maxCostTinybars: bigint }} UnverifiedSwap
 *   reason: por qué falla la simulación · maxCostTinybars: lo que costaría como mucho si la red lo rechaza
 */

/**
 * Hace el swap desde la Cartera, paso a paso:
 *   1. compra: asocia el token a la Cartera si aún no lo tiene;
 *   2. vuelve a cotizar en todas las pools: si ninguna llega al mínimo que el usuario aceptó, no sigue;
 *   3. venta: permiso (allowance) al router de la pool por la cantidad exacta, nunca ilimitado;
 *   4. simula la llamada en el mirror. Si revierte, prueba como la ejecuta la red de verdad (si la cuenta tiene
 *      dirección EVM, Hedera la usa como remitente) y, si tampoco, la siguiente pool (quitando el permiso de la
 *      anterior). Si el precio se ha movido, para;
 *   5. si ninguna simulación pasa, no se firma. Solo con `onUnverified` (la app pregunta al usuario, con lo que
 *      costaría si falla) se puede enviar igualmente con un gas limitado;
 *   6. la llamada al router; si falla, se quita el permiso que quedara.
 * Con `recipientId` (0.10.2) lo que sale del cambio va a otra cuenta propia (la bóveda): el router lo manda directo,
 * sin pasar por la Cartera. Paga y firma igual la Cartera. Antes se comprueba que esa cuenta puede recibir el token
 * (asociaciones automáticas ilimitadas, como las bóvedas v2, o el token ya asociado): si no, no se envía nada.
 * @param {{
 *   client: import("@hiero-ledger/sdk").Client, accountId: AccountId,
 *   mirror: SimulatingMirror & { accountTokens: (id: string) => Promise<{ tokenId: string }[]>, contractEvmAddress: (id: string) => Promise<string>, contractResult: (txId: string) => Promise<{ result: string, error: string | null } | null>, account?: (id: string) => Promise<{ evmAddress: string, maxAutoAssociations?: number } | null>, contractGasPrice?: () => Promise<bigint | null> },
 *   setup: SwapSetup, pools: SwapPool[], side: SwapSide, amountIn: bigint, agreedOut: bigint, slippageBps: number,
 *   submitTx?: typeof submit, sleep?: (ms: number) => Promise<void>, onUnverified?: (info: UnverifiedSwap) => Promise<boolean>,
 *   recipientId?: string | null,
 * }} p  agreedOut: lo que la app enseñó como «Recibes» cuando el usuario confirmó
 * @returns {Promise<{ txId: string, venue: "V1" | "V2", amountOut: bigint | null, minOut: bigint, verified: boolean, recipientId: string }>}
 */
export async function swapFromPocket({ client, accountId, mirror, setup, pools, side, amountIn, agreedOut, slippageBps, submitTx = submit, sleep = realSleep, onUnverified, recipientId = null }) {
  const owner = accountId.toString();
  const recipient = longZero(owner);
  const minOut = swapMinOut(agreedOut, slippageBps);
  let prepared = false;
  const elsewhere = recipientId != null && recipientId !== owner;
  if (elsewhere && !/^0\.0\.\d+$/.test(String(recipientId))) throw new WalletError(tr("Cuenta de destino no válida.", "Invalid destination account."));
  /** Destino fijo (otra cuenta propia) o null: a la Cartera, como siempre. */
  const fixedTo = elsewhere ? longZero(String(recipientId)) : null;

  // 1a. Otra cuenta (la bóveda): tiene que poder recibir el token sin que nadie lo asocie.
  if (elsewhere && side === "buy") {
    const dest = String(recipientId);
    const [acc, held] = await Promise.all([
      mirror.account ? mirror.account(dest).catch(() => null) : Promise.resolve(null),
      mirror.accountTokens(dest).catch(() => /** @type {{ tokenId: string }[]} */ ([])),
    ]);
    const unlimited = acc?.maxAutoAssociations === -1;
    if (!unlimited && !held.some((t) => t.tokenId === setup.tokenId)) {
      throw new WalletError(
        tr(
          "Tu bóveda no puede recibir este token directamente (no lo tiene asociado). Recíbelo en la Cartera y guárdalo después en la bóveda.",
          "Your vault can't receive this token directly (it isn't associated). Receive it in the Wallet and store it in the vault afterwards.",
        ),
        "DESTINATION_NOT_ASSOCIATED",
      );
    }
  }

  // 1. Asociación (una compra trae el token a la Cartera).
  if (side === "buy" && !elsewhere) {
    const held = await mirror.accountTokens(owner).catch(() => /** @type {{ tokenId: string }[]} */ ([]));
    if (!held.some((t) => t.tokenId === setup.tokenId)) {
      const assoc = new TokenAssociateTransaction().setAccountId(accountId).setTokenIds([TokenId.fromString(setup.tokenId)]);
      const out = await submitTx(client, assoc);
      if (!out.ok && out.status !== "TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT") {
        throw new WalletError(tr(`No se pudo añadir el token a la Cartera: ${out.status}`, `Could not add the token to the Wallet: ${out.status}`), out.status, out.txId);
      }
      prepared = true;
    }
  }

  // 2. Cotización fresca en todas las pools.
  const fresh = await bestSwapQuote(mirror, setup, pools, side, amountIn, { sleep });
  if (!fresh) throw new WalletError(tr("Ahora mismo no hay liquidez para este cambio. Prueba en un rato.", "There is no liquidity for this swap right now. Try again later."));
  if (fresh.best.amountOut < minOut) {
    throw new WalletError(tr("El precio ha cambiado más que tu tolerancia. Revisa la nueva cotización y vuelve a intentarlo.", "The price moved more than your tolerance. Check the new quote and try again."), "PRICE_MOVED");
  }
  const candidates = fresh.all.filter((q) => q.amountOut >= minOut);

  // Dirección EVM propia de la cuenta (las cuentas con clave ECDSA la tienen): la red la usa como remitente.
  const info = mirror.account ? await mirror.account(owner).catch(() => null) : null;
  const evm = info && /^0x[0-9a-f]{40}$/.test(String(info.evmAddress)) && String(info.evmAddress).toLowerCase() !== recipient.toLowerCase() ? String(info.evmAddress).toLowerCase() : null;
  /** @type {{ from: string, to: string }[]} */
  const senders = fixedTo
    ? [{ from: recipient, to: fixedTo }, ...(evm ? [{ from: evm, to: fixedTo }] : [])]
    : [{ from: recipient, to: recipient }, ...(evm ? [{ from: evm, to: recipient }, { from: evm, to: evm }] : [])];

  /** @param {{ approve: null | { tokenId: string, spenderId: string, amount: bigint } }} tx */
  const revoke = async (tx) => {
    if (!tx.approve) return;
    const zero = new AccountAllowanceApproveTransaction().approveTokenAllowance(TokenId.fromString(tx.approve.tokenId), accountId, AccountId.fromString(tx.approve.spenderId), 0);
    await submitTx(client, zero).catch(() => undefined);
  };
  /** @param {{ tokenId: string, spenderId: string, amount: bigint }} a */
  const approve = async (a) => {
    const tx = new AccountAllowanceApproveTransaction().approveTokenAllowance(TokenId.fromString(a.tokenId), accountId, AccountId.fromString(a.spenderId), Long.fromString(a.amount.toString()));
    const out = await submitTx(client, tx);
    if (!out.ok) throw new WalletError(tr(`No se pudo dar el permiso al router: ${out.status}`, `Could not give the router permission: ${out.status}`), out.status, out.txId);
  };
  /** @param {SwapQuote} quote @param {string} to */
  const build = async (quote, to) => {
    const routerV2Evm = quote.venue === "V2" && side === "sell" ? await mirror.contractEvmAddress(setup.routerV2) : to;
    return buildSwapTx({ setup, side, quote, minOut, recipient: to, routerV2Evm, deadline: nowSeconds() + SWAP_DEADLINE_S });
  };

  // 3-4. Permiso y simulación, pool a pool y remitente a remitente.
  /** @type {{ quote: SwapQuote, tx: ReturnType<typeof buildSwapTx>, gas: number } | null} */
  let chosen = null;
  let lastRevert = "";
  for (const quote of candidates) {
    let approvedFor = null;
    for (let s = 0; s < senders.length && !chosen; s++) {
      const who = senders[s];
      const tx = await build(quote, who.to);
      if (tx.approve && approvedFor !== tx.approve.spenderId) {
        await approve(tx.approve);
        approvedFor = tx.approve.spenderId;
        prepared = true;
      }
      const sim = { from: who.from, to: longZero(tx.contractId), data: tx.data, value: tx.payableTinybars, venue: quote.venue };
      let est = await estimateSwapGas(mirror, sim);
      // El mirror tarda unos segundos en ver la asociación o el permiso recién hechos.
      for (let i = 0; s === 0 && est.revert && prepared && !isMinOutRevert(est.revert) && i < 3; i++) {
        await sleep(4000);
        est = await estimateSwapGas(mirror, sim);
      }
      if (!est.revert) {
        chosen = { quote, tx, gas: est.gas };
        break;
      }
      if (isMinOutRevert(est.revert)) {
        await revoke(tx);
        throw new WalletError(tr("El precio ha cambiado más que tu tolerancia. Vuelve a cotizar.", "The price moved more than your tolerance. Get a new quote."), "SIMULATION_REVERT");
      }
      lastRevert = est.revert;
    }
    if (chosen) break;
    if (approvedFor) await revoke({ approve: { tokenId: setup.tokenId, spenderId: approvedFor, amount: 0n } });
  }

  // 5. Sin ninguna simulación buena: solo si el usuario lo acepta sabiendo lo que puede costar.
  let verified = true;
  if (!chosen) {
    const quote = candidates[0];
    const gas = SWAP_GAS_FALLBACK[quote.venue];
    const gasPrice = (mirror.contractGasPrice ? await mirror.contractGasPrice().catch(() => null) : null) ?? SWAP_GAS_PRICE_FALLBACK_TINYBARS;
    const go = onUnverified ? await onUnverified({ reason: lastRevert, venue: quote.venue, gas, maxCostTinybars: swapFailureCostTinybars(gas, gasPrice) }) : false;
    if (!go) {
      throw new WalletError(
        onUnverified
          ? tr("Cambio cancelado: no se ha enviado nada.", "Swap cancelled: nothing was sent.")
          : tr(`La simulación del cambio falla (${lastRevert}): no se ha enviado nada.`, `The swap simulation fails (${lastRevert}): nothing was sent.`),
        onUnverified ? "CANCELLED" : "SIMULATION_REVERT",
      );
    }
    const tx = await build(quote, fixedTo ?? recipient);
    if (tx.approve) await approve(tx.approve);
    chosen = { quote, tx, gas };
    verified = false;
  }

  // 6. El cambio.
  const { quote, tx } = chosen;
  const call = new ContractExecuteTransaction()
    .setContractId(ContractId.fromString(tx.contractId))
    .setGas(chosen.gas)
    .setFunctionParameters(swapHexToBytes(tx.data))
    .setMaxTransactionFee(new Hbar(SWAP_MAX_FEE_HBAR));
  if (tx.payableTinybars > 0n) call.setPayableAmount(Hbar.fromTinybars(tx.payableTinybars.toString()));
  const out = await submitTx(client, call);
  if (!out.ok) {
    await revoke(tx);
    let reason = "";
    for (let i = 0; i < 4 && !reason; i++) {
      await sleep(2500);
      const r = await mirror.contractResult(out.txId).catch(() => null);
      if (r?.error) reason = revertReason(r.error);
    }
    throw new WalletError(
      isMinOutRevert(reason)
        ? tr("El precio cambió mientras se enviaba y no llegaba al mínimo: no se ha cambiado nada (solo se cobra la comisión de red).", "The price moved while sending and didn't reach the minimum: nothing was swapped (only the network fee is charged).")
        : tr(`El cambio no ha salido (${reason || out.status}). Solo se cobra la comisión de red.`, `The swap failed (${reason || out.status}). Only the network fee is charged.`),
      out.status,
      out.txId,
    );
  }
  let amountOut = null;
  for (let i = 0; i < 4 && amountOut == null; i++) {
    await sleep(2500);
    const r = await mirror.contractResult(out.txId).catch(() => null);
    if (r) amountOut = decodeSwapAmountOut(quote.venue, r.result);
  }
  return { txId: out.txId, venue: quote.venue, amountOut, minOut, verified, recipientId: elsewhere ? String(recipientId) : owner };
}
