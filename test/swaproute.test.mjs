// 0.10.2 · Swap ampliado, fase 2: cambios de TOKEN A TOKEN (core/src/swaproute.js), SIN red.
// Mirror de juguete con pools x·y=k: A-B directa (V2 0,3 %) y cada token contra WHBAR (V1 y V2).
import test from "node:test";
import assert from "node:assert/strict";
import { AbiCoder, Interface, getAddress } from "ethers";
import { AccountAllowanceApproveTransaction, AccountId, ContractExecuteTransaction, TokenAssociateTransaction } from "@hiero-ledger/sdk";
import {
  SAUCERSWAP,
  bestRouteQuote,
  buildRouteTx,
  decodeRouteAmountOut,
  describeRoute,
  findRoutes,
  isQuoterRefused,
  longZero,
  quoteRoute,
  routeSetup,
  swapMinOut,
  swapTokensFromPocket,
  v1RouterTokens,
  v2RoutePath,
  v2RouterTokens,
} from "@boveda/core";

const coder = AbiCoder.defaultAbiCoder();
const NET = "mainnet";
const W = SAUCERSWAP.mainnet.whbar;
const A = "0.0.731861"; // SAUCE
const B = "0.0.456858"; // USDC
const VAULT = "0.0.5555";
const ME = "0.0.4242";
const U = 100_000_000n;
const lz = (id) => longZero(id).toLowerCase();
const idOf = (addr) => `0.0.${BigInt(addr)}`;
const r1 = new Interface(["function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)"]);
const qv2 = new Interface(["function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] a, uint32[] b, uint256 c)"]);

/**
 * Pools de juguete. Reservas por par (orden de los IDs como vienen): V1 y V2 (con su comisión).
 * @param {{ direct?: boolean, quoter429?: boolean, revertEstimate?: string | null, held?: Record<string, string[]>, vaultUnlimited?: boolean }} [o]
 */
function routeMirror({ direct = true, quoter429 = false, revertEstimate = null, held = {}, vaultUnlimited = true } = {}) {
  const pairs = new Map([
    [[A, W].sort().join("|"), { v1: { [A]: 1_000_000n * U, [W]: 300_000n * U }, v2: { fee: 3000, [A]: 3_000_000n * U, [W]: 900_000n * U } }],
    [[B, W].sort().join("|"), { v1: { [B]: 100_000n * U, [W]: 2_000_000n * U }, v2: { fee: 1500, [B]: 300_000n * U, [W]: 6_000_000n * U } }],
    ...(direct ? [[[A, B].sort().join("|"), { v2: { fee: 3000, [A]: 2_000_000n * U, [B]: 30_000n * U } }]] : []),
  ]);
  const pairOf = (x, y) => pairs.get([x, y].sort().join("|"));
  const out = (res, x, y, amountIn, feePpm) => {
    const xIn = (amountIn * BigInt(1_000_000 - feePpm)) / 1_000_000n;
    return (xIn * res[y]) / (res[x] + xIn);
  };
  const poolAddr = (x, y, venue, fee) => "0x" + (venue === "V1" ? "a1" : `b${fee}`).padEnd(8, "0") + BigInt(x.split(".")[2] * 1 + y.split(".")[2] * 1).toString(16).padStart(32, "0");
  const results = new Map();
  const calls = [];
  return {
    calls,
    results,
    async simulate(p) {
      calls.push(p);
      const d = p.data;
      if (p.estimate) {
        if (revertEstimate) return { ok: false, result: "0x", error: JSON.stringify({ _status: { messages: [{ message: "CONTRACT_REVERT_EXECUTED", detail: revertEstimate, data: "0x" }] } }) };
        return { ok: true, result: "0x" + (500_000).toString(16), error: "" };
      }
      if (d.startsWith("0xe6a43905")) {
        const [x, y] = coder.decode(["address", "address"], "0x" + d.slice(10)).map(idOf);
        const pr = pairOf(x, y);
        return { ok: true, result: coder.encode(["address"], [pr?.v1 ? poolAddr(x, y, "V1") : "0x0000000000000000000000000000000000000000"]), error: "" };
      }
      if (d.startsWith("0x1698ee82")) {
        const [x, y, fee] = coder.decode(["address", "address", "uint24"], "0x" + d.slice(10));
        const [ix, iy] = [idOf(x), idOf(y)];
        const pr = pairOf(ix, iy);
        return { ok: true, result: coder.encode(["address"], [pr?.v2 && pr.v2.fee === Number(fee) ? poolAddr(ix, iy, "V2", Number(fee)) : "0x0000000000000000000000000000000000000000"]), error: "" };
      }
      if (d.startsWith("0xd06ca61f")) {
        const [amountIn, path] = r1.decodeFunctionData("getAmountsOut", d);
        const ids = path.map(idOf);
        const amounts = [amountIn];
        for (let i = 0; i < ids.length - 1; i++) {
          const pr = pairOf(ids[i], ids[i + 1]);
          if (!pr?.v1) return { ok: false, result: "0x", error: JSON.stringify({ _status: { messages: [{ message: "CONTRACT_REVERT_EXECUTED" }] } }) };
          amounts.push(out(pr.v1, ids[i], ids[i + 1], amounts[i], 3000));
        }
        return { ok: true, result: r1.encodeFunctionResult("getAmountsOut", [amounts]), error: "" };
      }
      if (d.startsWith("0xcdca1753")) {
        if (quoter429) return { ok: false, result: "0x", error: "HTTP 429", status: 429 };
        const [path, amountIn] = qv2.decodeFunctionData("quoteExactInput", d);
        const hex = path.slice(2);
        let amount = BigInt(amountIn);
        for (let i = 0; i + 40 < hex.length; i += 46) {
          const x = idOf("0x" + hex.slice(i, i + 40));
          const fee = parseInt(hex.slice(i + 40, i + 46), 16);
          const y = idOf("0x" + hex.slice(i + 46, i + 86));
          const pr = pairOf(x, y);
          if (!pr?.v2 || pr.v2.fee !== fee) return { ok: false, result: "0x", error: JSON.stringify({ _status: { messages: [{ message: "CONTRACT_REVERT_EXECUTED" }] } }) };
          amount = out(pr.v2, x, y, amount, fee);
        }
        return { ok: true, result: qv2.encodeFunctionResult("quoteExactInput", [amount, [], [], 0]), error: "" };
      }
      return { ok: false, result: "0x", error: "?" };
    },
    async accountTokens(id) {
      return (held[id] ?? []).map((tokenId) => ({ tokenId }));
    },
    async account(id) {
      return { evmAddress: longZero(id), maxAutoAssociations: id === VAULT && vaultUnlimited ? -1 : 0 };
    },
    async contractResult(txId) {
      return results.get(txId) ?? null;
    },
    async contractGasPrice() {
      return 154n;
    },
  };
}

