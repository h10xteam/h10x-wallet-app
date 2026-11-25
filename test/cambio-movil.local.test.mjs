// Cambio de móvil SIN red (nodo + mirror simulados y guardián real): la Cartera y la bóveda pasan a la llave de un móvil
// nuevo con el kit + la confirmación del móvil viejo, sin copiar llaves ni tocar el notario. Y los ataques: solo el kit,
// solo el móvil viejo, peticiones trucadas, repetir firmas y usar la llave vieja después.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AccountCreateTransaction,
  AccountId,
  AccountUpdateTransaction,
  ContractId,
  Hbar,
  KeyList,
  Mnemonic,
  PrivateKey,
  ScheduleCreateTransaction,
  ScheduleId,
  ScheduleSignTransaction,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import {
  HBAR,
  MOVE_MEMO_PREFIX,
  Mirror,
  buildVaultKeyV2,
  checkMoveSchedule,
  confirmMove,
  createClient,
  evacuateVault,
  findMoveRequests,
  isVaultKeyV2For,
  keyStillControls,
  missingParts,
  moveFingerprint,
  moveStatus,
  nowSeconds,
  readWalletForMove,
  readWalletOnChain,
  requestMove,
  requestWithdrawalV2,
  rescueKeyFromWords,
  sendHbar,
  setupVaultV2,
  signRegistration,
  submit,
} from "@boveda/core";
import * as HieroProto from "@hiero-ledger/proto";
import { startFakeNetwork } from "./sim/fake-network.mjs";

const GUARDIAN_PORT = 18793;
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
    await sleep(400);
  }
}

