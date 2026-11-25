// Swap HBAR ↔ token en SaucerSwap (core/src/swap.js) y compra con tarjeta (core/src/onramp.js), SIN red.
//
// Las llamadas de lectura se comprueban byte a byte contra las que se hicieron de verdad el 19-nov-2026 a SaucerSwap
// (mainnet: WHBAR/H10X; testnet: WHBAR/SAUCE) por eth_call, y sus respuestas reales se decodifican aquí. El resto
// (elegir pool, impacto, mínimo, transacciones y el flujo de swapFromPocket) va contra un mirror simulado.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AbiCoder, Interface, getAddress } from "ethers";
import { AccountAllowanceApproveTransaction, AccountId, ContractExecuteTransaction, TokenAssociateTransaction } from "@hiero-ledger/sdk";
import {
  HBAR,
  KNOWN_POOLS,
  SAUCERSWAP,
  SWAP_DEFAULT_TOKEN,
  SWAP_GAS_FALLBACK,
  QUOTE_GAS,
  SWAP_GAS_RETRY,
  isRateLimited,
  bestSwapQuote,
  buildSwapTx,
  decodeSwapAmountOut,
  estimateSwapGas,
  findSwapPools,
  isMinOutRevert,
  longZero,
  onrampHost,
  onrampUrl,
  priceImpactPct,
  quotePool,
  revertReasonFromMirror,
  swapFromPocket,
  swapMinOut,
  swapSetup,
  swapFailureCostTinybars,
  v1Router,
  v2Router,
} from "@boveda/core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coder = AbiCoder.defaultAbiCoder();

// ---- Llamadas reales del 19-nov-2026 ----------------------------------------------------------------
const REAL = {
  mainnet: {
    getPair: {
      to: "0x0000000000000000000000000000000000103780",
      data: "0xe6a439050000000000000000000000000000000000000000000000000000000000163b5a0000000000000000000000000000000000000000000000000000000000a66f5c",
      result: "0x000000000000000000000000e22466ad145dc52ca813767d35f62ccf0d5d9a0c",
    },
    getPool3000: {
      to: "0x00000000000000000000000000000000003c3951",
      data: "0x1698ee820000000000000000000000000000000000000000000000000000000000163b5a0000000000000000000000000000000000000000000000000000000000a66f5c0000000000000000000000000000000000000000000000000000000000000bb8",
      result: "0x0000000000000000000000002b594ee52b87616c7f59c83901949e4300c08cf0",
    },
    getAmountsOut: {
      to: "0x00000000000000000000000000000000002e7a5d",
      data: "0xd06ca61f0000000000000000000000000000000000000000000000000000000005f5e100000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000163b5a0000000000000000000000000000000000000000000000000000000000a66f5c",
      result:
        "0x000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000005f5e100000000000000000000000000000000000000000000000000000000000087ecc7",
    },
    quote3000: {
      to: "0x00000000000000000000000000000000003c4370",
      data: "0xcdca175300000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000005f5e100000000000000000000000000000000000000000000000000000000000000002b0000000000000000000000000000000000163b5a000bb80000000000000000000000000000000000a66f5c000000000000000000000000000000000000000000",
      result:
        "0x000000000000000000000000000000000000000000000000000000000087b136000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000130b0000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000004c74a3889c20aea9009a3a0300000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000",
    },
  },
  testnet: {
    getAmountsOut: {
      to: "0x0000000000000000000000000000000000004b40",
      data: "0xd06ca61f0000000000000000000000000000000000000000000000000000000005f5e100000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000003ad20000000000000000000000000000000000000000000000000000000000120f46",
      result:
        "0x000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000005f5e1000000000000000000000000000000000000000000000000000000000003684355",
    },
    getPool3000: {
      to: "0x00000000000000000000000000000000001243ee",
      data: "0x1698ee820000000000000000000000000000000000000000000000000000000000003ad20000000000000000000000000000000000000000000000000000000000120f460000000000000000000000000000000000000000000000000000000000000bb8",
      result: "0x00000000000000000000000037814edc1ae88cf27c0c346648721fb04e7e0ae7",
    },
  },
};

/** Mirror que responde con las respuestas reales grabadas (y 0x0… a lo demás) y apunta lo que le piden. */
function recordedMirror(net) {
  const calls = [];
  return {
    calls,
    async simulate({ to, data }) {
      calls.push({ to, data });
      const hit = Object.values(REAL[net]).find((c) => c.to === to && c.data === data);
      if (hit) return { ok: true, result: hit.result, error: "" };
      if (data.startsWith("0xe6a43905") || data.startsWith("0x1698ee82")) return { ok: true, result: `0x${"0".repeat(64)}`, error: "" };
      return { ok: false, result: "0x", error: '{"_status":{"messages":[{"message":"CONTRACT_REVERT_EXECUTED"}]}}' };
    },
  };
}

test("SaucerSwap: los contratos y el token por red son los de su documentación", () => {
  assert.deepEqual(SAUCERSWAP.mainnet, { factoryV1: "0.0.1062784", routerV1: "0.0.3045981", factoryV2: "0.0.3946833", routerV2: "0.0.3949434", quoterV2: "0.0.3949424", whbar: "0.0.1456986" });
  assert.deepEqual(SAUCERSWAP.testnet, { factoryV1: "0.0.9959", routerV1: "0.0.19264", factoryV2: "0.0.1197038", routerV2: "0.0.1414040", quoterV2: "0.0.1390002", whbar: "0.0.15058" });
  assert.equal(SWAP_DEFAULT_TOKEN.mainnet, "0.0.10907484", "mainnet: H10X");
  assert.equal(SWAP_DEFAULT_TOKEN.testnet, "0.0.1183558", "testnet: SAUCE (H10X no tiene pool con HBAR en testnet)");
  assert.equal(swapSetup("testnet", "0.0.11330320")?.tokenId, "0.0.11330320");
  assert.equal(swapSetup("testnet", "no-vale")?.tokenId, "0.0.1183558");
  assert.equal(swapSetup("testnet", "0.0.15058"), null, "WHBAR contra WHBAR no tiene sentido");
  assert.equal(swapSetup("previewnet"), null);
  assert.equal(swapSetup("local"), null);
});

