// 0.10.2 · Swap ampliado, fase 3: acciones tokenizadas con SODAX (core/src/stocks.js), SIN red.
// La API de SODAX y el mirror son de juguete: se comprueba que la app solo firma lo que el usuario pidió.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AbiCoder, Interface, Transaction, hexlify } from "ethers";
import { AccountAllowanceApproveTransaction, AccountId, EthereumTransaction, PrivateKey, TokenAssociateTransaction } from "@hiero-ledger/sdk";
import {
  SODAX,
  STOCK_ELIGIBILITY,
  STOCK_PAY,
  STOCK_TOKENS,
  STOCK_TREASURY,
  assetManagerAbi,
  bytes20Fields,
  checkPastedToken,
  checkStockToken,
  hubWalletAddress,
  intentsAbi,
  hubApproveAbi,
  signStockTx,
  verifyCancelBuild,
  cancelStockOrder,
  intentHash,
  stockOrderState,
  sodaxApi,
  stockAddress,
  stockEligibility,
  stockSwapFromPocket,
  verifyIntentBuild,
} from "@boveda/core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(ROOT, f), "utf8");
const coder = AbiCoder.defaultAbiCoder();
const ZERO = "0x0000000000000000000000000000000000000000";
const HUB_ID = 18501n;
/**
 * Intención REAL que preparó SODAX el 25-nov-2026 (hvault-vps acciones): 200 HBAR → AAPL para una dirección de prueba
 * sin fondos. La llave de esa dirección no se guardó: no vale para nada más que para comprobar la codificación.
 */
const REAL = JSON.parse(String.raw`{"tx": {"from": "0x092c0df5fba71c2b97678211720219e2a85810b1", "to": "0x0df73542cC68bDC01b361d231c60F726B0e0bC05", "value": "200000000000000000000", "data": "0xc6b4180b0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000004a817c80000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000014Aff0b45Db7E1a61393A3898238F4b69130F56Ab1000000000000000000000000000000000000000000000000000000000000000000000000000000000000048000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000001200000000000000000000000005c18c543b6b6ea97de739f48c49cfc291b3ad465000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044095ea7b30000000000000000000000006382d6ccd780758c5e8a6123c33ee8f4472f96ef00000000000000000000000000000000000000000000000000000004a817c800000000000000000000000000000000000000000000000000000000000000000000000000000000006382d6ccd780758c5e8a6123c33ee8f4472f96ef000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000284016f02e3000000000000000000000000000000000000000000000000000000000000002077a4af750322d398271b0a995ba8b0895401ff696ebe769f943b1deb49aabdb8000000000000000000000000aff0b45db7e1a61393a3898238f4b69130f56ab10000000000000000000000005c18c543b6b6ea97de739f48c49cfc291b3ad465000000000000000000000000fdff1e1bec68fc9c75a2c89474c848a31be4924200000000000000000000000000000000000000000000000000000004a817c80000000000000000000000000000000000000000000000000000000000002986e8000000000000000000000000000000000000000000000000000000006b06b54800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004845000000000000000000000000000000000000000000000000000000000000484500000000000000000000000000000000000000000000000000000000000001c00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002400000000000000000000000000000000000000000000000000000000000000014092c0df5fba71c2b97678211720219e2a85810b10000000000000000000000000000000000000000000000000000000000000000000000000000000000000014092c0df5fba71c2b97678211720219e2a85810b1000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"}, "intent": {"intentId": "54116202860287067334513464417549206719294071308068455378625568998517734292920", "creator": "0xAff0b45Db7E1a61393A3898238F4b69130F56Ab1", "inputToken": "0x5c18c543b6B6EA97dE739F48C49CfC291B3AD465", "outputToken": "0xFDFf1e1Bec68fC9c75A2c89474C848A31Be49242", "inputAmount": "20000000000", "minOutputAmount": "2721512", "deadline": "1795601736", "allowPartialFill": false, "srcChain": "18501", "dstChain": "18501", "srcAddress": "0x092c0df5fba71c2b97678211720219e2a85810b1", "dstAddress": "0x092c0df5fba71c2b97678211720219e2a85810b1", "solver": "0x0000000000000000000000000000000000000000", "data": "0x"}, "relayData": {"address": "0xAff0b45Db7E1a61393A3898238F4b69130F56Ab1", "payload": "0x"}}`);
const REAL_ADDR = "0x092c0df5fba71c2b97678211720219e2a85810b1";
const AAPL = STOCK_TOKENS.find((t) => t.symbol === "AAPL");
const ELIGIBLE = { version: STOCK_ELIGIBILITY.version, country: "ES", notUsPerson: true, readNotice: true };
const NOW_S = 1_795_600_000;
const goodInfo = (e) => ({ tokenId: e.id, name: e.onChainName, symbol: e.symbol, decimals: 8, fungible: true, fees: { fixedHbar: 0n, fixedTokens: [], fractional: 0, royalty: 0 }, issuerKeys: ["admin", "supply"], deleted: false, paused: false, freezeDefault: false, createdAt: 1, treasury: STOCK_TREASURY });

