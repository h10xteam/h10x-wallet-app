// Prueba de extremo a extremo SIN red: nodo + mirror simulados, el núcleo de la app y el guardián real
// (como proceso aparte). Recorre lo que hará la app: cartera desde una dirección EVM (como el faucet),
// bóveda, registro en el guardián, retirada con cuenta atrás, bloqueo, intento directo y rescate.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountId, ContractId, Hbar, Mnemonic, PrivateKey, ScheduleId, TransferTransaction } from "@hiero-ledger/sdk";
import {
  HBAR,
  Mirror,
  WalletError,
  callNotary,
  createClient,
  loadWithdrawals,
  parseAccount,
  requestWithdrawal,
  rescueVault,
  sendHbar,
  setupVault,
  signRegistration,
  submit,
  nowSeconds,
} from "@boveda/core";
import { startFakeNetwork } from "./sim/fake-network.mjs";

const GUARDIAN_PORT = 18787;
const DELAY = 6;
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
  // Cuenta del guardián (sin alias: su msg.sender es la dirección long-zero).
  const op = createClient("local", { accountId: operatorId, key: operatorKey });
  const created = await submit(op, new (await import("@hiero-ledger/sdk")).AccountCreateTransaction().setKeyWithoutAlias(guardianKey.publicKey).setInitialBalance(new Hbar(50)));
  assert.ok(created.ok, `cuenta del guardián: ${created.status}`);
  op.close();
  dataDir = mkdtempSync(join(tmpdir(), "guardian-"));
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