test("mainnet: las lecturas son byte a byte las que funcionaron y sus respuestas se leen bien", async () => {
  const setup = swapSetup("mainnet");
  const mirror = recordedMirror("mainnet");
  const pools = await findSwapPools(mirror, setup);
  assert.deepEqual(pools, [
    { venue: "V1", address: "0xe22466ad145dc52ca813767d35f62ccf0d5d9a0c" },
    { venue: "V2", address: "0x2b594ee52b87616c7f59c83901949e4300c08cf0", fee: 3000 },
  ]);
  assert.ok(mirror.calls.some((c) => c.data === REAL.mainnet.getPair.data && c.to === REAL.mainnet.getPair.to));
  assert.ok(mirror.calls.some((c) => c.data === REAL.mainnet.getPool3000.data && c.to === REAL.mainnet.getPool3000.to));

  const v1 = await quotePool(mirror, setup, pools[0], "buy", HBAR);
  const v2 = await quotePool(mirror, setup, pools[1], "buy", HBAR);
  assert.equal(v1?.amountOut, 8_907_975n, "1 HBAR → 0,0891 H10X por la V1");
  assert.equal(v2?.amountOut, 8_892_726n, "1 HBAR → 0,0889 H10X por la V2");
  assert.equal(v2?.fee, 3000);
  // Se elige la que más da (la V1 ese día).
  const best = await bestSwapQuote(mirror, setup, pools, "buy", HBAR);
  assert.equal(best?.best.venue, "V1");
  assert.equal(best?.all.length, 2);
});

test("testnet: SAUCE (6 decimales) por la V1 y la pool V2 al 0,3 %", async () => {
  const setup = swapSetup("testnet");
  const mirror = recordedMirror("testnet");
  const pools = await findSwapPools(mirror, setup);
  assert.deepEqual(pools, [{ venue: "V2", address: "0x37814edc1ae88cf27c0c346648721fb04e7e0ae7", fee: 3000 }], "la V1 grabada no está en esta prueba: solo la V2");
  const q = await quotePool(mirror, setup, { venue: "V1", address: "0x00" }, "buy", HBAR);
  assert.equal(q?.amountOut, 57_164_629n, "1 HBAR → 57,16 SAUCE");
});

// ---- Mirror simulado con pools x·y=k -----------------------------------------------------------------

const r1 = new Interface(["function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)"]);
const qv2 = new Interface(["function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] a, uint32[] b, uint256 c)"]);

/** Pools de juguete: V1 con 1.000.000 HBAR / 90.000 token y V2 (más profunda pero con 0,3 %). */
function modelMirror(setup, { v1 = true, v2 = true, revertEstimate = null, held = [] } = {}) {
  const w = longZero(setup.whbar).toLowerCase();
  const reserves = { V1: [1_000_000n * HBAR, 90_000n * HBAR], V2: [3_000_000n * HBAR, 269_000n * HBAR] };
  const out = (venue, tokenIn, amountIn) => {
    const [rH, rT] = reserves[venue];
    const [rIn, rOut] = tokenIn.toLowerCase() === w ? [rH, rT] : [rT, rH];
    const x = amountIn * 997n;
    return (x * rOut) / (rIn * 1000n + x);
  };
  const results = new Map();
  return {
    calls: [],
    results,
    async simulate({ to, data, estimate }) {
      this.calls.push({ to, data, estimate });
      if (estimate) {
        if (revertEstimate) return { ok: false, result: "0x", error: JSON.stringify({ _status: { messages: [{ message: "CONTRACT_REVERT_EXECUTED", detail: revertEstimate, data: "0x" }] } }) };
        return { ok: true, result: "0x" + (350_000).toString(16), error: "" };
      }
      if (data.startsWith("0xe6a43905")) return { ok: true, result: coder.encode(["address"], [v1 ? "0x00000000000000000000000000000000000a0001" : "0x0000000000000000000000000000000000000000"]), error: "" };
      if (data.startsWith("0x1698ee82")) {
        const [, , fee] = coder.decode(["address", "address", "uint24"], "0x" + data.slice(10));
        return { ok: true, result: coder.encode(["address"], [v2 && Number(fee) === 3000 ? "0x00000000000000000000000000000000000b0003" : "0x0000000000000000000000000000000000000000"]), error: "" };
      }
      if (data.startsWith("0xd06ca61f")) {
        const [amountIn, p] = r1.decodeFunctionData("getAmountsOut", data);
        return { ok: true, result: r1.encodeFunctionResult("getAmountsOut", [[amountIn, out("V1", p[0], amountIn)]]), error: "" };
      }
      if (data.startsWith("0xcdca1753")) {
        const [p, amountIn] = qv2.decodeFunctionData("quoteExactInput", data);
        const tokenIn = "0x" + p.slice(2, 42);
        return { ok: true, result: qv2.encodeFunctionResult("quoteExactInput", [out("V2", tokenIn, amountIn), [], [], 0]), error: "" };
      }
      return { ok: false, result: "0x", error: "?" };
    },
    async accountTokens() {
      return held.map((tokenId) => ({ tokenId }));
    },
    async contractEvmAddress(id) {
      return longZero(id);
    },
    async contractResult(txId) {
      return results.get(txId) ?? null;
    },
  };
}

test("elige la pool que más da, calcula el impacto y el mínimo", async () => {
  const setup = swapSetup("mainnet");
  const mirror = modelMirror(setup);
  const pools = await findSwapPools(mirror, setup);
  assert.deepEqual(pools.map((p) => p.venue), ["V1", "V2"]);
  const small = await bestSwapQuote(mirror, setup, pools, "buy", 10n * HBAR);
  assert.ok(small);
  assert.ok(small.impactPct != null && small.impactPct < 0.01, "10 HBAR apenas mueven el precio");
  const big = await bestSwapQuote(mirror, setup, pools, "buy", 200_000n * HBAR);
  assert.equal(big?.best.venue, "V2", "con mucho importe gana la pool más profunda");
  assert.ok(big.impactPct > 5, `impacto alto con 200.000 HBAR (${big.impactPct})`);
  assert.equal(swapMinOut(1_000_000n, 100), 990_000n);
  assert.equal(swapMinOut(1_000_000n, 50), 995_000n);
  assert.throws(() => swapMinOut(1n, 0));
  assert.throws(() => swapMinOut(1n, 5000));
  assert.equal(priceImpactPct({ amountIn: 100n, amountOut: 90n }, { amountIn: 1n, amountOut: 1n }).toFixed(6), "10.000000");
  // Sin pools: no hay cotización
  const none = modelMirror(setup, { v1: false, v2: false });
  assert.deepEqual(await findSwapPools(none, setup), []);
  assert.equal(await bestSwapQuote(none, setup, [], "buy", HBAR), null);
});

