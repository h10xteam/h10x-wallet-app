// @ts-check
// Cambios de TOKEN A TOKEN en SaucerSwap desde la Cartera (swap ampliado, fase 2; app 0.10.2).
//
// HBAR ↔ token sigue en core/src/swap.js, sin tocar. Aquí, de un token A a otro B, por dos caminos:
//   - directo, si hay pool A-B (V1 y/o V2 de cada comisión);
//   - pasando por WHBAR (A → WHBAR → B), con las pools de cada token contra WHBAR.
// Los dos saltos van siempre por el MISMO router (V1-V1 o V2-V2): así es una sola transacción, con el mínimo a recibir
// dentro. Se cotizan todas las rutas y se usa la que más da (V1 con getAmountsOut del router; V2 con el QuoterV2 o,
// si el mirror lo rechaza, salto a salto con el estado de cada pool, como en swap.js).
// Antes de firmar: cotización fresca, permiso EXACTO del token A al router (nunca ilimitado), simulación y, si nada
// pasa, solo con la confirmación del usuario. Lo que sale puede ir a la Cartera o directo a la bóveda.
import { AccountAllowanceApproveTransaction, AccountId, ContractExecuteTransaction, ContractId, Hbar, Long, TokenAssociateTransaction, TokenId } from "@hiero-ledger/sdk";
import { AbiCoder, Interface, getAddress, solidityPacked } from "ethers";
import { nowSeconds } from "./format.js";
import { tr } from "./i18n.js";
import {
  QUOTE_GAS,
  SAUCERSWAP,
  SWAP_DEADLINE_S,
  SWAP_GAS_FALLBACK,
  SWAP_GAS_PRICE_FALLBACK_TINYBARS,
  SWAP_GAS_RETRY,
  SWAP_MAX_FEE_HBAR,
  V2_FEES,
  estimateSwapGas,
  findPoolsBetween,
  findSwapPools,
  isMinOutRevert,
  isQuoterRefused,
  isRateLimited,
  longZero,
  makeMirrorCall,
  markQuoterRefused,
  priceImpactPct,
  quoteV2FromPool,
  revertReason,
  swapFailureCostTinybars,
  swapHexToBytes,
  swapMinOut,
  swapSetup,
} from "./swap.js";
import { submit, WalletError } from "./wallet.js";