/** Lo que prepararía SODAX (con la codificación real: permiso + createIntent en el hub) y, si se pide, alterado. */
function fakeBuild(p, tamper = {}) {
  const src = p.srcAddress.toLowerCase();
  const dst = (tamper.dst ?? p.dstAddress).toLowerCase();
  const hubIn = tamper.hubIn ?? (p.inputToken === ZERO ? STOCK_PAY.HBAR.hub : p.inputToken === STOCK_PAY.USDC.address ? STOCK_PAY.USDC.hub : STOCK_TOKENS.find((t) => stockAddress(t.id) === p.inputToken).hub);
  const hubOut = tamper.hubOut ?? (p.outputToken === ZERO ? STOCK_PAY.HBAR.hub : p.outputToken === STOCK_PAY.USDC.address ? STOCK_PAY.USDC.hub : STOCK_TOKENS.find((t) => stockAddress(t.id) === p.outputToken).hub);
  const creator = hubWalletAddress(HUB_ID, src);
  const minOut = BigInt(tamper.minOut ?? p.minOutputAmount);
  const deadline = BigInt(tamper.deadline ?? p.deadline);
  const intent = {
    intentId: "7",
    creator,
    inputToken: hubIn,
    outputToken: hubOut,
    inputAmount: p.inputAmount.toString(),
    minOutputAmount: minOut.toString(),
    deadline: deadline.toString(),
    allowPartialFill: false,
    srcChain: "18501",
    dstChain: "18501",
    srcAddress: src,
    dstAddress: dst,
    solver: ZERO,
    data: "0x",
  };
  const approve = hubApproveAbi.encodeFunctionData("approve", [tamper.spender ?? SODAX.intents, tamper.approveAmount ?? p.inputAmount]);
  const call = intentsAbi.encodeFunctionData("createIntent", [[7n, creator, hubIn, hubOut, p.inputAmount, minOut, deadline, false, HUB_ID, HUB_ID, src, dst, ZERO, "0x"]]);
  const calls = [[hubIn, 0n, approve], [SODAX.intents, 0n, call], ...(tamper.extraCall ? [tamper.extraCall] : [])];
  const hook = coder.encode(["tuple(address addr, uint256 value, bytes data)[]"], [calls]);
  const hubTo = tamper.hubTo ?? creator;
  const data = assetManagerAbi.encodeFunctionData("transfer", [p.inputToken, hubTo, tamper.amount ?? p.inputAmount, hook]);
  const value = p.inputToken === ZERO ? (tamper.value ?? p.inputAmount * 10_000_000_000n) : (tamper.value ?? 0n);
  return { tx: { from: src, to: tamper.to ?? SODAX.assetManager, value: value.toString(), data }, intent: { ...intent, dstAddress: tamper.intentDst ?? dst }, relayData: { address: creator, payload: "0x" } };
}

test("la lista de acciones: fija, sin fondos cotizados ni empresas sin cotizar, y con la tesorería de SODAX", () => {
  assert.equal(STOCK_TOKENS.length, 39);
  assert.equal(new Set(STOCK_TOKENS.map((t) => t.id)).size, STOCK_TOKENS.length);
  assert.equal(new Set(STOCK_TOKENS.map((t) => t.symbol)).size, STOCK_TOKENS.length);
  for (const t of STOCK_TOKENS) {
    assert.match(t.id, /^0\.0\.\d+$/);
    assert.ok(t.onChainName.endsWith(" • Robinhood Token"), t.symbol);
    assert.ok(Object.isFrozen(t));
  }
  for (const no of ["SPY", "QQQ", "SGOV", "USO", "GLD", "SLV", "SPCX", "ANT"]) assert.ok(!STOCK_TOKENS.some((t) => t.symbol === no), no);
  assert.equal(AAPL.id, "0.0.10840033");
  assert.equal(stockAddress(AAPL.id), "0x0000000000000000000000000000000000a567e1");
  assert.equal(SODAX.assetManagerId, "0.0.10495847");
  assert.equal(STOCK_TREASURY, "0.0.10495816");
  const src = read("core/src/stocks.js");
  assert.doesNotMatch(src, /\bETF\b|auditad/i);
  assert.doesNotMatch(src, /partnerFee\s*:/, "sin comisión de servicio");
});

test("checkStockToken: la de verdad pasa; otra tesorería, otro nombre o una llave nueva se bloquean", () => {
  assert.equal(checkStockToken(AAPL, goodInfo(AAPL)).ok, true);
  assert.equal(checkStockToken(AAPL, null).ok, false);
  assert.equal(checkStockToken(AAPL, { ...goodInfo(AAPL), treasury: "0.0.999" }).ok, false);
  assert.equal(checkStockToken(AAPL, { ...goodInfo(AAPL), name: "Apple" }).ok, false);
  assert.equal(checkStockToken(AAPL, { ...goodInfo(AAPL), issuerKeys: ["admin", "supply", "wipe"] }).ok, false);
  assert.equal(checkStockToken(AAPL, { ...goodInfo(AAPL), decimals: 6 }).ok, false);
  assert.equal(checkStockToken(AAPL, { ...goodInfo(AAPL), paused: true }).ok, false);
});