test("transacciones: compra y venta, V1 y V2, como las de la web de H10X", () => {
  const setup = swapSetup("mainnet");
  const user = longZero("0.0.4242");
  const router = "0x00000000000000000000000000000000003c437a";
  const base = { setup, minOut: 900n, recipient: user, routerV2Evm: router, deadline: 1_800_000_000 };
  const W = getAddress(longZero(setup.whbar));
  const T = getAddress(longZero(setup.tokenId));

  // V2 compra: multicall(exactInput WHBAR→token al usuario, refundETH) con el HBAR como importe
  let tx = buildSwapTx({ ...base, side: "buy", quote: { venue: "V2", fee: 3000, address: "0x", amountIn: 1000n, amountOut: 950n } });
  assert.equal(tx.contractId, "0.0.3949434");
  assert.equal(tx.payableTinybars, 1000n);
  assert.equal(tx.approve, null);
  let [calls] = v2Router.decodeFunctionData("multicall", tx.data);
  let [p] = v2Router.decodeFunctionData("exactInput", calls[0]);
  assert.equal(p.recipient, getAddress(user));
  assert.equal(p.amountOutMinimum, 900n);
  assert.equal(p.path.toLowerCase(), (W + "000bb8" + T.slice(2)).toLowerCase());
  assert.equal(calls[1], v2Router.encodeFunctionData("refundETH", []));

  // V2 venta: permiso exacto, WHBAR al router y unwrapWHBAR(mínimo, usuario)
  tx = buildSwapTx({ ...base, side: "sell", quote: { venue: "V2", fee: 3000, address: "0x", amountIn: 1000n, amountOut: 950n } });
  assert.equal(tx.payableTinybars, 0n);
  assert.deepEqual(tx.approve, { tokenId: setup.tokenId, spenderId: "0.0.3949434", amount: 1000n });
  [calls] = v2Router.decodeFunctionData("multicall", tx.data);
  [p] = v2Router.decodeFunctionData("exactInput", calls[0]);
  assert.equal(p.recipient, getAddress(router), "el WHBAR va al router para desenvolverlo");
  assert.deepEqual([...v2Router.decodeFunctionData("unwrapWHBAR", calls[1])], [900n, getAddress(user)]);

  // V1 compra y venta
  tx = buildSwapTx({ ...base, side: "buy", quote: { venue: "V1", fee: 3000, address: "0x", amountIn: 1000n, amountOut: 950n } });
  assert.equal(tx.contractId, "0.0.3045981");
  assert.equal(tx.payableTinybars, 1000n);
  const b = v1Router.decodeFunctionData("swapExactETHForTokens", tx.data);
  assert.deepEqual([b[0], [...b[1]], b[2]], [900n, [W, T], getAddress(user)]);
  tx = buildSwapTx({ ...base, side: "sell", quote: { venue: "V1", fee: 3000, address: "0x", amountIn: 1000n, amountOut: 950n } });
  assert.deepEqual(tx.approve, { tokenId: setup.tokenId, spenderId: "0.0.3045981", amount: 1000n });
  const s = v1Router.decodeFunctionData("swapExactTokensForETH", tx.data);
  assert.deepEqual([s[0], s[1], [...s[2]], s[3]], [1000n, 900n, [T, W], getAddress(user)]);

  assert.throws(() => buildSwapTx({ ...base, side: "buy", quote: { venue: "V2", fee: 777, address: "0x", amountIn: 1n, amountOut: 1n } }));
  assert.throws(() => buildSwapTx({ ...base, minOut: 0n, side: "buy", quote: { venue: "V1", fee: 3000, address: "0x", amountIn: 1n, amountOut: 1n } }));
});

test("gas, reverts y lo recibido", async () => {
  const setup = swapSetup("mainnet");
  const ok = await estimateSwapGas(modelMirror(setup), { from: "0x1", to: "0x2", data: "0x", value: 0n, venue: "V2" });
  assert.equal(ok.gas, Math.ceil(350_000 * 1.3));
  assert.equal(ok.revert, null);
  const bad = await estimateSwapGas(modelMirror(setup, { revertEstimate: "Too little received" }), { from: "0x1", to: "0x2", data: "0x", value: 0n, venue: "V2" });
  assert.equal(bad.revert, "Too little received");
  assert.ok(isMinOutRevert(bad.revert));
  const net = await estimateSwapGas({ simulate: async () => ({ ok: false, result: "0x", error: "HTTP 429" }) }, { from: "0x1", to: "0x2", data: "0x", value: 0n, venue: "V1" });
  assert.deepEqual(net, { gas: SWAP_GAS_FALLBACK.V1, estimated: false, revert: null }, "un fallo de red no es un revert");
  const err = "0x08c379a0" + coder.encode(["string"], ["UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT"]).slice(2);
  assert.equal(revertReasonFromMirror(JSON.stringify({ _status: { messages: [{ message: "CONTRACT_REVERT_EXECUTED", data: err }] } })), "UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT");
  assert.ok(isMinOutRevert("UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT"));
  assert.ok(!isMinOutRevert("STF"));
  const v2res = v2Router.encodeFunctionResult("multicall", [[coder.encode(["uint256"], [12345n]), "0x"]]);
  assert.equal(decodeSwapAmountOut("V2", v2res), 12345n);
  assert.equal(decodeSwapAmountOut("V1", coder.encode(["uint256[]"], [[1n, 777n]])), 777n);
  assert.equal(decodeSwapAmountOut("V1", "0x"), null);
});