const coder = AbiCoder.defaultAbiCoder();
const routerV1Views = new Interface(["function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)"]);
const quoterV2 = new Interface([
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);
export const v2RouterTokens = new Interface(["function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)"]);
export const v1RouterTokens = new Interface(["function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)"]);
/** Como mucho tantas rutas V2 por WHBAR (combinaciones de comisiones): más sería leer de más del mirror. */
export const MAX_V2_VIA_ROUTES = 6;
/** @param {number} ms */
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @typedef {{ network: "mainnet" | "testnet", tokenIn: string, tokenOut: string, factoryV1: string, routerV1: string, factoryV2: string, routerV2: string, quoterV2: string, whbar: string }} RouteSetup
 * @typedef {{ venue: "V1", path: string[], pools: string[] } | { venue: "V2", path: string[], fees: number[], pools: string[] }} SwapRoute
 *   path: IDs 0.0.X (A, B o A, WHBAR, B) · pools: dirección de la pool de cada salto
 * @typedef {{ route: SwapRoute, amountIn: bigint, amountOut: bigint }} RouteQuote
 */

/**
 * Configuración de un cambio de token a token (null si no vale: otra red, IDs raros, el mismo token o WHBAR).
 * @param {string} network @param {string} tokenIn @param {string} tokenOut
 * @returns {RouteSetup | null}
 */
export function routeSetup(network, tokenIn, tokenOut) {
  if (network !== "mainnet" && network !== "testnet") return null;
  const ok = (/** @type {string} */ t) => /^0\.0\.\d+$/.test(String(t));
  if (!ok(tokenIn) || !ok(tokenOut) || tokenIn === tokenOut) return null;
  const w = SAUCERSWAP[network].whbar;
  if (tokenIn === w || tokenOut === w) return null;
  return { network, tokenIn, tokenOut, ...SAUCERSWAP[network] };
}

/** Ruta V2 empaquetada: token, comisión, token[, comisión, token]. @param {SwapRoute} route */
export function v2RoutePath(route) {
  if (route.venue !== "V2" || route.fees.length !== route.path.length - 1) throw new Error("ruta V2 mal formada");
  /** @type {string[]} */
  const types = ["address"];
  /** @type {(string | number)[]} */
  const values = [getAddress(longZero(route.path[0]))];
  route.fees.forEach((fee, i) => {
    if (!V2_FEES.includes(fee)) throw new Error(`comisión V2 desconocida: ${fee}`);
    types.push("uint24", "address");
    values.push(fee, getAddress(longZero(route.path[i + 1])));
  });
  return solidityPacked(types, values);
}

/** Texto corto de una ruta: «SAUCE → HBAR → USDC · V2». @param {SwapRoute} route @param {(id: string) => string} name */
export function describeRoute(route, name) {
  return `${route.path.map(name).join(" → ")} · ${route.venue}`;
}

/**
 * Rutas posibles entre A y B: las directas y las que pasan por WHBAR (mismo router en los dos saltos). Las búsquedas
 * van una detrás de otra: el mirror público corta si llegan muchas juntas.
 * @param {import("./swap.js").SimulatingMirror} mirror @param {RouteSetup} rs @param {{ sleep?: (ms: number) => Promise<void>, tries?: number }} [opts]
 * @returns {Promise<SwapRoute[]>}
 */
export async function findRoutes(mirror, rs, opts = {}) {
  const A = rs.tokenIn;
  const B = rs.tokenOut;
  const W = rs.whbar;
  const direct = await findPoolsBetween(mirror, rs, A, B, opts);
  const sa = swapSetup(rs.network, A);
  const sb = swapSetup(rs.network, B);
  const legA = sa ? await findSwapPools(mirror, sa, opts) : [];
  const legB = sb ? await findSwapPools(mirror, sb, opts) : [];
  /** @type {SwapRoute[]} */
  const routes = [];
  for (const p of direct) routes.push(p.venue === "V1" ? { venue: "V1", path: [A, B], pools: [p.address] } : { venue: "V2", path: [A, B], fees: [p.fee], pools: [p.address] });
  const a1 = legA.find((p) => p.venue === "V1");
  const b1 = legB.find((p) => p.venue === "V1");
  if (a1 && b1) routes.push({ venue: "V1", path: [A, W, B], pools: [a1.address, b1.address] });
  let via = 0;
  for (const pa of legA) {
    if (pa.venue !== "V2") continue;
    for (const pb of legB) {
      if (pb.venue !== "V2" || via >= MAX_V2_VIA_ROUTES) continue;
      routes.push({ venue: "V2", path: [A, W, B], fees: [pa.fee, pb.fee], pools: [pa.address, pb.address] });
      via++;
    }
  }
  return routes;
}

/**
 * Cotización de una ruta: lo que sale por `amountIn` (null si no puede: sin liquidez, revierte…).
 * @param {import("./swap.js").SimulatingMirror} mirror @param {RouteSetup} rs @param {SwapRoute} route @param {bigint} amountIn
 * @param {{ sleep?: (ms: number) => Promise<void>, cache?: import("./swap.js").PoolCache, now?: () => number }} [opts]
 * @returns {Promise<RouteQuote | null>}
 */
export async function quoteRoute(mirror, rs, route, amountIn, { sleep = realSleep, cache, now = Date.now } = {}) {
  if (amountIn <= 0n) return null;
  const call = makeMirrorCall(mirror, sleep);
  const addrs = route.path.map(longZero);
  try {
    if (route.venue === "V1") {
      const r = await call({ to: longZero(rs.routerV1), data: routerV1Views.encodeFunctionData("getAmountsOut", [amountIn, addrs]) });
      if (!r.ok) return null;
      const [amounts] = routerV1Views.decodeFunctionResult("getAmountsOut", r.result);
      const out = BigInt(amounts[amounts.length - 1]);
      return out > 0n ? { route, amountIn, amountOut: out } : null;
    }
    const v2 = route;
    // Salto a salto con el estado de cada pool (lo mismo que haría el QuoterV2).
    const local = async () => {
      let amount = amountIn;
      for (let i = 0; i < v2.fees.length; i++) {
        const out = await quoteV2FromPool(call, { address: v2.pools[i], fee: v2.fees[i] }, addrs[i], addrs[i + 1], amount, cache);
        if (out == null || out <= 0n) return null;
        amount = out;
      }
      return amount;
    };
    /** @type {bigint | null} */
    let out = null;
    if (isQuoterRefused(mirror, now)) out = await local();
    else {
      const data = quoterV2.encodeFunctionData("quoteExactInput", [v2RoutePath(v2), amountIn]);
      let r = await call({ to: longZero(rs.quoterV2), data, gas: QUOTE_GAS }, true);
      if (!r.ok && /INSUFFICIENT_GAS|out of gas/i.test(String(r.error))) r = await call({ to: longZero(rs.quoterV2), data, gas: SWAP_GAS_RETRY }, true);
      if (!r.ok && isRateLimited(r)) {
        markQuoterRefused(mirror, now);
        out = await local();
      } else if (r.ok) out = BigInt(quoterV2.decodeFunctionResult("quoteExactInput", r.result)[0]);
    }
    return out != null && out > 0n ? { route, amountIn, amountOut: out } : null;
  } catch {
    return null;
  }
}

/**
 * La mejor ruta y el impacto en el precio (contra 1/100 del importe por la misma ruta).
 * @param {import("./swap.js").SimulatingMirror} mirror @param {RouteSetup} rs @param {SwapRoute[]} routes @param {bigint} amountIn
 * @param {{ sleep?: (ms: number) => Promise<void>, now?: () => number }} [options]
 * @returns {Promise<{ best: RouteQuote, impactPct: number | null, all: RouteQuote[], failed: SwapRoute[] } | null>}
 */
export async function bestRouteQuote(mirror, rs, routes, amountIn, options = {}) {
  const opts = { ...options, cache: /** @type {import("./swap.js").PoolCache} */ (new Map()) };
  /** @type {(RouteQuote | null)[]} */
  const raw = [];
  // Una detrás de otra: las pools compartidas se leen una vez (caché) y el mirror no recibe ráfagas.
  for (const r of routes) raw.push(await quoteRoute(mirror, rs, r, amountIn, opts));
  const quotes = /** @type {RouteQuote[]} */ (raw.filter((q) => q !== null));
  const failed = routes.filter((_, i) => raw[i] === null);
  if (quotes.length === 0) return null;
  quotes.sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0));
  const best = quotes[0];
  const small = amountIn / 100n;
  let impactPct = null;
  if (small > 0n) {
    const ref = await quoteRoute(mirror, rs, best.route, small, opts);
    if (ref) impactPct = priceImpactPct(best, ref);
  }
  return { best, impactPct, all: quotes, failed };
}