test("token pegado que dice «Robinhood»: si no es de la tesorería de SODAX, se bloquea", () => {
  const lp = { tokenId: "0.0.10908276", name: "ssLP-Wrapped Hbar-NVIDIA • Robinhood Token", symbol: "ssLP-WHBAR-NVDA", decimals: 8, fungible: true, fees: { fixedHbar: 0n, fixedTokens: [], fractional: 0, royalty: 0 }, issuerKeys: ["supply"], treasury: "0.0.10908275", createdAt: 1 };
  const c = checkPastedToken("mainnet", lp);
  assert.equal(c.ok, false);
  assert.ok(c.problems.some((p) => /Robinhood/.test(p)));
  const real = checkPastedToken("mainnet", goodInfo(AAPL));
  assert.equal(real.ok, true);
  assert.ok(real.warnings.some((w) => /acción tokenizada/.test(w)));
});

test("condiciones: país, persona de EE. UU. y aviso del emisor", () => {
  assert.equal(stockEligibility(ELIGIBLE).ok, true);
  assert.equal(stockEligibility(null).reason, "MISSING");
  assert.equal(stockEligibility({ ...ELIGIBLE, country: "US" }).reason, "COUNTRY");
  assert.equal(stockEligibility({ ...ELIGIBLE, country: "pr" }).reason, "COUNTRY");
  assert.equal(stockEligibility({ ...ELIGIBLE, notUsPerson: false }).reason, "US_PERSON");
  assert.equal(stockEligibility({ ...ELIGIBLE, readNotice: false }).reason, "NOTICE");
  assert.equal(stockEligibility({ ...ELIGIBLE, version: 0 }).reason, "OUTDATED");
});

test("cartera del hub (CREATE3): determinista y distinta por usuario y por red", () => {
  const u = "0x1111111111111111111111111111111111111111";
  const a = hubWalletAddress(HUB_ID, u);
  assert.match(a, /^0x[0-9a-f]{40}$/);
  assert.equal(a, hubWalletAddress(HUB_ID, u));
  assert.notEqual(a, hubWalletAddress(295n, u));
  assert.notEqual(a, hubWalletAddress(HUB_ID, "0x2222222222222222222222222222222222222222"));
});

test("verifyIntentBuild: la buena pasa; cualquier cambio de contrato, importe, destino, mínimo, plazo o HBAR se rechaza", () => {
  const me = "0x00000000000000000000000000000000000abcde";
  const vault = "0x0000000000000000000000000000000000005555";
  const p = { inputToken: ZERO, outputToken: stockAddress(AAPL.id), inputAmount: 200n * 100_000_000n, minOutputAmount: 4_000_000n, deadline: NOW_S + 600, srcAddress: me, dstAddress: vault };
  const expect = { payToken: ZERO, outputToken: p.outputToken, inputAmount: p.inputAmount, minOutputAmount: p.minOutputAmount, srcAddress: me, dstAddress: vault, hbarIn: true, now: NOW_S };
  const good = verifyIntentBuild(fakeBuild(p), expect);
  assert.deepEqual(good.problems, []);
  assert.equal(good.valueTinybars, p.inputAmount);
  const hook = assetManagerAbi.decodeFunctionData("transfer", fakeBuild(p).tx.data)[3];
  assert.deepEqual(bytes20Fields(hook).sort(), [me, vault].sort());
  const bad = (tamper) => verifyIntentBuild(fakeBuild(p, tamper), expect);
  assert.equal(bad({ to: "0x00000000000000000000000000000000deadbeef" }).ok, false, "otro contrato");
  assert.equal(bad({ amount: p.inputAmount + 1n }).ok, false, "otro importe");
  assert.equal(bad({ dst: "0x000000000000000000000000000000000badbad0" }).ok, false, "otra dirección dentro");
  assert.equal(bad({ intentDst: "0x000000000000000000000000000000000badbad0" }).ok, false, "otra dirección en lo que cuenta la API");
  assert.equal(bad({ minOut: 1n }).ok, false, "mínimo más bajo");
  assert.equal(bad({ deadline: NOW_S + 86_400 }).ok, false, "plazo de un día");
  assert.equal(bad({ value: p.inputAmount * 10_000_000_000n * 2n }).ok, false, "el doble de HBAR");
  assert.equal(bad({ hubTo: "0x00000000000000000000000000000000000a77ac" }).ok, false, "a la cartera del hub de otro");
  assert.equal(bad({ hubOut: STOCK_TOKENS.find((t) => t.symbol === "GME").hub }).ok, false, "compra otra acción");
  assert.equal(bad({ spender: "0x00000000000000000000000000000000000a77ac" }).ok, false, "permiso en el hub a otro");
  assert.equal(bad({ approveAmount: p.inputAmount * 2n }).ok, false, "permiso en el hub mayor");
  assert.equal(bad({ extraCall: ["0x00000000000000000000000000000000000a77ac", 0n, "0x"] }).ok, false, "un tercer paso en el hub");
  // Pagando con un token no puede ir HBAR.
  const pu = { ...p, inputToken: STOCK_PAY.USDC.address, inputAmount: 10_000_000n };
  const eu = { ...expect, payToken: STOCK_PAY.USDC.address, inputAmount: pu.inputAmount, hbarIn: false };
  assert.equal(verifyIntentBuild(fakeBuild(pu), eu).ok, true);
  assert.equal(verifyIntentBuild(fakeBuild(pu, { value: 5n }), eu).ok, false);
});