test("flujo completo de la app contra la red simulada", async (t) => {
  // ---- cartera "como el faucet": se envían HBAR a una dirección EVM nueva -------------------------
  const pocketKey = PrivateKey.generateECDSA();
  const pocketEvm = `0x${pocketKey.publicKey.toEvmAddress()}`;
  const op = createClient("local", { accountId: operatorId, key: operatorKey });
  await sendHbar({ client: op, from: operatorId, to: AccountId.fromEvmAddress(0, 0, pocketEvm), tinybars: 100n * HBAR });
  const pocket = await waitFor("cartera en el mirror", () => mirror.account(pocketEvm));
  assert.equal(pocket.evmAddress, pocketEvm.toLowerCase());
  const pocketClient = createClient("local", { accountId: pocket.id, key: pocketKey });

  const recipientKey = PrivateKey.generateED25519();
  const created = await submit(op, new (await import("@hiero-ledger/sdk")).AccountCreateTransaction().setKeyWithoutAlias(recipientKey.publicKey));
  const recipient = created.receipt.accountId;

  // ---- bóveda --------------------------------------------------------------------------------------
  const info = await (await fetch(`http://127.0.0.1:${GUARDIAN_PORT}/info`)).json();
  const mnemonic = await Mnemonic.generate();
  const rescueKey = await mnemonic.toStandardEd25519PrivateKey("", 0);
  const steps = [];
  const { notaryId, vaultId, vetoers } = await setupVault({
    client: pocketClient,
    mirror,
    pocket: { evmAddress: pocket.evmAddress, publicKey: pocketKey.publicKey },
    rescuePublicKey: rescueKey.publicKey,
    guardianEvm: info.evmAddress,
    delaySeconds: DELAY,
    initialTinybars: 20n * HBAR,
    onStep: (s) => steps.push(s),
  });
  await t.test("crea notario y bóveda; la cartera hueca se completa al pagar", async () => {
    assert.deepEqual(steps, ["notary", "vault"]);
    assert.deepEqual(vetoers, [pocket.evmAddress, info.evmAddress]);
    assert.equal((await mirror.account(vaultId.toString())).balance, 20n * HBAR);
  });

  await t.test("el guardián rechaza un registro mal firmado y acepta el bueno", async () => {
    const fields = { vaultId: vaultId.toString(), notaryId: notaryId.toString(), pocketId: pocket.id.toString(), pushToken: null, timestamp: nowSeconds() };
    const post = (body) => fetch(`http://127.0.0.1:${GUARDIAN_PORT}/guardian/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const bad = await post(signRegistration(PrivateKey.generateECDSA(), fields));
    assert.equal(bad.status, 401);
    const wrongVault = await post(signRegistration(pocketKey, { ...fields, vaultId: recipient.toString() }));
    assert.equal(wrongVault.status, 400);
    const good = await post(signRegistration(pocketKey, fields));
    assert.equal(good.status, 200, await good.text());
  });

  await t.test("una transferencia directa desde la bóveda con la llave del móvil falla", async () => {
    const tx = new TransferTransaction().addHbarTransfer(vaultId, new Hbar(-1)).addHbarTransfer(recipient, new Hbar(1));
    const out = await submit(pocketClient, tx);
    assert.equal(out.status, "INVALID_SIGNATURE");
  });

  // ---- retirada con cuenta atrás, completada por el guardián ---------------------------------------
  const before = net.balanceOf(recipient.num.toNumber());
  const w1 = await requestWithdrawal({ client: pocketClient, vaultId, notaryId, to: recipient, tinybars: 3n * HBAR, delaySeconds: DELAY });
  await t.test("la retirada aparece pendiente y no sale antes de tiempo", async () => {
    const list = await loadWithdrawals({ mirror, notaryId: notaryId.toString() });
    const w = list.find((x) => x.scheduleId === w1.scheduleId.toString());
    assert.ok(w);
    assert.equal(w.status, "requested");
    assert.equal(w.executed, false);
    assert.deepEqual(w.action, { kind: "transfer", from: vaultId.toString(), to: recipient.toString(), tinybars: 3n * HBAR, tokens: [], nfts: [], fee: null, extra: [] });
    const early = await callNotary({ client: pocketClient, notaryId, scheduleId: w1.scheduleId, fn: "approve" });
    assert.equal(early.ok, false);
    assert.match(early.reason, /^TooEarly/);
  });

  await t.test("al acabar la cuenta atrás, el guardián la completa sola", async () => {
    await waitFor("retirada ejecutada", async () => (await mirror.schedule(w1.scheduleId.toString()))?.executed, 40_000);
    assert.equal(net.balanceOf(recipient.num.toNumber()) - before, 3n * HBAR);
    const w = (await loadWithdrawals({ mirror, notaryId: notaryId.toString() })).find((x) => x.scheduleId === w1.scheduleId.toString());
    assert.equal(w.status, "approved");
    assert.equal(w.executed, true);
    assert.match(guardianLog, /completando/);
  });

  // ---- bloqueo -------------------------------------------------------------------------------------
  await t.test("una retirada bloqueada no sale, ni siquiera cuando el guardián lo intenta", async () => {
    const w2 = await requestWithdrawal({ client: pocketClient, vaultId, notaryId, to: recipient, tinybars: 5n * HBAR, delaySeconds: DELAY });
    const veto = await callNotary({ client: pocketClient, notaryId, scheduleId: w2.scheduleId, fn: "veto" });
    assert.ok(veto.ok, veto.reason);
    await sleep((DELAY + 7) * 1000);
    assert.equal((await mirror.schedule(w2.scheduleId.toString())).executed, false);
    const w = (await loadWithdrawals({ mirror, notaryId: notaryId.toString() })).find((x) => x.scheduleId === w2.scheduleId.toString());
    assert.equal(w.status, "vetoed");
  });

  await t.test("solo la cartera puede anunciar retiradas al notario", async () => {
    // El operador intenta pedir una retirada de la bóveda ajena: el notario la rechaza.
    await assert.rejects(
      requestWithdrawal({ client: op, vaultId, notaryId, to: operatorId, tinybars: HBAR, delaySeconds: DELAY }),
      (e) => e instanceof WalletError && /NotQuorum/.test(e.message),
    );
  });

  // ---- rescate -------------------------------------------------------------------------------------
  await t.test("con el kit de rescate se vacía la bóveda al momento, sin cartera ni notario", async () => {
    const vaultBefore = (await mirror.account(vaultId.toString())).balance;
    const fresh = createClient("local", null);
    const restored = await (await Mnemonic.fromString(mnemonic.toString())).toStandardEd25519PrivateKey("", 0);
    const out = await rescueVault({ client: fresh, mirror, vaultId, rescueKey: restored, to: parseAccount(recipient.toString()) });
    fresh.close();
    assert.equal(out.tinybars, vaultBefore - HBAR / 10n);
    assert.ok((await mirror.account(vaultId.toString())).balance <= HBAR / 10n);
  });

  op.close();
  pocketClient.close();
});
