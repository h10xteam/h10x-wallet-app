#!/usr/bin/env node
// Prueba de las acciones tokenizadas (fase 3) contra SODAX y el mirror público de MAINNET. Lo ejecuta el usuario hvault
// (desde root: «hvault-vps acciones»). Solo lee: no firma, no envía nada y no usa ninguna clave de la bóveda.
//
//   1. la lista de acciones: ¿está en SODAX? ¿pasa la comprobación en la red?
//   2. cotizaciones con HBAR y con USDC, y la vuelta (vender lo comprado);
//   3. SODAX prepara tres intenciones para una dirección de prueba creada al momento (sin fondos y sin guardar su
//      llave) y la app las comprueba como lo haría antes de firmar.
// Deja el detalle en informe-acciones.json (sin secretos: la dirección de prueba se tira al acabar).
import { writeFileSync } from "node:fs";
import { Wallet } from "ethers";
import { NETWORKS } from "../core/src/config.js";
import { Mirror } from "../core/src/mirror.js";
import { SODAX, STOCK_PAY, STOCK_TOKENS, checkStockToken, hubWalletAddress, inspectIntentBuild, sodaxApi, stockAddress, verifyIntentBuild } from "../core/src/stocks.js";
// Uso: node scripts/acciones.mjs [--datos]   (--datos: saca también la transacción preparada, para revisarla)
const showData = process.argv.includes("--datos");

const mirror = new Mirror(NETWORKS.mainnet.mirror);
const api = sodaxApi();
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** @param {bigint} v @param {number} d */
const fmt = (v, d) => (Number(v) / 10 ** d).toLocaleString("es-ES", { maximumFractionDigits: 8 });
/** @type {any} */
const report = { when: new Date().toISOString(), tokens: [], quotes: [], builds: [] };
let bad = 0;