test("la intención REAL de SODAX pasa la comprobación; cambiar un solo byte del destino, del mínimo o de la acción la rompe", () => {
  const dl = Number(REAL.intent.deadline);
  const expect = { payToken: ZERO, outputToken: stockAddress(AAPL.id), inputAmount: 20_000_000_000n, minOutputAmount: 2_721_512n, srcAddress: REAL_ADDR, dstAddress: REAL_ADDR, hbarIn: true, now: dl - 600 };
  assert.deepEqual(verifyIntentBuild(REAL, expect).problems, []);
  assert.equal(hubWalletAddress(SODAX.hederaChainId, REAL_ADDR), REAL.intent.creator.toLowerCase());
  const swap = (from, to) => ({ ...REAL, tx: { ...REAL.tx, data: REAL.tx.data.toLowerCase().split(from).join(to) } });
  // Otra dirección de destino (los dos bytes del final cambiados) dentro de la intención.
  assert.equal(verifyIntentBuild(swap("092c0df5fba71c2b97678211720219e2a85810b1", "092c0df5fba71c2b97678211720219e2a85810ff"), expect).ok, false);
  // Mínimo más bajo (2.721.512 → 1).
  assert.equal(verifyIntentBuild(swap("00000000000000000000000000000000000000000000000000000000002986e8", "0000000000000000000000000000000000000000000000000000000000000001"), expect).ok, false);
  // Otra acción (AAPL → GME en el hub).
  assert.equal(verifyIntentBuild(swap("fdff1e1bec68fc9c75a2c89474c848a31be49242", STOCK_TOKENS.find((t) => t.symbol === "GME").hub.slice(2)), expect).ok, false);
  // Lo que pidió otra persona: mismo dato, otro origen esperado.
  assert.equal(verifyIntentBuild(REAL, { ...expect, srcAddress: "0x1111111111111111111111111111111111111111" }).ok, false);
  // Y con el plazo vencido.
  assert.equal(verifyIntentBuild(REAL, { ...expect, now: dl + 1 }).ok, false);
});

test("signStockTx: tipo 2, chainId 295, firmada por la Cartera y el HBAR en weibars", async () => {
  const key = PrivateKey.generateECDSA();
  const evm = `0x${key.publicKey.toEvmAddress()}`.toLowerCase();
  const s = await signStockTx({ key, nonce: 3, to: SODAX.assetManager, data: "0x1234", valueTinybars: 5n, gasLimit: 300_000, gasPriceTinybars: 80n });
  const t = Transaction.from(s.raw);
  assert.equal(t.type, 2);
  assert.equal(t.chainId, 295n);
  assert.equal(t.nonce, 3);
  assert.equal(t.to.toLowerCase(), SODAX.assetManager);
  assert.equal(t.value, 50_000_000_000n);
  assert.equal(t.from.toLowerCase(), evm);
  assert.equal(s.from, evm);
  assert.equal(t.maxFeePerGas, 1_000_000_000_000n);
  await assert.rejects(signStockTx({ key: PrivateKey.generateED25519(), nonce: 0, to: SODAX.assetManager, data: "0x", valueTinybars: 0n, gasLimit: 1, gasPriceTinybars: 1n }), (e) => e.status === "STOCKS_NEED_ECDSA");
});

test("sodaxApi: lee la cotización, distingue el límite (429) y rechaza respuestas raras", async () => {
  const reply = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
  assert.equal(await sodaxApi({ fetch: reply(200, { quotedAmount: "123" }) }).quote({ tokenSrc: ZERO, tokenDst: ZERO, amount: 1n }), 123n);
  assert.equal(await sodaxApi({ fetch: reply(200, { success: true, data: { quotedAmount: "9" } }) }).quote({ tokenSrc: ZERO, tokenDst: ZERO, amount: 1n }), 9n);
  await assert.rejects(sodaxApi({ fetch: reply(429, "") }).quote({ tokenSrc: ZERO, tokenDst: ZERO, amount: 1n }), (e) => e.code === "RATE_LIMITED");
  await assert.rejects(sodaxApi({ fetch: reply(200, { quotedAmount: "-1" }) }).quote({ tokenSrc: ZERO, tokenDst: ZERO, amount: 1n }), (e) => e.code === "SHAPE");
  await assert.rejects(sodaxApi({ fetch: async () => { throw new Error("offline"); } }).quote({ tokenSrc: ZERO, tokenDst: ZERO, amount: 1n }), (e) => e.code === "NETWORK");
  /** @type {any} */
  let sent = null;
  const api = sodaxApi({ fetch: async (_u, init) => ((sent = JSON.parse(init.body)), { status: 200, ok: true, text: async () => JSON.stringify({ success: true, data: { status: "inserted" } }) }) });
  assert.equal(await api.submitTx({ txHash: "0xab", walletAddress: "0x01", intent: {}, relayData: { address: "0x02", payload: "0x" } }), "inserted");
  assert.equal(sent.relayData, "0x");
  assert.equal(sent.srcChainKey, "hedera");
});

