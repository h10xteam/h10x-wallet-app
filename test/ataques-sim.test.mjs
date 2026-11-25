// Batería de ataques SIN red: nodo + mirror simulados y el guardián real (proceso aparte).
// Cada prueba es un ataque concreto; si pasa, el ataque no funciona.
//   A. Sin ninguna llave: tokens trampa, guardián saturado, actividad enterrada, metadata de NFT.
//   B. Con una dApp maliciosa: operaciones que tocan la bóveda o el notario, mensajes, navegador.
//   C. Con el kit filtrado: congelar, modo robo, recuperación; el dueño siempre puede evacuar.
//   D. Con la llave del móvil: dejar una operación aprobada y dispararla más tarde.
//   E. Empate móvil contra kit: la contraseña de desempate (notario v3) decide.
//   F. Contra el guardián: avisos ilegibles para dejarlo ciego, plazos raros, gasto sin tope, tokens cuyo
//      emisor puede cambiar las comisiones y avisos por correo (que solo el kit puede poner o quitar).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AccountCreateTransaction,
  AccountId,
  ContractExecuteTransaction,
  ContractId,
  CustomFixedFee,
  Hbar,
  Mnemonic,
  PrivateKey,
  ScheduleCreateTransaction,
  ScheduleId,
  ScheduleSignTransaction,
  TokenCreateTransaction,
  TokenFeeScheduleUpdateTransaction,
  Timestamp,
  TransactionId,
  TransferTransaction,
  AccountUpdateTransaction,
  BatchTransaction,
} from "@hiero-ledger/sdk";
import { CHAIN_IDS, changeVaultDelaysV2, notary2Config, requestPriorityRecoveryV3, signEmailNotice, tiebreakerAddress, tiebreakerKey } from "@boveda/core";
import * as HieroProto from "@hiero-ledger/proto";
import { Interface } from "ethers";
import {
  HBAR,
  Lane,
  Mirror,
  NOTARY2_ARTIFACT,
  browserDecision,
  buildVaultTransfer,
  callNotary2,
  createClient,
  dappForUrl,
  describeDappTransaction,
  encodeNotary2,
  evacuateVault,
  fetchNftMetadata,
  loadVaultActivity,
  nowSeconds,
  prefixedMessage,
  requestRecoveryV2,
  requestWithdrawalV2,
  rescueKeyFromWords,
  sendHbar,
  sendToken,
  setupVaultV2,
  signRegistration,
  signTheftNotice,
  submit,
  tokenRisks,
} from "@boveda/core";
import { startFakeNetwork } from "./sim/fake-network.mjs";

const { proto } = HieroProto;
const GUARDIAN_PORT = 18790;
const W = 4;
const R = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mirror = new Mirror("http://127.0.0.1:5551");
const operatorKey = PrivateKey.generateED25519();
const operatorId = new AccountId(1001);
const guardianKey = PrivateKey.generateED25519();
let net;
let op;
let guardianId;
let dataDir;
/** @type {{ proc: import("node:child_process").ChildProcess, log: string, dir: string }[]} */
const guardians = [];
const glog = () => guardians.map((g) => g.log).join("\n");

async function waitFor(what, fn, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`tiempo agotado esperando: ${what}\n--- guardián ---\n${glog().slice(-4000)}`);
    await sleep(400);
  }
}

async function startGuardian(port, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "guardian-ataques-"));
  const proc = spawn(process.execPath, ["guardian/src/index.js"], {
    env: { ...process.env, HEDERA_NETWORK: "local", MIRROR_URL: "http://127.0.0.1:5551", OPERATOR_KEY: guardianKey.toStringDer(), OPERATOR_ID: guardianId, PORT: String(port), DATA_DIR: dir, POLL_SECONDS: "3", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const g = { proc, log: "", dir };
  proc.stdout.on("data", (d) => (g.log += d));
  proc.stderr.on("data", (d) => (g.log += d));
  guardians.push(g);
  await waitFor("arranque del guardián", async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
    } catch {
      return false;
    }
  });
  return g;
}

before(async () => {
  net = await startFakeNetwork({ operatorNum: 1001, operatorKey: operatorKey.publicKey });
  op = createClient("local", { accountId: operatorId, key: operatorKey });
  const created = await submit(op, new AccountCreateTransaction().setKeyWithoutAlias(guardianKey.publicKey).setInitialBalance(new Hbar(200)));
  guardianId = created.receipt.accountId.toString();
  dataDir = (await startGuardian(GUARDIAN_PORT)).dir;
});

after(async () => {
  if (process.env.SHOW_GUARDIAN_LOG) console.log(glog());
  for (const g of guardians) g.proc.kill("SIGTERM");
  await sleep(500);
  for (const g of guardians) rmSync(g.dir, { recursive: true, force: true, maxRetries: 5 });
  op?.close();
  net?.stop();
  void dataDir;
});