before(async () => {
  net = await startFakeNetwork({ operatorNum: 1001, operatorKey: operatorKey.publicKey });
  const op = createClient("local", { accountId: operatorId, key: operatorKey });
  const created = await submit(op, new AccountCreateTransaction().setKeyWithoutAlias(guardianKey.publicKey).setInitialBalance(new Hbar(50)));
  op.close();
  dataDir = mkdtempSync(join(tmpdir(), "guardian-mv-"));
  guardian = spawn(process.execPath, ["guardian/src/index.js"], {
    env: {
      ...process.env,
      HEDERA_NETWORK: "local",
      MIRROR_URL: "http://127.0.0.1:5551",
      OPERATOR_KEY: guardianKey.toStringDer(),
      OPERATOR_ID: created.receipt.accountId.toString(),
      PORT: String(GUARDIAN_PORT),
      DATA_DIR: dataDir,
      POLL_SECONDS: "2",
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

const register = (key, fields) =>
  fetch(`http://127.0.0.1:${GUARDIAN_PORT}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signRegistration(key, { ...fields, timestamp: nowSeconds() })) });

test("cambio de móvil: kit + confirmación del móvil viejo, sin copiar llaves y sin tocar el notario", async (t) => {
  const op = createClient("local", { accountId: operatorId, key: operatorKey });
  // ---- la wallet de siempre, en el móvil viejo -------------------------------------------------------
  const k1 = PrivateKey.generateECDSA();
  const carteraEvm = `0x${k1.publicKey.toEvmAddress()}`.toLowerCase();
  await sendHbar({ client: op, from: operatorId, to: AccountId.fromEvmAddress(0, 0, carteraEvm), tinybars: 80n * HBAR });
  const cartera = await waitFor("cartera", () => mirror.account(carteraEvm));
  const oldPhone = createClient("local", { accountId: cartera.id, key: k1 });
  const info = await (await fetch(`http://127.0.0.1:${GUARDIAN_PORT}/info`)).json();
  const words = (await Mnemonic.generate()).toString();
  const rescueKey = await rescueKeyFromWords(words);
  const { notaryId, vaultId, rescueAccountId } = await setupVaultV2({
    client: oldPhone,
    mirror,
    pocket: { evmAddress: carteraEvm, publicKey: k1.publicKey },
    rescuePublicKey: rescueKey.publicKey,
    guardianEvm: info.evmAddress,
    withdrawDelay: W,
    recoveryDelay: R,
    initialTinybars: 20n * HBAR,
  });
  const fields = { vaultId: vaultId.toString(), notaryId: notaryId.toString(), pocketId: cartera.id.toString(), pushToken: null };
  assert.equal((await register(k1, fields)).status, 200);
  const kitClient = createClient("local", { accountId: rescueAccountId, key: rescueKey });

  // ---- móvil nuevo ---------------------------------------------------------------------------------
  const k2 = PrivateKey.generateECDSA();
  let w;
  await t.test("el móvil nuevo encuentra la wallet con el ID de la bóveda y las 24 palabras (y solo con las suyas)", async () => {
    const wrong = await rescueKeyFromWords((await Mnemonic.generate()).toString());
    await assert.rejects(readWalletForMove({ mirror, vaultId: vaultId.toString(), rescuePublicKey: wrong.publicKey }), /no son el kit/);
    await assert.rejects(readWalletForMove({ mirror, vaultId: cartera.id.toString(), rescuePublicKey: rescueKey.publicKey }), /no es una bóveda v2/);
    w = await readWalletForMove({ mirror, vaultId: vaultId.toString(), rescuePublicKey: rescueKey.publicKey });
    assert.equal(w.carteraId, cartera.id.toString());
    assert.equal(w.carteraEvm, carteraEvm);
    assert.equal(w.kitAccountId, rescueAccountId.toString());
    assert.equal(w.notaryId, notaryId.toString());
    assert.equal(w.withdrawDelay, W);
    assert.equal(w.kitBalance, 3n * HBAR);
  });

  let ids;
  await t.test("pide el cambio con el kit: dos programadas que solas no se ejecutan", async () => {
    ids = await requestMove({ client: kitClient, w, newKey: k2, name: "iPhone de prueba" });
    for (const id of [ids.vault, ids.cartera]) assert.equal((await mirror.schedule(id)).executed, false, `${id} no debe ejecutarse sin el móvil viejo`);
    assert.ok((await keyStillControls({ mirror, vaultId: w.vaultId, carteraId: w.carteraId, key: k1.publicKey })).vault);
  });

  // ---- ataques mientras está pendiente ----------------------------------------------------------------
  const k3 = PrivateKey.generateECDSA(); // el ladrón
  const kitSchedule = async (inner, { payer = rescueAccountId, signers = [k3], memo = `${MOVE_MEMO_PREFIX} · cartera · x` } = {}) => {
    const out = await submit(kitClient, new ScheduleCreateTransaction().setScheduledTransaction(inner).setPayerAccountId(payer).setScheduleMemo(memo), signers);
    assert.ok(out.receipt?.scheduleId, out.status);
    return out.receipt.scheduleId.toString();
  };
  const nId = ContractId.fromString(w.notaryId);
  let thiefMove;
  await t.test("con solo el kit, el ladrón puede pedirlo pero no terminarlo; y las peticiones trucadas se descartan", async () => {
    thiefMove = await requestMove({ client: kitClient, w, newKey: k3, name: "ladrón" });
    const tricks = {
      sinNotario: await kitSchedule(new AccountUpdateTransaction().setAccountId(vaultId).setKey(new KeyList([k3.publicKey, rescueKey.publicKey], 1)), { signers: [k3] }),
      otroKit: await kitSchedule(new AccountUpdateTransaction().setAccountId(vaultId).setKey(buildVaultKeyV2({ deviceKey: k3.publicKey, rescueKey: PrivateKey.generateED25519().publicKey, notaryId: nId }))),
      carteraMultifirma: await kitSchedule(new AccountUpdateTransaction().setAccountId(cartera.id).setKey(new KeyList([k3.publicKey, k1.publicKey], 1))),
      carteraConMemo: await kitSchedule(new AccountUpdateTransaction().setAccountId(cartera.id).setKey(k3.publicKey).setAccountMemo("hola")),
      carteraConStaking: await kitSchedule(new AccountUpdateTransaction().setAccountId(cartera.id).setStakedNodeId(3)),
      pagaLaCartera: await kitSchedule(new AccountUpdateTransaction().setAccountId(cartera.id).setKey(k3.publicKey), { payer: cartera.id }),
      carteraEd25519: await kitSchedule(new AccountUpdateTransaction().setAccountId(cartera.id).setKey(PrivateKey.generateED25519().publicKey), { signers: [] }),
    };
    const ow = await readWalletOnChain({ mirror, vaultId: vaultId.toString() });
    const found = await findMoveRequests({ mirror, w: ow });
    // Dos peticiones válidas (la del dueño y la del ladrón): la app avisa de que alguien más tiene el kit.
    assert.equal(found.requests.length, 2);
    const mine = found.requests.find((r) => r.newKey.toStringRaw() === k2.publicKey.toStringRaw());
    assert.ok(mine && mine.vault === ids.vault && mine.cartera === ids.cartera);
    assert.equal(mine.name, "iPhone de prueba");
    assert.deepEqual(moveFingerprint(mine.newKey), moveFingerprint(k2.publicKey));
    const bad = new Map(found.suspicious.map((s) => [s.id, s.reason]));
    assert.match(bad.get(tricks.sinNotario), /forma de una bóveda v2/);
    assert.match(bad.get(tricks.otroKit), /cambia el kit/);
    assert.match(bad.get(tricks.carteraMultifirma), /una sola llave ECDSA/);
    assert.match(bad.get(tricks.carteraConMemo), /algo más que la llave/);
    assert.match(bad.get(tricks.carteraConStaking), /algo más que la llave/);
    assert.match(bad.get(tricks.pagaLaCartera), /no la paga la cuenta del kit/);
    assert.match(bad.get(tricks.carteraEd25519), /una sola llave ECDSA/);
    for (const id of [...Object.values(tricks), thiefMove.vault, thiefMove.cartera]) assert.equal((await mirror.schedule(id)).executed, false);
  });

  await t.test("con solo el móvil viejo no se cambia la llave de la bóveda", async () => {
    const out = await submit(oldPhone, new AccountUpdateTransaction().setAccountId(vaultId).setKey(buildVaultKeyV2({ deviceKey: k3.publicKey, rescueKey: rescueKey.publicKey, notaryId: nId })), [k3]);
    assert.equal(out.status, "INVALID_SIGNATURE");
  });

  // ---- el dueño confirma en el móvil viejo -------------------------------------------------------------
  await t.test("el móvil viejo confirma: las dos se ejecutan al momento", async () => {
    const ow = await readWalletOnChain({ mirror, vaultId: vaultId.toString() });
    const { requests } = await findMoveRequests({ mirror, w: ow });
    const mine = requests.find((r) => r.newKey.toStringRaw() === k2.publicKey.toStringRaw());
    await confirmMove({ client: oldPhone, request: mine });
    const st = await moveStatus({ mirror, w, newKey: k2.publicKey });
    assert.deepEqual(st, { vault: true, cartera: true, done: true });
    const vault = await mirror.account(vaultId.toString());
    assert.ok(vault.key instanceof KeyList && isVaultKeyV2For(vault.key, nId));
    const after = await mirror.account(cartera.id.toString());
    assert.equal(after.evmAddress, carteraEvm, "la dirección de la Cartera (la que conoce el notario) no cambia");
    assert.deepEqual(await keyStillControls({ mirror, vaultId: w.vaultId, carteraId: w.carteraId, key: k1.publicKey }), { vault: false, cartera: false });
  });

  const newPhone = createClient("local", { accountId: cartera.id, key: k2 });
  await t.test("la llave vieja ya no sirve para nada", async () => {
    const send = await submit(oldPhone, new TransferTransaction().addHbarTransfer(cartera.id, new Hbar(-1)).addHbarTransfer(operatorId, new Hbar(1)));
    assert.equal(send.status, "INVALID_SIGNATURE");
    const both = await submit(oldPhone, new TransferTransaction().addHbarTransfer(vaultId, new Hbar(-1)).addHbarTransfer(operatorId, new Hbar(1)), [rescueKey]);
    assert.equal(both.status, "INVALID_SIGNATURE", "ni con el kit: la ruta «móvil + kit» ya es la del móvil nuevo");
    await assert.rejects(requestWithdrawalV2({ client: oldPhone, vaultId, notaryId: nId, to: operatorId, tinybars: HBAR, withdrawDelay: W }));
    const resign = await submit(oldPhone, new ScheduleSignTransaction().setScheduleId(ScheduleId.fromString(thiefMove.cartera)));
    assert.equal(resign.status, "INVALID_SIGNATURE", "el móvil viejo ya no puede firmar (ni pagar) nada");
    assert.equal((await register(k1, fields)).status, 401, "ni registrarse en el guardián");
  });

  await t.test("repetir las firmas no hace nada", async () => {
    const again = await submit(newPhone, new ScheduleSignTransaction().setScheduleId(ScheduleId.fromString(ids.vault)));
    assert.equal(again.status, "SCHEDULE_ALREADY_EXECUTED");
  });

  await t.test("el móvil nuevo: guardián, retirada por el notario (la dirección sigue valiendo) y avisos", async () => {
    const reg = await register(k2, fields);
    assert.equal(reg.status, 200, await reg.clone().text());
    const before = (await mirror.account(vaultId.toString())).balance;
    const { scheduleId } = await requestWithdrawalV2({ client: newPhone, vaultId, notaryId: nId, to: operatorId, tinybars: 2n * HBAR, withdrawDelay: W });
    await waitFor("retirada completada por el guardián", async () => (await mirror.schedule(scheduleId.toString()))?.executed, 30_000);
    assert.equal((await mirror.account(vaultId.toString())).balance, before - 2n * HBAR);
  });

  await t.test("en el móvil nuevo aparece la petición del ladrón (el kit está comprometido) y nada más", async () => {
    const nw = await readWalletOnChain({ mirror, vaultId: vaultId.toString() });
    const { requests } = await findMoveRequests({ mirror, w: nw });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].newKey.toStringRaw(), k3.publicKey.toStringRaw());
  });

  await t.test("móvil nuevo + kit: evacuar sigue funcionando", async () => {
    const out = await evacuateVault({ client: newPhone, mirror, vaultId, to: cartera.id, rescueKey });
    assert.ok(out);
    assert.equal((await mirror.account(vaultId.toString())).balance, 0n);
  });

  await t.test("validación: sin las firmas del kit y de la llave nueva no se ofrece", () => {
    const nw = { ...w, carteraKey: k2.publicKey, vaultDeviceKey: k2.publicKey };
    const k4 = PrivateKey.generateECDSA().publicKey;
    const ok = checkMoveSchedule(
      { id: "0.0.1", executed: false, deleted: false, expiresAt: nowSeconds() + 600, payer: w.kitAccountId, creator: w.kitAccountId, memo: "", signers: [], body: scheduledBase64(cartera.id, k4) },
      nw,
      nowSeconds(),
    );
    assert.deepEqual(ok, { ok: false, reason: "le faltan las firmas del kit o de la llave nueva" });
    const expired = checkMoveSchedule(
      { id: "0.0.1", executed: false, deleted: false, expiresAt: nowSeconds() - 1, payer: w.kitAccountId, creator: w.kitAccountId, memo: "", signers: [], body: scheduledBase64(cartera.id, k4) },
      nw,
      nowSeconds(),
    );
    assert.equal(expired, null, "una caducada no se ofrece");
  });

  kitClient.close();
  newPhone.close();
  oldPhone.close();
  op.close();
});

test("cambio a medias (se firmó la bóveda y no la Cartera): el móvil nuevo pide solo lo que falta", async () => {
  const op = createClient("local", { accountId: operatorId, key: operatorKey });
  const k1 = PrivateKey.generateECDSA();
  const carteraEvm = `0x${k1.publicKey.toEvmAddress()}`.toLowerCase();
  await sendHbar({ client: op, from: operatorId, to: AccountId.fromEvmAddress(0, 0, carteraEvm), tinybars: 60n * HBAR });
  const cartera = await waitFor("cartera", () => mirror.account(carteraEvm));
  const oldPhone = createClient("local", { accountId: cartera.id, key: k1 });
  const rescueKey = await rescueKeyFromWords((await Mnemonic.generate()).toString());
  const { vaultId, rescueAccountId } = await setupVaultV2({ client: oldPhone, mirror, pocket: { evmAddress: carteraEvm, publicKey: k1.publicKey }, rescuePublicKey: rescueKey.publicKey, withdrawDelay: W, recoveryDelay: R, initialTinybars: 5n * HBAR });
  const kitClient = createClient("local", { accountId: rescueAccountId, key: rescueKey });
  const k2 = PrivateKey.generateECDSA();
  const w = await readWalletForMove({ mirror, vaultId: vaultId.toString(), rescuePublicKey: rescueKey.publicKey });
  const ids = await requestMove({ client: kitClient, w, newKey: k2, name: "nuevo" });
  // El móvil viejo firma solo la de la bóveda (p. ej. se quedó sin conexión a mitad).
  assert.equal((await submit(oldPhone, new ScheduleSignTransaction().setScheduleId(ScheduleId.fromString(ids.vault)))).ok, true);
  assert.deepEqual(await moveStatus({ mirror, w, newKey: k2.publicKey }), { vault: true, cartera: false, done: false });

  // Sin la llave de este móvil, nadie puede empezar otro cambio sobre una wallet a medias…
  await assert.rejects(readWalletForMove({ mirror, vaultId: vaultId.toString(), rescuePublicKey: rescueKey.publicKey }), /a medias/);
  await assert.rejects(readWalletForMove({ mirror, vaultId: vaultId.toString(), rescuePublicKey: rescueKey.publicKey, resumeKey: PrivateKey.generateECDSA().publicKey }), /a medias/);
  // …pero el móvil nuevo, con su llave, sí retoma: solo falta la Cartera.
  const w2 = await readWalletForMove({ mirror, vaultId: vaultId.toString(), rescuePublicKey: rescueKey.publicKey, resumeKey: k2.publicKey });
  assert.deepEqual(missingParts(w2, k2.publicKey), ["cartera"]);
  const again = await requestMove({ client: kitClient, w: w2, newKey: k2, name: "nuevo" });
  assert.equal(again.vault, null);
  assert.ok(again.cartera);

  // El móvil viejo ve la parte que falta y la confirma.
  const ow = await readWalletOnChain({ mirror, vaultId: vaultId.toString() });
  const { requests } = await findMoveRequests({ mirror, w: ow });
  const mine = requests.find((r) => r.newKey.toStringRaw() === k2.publicKey.toStringRaw());
  assert.ok(mine && mine.vault === null && mine.cartera, JSON.stringify(requests.map((r) => [r.vault, r.cartera])));
  await confirmMove({ client: oldPhone, request: mine });
  assert.deepEqual(await moveStatus({ mirror, w, newKey: k2.publicKey }), { vault: true, cartera: true, done: true });
  await assert.rejects(requestMove({ client: kitClient, w: await readWalletForMove({ mirror, vaultId: vaultId.toString(), rescuePublicKey: rescueKey.publicKey, resumeKey: k2.publicKey }), newKey: k2, name: "x" }), /ya es de este móvil/);
  kitClient.close();
  oldPhone.close();
  op.close();
});

/** Cuerpo programable (base64) de un cambio de llave de `account` a `key`, como lo guarda el mirror. */
function scheduledBase64(account, key) {
  const body = { transactionFee: 100_000_000, cryptoUpdateAccount: { accountIDToUpdate: { shardNum: 0, realmNum: 0, accountNum: Number(account.num.toString()) }, key: key._toProtobufKey() } };
  return Buffer.from(HieroProto.proto.SchedulableTransactionBody.encode(body).finish()).toString("base64");
}

test("guardián: basura en sus puertas no lo tumba ni le saca un 200", async () => {
  const url = `http://127.0.0.1:${GUARDIAN_PORT}`;
  const post = (path, body, type = "application/json") => fetch(`${url}${path}`, { method: "POST", headers: { "content-type": type }, body });
  const garbage = [
    ["/register", "{"],
    ["/register", "null"],
    ["/register", "[]"],
    ["/register", JSON.stringify({ vaultId: "0.0.1" })],
    ["/register", JSON.stringify({ vaultId: "x", notaryId: "y", pocketId: "z", timestamp: nowSeconds(), signature: "00" })],
    ["/register", JSON.stringify({ vaultId: "0.0.1", notaryId: "0.0.2", pocketId: "0.0.3", timestamp: 1e30, signature: {} })],
    ["/register", JSON.stringify({ vaultId: "0.0.1", notaryId: "0.0.2", pocketId: "0.0.3", timestamp: nowSeconds(), signature: "zz".repeat(10_000) })],
    ["/theft", JSON.stringify({ vaultId: "0.0.1", __proto__: { admin: true } })],
    ["/email", JSON.stringify({ vaultId: "0.0.1", email: "<script>@x" })],
    ["/register", "x".repeat(200_000)],
  ];
  for (const [path, body] of garbage) {
    // Con un cuerpo enorme, el guardián puede cortar la conexión en vez de contestar: también vale.
    const r = await post(path, body).catch(() => (body.length > 100_000 ? { status: 413 } : null));
    assert.ok(r && r.status >= 400 && r.status < 500, `${path} ${String(body).slice(0, 40)} → ${r?.status ?? "sin respuesta"}`);
  }
  const unknown = await fetch(`${url}/../../etc/passwd`);
  assert.ok(unknown.status === 404 || unknown.status === 400, `ruta rara → ${unknown.status}`);
  assert.equal((await fetch(`${url}/health`)).status, 200, "sigue vivo");
});
