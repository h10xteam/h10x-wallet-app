#!/usr/bin/env node
// Prueba de la cotización del swap contra el mirror público de mainnet, la misma que hace la app (Cambiar).
// Lo ejecuta el usuario hvault (desde root: «hvault-vps cotizar [HBAR]»). Solo lee: no firma, no envía nada y no usa
// ninguna clave. Sirve para comprobar que la V2 cotiza antes de compilar la app.
//
//   node scripts/cotizar.mjs               compra con 100 HBAR de H10X y vende lo que saldría
//   node scripts/cotizar.mjs 2500          lo mismo con 2.500 HBAR
//   node scripts/cotizar.mjs 10 0.0.456858 lo mismo con otro token
//   node scripts/cotizar.mjs 10 todos      (0.10.2) cada token de la lista revisada: comprobación, pools y cotización
import { NETWORKS } from "../core/src/config.js";
import { Mirror } from "../core/src/mirror.js";
import { SAUCERSWAP, bestSwapQuote, buildSwapTx, estimateSwapGas, findSwapPools, longZero, swapSetup } from "../core/src/swap.js";
import { SWAP_TOKENS, checkSwapToken, swapTokenList } from "../core/src/swaptokens.js";
import { bestRouteQuote, describeRoute, findRoutes, routeSetup } from "../core/src/swaproute.js";

const hbar = Number(process.argv[2] ?? 100);
const which = String(process.argv[3] ?? "").trim();
if (!(hbar > 0 && hbar <= 1_000_000) || !(which === "" || which === "todos" || /^0\.0\.\d{1,10}$/.test(which))) {
  console.error("Uso: node scripts/cotizar.mjs [HBAR] [todos | 0.0.X]   (HBAR entre 0 y 1.000.000)");
  process.exit(1);
}
const mirror = new Mirror(NETWORKS.mainnet.mirror);
/** @param {bigint} v @param {number} d */
const fmt = (v, d) => (Number(v) / 10 ** d).toLocaleString("es-ES", { maximumFractionDigits: 6 });

if (which === "todos") {
  // Toda la lista: una línea por token. Sale con 1 si alguno no pasa la comprobación o no cotiza.
  const amountIn = BigInt(Math.round(hbar * 1e8));
  let bad = 0;
  /** @type {Map<string, bigint>} lo que da cada token por esos HBAR (para probar después de token a token) */
  const bought = new Map();
  for (const entry of SWAP_TOKENS.mainnet) {
    const s = swapSetup("mainnet", entry.id);
    if (!s) continue;
    const info = await mirror.tokenInfo(entry.id, { fresh: true }).catch(() => null);
    const check = checkSwapToken(entry, info);
    const pools = await findSwapPools(mirror, s).catch(() => []);
    const buy = pools.length ? await bestSwapQuote(mirror, s, pools, "buy", amountIn).catch(() => null) : null;
    const sell = buy ? await bestSwapQuote(mirror, s, pools, "sell", buy.best.amountOut).catch(() => null) : null;
    // Poca liquidez: si con este importe el precio se mueve más de un 5 %, no vale para la lista.
    const thin = buy?.impactPct != null && buy.impactPct > 5;
    const ok = check.ok && !!buy && !!sell && !thin;
    if (buy) bought.set(entry.id, buy.best.amountOut);
    if (!ok) bad++;
    const dec = info?.decimals ?? 0;
    console.log(
      `${ok ? "✅" : "⛔"} ${entry.symbol.padEnd(7)} ${entry.id.padEnd(13)} pools ${pools.map((p) => (p.venue === "V1" ? "V1" : `V2·${p.fee / 10_000}%`)).join(",") || "—"}` +
        (buy ? ` · ${fmt(amountIn, 8)} HBAR → ${fmt(buy.best.amountOut, dec)} (${buy.best.venue}${buy.impactPct != null ? `, impacto ${buy.impactPct.toFixed(2)} %` : ""})` : " · sin cotización") +
        (sell ? ` → ${fmt(sell.best.amountOut, 8)} HBAR` : "") +
        (thin ? "\n     poca liquidez: el precio se mueve más de un 5 %" : "") +
        (check.problems.length ? `\n     ${check.problems.join(" ")}` : "") +
        (check.warnings.length ? `\n     aviso: ${check.warnings.join(" ")}` : ""),
    );
    await new Promise((r) => setTimeout(r, 1500)); // el mirror público corta si llegan muchas peticiones juntas
  }
  console.log(bad ? `\n⛔ ${bad} token(s) con problemas` : `\n✅ Los ${SWAP_TOKENS.mainnet.length} tokens de la lista cotizan`);
  // De token a token (fase 2): solo informa, no cuenta como fallo.
  const name = (/** @type {string} */ id) => (id === SAUCERSWAP.mainnet.whbar ? "HBAR" : SWAP_TOKENS.mainnet.find((t) => t.id === id)?.symbol ?? id);
  console.log("\nDe token a token (lo que dan esos HBAR de cada uno):");
  for (const [a, b] of [["0.0.731861", "0.0.456858"], ["0.0.10907484", "0.0.456858"], ["0.0.731861", "0.0.1460200"]]) {
    const rs = routeSetup("mainnet", a, b);
    const amount = bought.get(a);
    if (!rs || !amount) continue;
    const routes = await findRoutes(mirror, rs).catch(() => []);
    const q = routes.length ? await bestRouteQuote(mirror, rs, routes, amount).catch(() => null) : null;
    const decB = (await mirror.tokenInfo(b).catch(() => null))?.decimals ?? 0;
    const decA = (await mirror.tokenInfo(a).catch(() => null))?.decimals ?? 0;
    console.log(
      `  ${name(a)} → ${name(b)}: ${routes.length} ruta(s)` +
        (q ? ` · ${fmt(amount, decA)} → ${fmt(q.best.amountOut, decB)} por ${describeRoute(q.best.route, name)}${q.impactPct != null ? `, impacto ${q.impactPct.toFixed(2)} %` : ""}` : " · sin cotización"),
    );
    await new Promise((r) => setTimeout(r, 1500));
  }
  process.exit(bad ? 1 : 0);
}