/**
 * Datos de la transacción (sin firmar) y el permiso exacto que necesita.
 * @param {{ rs: RouteSetup, quote: RouteQuote, minOut: bigint, recipient: string, deadline: number }} p  recipient: dirección EVM de quien recibe
 * @returns {{ contractId: string, data: string, payableTinybars: bigint, approve: { tokenId: string, spenderId: string, amount: bigint } }}
 */
export function buildRouteTx({ rs, quote, minOut, recipient, deadline }) {
  const amountIn = BigInt(quote.amountIn);
  const min = BigInt(minOut);
  if (amountIn <= 0n || min <= 0n) throw new Error("importe o mínimo no válido");
  const route = quote.route;
  if (route.path[0] !== rs.tokenIn || route.path[route.path.length - 1] !== rs.tokenOut) throw new Error("la ruta no va de A a B");
  if (route.path.length === 3 && route.path[1] !== rs.whbar) throw new Error("un salto intermedio que no es WHBAR");
  if (route.path.length < 2 || route.path.length > 3) throw new Error("ruta de longitud rara");
  const to = getAddress(recipient);
  if (route.venue === "V2") {
    const data = v2RouterTokens.encodeFunctionData("exactInput", [{ path: v2RoutePath(route), recipient: to, deadline, amountIn, amountOutMinimum: min }]);
    return { contractId: rs.routerV2, data, payableTinybars: 0n, approve: { tokenId: rs.tokenIn, spenderId: rs.routerV2, amount: amountIn } };
  }
  const data = v1RouterTokens.encodeFunctionData("swapExactTokensForTokens", [amountIn, min, route.path.map((id) => getAddress(longZero(id))), to, deadline]);
  return { contractId: rs.routerV1, data, payableTinybars: 0n, approve: { tokenId: rs.tokenIn, spenderId: rs.routerV1, amount: amountIn } };
}

