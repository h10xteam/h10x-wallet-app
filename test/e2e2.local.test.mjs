// Extremo a extremo de la bóveda v2 SIN red: nodo + mirror simulados, el núcleo de la app y el guardián
// real (proceso aparte). Recorre lo que hará la app v2: alta, registro, retirada completada por el
// guardián, kit robado y congelación, recuperación en un móvil nuevo y evacuación con las dos llaves.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountCreateTransaction, AccountId, AccountUpdateTransaction, Hbar, KeyList, Mnemonic, NftId, PrivateKey, TokenCreateTransaction, TokenId, TokenMintTransaction, TokenType, TransactionId, TransferTransaction } from "@hiero-ledger/sdk";
import {
  HBAR,
  Lane,
  Mirror,
  WalletError,
  callNotary2,
  changeVaultDelaysV2,
  checkDelays,
  createClient,
  DELAY_CHOICES,
  DELAYS2,
  describeDappTransaction,
  executeDappRequest,
  freezeDappRequest,
  parseDappRequest,
  gatewayUrl,
  nftMetadataUri,
  sendNfts,
  evacuateVault,
  findRescueAccount,
  friendlyNotary2Error,
  inspectVaultV2,
  isVaultKeyV2For,
  loadVaultActivity,
  longZeroAddress,
  notary2Config,
  nowSeconds,
  SERVICE_FEES,
  buildVaultKeyV2,
  requestEnableTokensV2,
  requestStakingV2,
  pickStakingNode,
  scheduleForVault,
  requestRecoveryV2,
  requestWithdrawalV2,
  rescueKeyFromWords,
  sendHbar,
  sendToken,
  setupVaultV2,
  signTheftNotice,
  summarizeAction,
  signRegistration,
  submit,
} from "@boveda/core";
import { startFakeNetwork } from "./sim/fake-network.mjs";

const GUARDIAN_PORT = 18789;
const W = 4;
const R = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mirror = new Mirror("http://127.0.0.1:5551");
const operatorKey = PrivateKey.generateED25519();
const operatorId = new AccountId(1001);
const guardianKey = PrivateKey.generateED25519();
let net;
let guardian;
let guardianLog = "";
let dataDir;

async function waitFor(what, fn, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`tiempo agotado esperando: ${what}\n--- guardián ---\n${guardianLog}`);
    await sleep(500);
  }
}