// 1. Lista.
console.log("── 1. Acciones de la lista: SODAX y comprobación en la red");
let sodaxTokens = [];
try {
  sodaxTokens = await api.tokens();
} catch (e) {
  console.log(`⛔ No se pudo leer la lista de SODAX: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
const inSodax = new Set(sodaxTokens.map((t) => t.address));
const liveHub = new Map(sodaxTokens.map((t) => [t.address, t.hubAsset]));
let hubBad = 0;
for (const p of Object.values(STOCK_PAY)) {
  if (liveHub.get(p.address) !== p.hub) {
    hubBad++;
    console.log(`   ⛔ ${p.symbol}: su activo en el hub no es el fijado en la app (${liveHub.get(p.address) ?? "no está"})`);
  }
}
let listed = 0;
for (const e of STOCK_TOKENS) {
  const info = await mirror.tokenInfo(e.id, { fresh: true }).catch(() => null);
  const c = checkStockToken(e, info);
  const there = inSodax.has(stockAddress(e.id));
  const hubOk = liveHub.get(stockAddress(e.id)) === e.hub;
  if (there && !hubOk) {
    hubBad++;
    c.problems.push("su activo en el hub no es el fijado en la app");
  }
  const ok = c.ok && there && hubOk;
  if (ok) listed++;
  else bad++;
  report.tokens.push({ symbol: e.symbol, id: e.id, sodax: there, ok: c.ok, problems: c.problems });
  if (!ok) console.log(`   ⛔ ${e.symbol.padEnd(6)} ${e.id}  ${there ? "" : "no está en SODAX · "}${c.problems.join(" · ")}`);
}
console.log(`${listed === STOCK_TOKENS.length ? "✅" : "⛔"} ${listed} de ${STOCK_TOKENS.length} acciones en SODAX y comprobadas (también su activo en el hub)`);
if (hubBad) bad++;
const extra = sodaxTokens.filter((t) => /^0x0{24}/.test(t.address) && !STOCK_TOKENS.some((e) => stockAddress(e.id) === t.address));
if (extra.length) console.log(`   (en SODAX y fuera de la lista: ${extra.map((t) => t.symbol).join(", ")})`);

// 2. Cotizaciones.
console.log("\n── 2. Cotizaciones");
const HBAR = STOCK_PAY.HBAR.address;
const USDC = STOCK_PAY.USDC.address;
const AAPL = STOCK_TOKENS.find((t) => t.symbol === "AAPL");
if (!AAPL) throw new Error("falta AAPL");
const aapl = stockAddress(AAPL.id);
/** @param {string} label @param {string} a @param {string} b @param {bigint} amount @param {number} dIn @param {number} dOut */
const q = async (label, a, b, amount, dIn, dOut) => {
  await sleep(350);
  try {
    const out = await api.quote({ tokenSrc: a, tokenDst: b, amount });
    report.quotes.push({ label, amount: amount.toString(), out: out.toString() });
    console.log(`   ✓ ${label}: ${fmt(amount, dIn)} → ${fmt(out, dOut)}`);
    return out;
  } catch (e) {
    report.quotes.push({ label, amount: amount.toString(), error: e instanceof Error ? e.message : String(e) });
    console.log(`   ✗ ${label}: ${fmt(amount, dIn)} → sin cotización (${e instanceof Error ? e.message : e})`);
    return null;
  }
};
// Mínimo: con cuánto HBAR empieza a cotizar.
for (const h of [5n, 20n, 100n, 1000n]) await q("HBAR→AAPL", HBAR, aapl, h * 100_000_000n, 8, 8);
const got = await q("HBAR→AAPL (para vender)", HBAR, aapl, 200n * 100_000_000n, 8, 8);
const back = got ? await q("AAPL→HBAR (vuelta)", aapl, HBAR, got, 8, 8) : null;
if (back != null) console.log(`   ida y vuelta con 200 HBAR: vuelven ${fmt(back, 8)} HBAR (${((1 - Number(back) / 2e10) * 100).toFixed(2)} % entre comisiones y precio)`);
await q("USDC→AAPL", USDC, aapl, 10_000_000n, 6, 8);
if (got) await q("AAPL→USDC", aapl, USDC, got, 8, 6);
let quoted = 0;
console.log("   100 HBAR en cada acción:");
for (const e of STOCK_TOKENS) {
  const out = await q(`   HBAR→${e.symbol}`, HBAR, stockAddress(e.id), 100n * 100_000_000n, 8, 8);
  if (out && out > 0n) quoted++;
}
console.log(`${quoted === STOCK_TOKENS.length ? "✅" : "⚠️"} cotizan ${quoted} de ${STOCK_TOKENS.length} (si el mercado está cerrado, algunas pueden no cotizar)`);

// 3. Intenciones preparadas por SODAX para una dirección de prueba (no se firma nada).
console.log("\n── 3. Intenciones preparadas por SODAX y comprobadas como antes de firmar");
const probe = Wallet.createRandom().address.toLowerCase();
const nowS = () => Math.floor(Date.now() / 1000);
/** @param {string} label @param {string} pay @param {string} out @param {bigint} amount @param {bigint} minOut */
const build = async (label, pay, out, amount, minOut) => {
  await sleep(400);
  /** @type {any} */
  const r = { label };
  try {
    const built = await api.buildIntent({ inputToken: pay, outputToken: out, inputAmount: amount, minOutputAmount: minOut, deadline: nowS() + 600, srcAddress: probe, dstAddress: probe });
    const x = inspectIntentBuild(built);
    const hub = x.transfer && hubWalletAddress(SODAX.hederaChainId, probe) === x.transfer.to;
    const v = verifyIntentBuild(built, { payToken: pay, outputToken: out, inputAmount: amount, minOutputAmount: minOut, srcAddress: probe, dstAddress: probe, hbarIn: pay === HBAR });
    r.ok = v.ok;
    r.problems = v.problems;
    r.hubWalletOk = !!hub;
    r.tx = { to: built.tx.to, from: built.tx.from ?? null, value: built.tx.value ?? null, dataBytes: (built.tx.data.length - 2) / 2, data: built.tx.data };
    r.intent = built.intent;
    r.relayData = built.relayData;
    r.decoded = { selector: x.selector, transfer: x.transfer ? { token: x.transfer.token, to: x.transfer.to, amount: x.transfer.amount.toString(), dataBytes: (x.transfer.data.length - 2) / 2 } : null, hookCalls: x.hookCalls?.map((/** @type {any} */ c) => ({ addr: c.addr, value: c.value.toString(), selector: c.selector, bytes: (c.data.length - 2) / 2 })) ?? null, hookBytes20: x.hookBytes20 };
    console.log(`${v.ok ? "✅" : "⛔"} ${label}: ${v.ok ? "todo cuadra" : v.problems.join(" · ")}`);
    console.log(`      contrato ${built.tx.to} · valor ${built.tx.value ?? "0"} · ${r.tx.dataBytes} bytes · cartera del hub ${hub ? "calculada en la app ✓" : "distinta de la calculada ✗"}`);
    console.log(`      intención: srcChain ${built.intent.srcChain} · dstChain ${built.intent.dstChain} · entrada ${built.intent.inputToken} · salida ${built.intent.outputToken} · creador ${built.intent.creator}`);
    console.log(`      llamadas en el hub: ${r.decoded.hookCalls ? r.decoded.hookCalls.map((/** @type {any} */ c) => `${c.addr.slice(0, 10)}…${c.selector}`).join(" · ") : "no se han podido leer"} · direcciones dentro: ${x.hookBytes20.length}`);
    if (!v.ok) bad++;
  } catch (e) {
    r.error = e instanceof Error ? e.message : String(e);
    console.log(`⛔ ${label}: SODAX no la prepara (${r.error})`);
    bad++;
  }
  report.builds.push(r);
};
const buyMin = got ? (got * 97n) / 100n : 1n;
await build("Comprar AAPL con 200 HBAR", HBAR, aapl, 200n * 100_000_000n, buyMin);
await build("Comprar AAPL con 10 USDC", USDC, aapl, 10_000_000n, 1n);
if (got) await build("Vender AAPL por HBAR", aapl, HBAR, got, back ? (back * 97n) / 100n : 1n);

const file = new URL("../informe-acciones.json", import.meta.url);
writeFileSync(file, JSON.stringify(report, null, 2));
// Para revisar la codificación: la transacción de la primera intención tal cual (dirección de prueba, sin fondos).
const first = report.builds.find((/** @type {any} */ b) => b.tx);
if (first && showData) {
  console.log(`\n── Datos de «${first.label}» (para revisar):`);
  console.log(JSON.stringify({ intent: first.intent, relayData: first.relayData, value: first.tx.value, from: first.tx.from }));
  console.log(first.tx.data);
}
console.log(`\n${bad === 0 ? "✅ Todo correcto" : `⚠️ ${bad} cosa(s) a revisar`} · detalle en ${file.pathname} · contrato SODAX ${SODAX.assetManagerId}`);
process.exit(bad === 0 ? 0 : 1);