/** Cartera, mirror, API y envío de juguete. */
function world({ held = {}, vaultUnlimited = true, quote = 5_000_000n, tamper = null, simulateFails = false, status = "solved" } = {}) {
  const key = PrivateKey.generateECDSA();
  const evm = `0x${key.publicKey.toEvmAddress()}`.toLowerCase();
  const ME = "0.0.4242";
  const VAULT = "0.0.5555";
  const sent = [];
  const calls = { submitTx: 0, built: null };
  let ethSent = false;
  const mirror = {
    tokenInfo: async (id) => goodInfo(STOCK_TOKENS.find((t) => t.id === id)),
    account: async (id) => (id === ME ? { evmAddress: evm, maxAutoAssociations: 0, ethereumNonce: 4 } : id === VAULT ? { evmAddress: stockAddress(VAULT), maxAutoAssociations: vaultUnlimited ? -1 : 0 } : null),
    // Lo que entrega el solver aparece en el destino después de la transacción EVM.
    accountTokens: async (id) => [...(held[id] ?? []).map((tokenId) => ({ tokenId, balance: 4_900_000n })), ...(ethSent && !(held[id] ?? []).includes(AAPL.id) ? [{ tokenId: AAPL.id, balance: 5_000_000n }] : [])],
    simulate: async () => (simulateFails ? { ok: false, result: "0x", error: "revert", status: 400 } : { ok: true, result: "0x30d40", error: "", status: 200 }),
    contractGasPrice: async () => 80n,
  };
  const api = {
    quote: async () => quote,
    buildIntent: async (p) => (calls.built = p) && fakeBuild(p, tamper ?? {}),
    submitTx: async () => (calls.submitTx++, "inserted"),
    status: async () => ({ status }),
  };
  const submitTx = async (_client, tx) => {
    sent.push(tx);
    if (tx instanceof EthereumTransaction) ethSent = true;
    return { ok: true, status: "SUCCESS", txId: "0.0.4242@1795600000.1", receipt: null, response: null };
  };
  let t = NOW_S * 1000;
  const base = { client: /** @type {any} */ ({}), key, accountId: AccountId.fromString(ME), network: "mainnet", mirror, api, amountIn: 200n * 100_000_000n, agreedOut: 5_000_000n, slippageBps: 100, eligibility: ELIGIBLE, submitTx, sleep: async () => {}, now: () => (t += 1000) };
  return { key, evm, ME, VAULT, sent, calls, base };
}

test("comprar AAPL con HBAR directo a la bóveda: una sola transacción EVM, al contrato de SODAX y con lo pedido", async () => {
  const w = world();
  const r = await stockSwapFromPocket({ ...w.base, trade: { side: "buy", stock: AAPL, pay: "HBAR" }, recipientId: w.VAULT });
  assert.equal(r.status, "solved");
  assert.equal(r.delivered, true, "espera a verlo en la bóveda");
  assert.equal(r.received, 5_000_000n);
  assert.equal(r.recipientId, w.VAULT);
  assert.equal(w.sent.length, 1);
  assert.ok(w.sent[0] instanceof EthereumTransaction);
  const t = Transaction.from(hexlify(w.sent[0].ethereumData));
  assert.equal(t.to.toLowerCase(), SODAX.assetManager);
  assert.equal(t.from.toLowerCase(), w.evm);
  assert.equal(t.nonce, 4);
  assert.equal(t.value, 200n * 100_000_000n * 10_000_000_000n);
  assert.equal(w.calls.built.dstAddress, stockAddress(w.VAULT));
  assert.equal(w.calls.built.minOutputAmount, 4_950_000n);
  assert.equal(w.calls.submitTx, 1);
});

test("a una bóveda que no puede recibir la acción: no se envía nada", async () => {
  const w = world({ vaultUnlimited: false });
  await assert.rejects(stockSwapFromPocket({ ...w.base, trade: { side: "buy", stock: AAPL, pay: "HBAR" }, recipientId: w.VAULT }), (e) => e.status === "DESTINATION_NOT_ASSOCIATED");
  assert.equal(w.sent.length, 0);
});