const setup = swapSetup("mainnet", which || null);
if (!setup) throw new Error("sin configuración de mainnet");
if (which && !swapTokenList("mainnet").some((t) => t.id === which)) console.log(`(${which} no está en la lista revisada: solo se cotiza)`);
const quoter = longZero(SAUCERSWAP.mainnet.quoterV2).toLowerCase();
const routers = new Set([SAUCERSWAP.mainnet.routerV1, SAUCERSWAP.mainnet.routerV2].map((id) => longZero(id).toLowerCase()));

/** Lo que pasa por el mirror: respuestas del QuoterV2 y lecturas de pools. */
const seen = { quoter: /** @type {string[]} */ ([]), router: /** @type {string[]} */ ([]), pool: 0 };
const watched = {
  /** @param {Parameters<Mirror["simulate"]>[0]} p */
  async simulate(p) {
    const r = await mirror.simulate(p);
    const to = String(p.to ?? "").toLowerCase();
    if (to === quoter) seen.quoter.push(r.ok ? "ok" : String(r.status));
    else if (routers.has(to) && p.estimate) seen.router.push(r.ok ? "ok" : String(r.status));
    else if (/^0x(3850c7bd|1a686502|d0c93a7c|5339c296|f30dba93)/.test(String(p.data))) seen.pool++;
    return r;
  },
};

const info = await mirror.tokenInfo(setup.tokenId);
if (!info) throw new Error(`no encuentro el token ${setup.tokenId}`);
const dec = info.decimals;

const pools = await findSwapPools(watched, setup);
console.log(`Pools de ${info.symbol}: ${pools.map((p) => (p.venue === "V1" ? "V1" : `V2 ${p.fee / 10_000} %`)).join(" · ") || "ninguna"}`);

const amountIn = BigInt(Math.round(hbar * 1e8));
const buy = await bestSwapQuote(watched, setup, pools, "buy", amountIn);
console.log(`\nComprar con ${fmt(amountIn, 8)} HBAR:`);
for (const q of buy?.all ?? []) console.log(`  ${q.venue} ${q.fee / 10_000} %: ${fmt(q.amountOut, dec)} ${info.symbol}${q === buy?.best ? "  ← la mejor" : ""}`);
for (const p of buy?.failed ?? []) console.log(`  ${p.venue}: sin cotización`);
if (buy?.impactPct != null) console.log(`  Impacto en el precio: ${buy.impactPct.toFixed(2)} %`);

if (buy) {
  const sell = await bestSwapQuote(watched, setup, pools, "sell", buy.best.amountOut);
  console.log(`\nVender ${fmt(buy.best.amountOut, dec)} ${info.symbol}:`);
  for (const q of sell?.all ?? []) console.log(`  ${q.venue} ${q.fee / 10_000} %: ${fmt(q.amountOut, 8)} HBAR${q === sell?.best ? "  ← la mejor" : ""}`);
  for (const p of sell?.failed ?? []) console.log(`  ${p.venue}: sin cotización`);
}

// La simulación que la app hace antes de firmar (estimación de gas en el router), desde una cuenta cualquiera: aquí
// basta con ver que el mirror la atiende (puede revertir, porque esa cuenta no tiene el token asociado).
if (buy) {
  const from = longZero("0.0.2");
  const tx = buildSwapTx({ setup, side: "buy", quote: buy.best, minOut: 1n, recipient: from, routerV2Evm: longZero(setup.routerV2), deadline: Math.floor(Date.now() / 1000) + 900 });
  const est = await estimateSwapGas(watched, { from, to: longZero(tx.contractId), data: tx.data, value: tx.payableTinybars, venue: buy.best.venue });
  const reached = est.estimated || est.revert != null;
  console.log(`\nSimulación en el router ${buy.best.venue}: ${seen.router.join(" → ") || "—"} · ${est.estimated ? `gas estimado ${est.gas}` : est.revert ? `revierte (normal desde esta cuenta): ${est.revert.slice(0, 80)}` : "⚠️ el mirror no la atiende"}`);
  if (!reached) console.log("   La app pediría confirmar el cambio sin simulación.");
}

const refused = seen.quoter.some((s) => s === "429");
console.log(
  `\nQuoterV2: ${seen.quoter.length ? seen.quoter.join(", ") : "no se ha usado"}` +
    (refused ? " (el mirror lo rechaza)" : "") +
    (seen.pool ? ` · V2 cotizada con el estado de la pool (${seen.pool} lecturas)` : ""),
);
const v2 = buy?.all.some((q) => q.venue === "V2");
if (pools.some((p) => p.venue === "V2") && !v2) {
  console.log("⛔ La V2 no ha cotizado");
  process.exit(1);
}
console.log(v2 ? "✅ La V2 cotiza" : "ℹ️ Este token no tiene pool V2");