/** Lo recibido según lo que devolvió el router, o null. @param {"V1" | "V2"} venue @param {string} hex */
export function decodeRouteAmountOut(venue, hex) {
  try {
    if (!hex || hex === "0x") return null;
    if (venue === "V2") return BigInt(v2RouterTokens.decodeFunctionResult("exactInput", hex)[0]);
    const [amounts] = coder.decode(["uint256[]"], hex);
    return BigInt(amounts[amounts.length - 1]);
  } catch {
    return null;
  }
}

/**
 * Cambio de token A a token B desde la Cartera, con los mismos pasos que swapFromPocket:
 *   1. destino: la bóveda tiene que poder recibir B (asociaciones ilimitadas o ya asociado); a la Cartera, se asocia B;
 *   2. cotización fresca de todas las rutas; si ninguna llega al mínimo aceptado, no sigue;
 *   3. permiso EXACTO de A al router de la ruta; simulación; si revierte, la siguiente ruta (quitando el permiso);
 *   4. sin ninguna simulación buena, solo con `onUnverified` (el usuario lo acepta sabiendo lo que puede costar);
 *   5. el cambio; si falla, se quita el permiso.
 * @param {{
 *   client: import("@hiero-ledger/sdk").Client, accountId: AccountId,
 *   mirror: import("./swap.js").SimulatingMirror & { accountTokens: (id: string) => Promise<{ tokenId: string }[]>, contractResult: (txId: string) => Promise<{ result: string, error: string | null } | null>, account?: (id: string) => Promise<{ evmAddress: string, maxAutoAssociations?: number } | null>, contractGasPrice?: () => Promise<bigint | null> },
 *   rs: RouteSetup, routes: SwapRoute[], amountIn: bigint, agreedOut: bigint, slippageBps: number,
 *   submitTx?: typeof submit, sleep?: (ms: number) => Promise<void>, onUnverified?: (info: import("./swap.js").UnverifiedSwap) => Promise<boolean>,
 *   recipientId?: string | null,
 * }} p
 * @returns {Promise<{ txId: string, venue: "V1" | "V2", route: SwapRoute, amountOut: bigint | null, minOut: bigint, verified: boolean, recipientId: string }>}
 */