// ---- swapFromPocket con un «submit» de mentira --------------------------------------------------------

function fakeSubmit({ failContract = false } = {}) {
  const sent = [];
  let n = 0;
  return {
    sent,
    async submitTx(_client, tx) {
      sent.push(tx);
      const txId = `0.0.4242@1800000000.${String(++n).padStart(9, "0")}`;
      const isContract = tx instanceof ContractExecuteTransaction;
      if (isContract && failContract) return { ok: false, status: "CONTRACT_REVERT_EXECUTED", txId };
      return { ok: true, status: "SUCCESS", txId };
    },
  };
}
// El SDK viene minificado: el nombre de la clase no sirve, se compara con instanceof.
const kinds = (sent) =>
  sent.map((t) =>
    t instanceof TokenAssociateTransaction ? "TokenAssociateTransaction" : t instanceof AccountAllowanceApproveTransaction ? "AccountAllowanceApproveTransaction" : t instanceof ContractExecuteTransaction ? "ContractExecuteTransaction" : "?",
  );
const noSleep = async () => {};

test("compra: asocia el token si hace falta y manda el HBAR al router", async () => {
  const setup = swapSetup("mainnet");
  const mirror = modelMirror(setup);
  const pools = await findSwapPools(mirror, setup);
  const q = await bestSwapQuote(mirror, setup, pools, "buy", 100n * HBAR);
  const sub = fakeSubmit();
  const out = await swapFromPocket({ client: /** @type {any} */ ({}), accountId: AccountId.fromString("0.0.4242"), mirror, setup, pools, side: "buy", amountIn: 100n * HBAR, agreedOut: q.best.amountOut, slippageBps: 100, submitTx: sub.submitTx, sleep: noSleep });
  assert.deepEqual(kinds(sub.sent), ["TokenAssociateTransaction", "ContractExecuteTransaction"]);
  const call = sub.sent[1];
  assert.equal(call.contractId.toString(), q.best.venue === "V2" ? "0.0.3949434" : "0.0.3045981");
  assert.equal(call.payableAmount.toTinybars().toString(), (100n * HBAR).toString());
  assert.equal(Number(call.gas), Math.ceil(350_000 * 1.3));
  assert.equal(out.minOut, swapMinOut(q.best.amountOut, 100));

  // Con el token ya asociado, no se vuelve a asociar.
  const sub2 = fakeSubmit();
  await swapFromPocket({ client: /** @type {any} */ ({}), accountId: AccountId.fromString("0.0.4242"), mirror: modelMirror(setup, { held: [setup.tokenId] }), setup, pools, side: "buy", amountIn: 100n * HBAR, agreedOut: q.best.amountOut, slippageBps: 100, submitTx: sub2.submitTx, sleep: noSleep });
  assert.deepEqual(kinds(sub2.sent), ["ContractExecuteTransaction"]);
});

test("venta: permiso exacto (nunca ilimitado) y, si el cambio falla, se quita", async () => {
  const setup = swapSetup("mainnet");
  const mirror = modelMirror(setup, { held: [setup.tokenId] });
  const pools = await findSwapPools(mirror, setup);
  const amountIn = 50n * HBAR;
  const q = await bestSwapQuote(mirror, setup, pools, "sell", amountIn);
  const sub = fakeSubmit();
  await swapFromPocket({ client: /** @type {any} */ ({}), accountId: AccountId.fromString("0.0.4242"), mirror, setup, pools, side: "sell", amountIn, agreedOut: q.best.amountOut, slippageBps: 100, submitTx: sub.submitTx, sleep: noSleep });
  assert.deepEqual(kinds(sub.sent), ["AccountAllowanceApproveTransaction", "ContractExecuteTransaction"]);
  const approval = sub.sent[0].tokenApprovals[0];
  assert.equal(approval.amount.toString(), amountIn.toString(), "permiso por la cantidad exacta");
  assert.equal(approval.spenderAccountId.toString(), q.best.venue === "V2" ? "0.0.3949434" : "0.0.3045981");
  assert.equal(sub.sent[1].payableAmount?.toTinybars().toString() ?? "0", "0");

  const failing = fakeSubmit({ failContract: true });
  await assert.rejects(
    swapFromPocket({ client: /** @type {any} */ ({}), accountId: AccountId.fromString("0.0.4242"), mirror, setup, pools, side: "sell", amountIn, agreedOut: q.best.amountOut, slippageBps: 100, submitTx: failing.submitTx, sleep: noSleep }),
    /El cambio no ha salido|swap failed/,
  );
  assert.deepEqual(kinds(failing.sent), ["AccountAllowanceApproveTransaction", "ContractExecuteTransaction", "AccountAllowanceApproveTransaction"]);
  assert.equal(failing.sent[2].tokenApprovals[0].amount.toString(), "0", "el permiso se deja a 0");
});

test("no firma si el precio ya se ha movido o si la simulación revierte", async () => {
  const setup = swapSetup("mainnet");
  const mirror = modelMirror(setup, { held: [setup.tokenId] });
  const pools = await findSwapPools(mirror, setup);
  const q = await bestSwapQuote(mirror, setup, pools, "buy", 100n * HBAR);
  const sub = fakeSubmit();
  await assert.rejects(
    swapFromPocket({ client: /** @type {any} */ ({}), accountId: AccountId.fromString("0.0.4242"), mirror, setup, pools, side: "buy", amountIn: 100n * HBAR, agreedOut: q.best.amountOut * 2n, slippageBps: 100, submitTx: sub.submitTx, sleep: noSleep }),
    (e) => e.status === "PRICE_MOVED",
  );
  assert.equal(sub.sent.length, 0, "nada enviado");

  const reverting = modelMirror(setup, { held: [setup.tokenId], revertEstimate: "Too little received" });
  const sq = await bestSwapQuote(reverting, setup, pools, "sell", 10n * HBAR);
  const sub2 = fakeSubmit();
  await assert.rejects(
    swapFromPocket({ client: /** @type {any} */ ({}), accountId: AccountId.fromString("0.0.4242"), mirror: reverting, setup, pools, side: "sell", amountIn: 10n * HBAR, agreedOut: sq.best.amountOut, slippageBps: 100, submitTx: sub2.submitTx, sleep: noSleep }),
    (e) => e.status === "SIMULATION_REVERT",
  );
  assert.deepEqual(kinds(sub2.sent), ["AccountAllowanceApproveTransaction", "AccountAllowanceApproveTransaction"], "permiso dado y quitado; el cambio no se envía");
});