before(async () => {
  net = await startFakeNetwork({ operatorNum: 1001, operatorKey: operatorKey.publicKey });
  const op = createClient("local", { accountId: operatorId, key: operatorKey });
  const created = await submit(op, new AccountCreateTransaction().setKeyWithoutAlias(guardianKey.publicKey).setInitialBalance(new Hbar(50)));
  op.close();
  dataDir = mkdtempSync(join(tmpdir(), "guardian2-"));
  guardian = spawn(process.execPath, ["guardian/src/index.js"], {
    env: {
      ...process.env,
      HEDERA_NETWORK: "local",
      MIRROR_URL: "http://127.0.0.1:5551",
      OPERATOR_KEY: guardianKey.toStringDer(),
      OPERATOR_ID: created.receipt.accountId.toString(),
      PORT: String(GUARDIAN_PORT),
      DATA_DIR: dataDir,
      POLL_SECONDS: "3",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  guardian.stdout.on("data", (d) => (guardianLog += d));
  guardian.stderr.on("data", (d) => (guardianLog += d));
  await waitFor("arranque del guardián", async () => {
    try {
      return (await fetch(`http://127.0.0.1:${GUARDIAN_PORT}/health`)).ok;
    } catch {
      return false;
    }
  });
});

after(() => {
  if (process.env.SHOW_GUARDIAN_LOG) console.log(`--- registro del guardián ---\n${guardianLog}`);
  guardian?.kill("SIGTERM");
  net?.stop();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test("textos de error del notario v2", () => {
  assert.equal(friendlyNotary2Error("veto", "BadStatus(2)"), "Ya estaba bloqueada.");
  assert.equal(friendlyNotary2Error("approve", "Superseded()"), "Se anuló al congelar su carril: no saldrá.");
  assert.match(friendlyNotary2Error("request", "LaneLocked(1, 1794517988)"), /congelado hasta/);
  assert.match(friendlyNotary2Error("requestRecovery", "NotRescue(0xabc)"), /kit de rescate/);
});

test("bóveda v2 de punta a punta con el guardián", async (t) => {
  const op = createClient("local", { accountId: operatorId, key: operatorKey });
  const pocketKey = PrivateKey.generateECDSA();
  const pocketEvm = `0x${pocketKey.publicKey.toEvmAddress()}`.toLowerCase();
  await sendHbar({ client: op, from: operatorId, to: AccountId.fromEvmAddress(0, 0, pocketEvm), tinybars: 100n * HBAR });
  const pocket = await waitFor("cartera", () => mirror.account(pocketEvm));
  const device = createClient("local", { accountId: pocket.id, key: pocketKey });
  const info = await (await fetch(`http://127.0.0.1:${GUARDIAN_PORT}/info`)).json();
  const mnemonic = await Mnemonic.generate();
  const words = mnemonic.toString();
  const rescueKey = await rescueKeyFromWords(words);

  const steps = [];
  const { notaryId, vaultId, rescueAccountId } = await setupVaultV2({
    client: device,
    mirror,
    pocket: { evmAddress: pocketEvm, publicKey: pocketKey.publicKey },
    rescuePublicKey: rescueKey.publicKey,
    guardianEvm: info.evmAddress,
    withdrawDelay: W,
    recoveryDelay: R,
    initialTinybars: 20n * HBAR,
    onStep: (s) => steps.push(s),
  });

  await t.test("crea kit, notario y bóveda con la clave de tres rutas", async () => {
    assert.deepEqual(steps, ["kit", "notary", "vault"]);
    const vault = await mirror.account(vaultId.toString());
    assert.equal(vault.balance, 20n * HBAR);
    assert.ok(vault.key instanceof KeyList && isVaultKeyV2For(vault.key, notaryId));
    assert.equal((await mirror.account(rescueAccountId.toString())).balance, 3n * HBAR);
    const cfg = await notary2Config({ mirror, notaryId });
    assert.deepEqual(cfg, { device: pocketEvm, rescue: longZeroAddress(rescueAccountId), guardian: info.evmAddress, withdrawDelay: W, recoveryDelay: R, tiebreaker: null, version: 2 });
  });

  await t.test("el guardián registra la v2 solo con la firma y la cartera correctas", async () => {
    const fields = { vaultId: vaultId.toString(), notaryId: notaryId.toString(), pocketId: pocket.id.toString(), pushToken: null, timestamp: nowSeconds() };
    const post = (body) => fetch(`http://127.0.0.1:${GUARDIAN_PORT}/guardian/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post(signRegistration(PrivateKey.generateECDSA(), fields))).status, 401);
    // Otra cuenta (la del kit no sirve: su clave es ED25519 y no es la del móvil de la bóveda).
    const kitSigned = signRegistration(rescueKey, { ...fields, pocketId: rescueAccountId.toString() });
    assert.equal((await post(kitSigned)).status, 400);
    const ok = await post(signRegistration(pocketKey, fields));
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.match(guardianLog, /bóveda v2 registrada/);

    // Registro v3: las preferencias de avisos de H10X van firmadas.
    const vaultState = async () => (await fetch(`http://127.0.0.1:${GUARDIAN_PORT}/vaults/${vaultId}`)).json();
    assert.equal((await vaultState()).h10x, null, "sin preferencias: el guardián manda los dos");
    const v3 = signRegistration(pocketKey, { ...fields, timestamp: nowSeconds(), lang: "es", h10x: "d" });
    assert.equal((await post(v3)).status, 200);
    assert.deepEqual((await vaultState()).h10x, { dao: true, basket: false });
    assert.equal((await post({ ...v3, h10x: "db" })).status, 401, "cambiar las preferencias rompe la firma");
    assert.equal((await post(signRegistration(pocketKey, { ...fields, timestamp: nowSeconds(), lang: "es", h10x: "x" }))).status, 400);
    assert.equal((await post(signRegistration(pocketKey, { ...fields, timestamp: nowSeconds(), lang: "es" }))).status, 200);
    assert.deepEqual((await vaultState()).h10x, { dao: true, basket: false }, "un registro sin preferencias (app antigua) las conserva");
  });

  await t.test("retirada con el móvil: el guardián la completa al acabar la cuenta atrás", async () => {
    const { scheduleId } = await requestWithdrawalV2({ client: device, vaultId, notaryId, to: operatorId, tinybars: 2n * HBAR, withdrawDelay: W });
    const a = await loadVaultActivity({ mirror, notaryId: notaryId.toString() });
    assert.equal(a.items[0].lane, "withdraw");
    assert.equal(a.items[0].status, "requested");
    assert.equal(a.items[0].action.kind, "transfer");
    await waitFor("ejecución por el guardián", async () => (await mirror.schedule(scheduleId.toString()))?.executed, 30_000);
    assert.equal((await mirror.account(vaultId.toString())).balance, 18n * HBAR);
  });

  await t.test("kit robado: su recuperación se ve, el móvil congela y el guardián no la completa", async () => {
    const thief = createClient("local", { accountId: rescueAccountId, key: rescueKey });
    const { scheduleId } = await requestRecoveryV2({ client: thief, vaultId, notaryId, to: operatorId, tinybars: 18n * HBAR, recoveryDelay: R });
    let a = await loadVaultActivity({ mirror, notaryId: notaryId.toString() });
    assert.equal(a.items[0].lane, "recovery");
    await waitFor("aviso del guardián", async () => /Alguien ha usado tu kit/.test(guardianLog), 15_000);
    const frozen = await callNotary2({ client: device, notaryId, call: "freeze", lane: Lane.Recovery });
    assert.ok(frozen.ok, frozen.reason);
    a = await loadVaultActivity({ mirror, notaryId: notaryId.toString() });
    assert.equal(a.items.find((m) => m.scheduleId === scheduleId.toString()).status, "superseded");
    assert.ok(a.locks.recovery > nowSeconds());
    // Un segundo intento choca con el carril congelado.
    await assert.rejects(
      requestRecoveryV2({ client: thief, vaultId, notaryId, to: operatorId, tinybars: HBAR, recoveryDelay: R }),
      (e) => e instanceof WalletError && /congelado hasta/.test(e.message),
    );
    await sleep((R + 6) * 1000);
    assert.equal((await mirror.schedule(scheduleId.toString())).executed, false);
    const state = await (await fetch(`http://127.0.0.1:${GUARDIAN_PORT}/vaults/${vaultId}`)).json();
    assert.equal(state.pending[scheduleId.toString()].status, "superseded");
    thief.close();
  });

  await t.test("móvil perdido: con las 24 palabras y el número de bóveda se recupera en otro móvil", async () => {
    // Lo que hace la app en el móvil nuevo: solo conoce las palabras y el número de la bóveda.
    const key = await rescueKeyFromWords(`  ${words.toUpperCase()}  `);
    const vault = await inspectVaultV2({ mirror, vaultId: vaultId.toString() });
    assert.ok(vault);
    assert.equal(vault.rescueKey.toStringRaw(), key.publicKey.toStringRaw(), "las palabras corresponden al kit");
    const cfg = await notary2Config({ mirror, notaryId: vault.notaryId });
    const kit = await findRescueAccount({ mirror, rescuePublicKey: key.publicKey, rescueAddress: cfg.rescue });
    assert.equal(kit?.id.toString(), rescueAccountId.toString());
    // Cartera nueva en el móvil nuevo, creada por la cuenta del kit.
    const newKey = PrivateKey.generateECDSA();
    const newEvm = `0x${newKey.publicKey.toEvmAddress()}`.toLowerCase();
    const kitClient = createClient("local", { accountId: kit.id, key });
    await sendHbar({ client: kitClient, from: kit.id, to: AccountId.fromEvmAddress(0, 0, newEvm), tinybars: HBAR });
    const newPocket = await waitFor("cartera nueva", () => mirror.account(newEvm));
    await waitFor("carril reabierto", async () => nowSeconds() > (await loadVaultActivity({ mirror, notaryId: notaryId.toString() })).locks.recovery + 1, 30_000);
    const { scheduleId } = await requestRecoveryV2({ client: kitClient, vaultId, notaryId: vault.notaryId, to: newPocket.id, tinybars: vault.balance, recoveryDelay: cfg.recoveryDelay });
    await waitFor("recuperación completada por el guardián", async () => (await mirror.schedule(scheduleId.toString()))?.executed, 40_000);
    assert.equal((await mirror.account(newEvm)).balance, HBAR + 18n * HBAR);
    assert.equal((await mirror.account(vaultId.toString())).balance, 0n);
    kitClient.close();
  });

  await t.test("evacuación con móvil + kit: inmediata; con otras palabras, rechazada", async () => {
    await sendHbar({ client: device, from: pocket.id, to: vaultId, tinybars: 5n * HBAR });
    const wrong = await rescueKeyFromWords((await Mnemonic.generate()).toString());
    await assert.rejects(evacuateVault({ client: device, mirror, vaultId, to: pocket.id, rescueKey: wrong }), /no son las del kit/);
    const out = await evacuateVault({ client: device, mirror, vaultId, to: pocket.id, rescueKey });
    assert.equal(out.tinybars, 5n * HBAR);
    assert.equal((await mirror.account(vaultId.toString())).balance, 0n);
  });

  await t.test("el kit solo no puede sacar nada al instante", async () => {
    await sendHbar({ client: device, from: pocket.id, to: vaultId, tinybars: 2n * HBAR });
    const c = createClient("local", null);
    const out = await submit(
      c,
      new TransferTransaction().addHbarTransfer(vaultId, Hbar.fromTinybars((-HBAR).toString())).addHbarTransfer(operatorId, Hbar.fromTinybars(HBAR.toString())).setTransactionId(TransactionId.generate(vaultId)),
      [rescueKey],
    );
    c.close();
    assert.equal(out.status, "INVALID_SIGNATURE");
  });

  device.close();
  op.close();
});

test("tokens de Hedera y comisiones del servicio (preparadas para activarlas)", async (t) => {
  const op = createClient("local", { accountId: operatorId, key: operatorKey });
  // Cuenta que cobraría las comisiones.
  const collectorKey = PrivateKey.generateED25519();
  const collector = (await submit(op, new AccountCreateTransaction().setKeyWithoutAlias(collectorKey.publicKey).setInitialBalance(new Hbar(1)))).receipt.accountId;
  const feeMirror = new Mirror("http://127.0.0.1:5551", fetch, { feeCollector: collector.toString() });
  const depositFee = { collector, tinybars: SERVICE_FEES.depositTinybars };
  const withdrawFee = { collector, tinybars: SERVICE_FEES.withdrawTinybars };
  assert.equal(SERVICE_FEES.depositTinybars, 2n * HBAR);
  assert.equal(SERVICE_FEES.withdrawTinybars, 2n * HBAR);

  // Un token de prueba (8 decimales) cuya tesorería es el operador.
  const created = await submit(op, new TokenCreateTransaction().setTokenName("Prueba").setTokenSymbol("PRB").setDecimals(8).setInitialSupply(1_000_000n * HBAR).setTreasuryAccountId(operatorId));
  assert.ok(created.ok, created.status);
  const tokenId = created.receipt.tokenId.toString();

  // Cartera (cuenta por alias: acepta tokens sin asociarlos antes).
  const pocketKey = PrivateKey.generateECDSA();
  const pocketEvm = `0x${pocketKey.publicKey.toEvmAddress()}`.toLowerCase();
  await sendHbar({ client: op, from: operatorId, to: AccountId.fromEvmAddress(0, 0, pocketEvm), tinybars: 80n * HBAR });
  const pocket = await waitFor("cartera", () => mirror.account(pocketEvm));
  await sendToken({ client: op, from: operatorId, to: pocket.id, tokenId, amount: 100n * HBAR, decimals: 8 });
  const device = createClient("local", { accountId: pocket.id, key: pocketKey });
  const rescueKey = await rescueKeyFromWords((await Mnemonic.generate()).toString());
  const { notaryId, vaultId } = await setupVaultV2({
    client: device,
    mirror,
    pocket: { evmAddress: pocketEvm, publicKey: pocketKey.publicKey },
    rescuePublicKey: rescueKey.publicKey,
    withdrawDelay: W,
    recoveryDelay: R,
  });
  const balance = async (id) => (await mirror.account(id.toString())).balance;
  const tokenBalance = async (id) => (await mirror.accountTokens(id.toString())).find((x) => x.tokenId === tokenId)?.balance ?? 0n;

  await t.test("las bóvedas nuevas aceptan cualquier token", async () => {
    assert.equal((await mirror.account(vaultId.toString())).maxAutoAssociations, -1);
  });

  await t.test("guardar con comisión: va en la misma transferencia (HBAR y tokens)", async () => {
    const before = await balance(collector);
    await sendHbar({ client: device, from: pocket.id, to: vaultId, tinybars: 10n * HBAR, fee: depositFee });
    await sendToken({ client: device, from: pocket.id, to: vaultId, tokenId, amount: 40n * HBAR, decimals: 8, fee: depositFee });
    assert.equal(await balance(vaultId), 10n * HBAR);
    assert.equal(await tokenBalance(vaultId), 40n * HBAR);
    assert.equal((await balance(collector)) - before, 4n * HBAR);
  });

  await t.test("sacar un token con comisión: se ve en la actividad y se cobra solo al ejecutarse", async () => {
    const before = await balance(collector);
    const { scheduleId } = await requestWithdrawalV2({ client: device, vaultId, notaryId, to: pocket.id, tokens: [{ tokenId, amount: 15n * HBAR, decimals: 8 }], fee: withdrawFee, withdrawDelay: W });
    const a = await loadVaultActivity({ mirror: feeMirror, notaryId: notaryId.toString() });
    const action = a.items[0].action;
    assert.equal(action.kind, "transfer");
    assert.deepEqual(action.tokens, [{ tokenId, amount: 15n * HBAR }]);
    assert.deepEqual(action.fee, { to: collector.toString(), tinybars: 2n * HBAR });
    const info = await mirror.tokenInfo(tokenId);
    const text = summarizeAction(action, { meta: () => info, lang: "es" });
    assert.equal(text.title, "Retirada de 15 PRB");
    assert.equal(text.fee, "Comisión del servicio: 2 HBAR");
    assert.equal(summarizeAction(action, { meta: () => info, lang: "en" }).title, "Withdrawal of 15 PRB");
    // Antes de la cuenta atrás no se ha cobrado nada.
    assert.equal(await balance(collector), before);
    await sleep((W + 1) * 1000);
    const done = await callNotary2({ client: device, notaryId, call: "approve", schedule: scheduleId });
    assert.ok(done.ok, done.reason);
    assert.equal(await tokenBalance(vaultId), 25n * HBAR);
    assert.equal((await balance(collector)) - before, 2n * HBAR);
    assert.equal(await balance(vaultId), 8n * HBAR);
  });

  await t.test("una retirada bloqueada no cobra comisión", async () => {
    const before = await balance(collector);
    const { scheduleId } = await requestWithdrawalV2({ client: device, vaultId, notaryId, to: pocket.id, tinybars: HBAR, fee: withdrawFee, withdrawDelay: W });
    const vetoed = await callNotary2({ client: device, notaryId, call: "veto", schedule: scheduleId });
    assert.ok(vetoed.ok, vetoed.reason);
    await sleep((W + 1) * 1000);
    assert.equal(await balance(collector), before);
    assert.equal(await balance(vaultId), 8n * HBAR);
  });

  await t.test("bóveda antigua sin tokens: se activan por el carril de retirada, sin comisión", async () => {
    const key = buildVaultKeyV2({ deviceKey: pocketKey.publicKey, rescueKey: rescueKey.publicKey, notaryId });
    const old = (await submit(device, new AccountCreateTransaction().setKeyWithoutAlias(key).setInitialBalance(new Hbar(1)))).receipt.accountId;
    assert.equal((await mirror.account(old.toString())).maxAutoAssociations, 0);
    await assert.rejects(sendToken({ client: device, from: pocket.id, to: old, tokenId, amount: HBAR, decimals: 8 }), /TOKEN_NOT_ASSOCIATED_TO_ACCOUNT/);
    const before = await balance(collector);
    const { scheduleId } = await requestEnableTokensV2({ client: device, vaultId: old, notaryId, withdrawDelay: W });
    const a = await loadVaultActivity({ mirror: feeMirror, notaryId: notaryId.toString() });
    const m = a.items.find((x) => x.scheduleId === scheduleId.toString());
    assert.deepEqual(m.action, { kind: "settings", account: old.toString(), autoAssociations: -1 });
    assert.equal(summarizeAction(m.action, { lang: "es" }).title, "Activar tokens en la bóveda");
    await sleep((W + 1) * 1000);
    assert.ok((await callNotary2({ client: device, notaryId, call: "approve", schedule: scheduleId })).ok);
    assert.equal((await mirror.account(old.toString())).maxAutoAssociations, -1);
    await sendToken({ client: device, from: pocket.id, to: old, tokenId, amount: HBAR, decimals: 8 });
    assert.equal(await tokenBalance(old), HBAR);
    assert.equal(await balance(collector), before);
  });

  await t.test("evacuar con las dos llaves se lleva también los tokens", async () => {
    const pocketTokens = await tokenBalance(pocket.id);
    const out = await evacuateVault({ client: device, mirror, vaultId, to: pocket.id, rescueKey });
    assert.deepEqual(out.tokens, [{ tokenId, amount: 25n * HBAR }]);
    assert.deepEqual(out.failedTokens, []);
    assert.equal(out.tinybars, 8n * HBAR);
    assert.equal(await tokenBalance(vaultId), 0n);
    assert.equal((await tokenBalance(pocket.id)) - pocketTokens, 25n * HBAR);
  });

  device.close();
  op.close();
});

test("móvil robado: el kit congela, el guardián entra en modo robo y bloquea al ladrón hasta que llega la recuperación", async (t) => {
  const W2 = 10;
  const R2 = 16;
  const op = createClient("local", { accountId: operatorId, key: operatorKey });
  const pocketKey = PrivateKey.generateECDSA();
  const pocketEvm = `0x${pocketKey.publicKey.toEvmAddress()}`.toLowerCase();
  await sendHbar({ client: op, from: operatorId, to: AccountId.fromEvmAddress(0, 0, pocketEvm), tinybars: 60n * HBAR });
  const pocket = await waitFor("cartera", () => mirror.account(pocketEvm));
  const thief = createClient("local", { accountId: pocket.id, key: pocketKey }); // el móvil robado
  const info = await (await fetch(`http://127.0.0.1:${GUARDIAN_PORT}/info`)).json();
  const rescueKey = await rescueKeyFromWords((await Mnemonic.generate()).toString());
  const { notaryId, vaultId, rescueAccountId } = await setupVaultV2({
    client: thief,
    mirror,
    pocket: { evmAddress: pocketEvm, publicKey: pocketKey.publicKey },
    rescuePublicKey: rescueKey.publicKey,
    guardianEvm: info.evmAddress,
    withdrawDelay: W2,
    recoveryDelay: R2,
    initialTinybars: 20n * HBAR,
  });
  const post = (path, body) => fetch(`http://127.0.0.1:${GUARDIAN_PORT}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const state = async () => (await fetch(`http://127.0.0.1:${GUARDIAN_PORT}/vaults/${vaultId}`)).json();
  const reg = { vaultId: vaultId.toString(), notaryId: notaryId.toString(), pocketId: pocket.id.toString(), pushToken: null };
  assert.equal((await post("/register", signRegistration(pocketKey, { ...reg, timestamp: nowSeconds() }))).status, 200);
  const kit = createClient("local", { accountId: rescueAccountId, key: rescueKey });
  const notice = (key, action) => signTheftNotice(key, { action, vaultId: vaultId.toString(), notaryId: notaryId.toString(), timestamp: nowSeconds(), lang: "es" });

  // El ladrón, con el móvil desbloqueado, pide sacarlo todo.
  const first = await requestWithdrawalV2({ client: thief, vaultId, notaryId, to: operatorId, tinybars: 19n * HBAR, withdrawDelay: W2 });

  await t.test("con el kit, en otro móvil: congelar anula la retirada del ladrón al momento", async () => {
    const fz = await callNotary2({ client: kit, notaryId, call: "freeze", lane: Lane.Withdraw });
    assert.ok(fz.ok, fz.reason);
    const a = await loadVaultActivity({ mirror, notaryId: notaryId.toString() });
    assert.equal(a.items.find((m) => m.scheduleId === first.scheduleId.toString()).status, "superseded");
    assert.ok(a.locks.withdraw > nowSeconds());
  });

  await t.test("solo la llave del kit activa el modo robo (ni el móvil ni otra llave)", async () => {
    assert.equal((await post("/theft", notice(pocketKey, "on"))).status, 401);
    assert.equal((await post("/theft", notice(PrivateKey.generateED25519(), "on"))).status, 401);
    const stale = signTheftNotice(rescueKey, { action: "on", vaultId: vaultId.toString(), notaryId: notaryId.toString(), timestamp: nowSeconds() - 3600 });
    assert.equal((await post("/theft", stale)).status, 400);
    const ok = await post("/theft", notice(rescueKey, "on"));
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.equal((await ok.json()).theft, true);
    assert.match(guardianLog, /modo robo ACTIVADO/);
  });

  // Recuperación hacia una cartera nueva (como hace la app en el móvil nuevo).
  const newKey = PrivateKey.generateECDSA();
  const newEvm = `0x${newKey.publicKey.toEvmAddress()}`.toLowerCase();
  await sendHbar({ client: kit, from: rescueAccountId, to: AccountId.fromEvmAddress(0, 0, newEvm), tinybars: HBAR });
  const newPocket = await waitFor("cartera nueva", () => mirror.account(newEvm));
  const rec = await requestRecoveryV2({ client: kit, vaultId, notaryId, to: newPocket.id, tinybars: 20n * HBAR, recoveryDelay: R2 });

  await t.test("volver a registrarse desde el móvil robado no quita el modo robo", async () => {
    assert.equal((await post("/register", signRegistration(pocketKey, { ...reg, timestamp: nowSeconds() }))).status, 200);
    assert.ok((await state()).theft);
  });

  await t.test("acabada la congelación, el guardián bloquea cada retirada nueva del ladrón", async () => {
    await waitFor("fin de la congelación", async () => nowSeconds() > (await loadVaultActivity({ mirror, notaryId: notaryId.toString() })).locks.withdraw + 1, 30_000);
    const second = await requestWithdrawalV2({ client: thief, vaultId, notaryId, to: operatorId, tinybars: 19n * HBAR, withdrawDelay: W2 });
    await waitFor("bloqueo del guardián", async () => (await loadVaultActivity({ mirror, notaryId: notaryId.toString() })).items.find((m) => m.scheduleId === second.scheduleId.toString())?.status === "vetoed", W2 * 1000);
    assert.match(guardianLog, /modo robo: retirada .* bloqueada/);
    await sleep((W2 + 4) * 1000);
    assert.equal((await mirror.schedule(second.scheduleId.toString())).executed, false);
  });

  await t.test("la recuperación llega a la cartera nueva y el modo robo se apaga solo", async () => {
    await waitFor("recuperación completada", async () => (await mirror.schedule(rec.scheduleId.toString()))?.executed, 40_000);
    assert.equal((await mirror.account(newEvm)).balance, 21n * HBAR);
    assert.equal((await mirror.account(vaultId.toString())).balance, 0n);
    assert.equal((await mirror.schedule(first.scheduleId.toString())).executed, false);
    await waitFor("fin del modo robo", async () => (await state()).theft === null, 15_000);
  });

  await t.test("el kit también puede quitar el modo robo a mano", async () => {
    assert.equal((await (await post("/theft", notice(rescueKey, "on"))).json()).theft, true);
    assert.equal((await (await post("/theft", notice(pocketKey, "off"))).status), 401);
    assert.equal((await (await post("/theft", notice(rescueKey, "off"))).json()).theft, false);
  });

  kit.close();
  thief.close();
  op.close();
});

test("NFT en la bóveda y plazos configurables", async (t) => {
  const op = createClient("local", { accountId: operatorId, key: operatorKey });
  // Colección de NFT cuya tesorería es el operador; tres piezas con metadata en IPFS.
  const created = await submit(
    op,
    new TokenCreateTransaction()
      .setTokenName("Gatos")
      .setTokenSymbol("GATO")
      .setTokenType(TokenType.NonFungibleUnique)
      .setDecimals(0)
      .setInitialSupply(0)
      .setSupplyKey(operatorKey.publicKey)
      .setTreasuryAccountId(operatorId),
  );
  assert.ok(created.ok, created.status);
  const nftToken = created.receipt.tokenId.toString();
  const cid = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
  const minted = await submit(op, new TokenMintTransaction().setTokenId(nftToken).setMetadata([1, 2, 3].map((i) => Buffer.from(`ipfs://${cid}/${i}.json`))));
  assert.ok(minted.ok, minted.status);
  assert.deepEqual(minted.receipt.serials.map((x) => Number(x)), [1, 2, 3]);

  const pocketKey = PrivateKey.generateECDSA();
  const pocketEvm = `0x${pocketKey.publicKey.toEvmAddress()}`.toLowerCase();
  await sendHbar({ client: op, from: operatorId, to: AccountId.fromEvmAddress(0, 0, pocketEvm), tinybars: 120n * HBAR });
  const pocket = await waitFor("cartera", () => mirror.account(pocketEvm));
  await sendNfts({ client: op, from: operatorId, to: pocket.id, nfts: [1, 2, 3].map((serial) => ({ tokenId: nftToken, serial })) });
  const device = createClient("local", { accountId: pocket.id, key: pocketKey });
  const rescueKey = await rescueKeyFromWords((await Mnemonic.generate()).toString());
  const { notaryId, vaultId, rescueAccountId } = await setupVaultV2({
    client: device,
    mirror,
    pocket: { evmAddress: pocketEvm, publicKey: pocketKey.publicKey },
    rescuePublicKey: rescueKey.publicKey,
    withdrawDelay: W,
    recoveryDelay: R,
    initialTinybars: 5n * HBAR,
  });
  const owned = async (id) => (await mirror.accountNfts(id.toString())).filter((x) => x.tokenId === nftToken).map((x) => x.serial).sort();

  await t.test("plazos: 24 h por defecto, hasta 7 días; recuperación 7 días, hasta 14", () => {
    assert.equal(DELAYS2.standard.withdraw, 24 * 3600);
    assert.equal(DELAYS2.standard.recovery, 7 * 24 * 3600);
    assert.deepEqual(DELAY_CHOICES.withdraw.map((s) => s / 3600), [24, 48, 72, 168]);
    assert.deepEqual(DELAY_CHOICES.recovery.map((s) => s / 86400), [7, 14]);
    checkDelays(7 * 86400, 7 * 86400);
    checkDelays(86400, 14 * 86400);
    assert.throws(() => checkDelays(10 * 86400, 14 * 86400), /no se puede elegir/);
    assert.throws(() => checkDelays(86400, 21 * 86400), /no se puede elegir/);
    assert.throws(() => checkDelays(W, R), /no se puede elegir/);
    checkDelays(W, R, { allowTest: true });
  });

  await t.test("guardar NFT en la bóveda y leer su metadata", async () => {
    await sendNfts({ client: device, from: pocket.id, to: vaultId, nfts: [{ tokenId: nftToken, serial: 1 }, { tokenId: nftToken, serial: 2 }] });
    assert.deepEqual(await owned(vaultId), [1, 2]);
    assert.deepEqual(await owned(pocket.id), [3]);
    const [first] = await mirror.accountNfts(vaultId.toString());
    assert.equal(nftMetadataUri(first.metadata), `ipfs://${cid}/1.json`);
    assert.equal(gatewayUrl(nftMetadataUri(first.metadata)), `https://ipfs.io/ipfs/${cid}/1.json`);
    assert.equal(gatewayUrl("javascript:alert(1)"), null);
    assert.equal(gatewayUrl("http://inseguro.example/x.png"), null);
    const info = await mirror.tokenInfo(nftToken);
    assert.equal(info.fungible, false);
  });

  await t.test("con una sola llave nadie saca un NFT de la bóveda", async () => {
    const out = await submit(device, new TransferTransaction().addNftTransfer(new NftId(TokenId.fromString(nftToken), 1), vaultId, pocket.id));
    assert.equal(out.status, "INVALID_SIGNATURE");
    assert.deepEqual(await owned(vaultId), [1, 2]);
  });

  await t.test("sacar un NFT tiene cuenta atrás y se ve qué NFT es", async () => {
    const { scheduleId } = await requestWithdrawalV2({ client: device, vaultId, notaryId, to: pocket.id, nfts: [{ tokenId: nftToken, serial: 1 }], withdrawDelay: W });
    const a = await loadVaultActivity({ mirror, notaryId: notaryId.toString() });
    const action = a.items.find((m) => m.scheduleId === scheduleId.toString()).action;
    assert.equal(action.kind, "transfer");
    assert.deepEqual(action.nfts, [{ tokenId: nftToken, serial: 1 }]);
    const info = await mirror.tokenInfo(nftToken);
    assert.equal(summarizeAction(action, { meta: () => info, lang: "es" }).title, "Retirada de NFT Gatos #1");
    assert.equal(summarizeAction(action, { meta: () => info, lang: "en" }).title, "Withdrawal of NFT Gatos #1");
    // Antes de tiempo, el notario no lo deja salir.
    const early = await callNotary2({ client: device, notaryId, call: "approve", schedule: scheduleId });
    assert.equal(early.ok, false);
    await sleep((W + 1) * 1000);
    const done = await callNotary2({ client: device, notaryId, call: "approve", schedule: scheduleId });
    assert.ok(done.ok, done.reason);
    assert.deepEqual(await owned(vaultId), [2]);
    assert.deepEqual(await owned(pocket.id), [1, 3]);
  });

  await t.test("una retirada de NFT bloqueada no sale", async () => {
    const { scheduleId } = await requestWithdrawalV2({ client: device, vaultId, notaryId, to: pocket.id, nfts: [{ tokenId: nftToken, serial: 2 }], withdrawDelay: W });
    const kit = createClient("local", { accountId: rescueAccountId, key: rescueKey });
    const vetoed = await callNotary2({ client: kit, notaryId, call: "veto", schedule: scheduleId });
    kit.close();
    assert.ok(vetoed.ok, vetoed.reason);
    await sleep((W + 1) * 1000);
    assert.equal((await callNotary2({ client: device, notaryId, call: "approve", schedule: scheduleId })).ok, false);
    assert.deepEqual(await owned(vaultId), [2]);
  });

  let newNotary;
  await t.test("cambiar los plazos pide las 24 palabras y anula lo pendiente del notario anterior", async () => {
    const pending = await requestWithdrawalV2({ client: device, vaultId, notaryId, to: pocket.id, tinybars: HBAR, withdrawDelay: W });
    const wrong = PrivateKey.generateED25519();
    await assert.rejects(changeVaultDelaysV2({ client: device, mirror, vaultId, rescueKey: wrong, withdrawDelay: W + 1, recoveryDelay: R + 1, allowTest: true }), /no son las del kit/);
    await assert.rejects(changeVaultDelaysV2({ client: device, mirror, vaultId, rescueKey, withdrawDelay: W, recoveryDelay: R, allowTest: true }), /ya tiene esos plazos/);
    await assert.rejects(changeVaultDelaysV2({ client: device, mirror, vaultId, rescueKey, withdrawDelay: 86400, recoveryDelay: 3600, allowTest: true }), /no se puede elegir|más corta/);
    const steps = [];
    const out = await changeVaultDelaysV2({ client: device, mirror, vaultId, rescueKey, withdrawDelay: W + 1, recoveryDelay: R + 2, allowTest: true, onStep: (s) => steps.push(s) });
    newNotary = out.notaryId;
    assert.deepEqual(steps, ["check", "notary", "key"]);
    assert.equal(out.oldNotaryId.toString(), notaryId.toString());
    const v = await inspectVaultV2({ mirror, vaultId: vaultId.toString() });
    assert.equal(v.notaryId.toString(), newNotary.toString());
    const cfg = await notary2Config({ mirror, notaryId: newNotary });
    assert.equal(cfg.withdrawDelay, W + 1);
    assert.equal(cfg.recoveryDelay, R + 2);
    assert.equal(cfg.device, pocketEvm);
    assert.equal(cfg.rescue, longZeroAddress(rescueAccountId));
    // La retirada pedida al notario anterior ya no puede salir aunque pase su cuenta atrás.
    await sleep((W + 1) * 1000);
    const before = (await mirror.account(vaultId.toString())).balance;
    await callNotary2({ client: device, notaryId, call: "approve", schedule: pending.scheduleId });
    assert.equal((await mirror.account(vaultId.toString())).balance, before);
  });

  await t.test("con el notario nuevo todo sigue funcionando (NFT incluidos)", async () => {
    const { scheduleId } = await requestWithdrawalV2({ client: device, vaultId, notaryId: newNotary, to: pocket.id, nfts: [{ tokenId: nftToken, serial: 2 }], withdrawDelay: W + 1 });
    await sleep((W + 2) * 1000);
    const done = await callNotary2({ client: device, notaryId: newNotary, call: "approve", schedule: scheduleId });
    assert.ok(done.ok, done.reason);
    assert.deepEqual(await owned(vaultId), []);
  });

  await t.test("evacuar con las dos llaves se lleva también los NFT", async () => {
    await sendNfts({ client: device, from: pocket.id, to: vaultId, nfts: [{ tokenId: nftToken, serial: 3 }] });
    const out = await evacuateVault({ client: device, mirror, vaultId, to: pocket.id, rescueKey });
    assert.deepEqual(out.nfts, [{ tokenId: nftToken, serial: 3 }]);
    assert.deepEqual(out.failedNfts, []);
    assert.deepEqual(out.tokens, []);
    assert.deepEqual(await owned(vaultId), []);
    assert.deepEqual(await owned(pocket.id), [1, 2, 3]);
  });

  device.close();
  op.close();
});

test("dApp por WalletConnect: la Cartera firma y ejecuta lo que el usuario ha visto", async () => {
  const op = createClient("local", { accountId: operatorId, key: operatorKey });
  const pocketKey = PrivateKey.generateECDSA();
  const pocketEvm = `0x${pocketKey.publicKey.toEvmAddress()}`.toLowerCase();
  await sendHbar({ client: op, from: operatorId, to: AccountId.fromEvmAddress(0, 0, pocketEvm), tinybars: 20n * HBAR });
  const pocket = await waitFor("cartera", () => mirror.account(pocketEvm));
  const device = createClient("local", { accountId: pocket.id, key: pocketKey });
  const me = pocket.id.toString();
  // Lo que mandaría una dApp: una transferencia sin congelar (HIP-745).
  const tx = new TransferTransaction().addHbarTransfer(pocket.id, new Hbar(-3)).addHbarTransfer(operatorId, new Hbar(3));
  const params = { signerAccountId: `hedera:testnet:${me}`, transactionList: Buffer.from(tx.toBytes()).toString("base64") };
  let req = parseDappRequest({ method: "hedera_signAndExecuteTransaction", params, chainId: "hedera:testnet", accountId: me });
  req = freezeDappRequest(req, device);
  const d = describeDappTransaction(req.bodies[0], { account: me, lang: "es" });
  assert.equal(d.payer, me, "tras congelar, paga la Cartera");
  assert.equal(d.outgoingTinybars, 3n * HBAR);
  assert.deepEqual(d.warnings, []);
  const before = (await mirror.account(me)).balance;
  const result = await executeDappRequest(req, { client: device, key: pocketKey });
  assert.ok(result.transactionId?.startsWith(me), JSON.stringify(result));
  await waitFor("saldo", async () => (await mirror.account(me)).balance <= before - 3n * HBAR);
  // hedera_getNodeAddresses devuelve los nodos del cliente.
  const nodesOut = await executeDappRequest({ method: "hedera_getNodeAddresses" }, { client: device, key: pocketKey });
  assert.ok(nodesOut.nodes.length >= 1);
  device.close();
  op.close();
});

test("rendimiento: staking nativo en la bóveda, y el guardián bloquea lo que la app nunca pide", async (t) => {
  const op = createClient("local", { accountId: operatorId, key: operatorKey });
  const pocketKey = PrivateKey.generateECDSA();
  const pocketEvm = `0x${pocketKey.publicKey.toEvmAddress()}`.toLowerCase();
  await sendHbar({ client: op, from: operatorId, to: AccountId.fromEvmAddress(0, 0, pocketEvm), tinybars: 80n * HBAR });
  const pocket = await waitFor("cartera", () => mirror.account(pocketEvm));
  const device = createClient("local", { accountId: pocket.id, key: pocketKey });
  const info = await (await fetch(`http://127.0.0.1:${GUARDIAN_PORT}/info`)).json();
  const rescueKey = await rescueKeyFromWords((await Mnemonic.generate()).toString());
  const nodes = await mirror.nodes();
  const node = pickStakingNode(nodes);
  const { notaryId, vaultId } = await setupVaultV2({
    client: device,
    mirror,
    pocket: { evmAddress: pocketEvm, publicKey: pocketKey.publicKey },
    rescuePublicKey: rescueKey.publicKey,
    guardianEvm: info.evmAddress,
    withdrawDelay: W,
    recoveryDelay: R,
    initialTinybars: 40n * HBAR,
    stakedNodeId: node,
  });
  const reg = { vaultId: vaultId.toString(), notaryId: notaryId.toString(), pocketId: pocket.id.toString(), pushToken: null, timestamp: nowSeconds() };
  const ok = await fetch(`http://127.0.0.1:${GUARDIAN_PORT}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signRegistration(pocketKey, reg)) });
  assert.equal(ok.status, 200, await ok.clone().text());
  const vault = () => mirror.account(vaultId.toString());
  const activity = async (id) => (await loadVaultActivity({ mirror, notaryId: notaryId.toString() })).items.find((m) => m.scheduleId === id.toString());
  const executed = (id) => waitFor(`ejecución de ${id}`, async () => (await mirror.schedule(id.toString()))?.executed, 30_000);

  await t.test("la bóveda nace haciendo staking en el nodo que más paga sin estar lleno", async () => {
    assert.equal(node, 5, "el 4 paga más pero está lleno; entre 3 y 5, el menos lleno");
    const v = await vault();
    assert.equal(v.stakedNodeId, 5);
    assert.ok(v.pendingReward > 0n, "recompensa pendiente");
    assert.equal(await mirror.stakingRewardsTotal(vaultId.toString()), 2000n);
  });

  await t.test("cambiar de nodo va por la cuenta atrás y lo completa el guardián", async () => {
    const { scheduleId } = await requestStakingV2({ client: device, vaultId, notaryId, nodeId: 3, withdrawDelay: W });
    const m = await activity(scheduleId);
    assert.deepEqual(m.action, { kind: "staking", account: vaultId.toString(), nodeId: 3, declineReward: null });
    assert.equal(summarizeAction(m.action, { lang: "es" }).unusual, false);
    await executed(scheduleId);
    assert.equal((await vault()).stakedNodeId, 3);
    assert.equal((await vault()).balance, 40n * HBAR, "los HBAR no se mueven");
  });

  await t.test("dejar de hacer staking, igual", async () => {
    const { scheduleId } = await requestStakingV2({ client: device, vaultId, notaryId, nodeId: null, withdrawDelay: W });
    assert.equal((await activity(scheduleId)).action.nodeId, null);
    await executed(scheduleId);
    assert.equal((await vault()).stakedNodeId, null);
  });

  // Con la llave del móvil (robada o copiada), alguien pide por el carril de retirada cosas que la
  // app nunca pide. El guardián las bloquea en cuanto las ve, antes de que acabe la cuenta atrás.
  const sneak = async (inner) => {
    const s = await scheduleForVault({ client: device, inner, lifetimeSeconds: W });
    assert.ok(s.ok && s.scheduleId, s.status);
    const r = await callNotary2({ client: device, notaryId, call: "request", schedule: s.scheduleId });
    assert.ok(r.ok, r.reason);
    return s.scheduleId;
  };
  const blocked = async (id) => {
    await waitFor(`bloqueo de ${id}`, async () => (await activity(id))?.status === "vetoed", 20_000);
    await sleep((W + 4) * 1000);
    assert.equal((await mirror.schedule(id.toString())).executed, false);
  };

  await t.test("cambiar las llaves de la bóveda: bloqueado al momento", async () => {
    const id = await sneak(new AccountUpdateTransaction().setAccountId(vaultId).setKey(PrivateKey.generateED25519().publicKey));
    await blocked(id);
    assert.ok(isVaultKeyV2For((await vault()).key, notaryId), "la llave sigue siendo la de la bóveda");
    assert.match(guardianLog, /operación no permitida .* bloqueada/);
  });

  await t.test("mandar las recompensas a otra cuenta: bloqueado", async () => {
    const id = await sneak(new AccountUpdateTransaction().setAccountId(vaultId).setStakedAccountId(operatorId));
    await blocked(id);
    assert.equal((await vault()).stakedAccountId, null);
  });

  await t.test("staking mezclado con otro ajuste (firma para recibir): bloqueado", async () => {
    const id = await sneak(new AccountUpdateTransaction().setAccountId(vaultId).setStakedNodeId(3).setReceiverSignatureRequired(true));
    await blocked(id);
    assert.equal((await vault()).stakedNodeId, null);
  });

  device.close();
  op.close();
});