export async function swapTokensFromPocket({ client, accountId, mirror, rs, routes, amountIn, agreedOut, slippageBps, submitTx = submit, sleep = realSleep, onUnverified, recipientId = null }) {
  const owner = accountId.toString();
  const self = longZero(owner);
  const minOut = swapMinOut(agreedOut, slippageBps);
  const elsewhere = recipientId != null && recipientId !== owner;
  if (elsewhere && !/^0\.0\.\d+$/.test(String(recipientId))) throw new WalletError(tr("Cuenta de destino no válida.", "Invalid destination account."));
  const fixedTo = elsewhere ? longZero(String(recipientId)) : null;
  let prepared = false;

  // 1. Destino.
  if (elsewhere) {
    const dest = String(recipientId);
    const [acc, held] = await Promise.all([
      mirror.account ? mirror.account(dest).catch(() => null) : Promise.resolve(null),
      mirror.accountTokens(dest).catch(() => /** @type {{ tokenId: string }[]} */ ([])),
    ]);
    if (acc?.maxAutoAssociations !== -1 && !held.some((t) => t.tokenId === rs.tokenOut)) {
      throw new WalletError(
        tr(
          "Tu bóveda no puede recibir este token directamente (no lo tiene asociado). Recíbelo en la Cartera y guárdalo después en la bóveda.",
          "Your vault can't receive this token directly (it isn't associated). Receive it in the Wallet and store it in the vault afterwards.",
        ),
        "DESTINATION_NOT_ASSOCIATED",
      );
    }
  } else {
    const held = await mirror.accountTokens(owner).catch(() => /** @type {{ tokenId: string }[]} */ ([]));
    if (!held.some((t) => t.tokenId === rs.tokenOut)) {
      const out = await submitTx(client, new TokenAssociateTransaction().setAccountId(accountId).setTokenIds([TokenId.fromString(rs.tokenOut)]));
      if (!out.ok && out.status !== "TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT") {
        throw new WalletError(tr(`No se pudo añadir el token a la Cartera: ${out.status}`, `Could not add the token to the Wallet: ${out.status}`), out.status, out.txId);
      }
      prepared = true;
    }
  }

  // 2. Cotización fresca.
  const fresh = await bestRouteQuote(mirror, rs, routes, amountIn, { sleep });
  if (!fresh) throw new WalletError(tr("Ahora mismo no hay liquidez para este cambio. Prueba en un rato.", "There is no liquidity for this swap right now. Try again later."));
  if (fresh.best.amountOut < minOut) {
    throw new WalletError(tr("El precio ha cambiado más que tu tolerancia. Revisa la nueva cotización y vuelve a intentarlo.", "The price moved more than your tolerance. Check the new quote and try again."), "PRICE_MOVED");
  }
  const candidates = fresh.all.filter((q) => q.amountOut >= minOut);

  const info = mirror.account ? await mirror.account(owner).catch(() => null) : null;
  const evm = info && /^0x[0-9a-f]{40}$/.test(String(info.evmAddress)) && String(info.evmAddress).toLowerCase() !== self.toLowerCase() ? String(info.evmAddress).toLowerCase() : null;
  /** @type {{ from: string, to: string }[]} */
  const senders = fixedTo
    ? [{ from: self, to: fixedTo }, ...(evm ? [{ from: evm, to: fixedTo }] : [])]
    : [{ from: self, to: self }, ...(evm ? [{ from: evm, to: self }, { from: evm, to: evm }] : [])];

  /** @param {{ tokenId: string, spenderId: string }} a */
  const revoke = async (a) => {
    const zero = new AccountAllowanceApproveTransaction().approveTokenAllowance(TokenId.fromString(a.tokenId), accountId, AccountId.fromString(a.spenderId), 0);
    await submitTx(client, zero).catch(() => undefined);
  };
  /** @param {{ tokenId: string, spenderId: string, amount: bigint }} a */
  const approve = async (a) => {
    const tx = new AccountAllowanceApproveTransaction().approveTokenAllowance(TokenId.fromString(a.tokenId), accountId, AccountId.fromString(a.spenderId), Long.fromString(a.amount.toString()));
    const out = await submitTx(client, tx);
    if (!out.ok) throw new WalletError(tr(`No se pudo dar el permiso al router: ${out.status}`, `Could not give the router permission: ${out.status}`), out.status, out.txId);
  };
  /** @param {RouteQuote} quote @param {string} to */
  const build = (quote, to) => buildRouteTx({ rs, quote, minOut, recipient: to, deadline: nowSeconds() + SWAP_DEADLINE_S });

  // 3. Permiso y simulación, ruta a ruta.
  /** @type {{ quote: RouteQuote, tx: ReturnType<typeof buildRouteTx>, gas: number } | null} */
  let chosen = null;
  let lastRevert = "";
  for (const quote of candidates) {
    /** @type {string | null} */
    let approvedFor = null;
    for (let s = 0; s < senders.length && !chosen; s++) {
      const who = senders[s];
      const tx = build(quote, who.to);
      if (approvedFor !== tx.approve.spenderId) {
        if (approvedFor) await revoke({ tokenId: rs.tokenIn, spenderId: approvedFor });
        await approve(tx.approve);
        approvedFor = tx.approve.spenderId;
        prepared = true;
      }
      const sim = { from: who.from, to: longZero(tx.contractId), data: tx.data, value: 0n, venue: quote.route.venue };
      let est = await estimateSwapGas(mirror, sim);
      for (let i = 0; s === 0 && est.revert && prepared && !isMinOutRevert(est.revert) && i < 3; i++) {
        await sleep(4000);
        est = await estimateSwapGas(mirror, sim);
      }
      if (!est.revert) {
        chosen = { quote, tx, gas: est.gas };
        break;
      }
      if (isMinOutRevert(est.revert)) {
        await revoke(tx.approve);
        throw new WalletError(tr("El precio ha cambiado más que tu tolerancia. Vuelve a cotizar.", "The price moved more than your tolerance. Get a new quote."), "SIMULATION_REVERT");
      }
      lastRevert = est.revert;
    }
    if (chosen) break;
    if (approvedFor) await revoke({ tokenId: rs.tokenIn, spenderId: approvedFor });
  }

  // 4. Sin simulación buena: solo si el usuario lo acepta.
  let verified = true;
  if (!chosen) {
    const quote = candidates[0];
    const gas = SWAP_GAS_FALLBACK[quote.route.venue];
    const gasPrice = (mirror.contractGasPrice ? await mirror.contractGasPrice().catch(() => null) : null) ?? SWAP_GAS_PRICE_FALLBACK_TINYBARS;
    const go = onUnverified ? await onUnverified({ reason: lastRevert, venue: quote.route.venue, gas, maxCostTinybars: swapFailureCostTinybars(gas, gasPrice) }) : false;
    if (!go) {
      throw new WalletError(
        onUnverified
          ? tr("Cambio cancelado: no se ha enviado nada.", "Swap cancelled: nothing was sent.")
          : tr(`La simulación del cambio falla (${lastRevert}): no se ha enviado nada.`, `The swap simulation fails (${lastRevert}): nothing was sent.`),
        onUnverified ? "CANCELLED" : "SIMULATION_REVERT",
      );
    }
    const tx = build(quote, fixedTo ?? self);
    await approve(tx.approve);
    chosen = { quote, tx, gas };
    verified = false;
  }

  // 5. El cambio.
  const { quote, tx } = chosen;
  const call = new ContractExecuteTransaction()
    .setContractId(ContractId.fromString(tx.contractId))
    .setGas(chosen.gas)
    .setFunctionParameters(swapHexToBytes(tx.data))
    .setMaxTransactionFee(new Hbar(SWAP_MAX_FEE_HBAR));
  const out = await submitTx(client, call);
  if (!out.ok) {
    await revoke(tx.approve);
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
    if (r) amountOut = decodeRouteAmountOut(quote.route.venue, r.result);
  }
  return { txId: out.txId, venue: quote.route.venue, route: quote.route, amountOut, minOut, verified, recipientId: elsewhere ? String(recipientId) : owner };
}