test("si SODAX prepara otra cosa (otro destino o más HBAR), no se firma nada", async () => {
  for (const tamper of [{ dst: "0x000000000000000000000000000000000badbad0" }, { value: 1n }, { to: "0x00000000000000000000000000000000deadbeef" }, { minOut: 1n }]) {
    const w = world({ tamper });
    await assert.rejects(stockSwapFromPocket({ ...w.base, trade: { side: "buy", stock: AAPL, pay: "HBAR" }, recipientId: w.VAULT }), (e) => e.status === "INTENT_MISMATCH", JSON.stringify(tamper, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    assert.equal(w.sent.length, 0);
  }
});

test("pagar con USDC a la Cartera: asocia la acción, permiso exacto a SODAX y, si la simulación falla, lo quita", async () => {
  const w = world({ simulateFails: true });
  const amountIn = 10_000_000n;
  await assert.rejects(stockSwapFromPocket({ ...w.base, amountIn, trade: { side: "buy", stock: AAPL, pay: "USDC" } }), (e) => e.status === "SIMULATION_REVERT");
  assert.ok(w.sent[0] instanceof TokenAssociateTransaction);
  const approvals = w.sent.filter((t) => t instanceof AccountAllowanceApproveTransaction).map((t) => t.tokenApprovals[0]);
  assert.equal(approvals.length, 2);
  assert.equal(approvals[0].spenderAccountId.toString(), SODAX.assetManagerId);
  assert.equal(approvals[0].tokenId.toString(), STOCK_PAY.USDC.tokenId);
  assert.equal(approvals[0].amount.toString(), amountIn.toString());
  assert.equal(approvals[1].amount.toString(), "0");
  assert.ok(!w.sent.some((t) => t instanceof EthereumTransaction));
});

test("vender: permiso exacto de la acción; precio movido, red equivocada o sin aceptar las condiciones: no se envía nada", async () => {
  const w = world({ held: { "0.0.4242": [AAPL.id] }, quote: 100n * 100_000_000n });
  const r = await stockSwapFromPocket({ ...w.base, amountIn: 4_000_000n, agreedOut: 100n * 100_000_000n, trade: { side: "sell", stock: AAPL, pay: "HBAR" } });
  assert.equal(r.status, "solved");
  const ap = w.sent.filter((t) => t instanceof AccountAllowanceApproveTransaction).map((t) => t.tokenApprovals[0]);
  assert.equal(ap[0].tokenId.toString(), AAPL.id);
  assert.equal(ap[0].amount.toString(), "4000000");
  assert.equal(Transaction.from(hexlify(w.sent.find((t) => t instanceof EthereumTransaction).ethereumData)).value, 0n);
  const moved = world({ quote: 1n });
  await assert.rejects(stockSwapFromPocket({ ...moved.base, trade: { side: "buy", stock: AAPL, pay: "HBAR" } }), (e) => e.status === "PRICE_MOVED");
  const tn = world();
  await assert.rejects(stockSwapFromPocket({ ...tn.base, network: "testnet", trade: { side: "buy", stock: AAPL, pay: "HBAR" } }), (e) => e.status === "STOCKS_MAINNET_ONLY");
  const ne = world();
  await assert.rejects(stockSwapFromPocket({ ...ne.base, eligibility: null, trade: { side: "buy", stock: AAPL, pay: "HBAR" } }), (e) => e.status === "STOCKS_NOT_ELIGIBLE");
  for (const x of [moved, tn, ne]) assert.equal(x.sent.length, 0, "ni siquiera la asociación");
});

test("la pantalla de acciones: condiciones primero, solo compra en mainnet, Cartera o bóveda y sin comisión", () => {
  const scr = read("app/src/screens/Stocks.tsx");
  assert.match(scr, /const eligible = stockEligibility\(prefs\.stocks\)\.ok;/, "sin aceptar las condiciones no hay nada");
  assert.match(scr, /if \(!eligible\) \{[\s\S]*?Ver condiciones y empezar/);
  assert.match(scr, /const CAN_TRADE = NETWORK === SODAX\.network;/, "en testnet se ve, pero no se compra");
  assert.match(scr, /const canTrade = CAN_TRADE && !!mirror && eligible && !!out/);
  assert.match(scr, /withPocket\(\(\{ client, key, accountId \}\) =>\s+stockSwapFromPocket\(/);
  assert.match(scr, /eligibility: prefs\.stocks,/);
  assert.match(scr, /recipientId: dest,/);
  assert.match(scr, /const dest = toVault && vaultId \? vaultId : null;/);
  assert.match(scr, /\["US", "Estados Unidos", "United States"\]/, "EE. UU. aparece, para explicar que no se puede");
  assert.match(scr, /STOCK_ELIGIBILITY\.blockedCountries\.includes\(code\)/);
  assert.match(scr, /persona de EE\. UU\./);
  assert.match(scr, /no me hace accionista/);
  assert.match(scr, /no es un bróker/);
  assert.doesNotMatch(scr, /FEE_COLLECTOR|serviceFees|partnerFee|\bETF\b|auditad/i);
  assert.doesNotMatch(scr, /from "\.\/Swap"/, "los trozos llegan por props: sin importarse el uno al otro");
  const swap = read("app/src/screens/Swap.tsx");
  assert.match(swap, /import \{ StocksPanel \} from "\.\/Stocks";/);
  assert.match(swap, /market === "stocks" && stocksEnabled \?/);
  assert.match(read("app/src/env.ts"), /export const stocksEnabled: boolean = \(process\.env\.EXPO_PUBLIC_STOCKS \?\? "1"\)\.trim\(\) !== "0";/);
  assert.match(read("app/src/prefs.tsx"), /stocks: saved\.stocks \?\? null/);
});

/** La orden de 29 HBAR del 25-nov-2026 (paso 4 de la 3ª pasada): SODAX la canceló sola al caducar. */
const ORDER_29 = {
  intentId: "64623906319392949558429760608758818654631821809254278817796088654066170518982",
  creator: "0x8AEc9A053ea0814dcfFDa67Fa072AC1F8C4bcB95",
  inputToken: "0x5c18c543b6B6EA97dE739F48C49CfC291B3AD465",
  outputToken: "0xFDFf1e1Bec68fC9c75A2c89474C848A31Be49242",
  inputAmount: "2900000000",
  minOutputAmount: "1185315",
  deadline: "1795620967",
  allowPartialFill: false,
  srcChain: 18501,
  dstChain: 18501,
  srcAddress: "0xbea0f651f35ae58eca2c13550766e49bcada12f8",
  dstAddress: "0xbea0f651f35ae58eca2c13550766e49bcada12f8",
  solver: ZERO,
  data: "0x",
};
const ORDER_29_HASH = "0x2379406f997f9f6ed5c5a1bf66ff22418a87c30b043b4eaef07e3f5785a8b035";

test("intentHash: el de una orden REAL de SODAX; cambiar un campo lo cambia", () => {
  assert.equal(intentHash(ORDER_29), ORDER_29_HASH);
  assert.notEqual(intentHash({ ...ORDER_29, inputAmount: "2900000001" }), ORDER_29_HASH);
  assert.notEqual(intentHash({ ...ORDER_29, dstAddress: "0xbea0f651f35ae58eca2c13550766e49bcada12f9" }), ORDER_29_HASH);
  assert.equal(hubWalletAddress(HUB_ID, ORDER_29.srcAddress).toLowerCase(), ORDER_29.creator.toLowerCase(), "la cartera del hub de esa dirección es la que creó la orden");
});

test("diario de SODAX: 404 = aún no está; abierta; cancelada; y rechaza respuestas raras", async () => {
  const urls = [];
  const reply = (status, body) => async (u) => (urls.push(u), { status, ok: status >= 200 && status < 300, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
  const j404 = await sodaxApi({ fetch: reply(404, { message: "Not Found" }) }).journal(ORDER_29_HASH);
  assert.deepEqual(j404, { found: false, open: false, cancelled: false, filled: false, events: [] });
  assert.equal(urls[0], `https://api.sodax.com/v1/be/intent/${ORDER_29_HASH}`);
  const open = await sodaxApi({ fetch: reply(200, { intentHash: ORDER_29_HASH, open: true, events: [] }) }).journal(ORDER_29_HASH);
  assert.equal(open.open, true);
  // Lo que contestó de verdad para la orden de 29 HBAR (resumido).
  const real = { intentHash: ORDER_29_HASH, txHash: "0xf04db2bc814210648f55576329545a6a1a470850372f0283a8986a58c8c2029c", chainId: 146, open: false, intent: ORDER_29, events: [{ eventType: "intent-cancelled", txHash: "0x2bd5d48bab2083769f24900ebfb4341393ecad995afce7285aa6693312672af9", logIndex: 2 }] };
  const c = await sodaxApi({ fetch: reply(200, real) }).journal(ORDER_29_HASH);
  assert.equal(c.cancelled, true);
  assert.equal(c.open, false);
  await assert.rejects(sodaxApi({ fetch: reply(200, { ...real, intentHash: "0x" + "11".repeat(32) }) }).journal(ORDER_29_HASH), (e) => e.code === "SHAPE", "de otra orden");
  await assert.rejects(sodaxApi({ fetch: reply(200, { foo: 1 }) }).journal(ORDER_29_HASH), (e) => e.code === "SHAPE");
  await assert.rejects(sodaxApi({ fetch: reply(200, real) }).journal("0x12"), (e) => e.code === "SHAPE");
  await assert.rejects(sodaxApi({ fetch: reply(500, "x") }).journal(ORDER_29_HASH), (e) => e.code === "HTTP");
});

test("stockOrderState: primero el diario; si no contesta, /fill; si nada contesta, «unknown»", async () => {
  const j = (r) => ({ journal: async () => r });
  assert.equal((await stockOrderState(j({ found: true, open: false, cancelled: true, filled: false, events: [] }), ORDER_29)).state, "cancelled");
  assert.equal((await stockOrderState(j({ found: true, open: true, cancelled: false, filled: false, events: [] }), ORDER_29)).state, "open");
  assert.equal((await stockOrderState(j({ found: true, open: false, cancelled: false, filled: true, events: [] }), ORDER_29)).state, "filled");
  const fillOnly = { journal: async () => { throw new Error("x"); }, fill: async () => ({ exists: true, remainingInput: 1n, receivedOutput: 0n, pendingPayment: false }) };
  assert.equal((await stockOrderState(fillOnly, ORDER_29, "0xab")).state, "open");
  const none = { journal: async () => ({ found: false }), fill: async () => { throw new Error("SERVER_ERROR"); } };
  const u = await stockOrderState(none, ORDER_29, "0xab", 1795620967 + 1);
  assert.equal(u.state, "unknown");
  assert.equal(u.expired, true);
  assert.equal(u.intentHash, ORDER_29_HASH);
});

/** Lo que prepararía SODAX para cancelar una orden (formato supuesto: mensaje sin fondos y cancelIntent en el hub). */
function fakeCancel(intent, src, tamper = {}) {
  const t = [BigInt(tamper.intentId ?? intent.intentId), intent.creator, intent.inputToken, intent.outputToken, BigInt(intent.inputAmount), BigInt(intent.minOutputAmount), BigInt(intent.deadline), false, BigInt(intent.srcChain), BigInt(intent.dstChain), intent.srcAddress, intent.dstAddress, intent.solver, "0x"];
  const call = intentsAbi.encodeFunctionData("cancelIntent", [t]);
  const calls = [[tamper.target ?? SODAX.intents, 0n, call], ...(tamper.extraCall ? [tamper.extraCall] : [])];
  const hook = coder.encode(["tuple(address addr, uint256 value, bytes data)[]"], [calls]);
  const data = assetManagerAbi.encodeFunctionData("transfer", [ZERO, hubWalletAddress(HUB_ID, src), tamper.amount ?? 0n, hook]);
  return { tx: { from: src, to: tamper.to ?? SODAX.assetManager, value: String(tamper.value ?? 0n), data } };
}

test("verifyCancelBuild: solo cancela ESTA orden, sin mover fondos; cualquier otra cosa no se firma", () => {
  const me = "0x00000000000000000000000000000000000abcde";
  const p = { inputToken: ZERO, outputToken: stockAddress(AAPL.id), inputAmount: 20n * 100_000_000n, minOutputAmount: 9_000_000n, deadline: NOW_S + 900, srcAddress: me, dstAddress: me };
  const intent = fakeBuild(p).intent;
  const ok = verifyCancelBuild(fakeCancel(intent, me), { intent, srcAddress: me });
  assert.deepEqual(ok.problems, []);
  const bad = (tamper) => verifyCancelBuild(fakeCancel(intent, me, tamper), { intent, srcAddress: me }).ok;
  assert.equal(bad({ intentId: 8n }), false, "otra orden");
  assert.equal(bad({ amount: 1n }), false, "mueve fondos");
  assert.equal(bad({ value: 1n }), false, "lleva HBAR");
  assert.equal(bad({ to: "0x00000000000000000000000000000000deadbeef" }), false, "otro contrato");
  assert.equal(bad({ target: "0x00000000000000000000000000000000000a77ac" }), false, "en el hub, otro contrato");
  assert.equal(bad({ extraCall: ["0x00000000000000000000000000000000000a77ac", 0n, "0x"] }), false, "un segundo paso");
  assert.equal(verifyCancelBuild(fakeCancel(intent, me), { intent, srcAddress: "0x1111111111111111111111111111111111111111" }).ok, false, "desde otra Cartera");
});

test("cancelStockOrder: solo si la orden sigue abierta y la cancelación cuadra; entonces una transacción EVM sin HBAR", async () => {
  const w = world();
  const p = { inputToken: ZERO, outputToken: stockAddress(AAPL.id), inputAmount: 20n * 100_000_000n, minOutputAmount: 9_000_000n, deadline: NOW_S + 900, srcAddress: w.evm, dstAddress: w.evm };
  const intent = fakeBuild(p).intent;
  let open = true;
  const api = (cancelTamper) => ({
    fill: async () => (open ? { exists: true, remainingInput: p.inputAmount, receivedOutput: 0n, pendingPayment: false } : { exists: false, remainingInput: 0n, receivedOutput: 0n, pendingPayment: false }),
    cancel: async (i) => fakeCancel(i, w.evm, cancelTamper),
  });
  const base = { client: w.base.client, key: w.key, accountId: w.base.accountId, network: "mainnet", mirror: w.base.mirror, intent, txHash: "0xab", sleep: async () => {}, now: w.base.now };
  // Cancelación de otra orden: nada se firma.
  const t1 = world();
  await assert.rejects(cancelStockOrder({ ...base, api: api({ intentId: 9n }), submitTx: t1.base.submitTx }), (e) => e.status === "CANCEL_MISMATCH");
  assert.equal(t1.sent.length, 0);
  // Orden ya cerrada: nada que cancelar.
  open = false;
  const t2 = world();
  await assert.rejects(cancelStockOrder({ ...base, api: api(), submitTx: t2.base.submitTx }), (e) => e.status === "ORDER_NOT_OPEN");
  assert.equal(t2.sent.length, 0);
  // Cancelada ya (por SODAX al caducar), según el diario: nada que firmar aunque /fill falle.
  const t2b = world();
  const gone = { journal: async () => ({ found: true, open: false, cancelled: true, filled: false, events: [] }), fill: async () => { throw new Error("SERVER_ERROR"); }, cancel: async (i) => fakeCancel(i, w.evm) };
  await assert.rejects(cancelStockOrder({ ...base, api: gone, submitTx: t2b.base.submitTx }), (e) => e.status === "ORDER_NOT_OPEN");
  assert.equal(t2b.sent.length, 0);
  // Con el diario: abierta → se firma la cancelación → el diario la da por cancelada.
  const t2c = world();
  let jp = 0;
  const withJournal = { journal: async () => (jp++ > 0 ? { found: true, open: false, cancelled: true, filled: false, events: [] } : { found: true, open: true, cancelled: false, filled: false, events: [] }), fill: async () => { throw new Error("SERVER_ERROR"); }, cancel: async (i) => fakeCancel(i, w.evm) };
  const rj = await cancelStockOrder({ ...base, api: withJournal, submitTx: t2c.base.submitTx });
  assert.equal(rj.closed, true);
  assert.equal(rj.state, "cancelled");
  assert.equal(t2c.sent.length, 1);
  // La buena: una transacción EVM, sin HBAR, al SpokeAssetManager; y la orden se cierra.
  open = true;
  const t3 = world();
  const fa = api();
  const realFill = fa.fill;
  let polls = 0;
  fa.fill = async () => (polls++ > 0 ? { exists: false, remainingInput: 0n, receivedOutput: 0n, pendingPayment: false } : realFill());
  const r = await cancelStockOrder({ ...base, api: fa, submitTx: t3.base.submitTx });
  assert.equal(r.closed, true);
  assert.equal(t3.sent.length, 1);
  assert.ok(t3.sent[0] instanceof EthereumTransaction);
  const tx = Transaction.from(hexlify(t3.sent[0].ethereumData));
  assert.equal(tx.to.toLowerCase(), SODAX.assetManager);
  assert.equal(tx.value, 0n);
  assert.equal(tx.from.toLowerCase(), w.evm, "la firma la Cartera de esta orden");
});