function fakeSubmit({ failContract = false } = {}) {
  const sent = [];
  let n = 0;
  return {
    sent,
    async submitTx(_client, tx) {
      sent.push(tx);
      const txId = `${ME}@1800000000.${String(++n).padStart(9, "0")}`;
      if (tx instanceof ContractExecuteTransaction && failContract) return { ok: false, status: "CONTRACT_REVERT_EXECUTED", txId };
      return { ok: true, status: "SUCCESS", txId };
    },
  };
}
const kinds = (sent) => sent.map((t) => (t instanceof TokenAssociateTransaction ? "assoc" : t instanceof AccountAllowanceApproveTransaction ? "approve" : t instanceof ContractExecuteTransaction ? "call" : "?"));
const noSleep = async () => {};
const recipientOf = (venue, call) => {
  const data = "0x" + Buffer.from(call.functionParameters).toString("hex");
  return venue === "V2" ? v2RouterTokens.decodeFunctionData("exactInput", data)[0].recipient : v1RouterTokens.decodeFunctionData("swapExactTokensForTokens", data)[3];
};
const args = (mirror, rs, routes, q, sub, recipientId = null) => ({
  client: /** @type {any} */ ({}),
  accountId: AccountId.fromString(ME),
  mirror,
  rs,
  routes,
  amountIn: q.best.amountIn,
  agreedOut: q.best.amountOut,
  slippageBps: 100,
  submitTx: sub.submitTx,
  sleep: noSleep,
  recipientId,
});

test("0.10.2 · routeSetup: solo dos tokens distintos de una red con SaucerSwap, y nunca WHBAR", () => {
  assert.equal(routeSetup(NET, A, B)?.tokenIn, A);
  assert.equal(routeSetup(NET, A, A), null);
  assert.equal(routeSetup(NET, A, W), null);
  assert.equal(routeSetup(NET, W, B), null);
  assert.equal(routeSetup(NET, "HBAR", B), null, "HBAR va por swap.js");
  assert.equal(routeSetup("previewnet", A, B), null);
});

test("0.10.2 · ruta V2 empaquetada: token, comisión, WHBAR, comisión, token", () => {
  const hex = v2RoutePath({ venue: "V2", path: [A, W, B], fees: [3000, 1500], pools: ["0x1", "0x2"] }).toLowerCase();
  assert.equal(hex, "0x" + lz(A).slice(2) + "000bb8" + lz(W).slice(2) + "0005dc" + lz(B).slice(2));
  assert.throws(() => v2RoutePath({ venue: "V2", path: [A, B], fees: [777], pools: ["0x1"] }));
  assert.throws(() => v2RoutePath({ venue: "V2", path: [A, W, B], fees: [3000], pools: ["0x1"] }));
  assert.equal(describeRoute({ venue: "V2", path: [A, W, B], fees: [3000, 1500], pools: [] }, (id) => ({ [A]: "SAUCE", [W]: "HBAR", [B]: "USDC" })[id]), "SAUCE → HBAR → USDC · V2");
});