const post = (port, path, body, headers = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

/** Cuenta nueva pagada por el operador (acepta cualquier token, como una bóveda o una cartera nueva). */
async function newAccount(hbar = 20, key = PrivateKey.generateED25519()) {
  const out = await submit(op, new AccountCreateTransaction().setKeyWithoutAlias(key.publicKey).setInitialBalance(new Hbar(hbar)).setMaxAutomaticTokenAssociations(-1));
  assert.ok(out.ok, out.status);
  return { id: out.receipt.accountId, key, client: createClient("local", { accountId: out.receipt.accountId, key }) };
}

/** Cartera + kit + bóveda v2 con el guardián (y registrada en él si se pide). */
async function newVault({ hbar = 40, register = true, port = GUARDIAN_PORT, delays = { W, R }, password = null } = {}) {
  const pocketKey = PrivateKey.generateECDSA();
  const pocketEvm = `0x${pocketKey.publicKey.toEvmAddress()}`.toLowerCase();
  await sendHbar({ client: op, from: operatorId, to: AccountId.fromEvmAddress(0, 0, pocketEvm), tinybars: BigInt(hbar + 60) * HBAR });
  const pocket = await waitFor("cartera", () => mirror.account(pocketEvm));
  const device = createClient("local", { accountId: pocket.id, key: pocketKey });
  const info = await (await fetch(`http://127.0.0.1:${port}/info`)).json();
  const rescueKey = await rescueKeyFromWords((await Mnemonic.generate()).toString());
  const tbKey = password ? await tiebreakerKey(password, rescueKey.publicKey) : null;
  const { notaryId, vaultId, rescueAccountId } = await setupVaultV2({
    client: device,
    mirror,
    pocket: { evmAddress: pocketEvm, publicKey: pocketKey.publicKey },
    rescuePublicKey: rescueKey.publicKey,
    guardianEvm: info.evmAddress,
    withdrawDelay: delays.W,
    recoveryDelay: delays.R,
    initialTinybars: BigInt(hbar) * HBAR,
    tiebreaker: tbKey ? tiebreakerAddress(tbKey) : null,
  });
  const v = { pocketKey, pocket, device, rescueKey, rescueAccountId, kit: createClient("local", { accountId: rescueAccountId, key: rescueKey }), vaultId, notaryId, tbKey };
  if (register) {
    const res = await post(port, "/register", signRegistration(pocketKey, { vaultId: vaultId.toString(), notaryId: notaryId.toString(), pocketId: pocket.id.toString(), pushToken: null, timestamp: nowSeconds() }));
    assert.equal(res.status, 200, await res.clone().text());
    v.readToken = (await res.json()).readToken;
  }
  return v;
}
const balance = async (id) => (await mirror.account(id.toString())).balance;
const activity = async (v, id) => (await loadVaultActivity({ mirror, notaryId: v.notaryId.toString() })).items.find((m) => m.scheduleId === id.toString());

/** Token del atacante (tesorería = operador). */
async function attackerToken({ symbol, feeHbar = 0, keys = {} }) {
  const tx = new TokenCreateTransaction()
    .setTokenName(`Token ${symbol}`)
    .setTokenSymbol(symbol)
    .setDecimals(0)
    .setInitialSupply(1_000_000)
    .setTreasuryAccountId(operatorId);
  if (feeHbar) tx.setCustomFees([new CustomFixedFee().setHbarAmount(new Hbar(feeHbar)).setFeeCollectorAccountId(operatorId)]);
  if (keys.freeze) tx.setFreezeKey(operatorKey.publicKey);
  if (keys.wipe) tx.setWipeKey(operatorKey.publicKey);
  if (keys.pause) tx.setPauseKey(operatorKey.publicKey);
  if (keys.feeSchedule) tx.setFeeScheduleKey(operatorKey.publicKey);
  const out = await submit(op, tx);
  assert.ok(out.ok, out.status);
  return out.receipt.tokenId.toString();
}

// =============================================================================================
// A. Sin ninguna llave
// =============================================================================================

test("A1 · token trampa con comisión en HBAR: al evacuar, los HBAR llegan enteros", async () => {
  const v = await newVault({ hbar: 40, register: false });
  const trap = await attackerToken({ symbol: "TRAMPA", feeHbar: 30 });
  // El atacante lo regala a la bóveda (acepta cualquier token sin asociarlo antes).
  await sendToken({ client: op, from: operatorId, to: v.vaultId, tokenId: trap, amount: 1000n });
  const safe = await newAccount(1);
  const before = await balance(operatorId);
  const out = await evacuateVault({ client: v.device, mirror, vaultId: v.vaultId, to: safe.id, rescueKey: v.rescueKey });
  assert.equal(await balance(safe.id), 41n * HBAR, "los 40 HBAR de la bóveda llegan a la cuenta segura");
  assert.ok((await balance(operatorId)) <= before, "el atacante no cobra nada");
  assert.ok((out.skippedTokens ?? []).some((t) => t.tokenId === trap), "el token trampa se queda, avisado");
  v.device.close();
  v.kit.close();
  safe.client.close();
});

test("A2 · comisión añadida DESPUÉS de pedir la retirada: el guardián la bloquea", async () => {
  const v = await newVault({ hbar: 40 });
  const tok = await attackerToken({ symbol: "CAMBIA", keys: { feeSchedule: true } });
  await sendToken({ client: op, from: operatorId, to: v.vaultId, tokenId: tok, amount: 100n });
  const { scheduleId } = await requestWithdrawalV2({ client: v.device, vaultId: v.vaultId, notaryId: v.notaryId, to: v.pocket.id, tokens: [{ tokenId: tok, amount: 50n }], withdrawDelay: W });
  // Durante la cuenta atrás, el emisor le pone una comisión de 25 HBAR.
  const upd = await submit(op, new TokenFeeScheduleUpdateTransaction().setTokenId(tok).setCustomFees([new CustomFixedFee().setHbarAmount(new Hbar(25)).setFeeCollectorAccountId(operatorId)]));
  assert.ok(upd.ok, upd.status);
  await sleep((W + 8) * 1000);
  assert.equal((await mirror.schedule(scheduleId.toString())).executed, false, "no se ejecuta");
  assert.equal(await balance(v.vaultId), 40n * HBAR, "la bóveda no paga la comisión");
  assert.match(glog(), /comisión/);
  v.device.close();
  v.kit.close();
});

test("A2b · el emisor pone la comisión y completa él mismo la retirada (approve es de cualquiera): no puede", async () => {
  const v = await newVault({ hbar: 40 });
  const tok = await attackerToken({ symbol: "CAMBIA2", keys: { feeSchedule: true } });
  await sendToken({ client: op, from: operatorId, to: v.vaultId, tokenId: tok, amount: 100n });
  // Una app anterior a la 0.10 (o quien tenga la llave del móvil) pide la retirada con ese token.
  const { scheduleId } = await requestWithdrawalV2({ client: v.device, vaultId: v.vaultId, notaryId: v.notaryId, to: v.pocket.id, tokens: [{ tokenId: tok, amount: 50n }], withdrawDelay: W });
  // El guardián la bloquea al verla, sin esperar al final de la cuenta atrás (en mainnet, 24 horas como poco).
  await waitFor("bloqueo del guardián", async () => (await activity(v, scheduleId))?.status === "vetoed", 20_000);
  // El emisor le pone una comisión de 25 HBAR y, acabada la cuenta atrás, la completa él mismo.
  const upd = await submit(op, new TokenFeeScheduleUpdateTransaction().setTokenId(tok).setCustomFees([new CustomFixedFee().setHbarAmount(new Hbar(25)).setFeeCollectorAccountId(operatorId)]));
  assert.ok(upd.ok, upd.status);
  await sleep((W + 2) * 1000);
  const out = await callNotary2({ client: op, notaryId: v.notaryId, call: "approve", schedule: scheduleId });
  assert.equal(out.ok, false, "bloqueada, ya no la completa nadie");
  assert.equal((await mirror.schedule(scheduleId.toString())).executed, false);
  assert.equal(await balance(v.vaultId), 40n * HBAR, "la bóveda no paga la comisión");
  v.device.close();
  v.kit.close();
});

test("A3 · riesgos de un token: comisiones y llaves del emisor a la vista", async () => {
  const id = await attackerToken({ symbol: "RIESGO", feeHbar: 2, keys: { freeze: true, wipe: true, pause: true } });
  const info = await mirror.tokenInfo(id, { fresh: true });
  const r = tokenRisks(info);
  assert.equal(r.chargesOnMove, true);
  assert.equal(r.fixedHbar, 2n * HBAR);
  assert.deepEqual([...r.issuerCan].sort(), ["freeze", "pause", "wipe"]);
  const clean = tokenRisks(await mirror.tokenInfo(await attackerToken({ symbol: "LIMPIO" }), { fresh: true }));
  assert.equal(clean.chargesOnMove, false);
  assert.deepEqual(clean.issuerCan, []);
});

test("A4 · inundar el guardián no impide activar el modo robo", async () => {
  const v = await newVault({ hbar: 10 });
  // Basura desde una misma dirección (llega por el servidor de Expo, que pasa la IP en X-Forwarded-For).
  const attacker = { "x-forwarded-for": "192.0.2.66" };
  const codes = [];
  for (let i = 0; i < 30; i++) codes.push((await post(GUARDIAN_PORT, "/register", { vaultId: "0.0.1", notaryId: "0.0.2", pocketId: "0.0.3", timestamp: nowSeconds(), signature: "00" }, attacker)).status);
  assert.ok(codes.includes(429), "a quien abusa se le frena");
  // Incluso desde ESA misma dirección (p. ej. la misma red), el aviso de robo bien firmado pasa.
  const notice = signTheftNotice(v.rescueKey, { action: "on", vaultId: v.vaultId.toString(), notaryId: v.notaryId.toString(), timestamp: nowSeconds(), lang: "es" });
  const res = await post(GUARDIAN_PORT, "/theft", notice, attacker);
  assert.equal(res.status, 200, await res.clone().text());
  // Otro usuario (otra IP detrás del proxy) tampoco queda bloqueado.
  const w = await newVault({ hbar: 5, register: false });
  const reg = signRegistration(w.pocketKey, { vaultId: w.vaultId.toString(), notaryId: w.notaryId.toString(), pocketId: w.pocket.id.toString(), pushToken: null, timestamp: nowSeconds() });
  assert.equal((await post(GUARDIAN_PORT, "/register", reg, { "x-forwarded-for": "203.0.113.7" })).status, 200);
  const off = signTheftNotice(v.rescueKey, { action: "off", vaultId: v.vaultId.toString(), notaryId: v.notaryId.toString(), timestamp: nowSeconds(), lang: "es" });
  assert.equal((await post(GUARDIAN_PORT, "/theft", off, attacker)).status, 200);
  for (const x of [v, w]) {
    x.device.close();
    x.kit.close();
  }
});

test("A5 · llenar el guardián con bóvedas vacías no deja fuera a una bóveda de verdad", async () => {
  const port = GUARDIAN_PORT + 1;
  await startGuardian(port, { MAX_VAULTS: "1" });
  const junk = await newVault({ hbar: 0, port });
  const real = await newVault({ hbar: 15, register: false, port });
  const reg = signRegistration(real.pocketKey, { vaultId: real.vaultId.toString(), notaryId: real.notaryId.toString(), pocketId: real.pocket.id.toString(), pushToken: null, timestamp: nowSeconds() });
  const res = await post(port, "/register", reg, { "x-forwarded-for": "198.51.100.9" });
  assert.equal(res.status, 200, await res.clone().text());
  // La que sale no sale en silencio: su dueño recibe el aviso (y su app lo ve: ya no está registrada).
  await waitFor("aviso a la bóveda que sale", () => /El guardián ya no vigila tu bóveda/.test(glog()), 5_000);
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/vaults/${junk.vaultId}`)).json()).registered, false);
  for (const x of [junk, real]) {
    x.device.close();
    x.kit.close();
  }
});

test("A6 · 2.500 avisos basura no esconden la última retirada en la app", async () => {
  const iface = new Interface(NOTARY2_ARTIFACT.abi);
  const ev = iface.getEvent("Requested");
  const logs = [];
  for (let i = 0; i < 2500; i++) {
    const enc = iface.encodeEventLog(ev, [`0x${(0x9000 + i).toString(16).padStart(40, "0")}`, 1, 1000 + i, 2000 + i]);
    logs.push({ address: "0x1", topics: enc.topics, data: enc.data, timestamp: `${1000 + i}.000000001` });
  }
  // Mirror falso que pagina como el de verdad, en el orden que se le pida.
  const fakeFetch = async (url) => {
    const u = new URL(url, "http://m");
    const desc = u.searchParams.get("order") === "desc";
    const list = desc ? [...logs].reverse() : logs;
    const offset = Number(u.searchParams.get("offset") ?? 0);
    const page = list.slice(offset, offset + 100);
    const next = offset + 100 < list.length ? `${u.pathname}?order=${desc ? "desc" : "asc"}&limit=100&offset=${offset + 100}` : null;
    return new Response(JSON.stringify({ logs: page, links: { next } }), { status: 200 });
  };
  const m = new Mirror("http://m", fakeFetch);
  const a = await loadVaultActivity({ mirror: m, notaryId: "0.0.42" });
  const newest = `0.0.${0x9000 + 2499}`;
  assert.ok(a.items.some((x) => x.scheduleId === newest), "la última petición se ve");
});

test("A7 · metadata de NFT enorme o con enlaces raros: no se descarga ni se abre", async () => {
  let read = false;
  const huge = async () => ({ ok: true, headers: new Headers({ "content-length": "50000000" }), text: async () => ((read = true), "{}") });
  const meta = Buffer.from("https://evil.example/meta.json").toString("base64");
  assert.equal(await fetchNftMetadata(meta, { fetchImpl: /** @type {any} */ (huge) }), null);
  assert.equal(read, false, "no lee 50 MB");
  const bad = async () => ({ ok: true, headers: new Headers(), text: async () => JSON.stringify({ name: "x", image: "javascript:alert(1)" }) });
  assert.equal((await fetchNftMetadata(meta, { fetchImpl: /** @type {any} */ (bad) }))?.image ?? null, null, "una imagen javascript: no pasa");
});

// =============================================================================================
// B. Con una dApp maliciosa (la Cartera firma con la misma llave que el «móvil» de la bóveda)
// =============================================================================================

const ME = "0.0.5005";
const VAULT = "0.0.6006";
const NOTARY = "0.0.7007";
const bodyOf = (tx, payer = ME) => {
  if (!tx.isFrozen()) tx.setTransactionId(TransactionId.generate(payer)).setNodeAccountIds([new AccountId(3)]).freeze();
  const first = proto.TransactionList.decode(tx.toBytes()).transactionList[0];
  return proto.TransactionBody.decode(proto.SignedTransaction.decode(first.signedTransactionBytes).bodyBytes);
};
const describe = (tx) => describeDappTransaction(bodyOf(tx), { account: ME, vaultId: VAULT, notaryId: NOTARY, lang: "es" });

test("B1 · una dApp no puede preparar nada que toque la bóveda o el notario", () => {
  const vaultOut = new TransferTransaction().addHbarTransfer(VAULT, new Hbar(-100)).addHbarTransfer("0.0.666", new Hbar(100));
  // Programar una transferencia desde la bóveda: la firma de la Cartera cuenta como la del móvil.
  assert.ok(describe(new ScheduleCreateTransaction().setScheduledTransaction(vaultOut)).blocked, "programar una salida de la bóveda");
  // Llamar al notario: la Cartera ES el «móvil» y podría abrir una retirada.
  const call = new ContractExecuteTransaction().setContractId(ContractId.fromString(NOTARY)).setGas(90_000).setFunctionParameters(encodeNotary2("request", ScheduleId.fromString("0.0.9999")));
  assert.ok(describe(call).blocked, "llamar al notario");
  // Firmar una operación programada ajena (con el kit filtrado, móvil + kit = evacuación inmediata).
  assert.ok(describe(new ScheduleSignTransaction().setScheduleId("0.0.9999")).blocked, "firmar una programada");
  // Firmar programadas a través del Schedule Service (0x16b) también.
  const hss = new ContractExecuteTransaction().setContractId(ContractId.fromString("0.0.363")).setGas(100_000).setFunctionParameters(Buffer.from("deadbeef", "hex"));
  assert.ok(describe(hss).blocked, "llamar al Schedule Service");
  // Una transferencia directa desde la bóveda o un cambio en ella.
  assert.ok(describe(vaultOut).blocked, "transferencia desde la bóveda");
  assert.ok(describe(new AccountUpdateTransaction().setAccountId(VAULT).setStakedNodeId(3)).blocked, "tocar la bóveda");
  // Lo normal sigue pasando: un contrato cualquiera de la dApp.
  const swap = new ContractExecuteTransaction().setContractId(ContractId.fromString("0.0.3045981")).setGas(300_000).setPayableAmount(new Hbar(1)).setFunctionParameters(Buffer.from("12345678", "hex"));
  assert.equal(describe(swap).blocked, null);
  assert.equal(describe(new TransferTransaction().addHbarTransfer(ME, new Hbar(-1)).addHbarTransfer("0.0.800", new Hbar(1))).blocked, null);
});

test("B1b · ni escondido dentro de un lote de operaciones", () => {
  const vaultOut = new TransferTransaction().addHbarTransfer(VAULT, new Hbar(-100)).addHbarTransfer("0.0.666", new Hbar(100));
  // Lote atómico (HIP-551) cuyo único contenido es «programar una salida de la bóveda».
  const innerBody = bodyOf(new ScheduleCreateTransaction().setScheduledTransaction(vaultOut));
  const signedInner = proto.SignedTransaction.encode({ bodyBytes: proto.TransactionBody.encode(innerBody).finish(), sigMap: {} }).finish();
  const outer = bodyOf(new TransferTransaction().addHbarTransfer(ME, new Hbar(-1)).addHbarTransfer("0.0.98", new Hbar(1)));
  const batchBody = { transactionID: outer.transactionID, transactionFee: outer.transactionFee, atomicBatch: { transactions: [signedInner] } };
  assert.ok(describeDappTransaction(batchBody, { account: ME, vaultId: VAULT, notaryId: NOTARY, lang: "es" }).blocked);
});

test("B1c · tampoco puede hacer que pague la bóveda: lo que no nombra a nadie saldría de ella", () => {
  const opts = { account: ME, vaultId: VAULT, notaryId: NOTARY, lang: "es" };
  const newKey = PrivateKey.generateED25519().publicKey;
  const create = () => new AccountCreateTransaction().setKeyWithoutAlias(newKey).setInitialBalance(new Hbar(100));
  const pay = () => new ContractExecuteTransaction().setContractId(ContractId.fromString("0.0.3045981")).setGas(300_000).setPayableAmount(new Hbar(100)).setFunctionParameters(Buffer.from("12345678", "hex"));
  // Paga la bóveda: el saldo inicial de la cuenta nueva y los HBAR enviados al contrato salen de ella aunque
  // la operación no la nombre. Con el kit filtrado, la firma de la Cartera bastaría para ejecutarla.
  assert.ok(describeDappTransaction(bodyOf(create(), VAULT), opts).blocked, "crear una cuenta con saldo de la bóveda");
  assert.ok(describeDappTransaction(bodyOf(pay(), VAULT), opts).blocked, "enviar HBAR de la bóveda a un contrato");
  // Lo mismo si la bóveda es quien paga una operación programada (payerAccountID)…
  const scheduled = (inner) => describeDappTransaction(bodyOf(new ScheduleCreateTransaction().setScheduledTransaction(inner).setPayerAccountId(AccountId.fromString(VAULT))), opts);
  assert.ok(scheduled(create()).blocked, "programada que paga la bóveda: crear una cuenta");
  assert.ok(scheduled(pay()).blocked, "programada que paga la bóveda: enviar HBAR a un contrato");
  // …o una operación metida en un lote (cada una lleva su propio pagador).
  const innerBody = bodyOf(create(), VAULT);
  const signedInner = proto.SignedTransaction.encode({ bodyBytes: proto.TransactionBody.encode(innerBody).finish(), sigMap: {} }).finish();
  const outer = bodyOf(new TransferTransaction().addHbarTransfer(ME, new Hbar(-1)).addHbarTransfer("0.0.98", new Hbar(1)));
  assert.ok(describeDappTransaction({ transactionID: outer.transactionID, transactionFee: outer.transactionFee, atomicBatch: { transactions: [signedInner] } }, opts).blocked, "dentro de un lote");
  // Un permiso de gasto o un rechazo de tokens SIN dueño recaen en quien paga.
  const vaultPays = bodyOf(create(), VAULT).transactionID;
  const mePays = bodyOf(create()).transactionID;
  const spender = { shardNum: 0, realmNum: 0, accountNum: 666 };
  const allowance = (transactionID) => ({ transactionID, transactionFee: 100_000_000, cryptoApproveAllowance: { cryptoAllowances: [{ spender, amount: 100 }] } });
  assert.ok(describeDappTransaction(allowance(vaultPays), opts).blocked, "permiso sin dueño pagado por la bóveda");
  assert.ok(describeDappTransaction({ transactionID: vaultPays, transactionFee: 100_000_000, tokenReject: { rejections: [] } }, opts).blocked, "rechazo de tokens sin dueño pagado por la bóveda");
  // Y rechazar los tokens de la bóveda nombrándola, pague quien pague.
  assert.ok(describeDappTransaction({ transactionID: mePays, transactionFee: 100_000_000, tokenReject: { owner: { shardNum: 0, realmNum: 0, accountNum: 6006 }, rejections: [] } }, opts).blocked, "rechazar tokens de la bóveda");
  // Lo normal sigue pasando: la Cartera paga lo suyo, o la dApp le paga la comisión.
  assert.equal(describeDappTransaction(bodyOf(create()), opts).blocked, null, "crear una cuenta con saldo de la Cartera");
  assert.equal(describeDappTransaction(bodyOf(pay()), opts).blocked, null, "swap pagado por la Cartera");
  assert.equal(describeDappTransaction(allowance(mePays), opts).blocked, null, "permiso de la Cartera");
  const sponsored = bodyOf(new TransferTransaction().addHbarTransfer(ME, new Hbar(-1)).addHbarTransfer("0.0.800", new Hbar(1)), "0.0.666");
  assert.equal(describeDappTransaction(sponsored, opts).blocked, null, "la dApp paga la comisión");
});

test("B2 · «firmar un mensaje» nunca sirve como firma de una transacción", () => {
  const key = PrivateKey.generateECDSA();
  const tx = new TransferTransaction().addHbarTransfer(ME, new Hbar(-50)).addHbarTransfer("0.0.666", new Hbar(50));
  tx.setTransactionId(TransactionId.generate(ME)).setNodeAccountIds([new AccountId(3)]).freeze();
  const first = proto.TransactionList.decode(tx.toBytes()).transactionList[0];
  const bodyBytes = proto.SignedTransaction.decode(first.signedTransactionBytes).bodyBytes;
  const sig = key.sign(prefixedMessage(bodyBytes));
  assert.equal(key.publicKey.verify(bodyBytes, sig), false);
});

test("B3 · navegador: dominios imitados y enlaces raros no se quedan dentro", () => {
  const top = (url) => browserDecision({ url, isTopFrame: true }).action;
  for (const url of [
    "https://xn--sucerswap-r2a.finance/", // «sаucerswap» con letra cirílica
    "https://saucerswap.finance.evil.io/",
    "https://evil.io/saucerswap.finance",
    "https://saucerswap.finance@evil.io/",
    "https://evil.io\\@saucerswap.finance",
    "https://evil.io#https://www.saucerswap.finance",
    "http://www.saucerswap.finance/",
  ])
    assert.notEqual(top(url), "allow", url);
  for (const url of ["javascript:alert(1)", "data:text/html,<h1>x</h1>", "blob:https://www.saucerswap.finance/x", "file:///etc/passwd", "hashpack://x", "itms-services://x"]) assert.equal(top(url), "block", url);
  assert.equal(top("https://WWW.SaucerSwap.Finance/swap"), "allow");
  // Con punto final o puerto 443 explícito es el mismo dominio (no es una imitación).
  assert.equal(dappForUrl("https://www.saucerswap.finance.:443/")?.id, "saucerswap");
});

// =============================================================================================
// C. Con el kit filtrado
// =============================================================================================

test("C1 · kit filtrado: congela, activa el modo robo y pide recuperación; el dueño evacúa igual", async () => {
  const v = await newVault({ hbar: 30 });
  const thief = await newAccount(1);
  assert.ok((await callNotary2({ client: v.kit, notaryId: v.notaryId, call: "freeze", lane: Lane.Withdraw })).ok);
  const on = signTheftNotice(v.rescueKey, { action: "on", vaultId: v.vaultId.toString(), notaryId: v.notaryId.toString(), timestamp: nowSeconds(), lang: "es" });
  assert.equal((await post(GUARDIAN_PORT, "/theft", on)).status, 200);
  const { scheduleId } = await requestRecoveryV2({ client: v.kit, vaultId: v.vaultId, notaryId: v.notaryId, to: thief.id, tinybars: 30n * HBAR, recoveryDelay: R });
  // El móvil congela las recuperaciones (anula la del ladrón)…
  assert.ok((await callNotary2({ client: v.device, notaryId: v.notaryId, call: "freeze", lane: Lane.Recovery })).ok);
  // …y el dueño, que también tiene sus 24 palabras, evacúa al momento a una cuenta segura.
  const safe = await newAccount(1);
  await evacuateVault({ client: v.device, mirror, vaultId: v.vaultId, to: safe.id, rescueKey: v.rescueKey });
  assert.equal(await balance(safe.id), 31n * HBAR);
  await sleep((R + 6) * 1000);
  assert.equal((await mirror.schedule(scheduleId.toString())).executed, false);
  assert.equal(await balance(thief.id), 1n * HBAR, "el ladrón no se lleva nada");
  for (const c of [v.device, v.kit, thief.client, safe.client]) c.close();
});

// =============================================================================================
// D. Con la llave del móvil: operación «cargada» (aprobada pero sin ejecutar)
// =============================================================================================

test("D1 · operación que paga otra cuenta sin firmar: el guardián la bloquea y no se puede disparar después", async () => {
  const v = await newVault({ hbar: 30 });
  const thief = await newAccount(5);
  // El ladrón (con la llave del móvil) programa una salida cuyo pagador es su otra cuenta, SIN su firma:
  // así no se ejecuta al aprobarse y la puede disparar cuando quiera.
  const inner = buildVaultTransfer({ vaultId: v.vaultId, to: thief.id, tinybars: 30n * HBAR });
  const sc = await submit(
    v.device,
    new ScheduleCreateTransaction().setScheduledTransaction(inner).setPayerAccountId(thief.id).setScheduleMemo("cargada").setExpirationTime(Timestamp.fromDate(new Date((nowSeconds() + 120) * 1000))).setWaitForExpiry(false),
  );
  assert.ok(sc.ok, sc.status);
  const scheduleId = sc.receipt.scheduleId;
  assert.ok((await callNotary2({ client: v.device, notaryId: v.notaryId, call: "request", schedule: scheduleId })).ok);
  await waitFor("bloqueo del guardián", async () => (await activity(v, scheduleId))?.status === "vetoed", 20_000);
  await sleep((W + 4) * 1000);
  // Pasada la cuenta atrás, el ladrón intenta dispararla firmando con su cuenta: no hay firma del notario.
  await submit(thief.client, new ScheduleSignTransaction().setScheduleId(scheduleId));
  assert.equal((await mirror.schedule(scheduleId.toString())).executed, false);
  assert.equal(await balance(v.vaultId), 30n * HBAR);
  for (const c of [v.device, v.kit, thief.client]) c.close();
});

// =============================================================================================
// E. Empate móvil contra kit: la contraseña de desempate (notario v3)
// =============================================================================================

test("E1 · móvil robado contra kit + contraseña: la recuperación prioritaria sale aunque el ladrón congele y bloquee", async () => {
  const PASS = "faro  Tortuga  CANELA  nube  río";
  const v = await newVault({ hbar: 30, password: PASS });
  assert.equal((await notary2Config({ mirror, notaryId: v.notaryId })).version, 3);
  const thief = await newAccount(1);
  const safe = await newAccount(1);
  // El ladrón (llave del móvil) pide una retirada a su cuenta y congela las recuperaciones.
  const { scheduleId: robo } = await requestWithdrawalV2({ client: v.device, vaultId: v.vaultId, notaryId: v.notaryId, to: thief.id, tinybars: 30n * HBAR, withdrawDelay: W });
  assert.ok((await callNotary2({ client: v.device, notaryId: v.notaryId, call: "freeze", lane: Lane.Recovery })).ok);
  // Con el kit pero la contraseña equivocada: no hay prioridad.
  const wrong = await tiebreakerKey("faro tortuga canela nube mar", v.rescueKey.publicKey);
  await assert.rejects(
    requestPriorityRecoveryV3({ client: v.kit, vaultId: v.vaultId, notaryId: v.notaryId, to: safe.id, tinybars: 30n * HBAR, recoveryDelay: R, tiebreakerKey: wrong, chainId: CHAIN_IDS.local }),
    /contraseña de desempate/,
  );
  // La contraseña se escribe con otras mayúsculas y espacios: vale igual.
  const ok = await tiebreakerKey("Faro tortuga canela Nube Río", v.rescueKey.publicKey);
  const { scheduleId } = await requestPriorityRecoveryV3({ client: v.kit, vaultId: v.vaultId, notaryId: v.notaryId, to: safe.id, tinybars: 30n * HBAR, recoveryDelay: R, tiebreakerKey: ok, chainId: CHAIN_IDS.local });
  // El ladrón no la puede bloquear ni anular congelando otra vez, y ya no puede pedir más retiradas.
  assert.equal((await callNotary2({ client: v.device, notaryId: v.notaryId, call: "veto", schedule: scheduleId })).ok, false);
  assert.ok((await callNotary2({ client: v.device, notaryId: v.notaryId, call: "freeze", lane: Lane.Recovery })).ok);
  await assert.rejects(requestWithdrawalV2({ client: v.device, vaultId: v.vaultId, notaryId: v.notaryId, to: thief.id, tinybars: 1n * HBAR, withdrawDelay: W }));
  // La retirada del ladrón quedó anulada; la prioritaria la completa el guardián al acabar la cuenta atrás.
  await waitFor("recuperación prioritaria ejecutada", async () => (await mirror.schedule(scheduleId.toString()))?.executed, (R + 25) * 1000);
  assert.equal(await balance(safe.id), 31n * HBAR, "los 30 HBAR llegan a la cuenta del dueño");
  assert.equal(await balance(thief.id), 1n * HBAR, "el ladrón no se lleva nada");
  assert.equal((await mirror.schedule(robo.toString())).executed, false);
  const mine = await activity(v, scheduleId);
  assert.equal(mine.priority, true);
  assert.equal((await activity(v, robo)).status, "superseded");
  for (const c of [v.device, v.kit, thief.client, safe.client]) c.close();
});

test("E2 · la contraseña se pone a una bóveda sin ella, se mantiene al cambiar plazos y el móvil solo no la quita", async () => {
  const v = await newVault({ hbar: 5, register: false });
  assert.equal((await notary2Config({ mirror, notaryId: v.notaryId })).version, 2);
  const key = await tiebreakerKey("lápiz órbita trigo ancla", v.rescueKey.publicKey);
  // Poner la contraseña: notario v3 con los mismos plazos (móvil + kit).
  const up = await changeVaultDelaysV2({ client: v.device, mirror, vaultId: v.vaultId, rescueKey: v.rescueKey, withdrawDelay: W, recoveryDelay: R, tiebreaker: tiebreakerAddress(key), allowTest: true });
  const cfg = await waitFor("notario v3", async () => {
    const c = await notary2Config({ mirror, notaryId: up.notaryId }).catch(() => null);
    return c?.version === 3 ? c : null;
  });
  assert.equal(cfg.tiebreaker, tiebreakerAddress(key));
  // Cambiar solo los plazos: la contraseña sigue.
  const again = await changeVaultDelaysV2({ client: v.device, mirror, vaultId: v.vaultId, rescueKey: v.rescueKey, withdrawDelay: W + 1, recoveryDelay: R + 1, allowTest: true });
  const cfg2 = await waitFor("notario nuevo", () => notary2Config({ mirror, notaryId: again.notaryId }).catch(() => null));
  assert.equal(cfg2.tiebreaker, tiebreakerAddress(key));
  assert.equal(cfg2.withdrawDelay, W + 1);
  // Con el móvil solo (sin las 24 palabras) no se puede cambiar el notario: la llave de la bóveda pide el kit.
  await assert.rejects(
    changeVaultDelaysV2({ client: v.device, mirror, vaultId: v.vaultId, rescueKey: PrivateKey.generateED25519(), withdrawDelay: W, recoveryDelay: R, tiebreaker: null, allowTest: true }),
    /24 palabras/,
  );
  v.device.close();
  v.kit.close();
});

// =============================================================================================
// F. Contra el guardián: dejarlo ciego o sin saldo
// =============================================================================================

test("F1 · un aviso que no es una operación no deja ciegos ni al guardián ni a la app", async () => {
  const v = await newVault({ hbar: 30 });
  const thief = await newAccount(1);
  // Con la llave del móvil se anuncian al notario direcciones que no son las de ninguna programada
  // (el contrato acepta cualquiera)…
  const iface = new Interface(NOTARY2_ARTIFACT.abi);
  for (const bogus of ["0x00000000ffffffffffffffff0000000000000001", "0x000000000000000000000000ffffffffffffffff"]) {
    const call = new ContractExecuteTransaction().setContractId(v.notaryId).setGas(90_000).setFunctionParameters(Buffer.from(iface.encodeFunctionData("request", [bogus]).slice(2), "hex"));
    const out = await submit(v.device, call);
    assert.ok(out.ok, out.status);
  }
  // …y después una operación que la app nunca pide: cambiar la llave de la bóveda.
  const inner = new AccountUpdateTransaction().setAccountId(v.vaultId).setKey(thief.key.publicKey);
  const sc = await submit(v.device, new ScheduleCreateTransaction().setScheduledTransaction(inner).setScheduleMemo("llave").setExpirationTime(Timestamp.fromDate(new Date((nowSeconds() + 120) * 1000))).setWaitForExpiry(false));
  assert.ok(sc.ok, sc.status);
  const scheduleId = sc.receipt.scheduleId;
  assert.ok((await callNotary2({ client: v.device, notaryId: v.notaryId, call: "request", schedule: scheduleId })).ok);
  // El guardián sigue viendo y bloquea el cambio de llave…
  await waitFor("bloqueo del guardián tras los avisos ilegibles", async () => (await activity(v, scheduleId))?.status === "vetoed", 30_000);
  // …y la app sigue cargando los movimientos, con los avisos ilegibles contados aparte.
  const a = await loadVaultActivity({ mirror, notaryId: v.notaryId.toString() });
  assert.equal(a.unreadable.length, 2, "los dos avisos ilegibles");
  assert.ok(a.items.every((m) => /^0\.0\.\d+$/.test(m.scheduleId)), "solo operaciones de verdad en la lista");
  await sleep((W + 4) * 1000);
  assert.equal(await balance(v.vaultId), 30n * HBAR);
  for (const c of [v.device, v.kit, thief.client]) c.close();
});

test("F2 · el guardián no admite notarios con plazos que la app no ofrece", async () => {
  // Un notario con plazos raros (o de segundos) solo sirve para hacerle gastar: no lo vigila.
  const v = await newVault({ hbar: 1, register: false, delays: { W: 1000, R: 2000 } });
  const res = await post(GUARDIAN_PORT, "/register", signRegistration(v.pocketKey, { vaultId: v.vaultId.toString(), notaryId: v.notaryId.toString(), pocketId: v.pocket.id.toString(), pushToken: null, timestamp: nowSeconds() }));
  assert.equal(res.status, 400, await res.clone().text());
  assert.match((await res.json()).error, /plazos/);
  for (const c of [v.device, v.kit]) c.close();
});

test("F3 · tope diario por bóveda: el guardián deja de pagar y el dueño completa a mano", async () => {
  const port = GUARDIAN_PORT + 2;
  await startGuardian(port, { BUDGET_APPROVES_DAY: "1" });
  const v = await newVault({ hbar: 30, port });
  const dest = await newAccount(1);
  // La primera retirada del día la completa el guardián.
  const first = await requestWithdrawalV2({ client: v.device, vaultId: v.vaultId, notaryId: v.notaryId, to: dest.id, tinybars: 5n * HBAR, withdrawDelay: W });
  await waitFor("primera retirada", async () => (await mirror.schedule(first.scheduleId.toString()))?.executed, 40_000);
  // La segunda ya no (tope de 1 al día en este guardián): se queda esperando…
  const second = await requestWithdrawalV2({ client: v.device, vaultId: v.vaultId, notaryId: v.notaryId, to: dest.id, tinybars: 5n * HBAR, withdrawDelay: W });
  await sleep((W + 10) * 1000);
  assert.equal((await mirror.schedule(second.scheduleId.toString())).executed, false, "el guardián no paga más por esta bóveda hoy");
  // …y el dueño la completa desde la app: aprobar puede hacerlo cualquiera.
  assert.ok((await callNotary2({ client: v.device, notaryId: v.notaryId, call: "approve", schedule: second.scheduleId })).ok);
  await waitFor("segunda retirada", async () => (await mirror.schedule(second.scheduleId.toString()))?.executed, 20_000);
  assert.equal(await balance(dest.id), 11n * HBAR);
  for (const c of [v.device, v.kit, dest.client]) c.close();
});

test("F4 · token cuyo emisor puede cambiar las comisiones: el guardián bloquea la retirada y sale con «Evacuar»", async () => {
  const v = await newVault({ hbar: 40 });
  const dest = await newAccount(1);
  // Sin comisión… pero con la llave para ponerla en cualquier momento (también en el último segundo).
  const tok = await attackerToken({ symbol: "LLAVE", keys: { feeSchedule: true } });
  await sendToken({ client: op, from: operatorId, to: v.vaultId, tokenId: tok, amount: 100n });
  const { scheduleId } = await requestWithdrawalV2({ client: v.device, vaultId: v.vaultId, notaryId: v.notaryId, to: dest.id, tokens: [{ tokenId: tok, amount: 40n }], withdrawDelay: W });
  await waitFor("bloqueo del guardián", async () => (await activity(v, scheduleId))?.status === "vetoed", 20_000);
  assert.match(glog(), /puede ponerle una comisión cuando quiera/);
  const st = await (await fetch(`http://127.0.0.1:${GUARDIAN_PORT}/vaults/${v.vaultId}`)).json();
  assert.equal(st.pending[scheduleId.toString()]?.feeRisk?.reason, "feeKey");
  await sleep((W + 2) * 1000);
  assert.equal((await mirror.schedule(scheduleId.toString())).executed, false, "nadie puede completarla");
  // Ese token sale con «Evacuar» (móvil + kit, sin cuenta atrás): primero los HBAR, luego los tokens.
  const safe = await newAccount(1);
  const out = await evacuateVault({ client: v.device, mirror, vaultId: v.vaultId, to: safe.id, rescueKey: v.rescueKey });
  assert.ok(out.tokens.some((t) => t.tokenId === tok && t.amount === 100n), "el token sale entero");
  assert.equal(await balance(safe.id), 41n * HBAR, "y los 40 HBAR también");
  for (const c of [v.device, v.kit, dest.client, safe.client]) c.close();
});

test("F6 · /vaults: a desconocidos solo les dice si está registrada; la app, con su código, ve lo suyo", async () => {
  const outside = { "x-forwarded-for": "203.0.113.20" };
  const view = async (id, headers = {}) => (await fetch(`http://127.0.0.1:${GUARDIAN_PORT}/vaults/${id}`, { headers })).json();
  const v = await newVault({ hbar: 5 });
  assert.deepEqual(await view(v.vaultId, outside), { registered: true }, "ni modo robo, ni correo, ni nada pendiente");
  const mine = await view(v.vaultId, { ...outside, "x-h10x-token": v.readToken });
  assert.equal(mine.registered, true);
  assert.equal(mine.theft, null);
  assert.equal(mine.email, null);
  assert.equal("pending" in mine, false, "lo pendiente, ni para la app");
  assert.deepEqual(await view(v.vaultId, { ...outside, "x-h10x-token": "x".repeat(32) }), { registered: true });
  // Volver a registrar (lo hace la app cada vez que se abre) da otro código; el anterior deja de valer.
  const again = await post(GUARDIAN_PORT, "/register", signRegistration(v.pocketKey, { vaultId: v.vaultId.toString(), notaryId: v.notaryId.toString(), pocketId: v.pocket.id.toString(), pushToken: null, timestamp: nowSeconds() }));
  const fresh = (await again.json()).readToken;
  assert.ok(fresh && fresh !== v.readToken);
  assert.deepEqual(await view(v.vaultId, { ...outside, "x-h10x-token": v.readToken }), { registered: true });
  assert.equal((await view(v.vaultId, { ...outside, "x-h10x-token": fresh })).registered, true);
  assert.ok("pending" in (await view(v.vaultId)), "desde el propio servidor (sin proxy), todo");
  // Una bóveda que solo conoce el guardián por el aviso de robo (sin registro de la app 0.10): lo de antes, sin lo pendiente.
  const w = await newVault({ hbar: 5, register: false });
  const on = signTheftNotice(w.rescueKey, { action: "on", vaultId: w.vaultId.toString(), notaryId: w.notaryId.toString(), timestamp: nowSeconds(), lang: "es" });
  assert.equal((await post(GUARDIAN_PORT, "/theft", on)).status, 200);
  const legacy = await view(w.vaultId, outside);
  assert.ok(legacy.theft && legacy.theft.until > nowSeconds());
  assert.equal("pending" in legacy, false);
  assert.equal(legacy.legacy, true, "la app 0.10 sabe que tiene que pedir su código");
  assert.deepEqual(await view("__proto__", outside), { registered: false });
  const off = signTheftNotice(w.rescueKey, { action: "off", vaultId: w.vaultId.toString(), notaryId: w.notaryId.toString(), timestamp: nowSeconds(), lang: "es" });
  assert.equal((await post(GUARDIAN_PORT, "/theft", off)).status, 200);
  for (const c of [v.device, v.kit, w.device, w.kit]) c.close();
});

test("F5 · avisos por correo: solo el kit los pone o los quita, y avisan de lo grave", async () => {
  const port = GUARDIAN_PORT + 3;
  const g = await startGuardian(port, { EMAIL_PROVIDER: "archivo" });
  const outbox = join(g.dir, "correos.jsonl");
  const mails = () => (existsSync(outbox) ? readFileSync(outbox, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/info`)).json()).emails, true);
  const v = await newVault({ hbar: 30, port });
  const base = { vaultId: v.vaultId.toString(), notaryId: v.notaryId.toString(), lang: /** @type {const} */ ("es") };
  const emailPost = (key, n) => post(port, "/email", signEmailNotice(key, { ...base, timestamp: nowSeconds(), ...n }));
  const status = async () => (await fetch(`http://127.0.0.1:${port}/vaults/${v.vaultId}`)).json();
  // Con la llave del móvil no se puede poner (quien robe el móvil no puede desviar los avisos).
  assert.equal((await emailPost(v.pocketKey, { action: "start", email: "ladron@correo.es" })).status, 401);
  assert.equal(mails().length, 0);
  // Con el kit: llega un código a ese correo…
  assert.equal((await emailPost(v.rescueKey, { action: "start", email: "dueno@correo.es" })).status, 200);
  const sent = mails().at(-1);
  assert.equal(sent.to, "dueno@correo.es");
  assert.doesNotMatch(sent.text, /https?:\/\//, "sin enlaces");
  const code = /(\d{6})/.exec(sent.text)?.[1] ?? "";
  // …y sin el código bueno no se activa.
  assert.equal((await emailPost(v.rescueKey, { action: "confirm", email: "dueno@correo.es", code: code === "000000" ? "111111" : "000000" })).status, 400);
  assert.equal((await emailPost(v.rescueKey, { action: "confirm", email: "dueno@correo.es", code })).status, 200);
  assert.equal((await status()).email, "d•••@correo.es", "se enseña a medias, nunca entero");
  // Una retirada pedida también llega al correo.
  const dest = await newAccount(1);
  await requestWithdrawalV2({ client: v.device, vaultId: v.vaultId, notaryId: v.notaryId, to: dest.id, tinybars: 5n * HBAR, withdrawDelay: W });
  await waitFor("correo de la retirada", () => mails().some((m) => m.to === "dueno@correo.es" && /Retirada solicitada/.test(m.subject)), 20_000);
  // Con el móvil se vuelve a registrar con otro destino para los avisos: el correo se entera y sigue puesto.
  const rereg = await post(port, "/register", signRegistration(v.pocketKey, { vaultId: base.vaultId, notaryId: base.notaryId, pocketId: v.pocket.id.toString(), pushToken: "token-de-otro-movil", timestamp: nowSeconds() }));
  assert.equal(rereg.status, 200, await rereg.clone().text());
  await waitFor("correo del cambio de móvil", () => mails().some((m) => m.to === "dueno@correo.es" && /otro móvil/.test(m.subject)), 10_000);
  assert.equal((await status()).email, "d•••@correo.es");
  // Quitarlo con la llave del móvil, tampoco; con el kit sí, y se avisa al correo que deja de recibir.
  assert.equal((await emailPost(v.pocketKey, { action: "remove", email: "" })).status, 401);
  assert.equal((await emailPost(v.rescueKey, { action: "remove", email: "" })).status, 200);
  assert.ok(mails().some((m) => m.to === "dueno@correo.es" && /desactivados/.test(m.subject)));
  assert.equal((await status()).email, null);
  for (const c of [v.device, v.kit, dest.client]) c.close();
});