// ---- Comprar con tarjeta (apagado) ------------------------------------------------------------------

test("comprar con tarjeta: apagado sin configurar; solo https y con la Cartera puesta", () => {
  assert.equal(onrampUrl(null, { address: "0.0.4242", network: "testnet" }), null);
  assert.equal(onrampUrl("https://proveedor.example/compra", { address: "0.0.4242", network: "testnet" }), null, "sin {address} no vale");
  assert.equal(onrampUrl("http://proveedor.example/?w={address}", { address: "0.0.4242", network: "testnet" }), null, "solo https");
  assert.equal(onrampUrl("https://user:pass@proveedor.example/?w={address}", { address: "0.0.4242", network: "testnet" }), null);
  assert.equal(onrampUrl("https://proveedor.example/?w={address}", { address: "0.0.4242&x=1", network: "testnet" }), null);
  const url = onrampUrl("https://www.proveedor.example/buy?wallet={address}&net={network}&crypto=HBAR", { address: "0.0.4242", network: "testnet" });
  assert.equal(url, "https://www.proveedor.example/buy?wallet=0.0.4242&net=testnet&crypto=HBAR");
  assert.equal(onrampHost(url), "proveedor.example");
});

test("la app: pestaña Cambiar, sin comisiones propias y el swap solo desde la Cartera", () => {
  const ui = fs.readFileSync(path.join(ROOT, "app/src/ui.tsx"), "utf8");
  assert.match(ui, /export type Tab = "home" \| "swap" \|/);
  assert.match(ui, /key: "swap", label: t\("Cambiar", "Swap"\), icon: "arrow\.left\.arrow\.right"/);
  const app = fs.readFileSync(path.join(ROOT, "app/App.tsx"), "utf8");
  assert.match(app, /case "swap":\n\s+return <SwapHome/);
  const screen = fs.readFileSync(path.join(ROOT, "app/src/screens/Swap.tsx"), "utf8");
  assert.match(screen, /withPocket\(\(\{ client, accountId \}\) =>\s+swapFromPocket\(/);
  assert.doesNotMatch(screen, /FEE_COLLECTOR|serviceFees/, "el swap no cobra comisión de H10X Wallet");
  assert.match(screen, /IMPACT_CONFIRM_PCT/);
  const core = fs.readFileSync(path.join(ROOT, "core/src/swap.js"), "utf8");
  assert.doesNotMatch(core, /MaxUint256|2n \*\* 256n|approveTokenAllowance\([^)]*MAX/i, "nunca permisos ilimitados");
  const onboarding = fs.readFileSync(path.join(ROOT, "app/src/screens/Onboarding.tsx"), "utf8");
  assert.match(onboarding, /<LanguageSwitch \/>/, "el idioma se elige ya en la primera pantalla");
});

// ---- 0.9.4: pools que no desaparecen, otra pool u otro remitente si la simulación falla ------------------

const SAFE_FAIL = JSON.stringify({ _status: { messages: [{ message: "CONTRACT_REVERT_EXECUTED", detail: "Safe token transfer failed!", data: "0x" }] } });
const v1Selector = v1Router.getFunction("swapExactETHForTokens").selector;

/**
 * El mirror de juguete con fallos a medida: búsquedas que fallan por red las primeras `lookupFails` veces,
 * simulaciones que revierten según el router o el remitente, y la cuenta con dirección EVM propia.
 */
function flakyMirror(setup, { lookupFails = 0, quoteFails = 0, v1QuotesDown = false, revertWhen = () => false, evm = null, held = [setup.tokenId], gasPrice = 154n } = {}) {
  const base = modelMirror(setup, { held });
  let lookups = 0;
  let quotes = 0;
  const sims = [];
  return {
    ...base,
    sims,
    async simulate(p) {
      const d = p.data;
      if ((d.startsWith("0xe6a43905") || d.startsWith("0x1698ee82")) && lookups++ < lookupFails) return { ok: false, result: "0x", error: "HTTP 429 Too Many Requests" };
      if (v1QuotesDown && d.startsWith("0xd06ca61f")) return { ok: false, result: "0x", error: "HTTP 503" };
      if ((d.startsWith("0xd06ca61f") || d.startsWith("0xcdca1753")) && quotes++ < quoteFails) return { ok: false, result: "0x", error: "HTTP 503" };
      if (p.estimate) {
        sims.push({ from: p.from, to: p.to, data: d });
        if (revertWhen(p)) return { ok: false, result: "0x", error: SAFE_FAIL };
      }
      return base.simulate.call(base, p);
    },
    async account() {
      return { evmAddress: evm ?? longZero("0.0.4242") };
    },
    async contractGasPrice() {
      return gasPrice;
    },
  };
}
const ALIAS = "0x1faa4c25af89402855d3577778da41bc74a3f048";
const routerOf = (venue) => longZero(venue === "V1" ? "0.0.3045981" : "0.0.3949434");

test("0.9.4: si la fábrica no contesta, se repite; y si sigue sin contestar, la pool conocida de H10X", async () => {
  const setup = swapSetup("mainnet");
  const slept = [];
  const sleep = async (ms) => void slept.push(ms);
  // 5 búsquedas a la vez fallan; al repetirlas de una en una contestan.
  const pools = await findSwapPools(flakyMirror(setup, { lookupFails: 5 }), setup, { sleep });
  assert.deepEqual(pools.map((p) => p.venue), ["V1", "V2"]);
  assert.equal(slept.length, 5, "una pausa por cada búsqueda repetida");
  // No contesta nunca: se usan las pools de H10X apuntadas, y nada más.
  const dead = await findSwapPools(flakyMirror(setup, { lookupFails: 1000 }), setup, { sleep });
  assert.deepEqual(dead, [
    { venue: "V1", address: KNOWN_POOLS.mainnet["0.0.10907484"][0].address },
    { venue: "V2", address: KNOWN_POOLS.mainnet["0.0.10907484"][1].address, fee: 3000 },
  ]);
  // Si la fábrica contesta que no hay pool, manda ella aunque esté apuntada.
  assert.deepEqual(await findSwapPools(modelMirror(setup, { v1: false, v2: false }), setup, { sleep }), []);
  // Otro token sin pools apuntadas: si no contesta, no se inventa nada.
  const other = swapSetup("mainnet", "0.0.1183558");
  assert.deepEqual(await findSwapPools(flakyMirror(other, { lookupFails: 1000 }), other, { sleep }), []);
});

test("0.9.4: una cotización que falla por red se repite; un revert, no", async () => {
  const setup = swapSetup("mainnet");
  const pools = await findSwapPools(modelMirror(setup), setup);
  const sleep = async () => {};
  const q = await quotePool(flakyMirror(setup, { quoteFails: 2 }), setup, pools[1], "buy", 10n * HBAR, { sleep });
  assert.ok(q && q.venue === "V2", "a la tercera contesta");
  const gone = await quotePool(flakyMirror(setup, { quoteFails: 3 }), setup, pools[1], "buy", 10n * HBAR, { sleep });
  assert.equal(gone, null);
  let calls = 0;
  const reverting = { simulate: async () => (calls++, { ok: false, result: "0x", error: '{"_status":{"messages":[{"message":"CONTRACT_REVERT_EXECUTED"}]}}' }) };
  assert.equal(await quotePool(reverting, setup, pools[0], "buy", HBAR, { sleep }), null);
  assert.equal(calls, 1, "sin liquidez no se insiste");
  // bestSwapQuote dice qué pools no se pudieron cotizar.
  const both = await bestSwapQuote(flakyMirror(setup, { v1QuotesDown: true }), setup, pools, "buy", 10n * HBAR, { sleep });
  assert.equal(both?.all.length, 1);
  assert.equal(both?.failed.length, 1);
});

test("0.9.4: si la simulación falla con la dirección long-zero, se prueba como remitente la dirección EVM de la cuenta", async () => {
  const setup = swapSetup("mainnet");
  const me = longZero("0.0.4242");
  const mirror = flakyMirror(setup, { evm: ALIAS, revertWhen: (p) => p.from === me });
  const pools = await findSwapPools(mirror, setup);
  const q = await bestSwapQuote(mirror, setup, pools, "buy", 10n * HBAR);
  const sub = fakeSubmit();
  const out = await swapFromPocket({ client: /** @type {any} */ ({}), accountId: AccountId.fromString("0.0.4242"), mirror, setup, pools, side: "buy", amountIn: 10n * HBAR, agreedOut: q.best.amountOut, slippageBps: 100, submitTx: sub.submitTx, sleep: noSleep });
  assert.equal(out.verified, true);
  assert.deepEqual(mirror.sims.map((s) => s.from), [me, ALIAS], "primero la long-zero, después la EVM");
  assert.deepEqual(kinds(sub.sent), ["ContractExecuteTransaction"]);
  // Los tokens siguen yendo a la cuenta 0.0.4242 (su long-zero).
  const data = Buffer.from(sub.sent[0].functionParameters).toString("hex");
  assert.ok(data.includes(me.slice(2)), "el destinatario es la long-zero de la cuenta");
});

test("0.9.4: si una pool no pasa la simulación, se prueba la otra (y en una venta se quita el permiso de la primera)", async () => {
  const setup = swapSetup("mainnet");
  // La V1 siempre revierte; la V2 no.
  const mirror = flakyMirror(setup, { evm: ALIAS, revertWhen: (p) => p.to === routerOf("V1") });
  const pools = await findSwapPools(mirror, setup);
  const amountIn = 10n * HBAR;
  const q = await bestSwapQuote(mirror, setup, pools, "buy", amountIn);
  assert.equal(q.best.venue, "V1", "con poco importe la V1 de juguete da más");
  const sub = fakeSubmit();
  const out = await swapFromPocket({ client: /** @type {any} */ ({}), accountId: AccountId.fromString("0.0.4242"), mirror, setup, pools, side: "buy", amountIn, agreedOut: q.all[1].amountOut, slippageBps: 100, submitTx: sub.submitTx, sleep: noSleep });
  assert.equal(out.venue, "V2");
  assert.equal(sub.sent[0].contractId.toString(), "0.0.3949434");
  assert.equal(mirror.sims.filter((s) => s.to === routerOf("V1")).length, 3, "la V1 con los tres remitentes");

  // Venta: permiso al router de la mejor pool, se quita, permiso al de la otra y el cambio.
  const sq0 = await bestSwapQuote(modelMirror(setup), setup, pools, "sell", amountIn);
  const first = sq0.best.venue;
  const second = first === "V1" ? "V2" : "V1";
  const id = (v) => (v === "V1" ? "0.0.3045981" : "0.0.3949434");
  const sellMirror = flakyMirror(setup, { evm: ALIAS, revertWhen: (p) => p.to === routerOf(first) });
  const sub2 = fakeSubmit();
  const sold = await swapFromPocket({ client: /** @type {any} */ ({}), accountId: AccountId.fromString("0.0.4242"), mirror: sellMirror, setup, pools, side: "sell", amountIn, agreedOut: sq0.all[1].amountOut, slippageBps: 100, submitTx: sub2.submitTx, sleep: noSleep });
  assert.equal(sold.venue, second);
  const approvals = sub2.sent.filter((t) => t instanceof AccountAllowanceApproveTransaction).map((t) => [t.tokenApprovals[0].spenderAccountId.toString(), t.tokenApprovals[0].amount.toString()]);
  assert.deepEqual(approvals, [
    [id(first), amountIn.toString()],
    [id(first), "0"],
    [id(second), amountIn.toString()],
  ]);
  assert.equal(sub2.sent.at(-1).contractId.toString(), id(second));
});

test("0.9.4: si no pasa ninguna simulación, solo se envía si el usuario acepta, con gas limitado y sabiendo lo que puede costar", async () => {
  const setup = swapSetup("mainnet");
  const mirror = flakyMirror(setup, { evm: ALIAS, revertWhen: () => true });
  const pools = await findSwapPools(mirror, setup);
  const amountIn = 6n * HBAR;
  const q = await bestSwapQuote(mirror, setup, pools, "buy", amountIn);
  const base = { client: /** @type {any} */ ({}), accountId: AccountId.fromString("0.0.4242"), mirror, setup, pools, side: "buy", amountIn, agreedOut: q.best.amountOut, slippageBps: 100, sleep: noSleep };

  // Sin preguntar (como antes): no se firma.
  const sub0 = fakeSubmit();
  await assert.rejects(swapFromPocket({ ...base, submitTx: sub0.submitTx }), (e) => e.status === "SIMULATION_REVERT" && /Safe token transfer failed/.test(e.message));
  assert.equal(sub0.sent.length, 0);

  // Pregunta y dice que no.
  let asked = null;
  const sub1 = fakeSubmit();
  await assert.rejects(
    swapFromPocket({ ...base, submitTx: sub1.submitTx, onUnverified: async (info) => ((asked = info), false) }),
    (e) => e.status === "CANCELLED" && /cancel/i.test(e.message),
  );
  assert.equal(sub1.sent.length, 0, "nada enviado");
  assert.equal(asked.reason, "Safe token transfer failed!");
  assert.equal(asked.gas, SWAP_GAS_FALLBACK[q.best.venue]);
  assert.equal(asked.maxCostTinybars, swapFailureCostTinybars(1_200_000, 154n));
  assert.equal(asked.maxCostTinybars, 157_840_000n, "1,58 HBAR como mucho");

  // Dice que sí: se envía con 1.200.000 de gas.
  const sub2 = fakeSubmit();
  const out = await swapFromPocket({ ...base, submitTx: sub2.submitTx, onUnverified: async () => true });
  assert.equal(out.verified, false);
  assert.deepEqual(kinds(sub2.sent), ["ContractExecuteTransaction"]);
  assert.equal(Number(sub2.sent[0].gas), 1_200_000);
  assert.equal(sub2.sent[0].payableAmount.toTinybars().toString(), amountIn.toString());
});

test("0.9.4: la app cotiza en todas las pools, enseña la otra y pregunta antes de enviar sin simulación", () => {
  const screen = fs.readFileSync(path.join(ROOT, "app/src/screens/Swap.tsx"), "utf8");
  // 0.10.2: la misma pregunta sirve para HBAR ↔ token y para token ↔ token.
  assert.match(screen, /const askUnverified = \(\{ reason, maxCostTinybars \}: \{ reason: string; maxCostTinybars: bigint \}\) =>\s+confirm\(/);
  assert.equal((screen.match(/onUnverified: askUnverified/g) ?? []).length, 2, "en los dos tipos de cambio");
  assert.match(screen, /Enviar igualmente/);
  assert.match(screen, /other: second \?/, "enseña la segunda mejor ruta");
  const mirror = fs.readFileSync(path.join(ROOT, "core/src/mirror.js"), "utf8");
  assert.match(mirror, /async contractGasPrice\(\)/);
});

test("0.10: la V2 se cotiza con poco gas (el mirror público rechaza 3.000.000) y una estimación rechazada se repite", async () => {
  const setup = swapSetup("mainnet");
  const pools = await findSwapPools(modelMirror(setup), setup);
  const sleep = async () => {};
  // Un mirror como el público: con mucho gas reservado contesta 429.
  const strict = (inner, limit = 1_500_000) => ({
    gasSeen: [],
    async simulate(p) {
      this.gasSeen.push(p.gas ?? 900_000);
      if ((p.gas ?? 900_000) > limit) return { ok: false, result: "0x", error: "Too Many Requests", status: 429 };
      return inner.simulate(p);
    },
  });
  const m = strict(modelMirror(setup));
  const q = await quotePool(m, setup, pools[1], "buy", 10n * HBAR, { sleep });
  assert.ok(q && q.venue === "V2", "la V2 vuelve a cotizar");
  assert.deepEqual(m.gasSeen, [QUOTE_GAS]);
  const best = await bestSwapQuote(strict(modelMirror(setup)), setup, pools, "buy", 200_000n * HBAR, { sleep });
  assert.equal(best?.best.venue, "V2", "con mucho importe gana la V2 también con el mirror público");
  // Sin gas suficiente para una ruta rara: una vez más con más gas.
  let n = 0;
  const thirsty = { async simulate(p) { n++; return (p.gas ?? 0) < SWAP_GAS_RETRY ? { ok: false, result: "0x", error: "INSUFFICIENT_GAS", status: 400 } : modelMirror(setup).simulate(p); } };
  assert.ok(await quotePool(thirsty, setup, pools[1], "buy", 10n * HBAR, { sleep }));
  assert.ok(n >= 2);
  // La estimación del swap: con 3.000.000 → 429; se repite con 1.200.000 y vale.
  const e = strict(modelMirror(setup));
  const est = await estimateSwapGas(e, { from: "0x1", to: "0x2", data: "0x", value: 0n, venue: "V2" });
  assert.equal(est.estimated, true);
  assert.equal(est.gas, Math.ceil(350_000 * 1.3));
  assert.deepEqual(e.gasSeen, [3_000_000, SWAP_GAS_RETRY]);
  assert.ok(isRateLimited({ status: 429 }));
  assert.ok(isRateLimited({ error: "HTTP 429 Too Many Requests" }));
  assert.ok(!isRateLimited({ status: 400, error: "CONTRACT_REVERT_EXECUTED" }));
});

// ---- 0.10.2: lo comprado puede ir directo a la bóveda ------------------------------------------------

const VAULT = "0.0.5555";
/** Mirror de juguete con una bóveda: asociaciones automáticas ilimitadas (v2) o no, y lo que ya tiene. */
function vaultMirror(setup, { unlimited = true, vaultHeld = [], pocketHeld = [] } = {}) {
  const base = modelMirror(setup);
  return {
    ...base,
    simulate: (p) => base.simulate.call(base, p),
    async accountTokens(id) {
      return (id === VAULT ? vaultHeld : pocketHeld).map((tokenId) => ({ tokenId }));
    },
    async account(id) {
      return id === VAULT ? { evmAddress: longZero(VAULT), maxAutoAssociations: unlimited ? -1 : 0 } : { evmAddress: longZero("0.0.4242"), maxAutoAssociations: 0 };
    },
  };
}
/** A quién manda el router lo que sale del cambio (decodificando la llamada firmada). */
function routerRecipient(venue, side, call) {
  const data = "0x" + Buffer.from(call.functionParameters).toString("hex");
  if (venue === "V2") {
    const [calls] = v2Router.decodeFunctionData("multicall", data);
    if (side === "buy") return v2Router.decodeFunctionData("exactInput", calls[0])[0].recipient;
    return v2Router.decodeFunctionData("unwrapWHBAR", calls[1])[1];
  }
  return side === "buy" ? v1Router.decodeFunctionData("swapExactETHForTokens", data)[2] : v1Router.decodeFunctionData("swapExactTokensForETH", data)[3];
}
const swapArgs = (mirror, setup, pools, side, amountIn, agreedOut, sub, recipientId) => ({
  client: /** @type {any} */ ({}),
  accountId: AccountId.fromString("0.0.4242"),
  mirror,
  setup,
  pools,
  side,
  amountIn,
  agreedOut,
  slippageBps: 100,
  submitTx: sub.submitTx,
  sleep: noSleep,
  recipientId,
});

test("0.10.2 · comprar directo a la bóveda: no se asocia nada en la Cartera y el router manda el token a la bóveda", async () => {
  const setup = swapSetup("mainnet");
  const mirror = vaultMirror(setup);
  const pools = await findSwapPools(mirror, setup);
  for (const amount of [100n * HBAR, 200_000n * HBAR]) {
    const q = await bestSwapQuote(mirror, setup, pools, "buy", amount);
    const sub = fakeSubmit();
    const out = await swapFromPocket(swapArgs(mirror, setup, pools, "buy", amount, q.best.amountOut, sub, VAULT));
    assert.deepEqual(kinds(sub.sent), ["ContractExecuteTransaction"], "ni asociación en la Cartera ni permisos");
    assert.equal(out.recipientId, VAULT);
    assert.equal(routerRecipient(out.venue, "buy", sub.sent[0]), getAddress(longZero(VAULT)), `${out.venue}: lo comprado va a la bóveda`);
    assert.equal(sub.sent[0].payableAmount.toTinybars().toString(), amount.toString(), "paga la Cartera");
  }
});

test("0.10.2 · si la bóveda no puede recibir el token (sin asociaciones ilimitadas ni el token), no se envía nada", async () => {
  const setup = swapSetup("mainnet");
  const mirror = vaultMirror(setup, { unlimited: false });
  const pools = await findSwapPools(mirror, setup);
  const q = await bestSwapQuote(mirror, setup, pools, "buy", 100n * HBAR);
  const sub = fakeSubmit();
  await assert.rejects(swapFromPocket(swapArgs(mirror, setup, pools, "buy", 100n * HBAR, q.best.amountOut, sub, VAULT)), (e) => e.status === "DESTINATION_NOT_ASSOCIATED");
  assert.equal(sub.sent.length, 0, "nada enviado");
  // Si ya tiene el token asociado, sí.
  const held = vaultMirror(setup, { unlimited: false, vaultHeld: [setup.tokenId] });
  const sub2 = fakeSubmit();
  const out = await swapFromPocket(swapArgs(held, setup, pools, "buy", 100n * HBAR, q.best.amountOut, sub2, VAULT));
  assert.equal(routerRecipient(out.venue, "buy", sub2.sent.at(-1)), getAddress(longZero(VAULT)));
});

test("0.10.2 · vender con el HBAR directo a la bóveda: permiso exacto desde la Cartera y el HBAR a la bóveda", async () => {
  const setup = swapSetup("mainnet");
  const mirror = vaultMirror(setup, { pocketHeld: [setup.tokenId] });
  const pools = await findSwapPools(mirror, setup);
  const amountIn = 50n * HBAR;
  const q = await bestSwapQuote(mirror, setup, pools, "sell", amountIn);
  const sub = fakeSubmit();
  const out = await swapFromPocket(swapArgs(mirror, setup, pools, "sell", amountIn, q.best.amountOut, sub, VAULT));
  assert.deepEqual(kinds(sub.sent), ["AccountAllowanceApproveTransaction", "ContractExecuteTransaction"]);
  assert.equal(sub.sent[0].tokenApprovals[0].amount.toString(), amountIn.toString(), "permiso exacto");
  assert.equal(sub.sent[0].tokenApprovals[0].ownerAccountId.toString(), "0.0.4242", "el token sale de la Cartera");
  assert.equal(routerRecipient(out.venue, "sell", sub.sent[1]), getAddress(longZero(VAULT)), `${out.venue}: el HBAR va a la bóveda`);
});

test("0.10.2 · destino no válido: error; y el destino igual a la Cartera es el cambio de siempre", async () => {
  const setup = swapSetup("mainnet");
  const mirror = vaultMirror(setup);
  const pools = await findSwapPools(mirror, setup);
  const q = await bestSwapQuote(mirror, setup, pools, "buy", 100n * HBAR);
  const sub = fakeSubmit();
  await assert.rejects(swapFromPocket(swapArgs(mirror, setup, pools, "buy", 100n * HBAR, q.best.amountOut, sub, "0x1234")), /no válida|Invalid/);
  assert.equal(sub.sent.length, 0);
  const same = fakeSubmit();
  const out = await swapFromPocket(swapArgs(mirror, setup, pools, "buy", 100n * HBAR, q.best.amountOut, same, "0.0.4242"));
  assert.deepEqual(kinds(same.sent), ["TokenAssociateTransaction", "ContractExecuteTransaction"], "a la Cartera: asocia como siempre");
  assert.equal(out.recipientId, "0.0.4242");
  assert.equal(routerRecipient(out.venue, "buy", same.sent[1]), getAddress(longZero("0.0.4242")));
});