test("0.10.2 · rutas: la directa y las que pasan por WHBAR, cada una por un solo router", async () => {
  const rs = routeSetup(NET, A, B);
  const routes = await findRoutes(routeMirror(), rs, { sleep: noSleep });
  const shape = routes.map((r) => `${r.venue}:${r.path.length === 2 ? "directa" : "WHBAR"}${r.venue === "V2" ? `:${r.fees.join("/")}` : ""}`);
  assert.deepEqual(shape, ["V2:directa:3000", "V1:WHBAR", "V2:WHBAR:3000/1500"]);
  for (const r of routes) {
    assert.equal(r.path[0], A);
    assert.equal(r.path.at(-1), B);
    if (r.path.length === 3) assert.equal(r.path[1], W);
    assert.equal(r.pools.length, r.path.length - 1);
  }
  const none = await findRoutes(routeMirror({ direct: false }), rs, { sleep: noSleep });
  assert.ok(none.every((r) => r.path.length === 3), "sin pool directa, solo por WHBAR");
});

test("0.10.2 · la mejor ruta, el impacto y el mínimo; y si el mirror rechaza el QuoterV2, salto a salto", async () => {
  const rs = routeSetup(NET, A, B);
  const mirror = routeMirror();
  const routes = await findRoutes(mirror, rs, { sleep: noSleep });
  const q = await bestRouteQuote(mirror, rs, routes, 1000n * U, { sleep: noSleep });
  assert.ok(q && q.all.length === 3);
  assert.ok(q.all.every((x, i) => i === 0 || q.all[i - 1].amountOut >= x.amountOut), "de la que más da a la que menos");
  assert.ok(q.impactPct != null && q.impactPct < 1);
  // QuoterV2 rechazado (429): se marca y se cotiza leyendo las pools (aquí no contestan: sin cotización V2, nunca a medias).
  const refused = routeMirror({ quoter429: true });
  const v2 = routes.find((r) => r.venue === "V2" && r.path.length === 3);
  assert.equal(await quoteRoute(refused, rs, v2, 1000n * U, { sleep: noSleep }), null);
  assert.ok(isQuoterRefused(refused), "ese mirror ya no se pregunta al QuoterV2");
  assert.ok(refused.calls.some((c) => c.to.toLowerCase() === v2.pools[0].toLowerCase() && c.data.startsWith("0x3850c7bd")), "lee el estado de la primera pool");
  const v1 = routes.find((r) => r.venue === "V1");
  assert.ok(await quoteRoute(refused, rs, v1, 1000n * U, { sleep: noSleep }), "la V1 cotiza igual");
});

test("0.10.2 · transacciones: V2 exactInput y V1 swapExactTokensForTokens, con permiso exacto del token A", () => {
  const rs = routeSetup(NET, A, B);
  const me = longZero(ME);
  const v2q = { route: { venue: "V2", path: [A, W, B], fees: [3000, 1500], pools: ["0x1", "0x2"] }, amountIn: 1000n, amountOut: 950n };
  let tx = buildRouteTx({ rs, quote: v2q, minOut: 900n, recipient: me, deadline: 1_800_000_000 });
  assert.equal(tx.contractId, SAUCERSWAP.mainnet.routerV2);
  assert.equal(tx.payableTinybars, 0n);
  assert.deepEqual(tx.approve, { tokenId: A, spenderId: SAUCERSWAP.mainnet.routerV2, amount: 1000n });
  const [p] = v2RouterTokens.decodeFunctionData("exactInput", tx.data);
  assert.equal(p.recipient, getAddress(me));
  assert.equal(p.amountIn, 1000n);
  assert.equal(p.amountOutMinimum, 900n);
  assert.equal(p.path.toLowerCase(), v2RoutePath(v2q.route).toLowerCase());
  const v1q = { route: { venue: "V1", path: [A, W, B], pools: ["0x1", "0x2"] }, amountIn: 1000n, amountOut: 950n };
  tx = buildRouteTx({ rs, quote: v1q, minOut: 900n, recipient: me, deadline: 1_800_000_000 });
  assert.equal(tx.contractId, SAUCERSWAP.mainnet.routerV1);
  const a = v1RouterTokens.decodeFunctionData("swapExactTokensForTokens", tx.data);
  assert.deepEqual([a[0], a[1], [...a[2]].map((x) => x.toLowerCase()), a[3]], [1000n, 900n, [lz(A), lz(W), lz(B)], getAddress(me)]);
  // Rutas que no son de A a B o con un salto que no es WHBAR: no se construyen.
  assert.throws(() => buildRouteTx({ rs, quote: { ...v1q, route: { ...v1q.route, path: [B, W, A] } }, minOut: 1n, recipient: me, deadline: 1 }));
  assert.throws(() => buildRouteTx({ rs, quote: { ...v1q, route: { ...v1q.route, path: [A, "0.0.999", B] } }, minOut: 1n, recipient: me, deadline: 1 }));
  assert.throws(() => buildRouteTx({ rs, quote: v1q, minOut: 0n, recipient: me, deadline: 1 }));
  assert.equal(decodeRouteAmountOut("V2", v2RouterTokens.encodeFunctionResult("exactInput", [777n])), 777n);
  assert.equal(decodeRouteAmountOut("V1", coder.encode(["uint256[]"], [[1n, 2n, 888n]])), 888n);
  assert.equal(decodeRouteAmountOut("V1", "0x"), null);
});

test("0.10.2 · de token a token a la Cartera: asocia B, permiso exacto de A y el cambio", async () => {
  const rs = routeSetup(NET, A, B);
  const mirror = routeMirror({ held: { [ME]: [A] } });
  const routes = await findRoutes(mirror, rs, { sleep: noSleep });
  const q = await bestRouteQuote(mirror, rs, routes, 1000n * U, { sleep: noSleep });
  const sub = fakeSubmit();
  const out = await swapTokensFromPocket(args(mirror, rs, routes, q, sub));
  assert.deepEqual(kinds(sub.sent), ["assoc", "approve", "call"]);
  assert.equal(sub.sent[1].tokenApprovals[0].amount.toString(), (1000n * U).toString(), "permiso exacto");
  assert.equal(sub.sent[1].tokenApprovals[0].tokenId.toString(), A);
  assert.equal(recipientOf(out.venue, sub.sent[2]), getAddress(longZero(ME)));
  assert.equal(out.minOut, swapMinOut(q.best.amountOut, 100));
  assert.equal(out.recipientId, ME);
  assert.ok(!sub.sent[2].payableAmount || sub.sent[2].payableAmount.toTinybars().toString() === "0", "no se manda HBAR");
});

test("0.10.2 · de token a token directo a la bóveda; y si no puede recibirlo, nada se envía", async () => {
  const rs = routeSetup(NET, A, B);
  const mirror = routeMirror({ held: { [ME]: [A] } });
  const routes = await findRoutes(mirror, rs, { sleep: noSleep });
  const q = await bestRouteQuote(mirror, rs, routes, 1000n * U, { sleep: noSleep });
  const sub = fakeSubmit();
  const out = await swapTokensFromPocket(args(mirror, rs, routes, q, sub, VAULT));
  assert.deepEqual(kinds(sub.sent), ["approve", "call"], "ni asociación en la Cartera");
  assert.equal(recipientOf(out.venue, sub.sent[1]), getAddress(longZero(VAULT)));
  const limited = routeMirror({ held: { [ME]: [A] }, vaultUnlimited: false });
  const sub2 = fakeSubmit();
  await assert.rejects(swapTokensFromPocket(args(limited, rs, routes, q, sub2, VAULT)), (e) => e.status === "DESTINATION_NOT_ASSOCIATED");
  assert.equal(sub2.sent.length, 0);
});

test("0.10.2 · de token a token: precio movido, simulación que revierte y cambio que falla", async () => {
  const rs = routeSetup(NET, A, B);
  const mirror = routeMirror({ held: { [ME]: [A, B] } });
  const routes = await findRoutes(mirror, rs, { sleep: noSleep });
  const q = await bestRouteQuote(mirror, rs, routes, 1000n * U, { sleep: noSleep });
  const sub = fakeSubmit();
  await assert.rejects(swapTokensFromPocket({ ...args(mirror, rs, routes, q, sub), agreedOut: q.best.amountOut * 2n }), (e) => e.status === "PRICE_MOVED");
  assert.equal(sub.sent.length, 0);

  const rev = routeMirror({ held: { [ME]: [A, B] }, revertEstimate: "Too little received" });
  const sub2 = fakeSubmit();
  await assert.rejects(swapTokensFromPocket(args(rev, rs, routes, q, sub2)), (e) => e.status === "SIMULATION_REVERT");
  assert.deepEqual(kinds(sub2.sent), ["approve", "approve"], "permiso dado y quitado");
  assert.equal(sub2.sent[1].tokenApprovals[0].amount.toString(), "0");

  const failing = fakeSubmit({ failContract: true });
  await assert.rejects(swapTokensFromPocket(args(mirror, rs, routes, q, failing)), /El cambio no ha salido|swap failed/);
  assert.deepEqual(kinds(failing.sent), ["approve", "call", "approve"]);
  assert.equal(failing.sent[2].tokenApprovals[0].amount.toString(), "0", "el permiso se deja a 0");
});
