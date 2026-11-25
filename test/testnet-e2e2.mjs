// Prueba en testnet REAL de lo que hace la app v2, con el guardián arrancado:
//   cartera desde una dirección EVM → kit + notario v2 + bóveda → registro en el guardián →
//   retirada completada por el guardián → kit robado: aviso, congelación y nada sale →
//   móvil perdido: recuperación en un móvil nuevo solo con las 24 palabras → evacuación con las dos llaves.
// Al final devuelve lo que sobre a la cuenta que paga.
//
//   npm run prueba:red2      (con el guardián arrancado y guardian/.env relleno)
import { existsSync, readFileSync } from "node:fs";
import { AccountId, Hbar, Mnemonic, PrivateKey, TransactionId, TransferTransaction } from "@hiero-ledger/sdk";
import {
  HBAR,
  Lane,
  Mirror,
  NETWORKS,
  callNotary2,
  createClient,
  evacuateVault,
  findRescueAccount,
  formatHbar,
  inspectVaultV2,
  loadVaultActivity,
  notary2Config,
  nowSeconds,
  parsePrivateKey,
  requestRecoveryV2,
  requestWithdrawalV2,
  rescueKeyFromWords,
  sendHbar,
  setupVaultV2,
  signRegistration,
  submit,
} from "@boveda/core";

const env = Object.fromEntries(
  (existsSync("guardian/.env") ? readFileSync("guardian/.env", "utf8") : "")
    .split("\n")
    .map((l) => l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const NETWORK = (process.env.HEDERA_NETWORK ?? env.HEDERA_NETWORK ?? "testnet").toLowerCase();
if (!["testnet", "previewnet", "local"].includes(NETWORK)) throw new Error("Esta prueba solo corre en testnet, previewnet o local.");
const GUARDIAN = process.env.GUARDIAN_URL ?? `http://127.0.0.1:${env.PORT ?? 8787}`;
const W = Number(process.env.DELAY_SECONDS ?? 30);
const R = Number(process.env.RECOVERY_SECONDS ?? 60);
const keyText = process.env.OPERATOR_KEY ?? env.OPERATOR_KEY;
if (!keyText) throw new Error("Falta OPERATOR_KEY en guardian/.env");
const NEEDED = NETWORK === "local" ? 0n : 40n * HBAR;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (id, title, pass, detail) => {
  checks.push({ id, pass });
  console.log(`${pass ? "✅" : "❌"} ${id}  ${title}\n      ${detail}`);
};
const waitFor = async (fn, ms) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(3000);
  }
};

const mirror = new Mirror(process.env.MIRROR_URL ?? NETWORKS[NETWORK].mirror);
const hashscan = NETWORKS[NETWORK].hashscan;
const funderKey = parsePrivateKey(keyText, process.env.OPERATOR_KEY_TYPE ?? env.OPERATOR_KEY_TYPE);
const funderIdText = process.env.OPERATOR_ID ?? env.OPERATOR_ID;
const funderAcc = funderIdText ? await mirror.account(funderIdText) : await mirror.account(`0x${funderKey.publicKey.toEvmAddress()}`);
if (!funderAcc) throw new Error("No encuentro la cuenta de guardian/.env en la red");
const funderId = funderAcc.id;
const funder = createClient(NETWORK, { accountId: funderId, key: funderKey });
const startBalance = funderAcc.balance;
console.log(`Red ${NETWORK} · paga ${funderId} (${formatHbar(startBalance)} HBAR) · guardián ${GUARDIAN}`);
if (startBalance < NEEDED) {
  console.log(`⛔ Hacen falta unos ${formatHbar(NEEDED)} HBAR de testnet. Recarga en ${NETWORKS[NETWORK].faucet} pegando: ${funderAcc.evmAddress}`);
  process.exit(1);
}
const info = await fetch(`${GUARDIAN}/info`).then((r) => r.json()).catch(() => null);
if (!info?.evmAddress) throw new Error(`El guardián no responde en ${GUARDIAN}: arráncalo primero (npm run guardian).`);
if (!/^0\.([2-9]|\d{2,})\./.test(String(info.version ?? ""))) throw new Error(`El guardián es la versión ${info.version}: actualízalo y vuelve a arrancarlo.`);
console.log(`Guardián ${info.version}: cuenta ${info.account} · cuenta atrás de retirada ${W} s · de recuperación ${R} s\n`);

/** Cuentas que se crean y a las que hay que devolver el saldo: [nombre, id, llave]. */
const refunds = [];
let vaultId, pocketKey, rescueKey;
let evacuated = false;

try {
  // ---- 1. cartera como la del faucet y bóveda v2 ------------------------------------------------
  console.log("── Cartera nueva y bóveda v2");
  pocketKey = PrivateKey.generateECDSA();
  const pocketEvm = `0x${pocketKey.publicKey.toEvmAddress()}`.toLowerCase();
  await sendHbar({ client: funder, from: funderId, to: AccountId.fromEvmAddress(0, 0, pocketEvm), tinybars: 32n * HBAR });
  const pocket = await waitFor(() => mirror.account(pocketEvm), 60_000);
  if (!pocket) throw new Error("la cartera no aparece en el mirror node");
  refunds.push(["cartera", pocket.id, pocketKey]);
  const device = createClient(NETWORK, { accountId: pocket.id, key: pocketKey });
  const words = (await Mnemonic.generate()).toString();
  rescueKey = await rescueKeyFromWords(words);
  const out = await setupVaultV2({
    client: device,
    mirror,
    pocket: { evmAddress: pocketEvm, publicKey: pocketKey.publicKey },
    rescuePublicKey: rescueKey.publicKey,
    guardianEvm: info.evmAddress,
    withdrawDelay: W,
    recoveryDelay: R,
    initialTinybars: 5n * HBAR,
  });
  vaultId = out.vaultId;
  const { notaryId, rescueAccountId } = out;
  refunds.push(["kit", rescueAccountId, rescueKey]);
  console.log(`   cartera ${pocket.id} · kit ${rescueAccountId} · notario ${notaryId} · bóveda ${vaultId} · ${hashscan}/account/${vaultId}`);
  const vault = await waitFor(() => inspectVaultV2({ mirror, vaultId: vaultId.toString() }), 60_000);
  check("V1", "La app crea kit, notario v2 y bóveda con la clave de tres rutas", !!vault && vault.notaryId.toString() === notaryId.toString(), vault ? `saldo ${formatHbar(vault.balance)} HBAR` : "no aparece");

  // ---- 2. registro en el guardián ------------------------------------------------------------------
  const fields = { vaultId: vaultId.toString(), notaryId: notaryId.toString(), pocketId: pocket.id.toString(), pushToken: null, timestamp: nowSeconds() };
  let reg;
  for (let i = 0; i < 6; i++) {
    reg = await fetch(`${GUARDIAN}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signRegistration(pocketKey, { ...fields, timestamp: nowSeconds() })) });
    if (reg.ok) break;
    await sleep(4000);
  }
  check("V2", "El guardián verifica la bóveda v2 en la red y la registra", reg.ok, `HTTP ${reg.status} ${reg.ok ? "" : await reg.text()}`);

  // ---- 3. retirada con el móvil, completada por el guardián ------------------------------------------
  console.log("── Retirada con el móvil");
  const w = await requestWithdrawalV2({ client: device, vaultId, notaryId, to: pocket.id, tinybars: HBAR, withdrawDelay: W });
  console.log(`   ${w.scheduleId}: sale en ${W} s; la completa el guardián`);
  const doneW = await waitFor(async () => (await mirror.schedule(w.scheduleId.toString()))?.executed, (W + 90) * 1000);
  check("V3", "El guardián completa la retirada al acabar la cuenta atrás", !!doneW, doneW ? "ejecutada" : "no se ejecutó a tiempo");

  // ---- 4. kit robado: el ladrón pide una recuperación y el móvil la congela -------------------------
  console.log("── Kit robado");
  const thief = createClient(NETWORK, { accountId: rescueAccountId, key: rescueKey });
  const t = await requestRecoveryV2({ client: thief, vaultId, notaryId, to: funderId, tinybars: 4n * HBAR, recoveryDelay: R, memo: "ladrón con el kit" });
  const seen = await waitFor(async () => (await loadVaultActivity({ mirror, notaryId: notaryId.toString() })).items.find((m) => m.scheduleId === t.scheduleId.toString() && m.lane === "recovery"), 30_000);
  check("V4", "La app ve la recuperación del ladrón (carril del kit)", !!seen, seen ? `sale en ${R} s si nadie la congela` : "no aparece");
  const frozen = await callNotary2({ client: device, notaryId, call: "freeze", lane: Lane.Recovery });
  const activity = await waitFor(async () => {
    const a = await loadVaultActivity({ mirror, notaryId: notaryId.toString() });
    return a.locks.recovery > nowSeconds() && a.items.find((m) => m.scheduleId === t.scheduleId.toString())?.status === "superseded" ? a : null;
  }, 30_000);
  check("V5", "El móvil congela las recuperaciones con un toque", frozen.ok && !!activity, frozen.ok ? "anulada; carril cerrado" : `${frozen.status} ${frozen.reason}`);
  await sleep((R + 20) * 1000);
  const stolen = (await mirror.schedule(t.scheduleId.toString()))?.executed;
  check("V6", "Pasado su plazo, la recuperación del ladrón no sale (ni el guardián la completa)", !stolen, stolen ? "¡se ejecutó!" : "no se ejecutó");
  thief.close();

  // ---- 5. móvil perdido: recuperación en un móvil nuevo solo con las 24 palabras ----------------------
  console.log("── Móvil perdido: recuperación con las 24 palabras");
  const key = await rescueKeyFromWords(words);
  const v = await inspectVaultV2({ mirror, vaultId: vaultId.toString() });
  const cfg = await notary2Config({ mirror, notaryId: v.notaryId });
  const kit = await waitFor(() => findRescueAccount({ mirror, rescuePublicKey: key.publicKey, rescueAddress: cfg.rescue }), 30_000);
  check("V7", "Con las palabras se encuentra la cuenta del kit en la red", kit?.id.toString() === rescueAccountId.toString(), kit ? `kit ${kit.id}` : "no se encontró");
  const newKey = PrivateKey.generateECDSA();
  const newEvm = `0x${newKey.publicKey.toEvmAddress()}`.toLowerCase();
  const kitClient = createClient(NETWORK, { accountId: rescueAccountId, key });
  await sendHbar({ client: kitClient, from: rescueAccountId, to: AccountId.fromEvmAddress(0, 0, newEvm), tinybars: HBAR });
  const newPocket = await waitFor(() => mirror.account(newEvm), 60_000);
  if (!newPocket) throw new Error("la cartera nueva no aparece");
  refunds.push(["cartera nueva", newPocket.id, newKey]);
  await waitFor(async () => nowSeconds() > (await loadVaultActivity({ mirror, notaryId: notaryId.toString() })).locks.recovery + 3, (R + 30) * 1000);
  let rec;
  for (let i = 0; i < 6 && !rec; i++) {
    rec = await requestRecoveryV2({ client: kitClient, vaultId, notaryId: v.notaryId, to: newPocket.id, tinybars: v.balance, recoveryDelay: cfg.recoveryDelay }).catch((e) => {
      if (!/congelado/.test(e.message)) throw e;
      return null;
    });
    if (!rec) await sleep(4000);
  }
  console.log(`   ${rec.scheduleId}: ${formatHbar(v.balance)} HBAR a la cartera nueva en ${cfg.recoveryDelay} s`);
  const doneR = await waitFor(async () => (await mirror.schedule(rec.scheduleId.toString()))?.executed, (R + 90) * 1000);
  check("V8", "El guardián completa la recuperación y el dinero llega a la cartera nueva", !!doneR, doneR ? `${formatHbar(v.balance)} HBAR` : "no se ejecutó a tiempo");
  kitClient.close();

  // ---- 6. evacuación con las dos llaves ----------------------------------------------------------------
  console.log("── Evacuación con móvil + kit");
  await sendHbar({ client: device, from: pocket.id, to: vaultId, tinybars: 2n * HBAR });
  await sleep(6000);
  const ev = await evacuateVault({ client: device, mirror, vaultId, to: pocket.id, rescueKey }).catch((e) => ({ error: e.message }));
  evacuated = !ev.error;
  check("V9", "Con móvil + kit se vacía la bóveda al momento", !ev.error, ev.error ?? `${formatHbar(ev.tinybars)} HBAR · ${ev.txId}`);
  device.close();
} catch (e) {
  console.log(`\n⛔ Interrumpida: ${e instanceof Error ? e.message : String(e)}`);
  checks.push({ id: "abort", pass: false });
}

// ---- devolver lo que sobre ----------------------------------------------------------------------
console.log("\n── Devolviendo el saldo sobrante");
// Si ya se evacuó, la bóveda está vacía (el mirror node puede tardar en reflejarlo): no se toca.
if (vaultId && pocketKey && rescueKey && !evacuated) {
  const bal = (await mirror.account(vaultId.toString()).catch(() => null))?.balance ?? 0n;
  if (bal > 0n) {
    const pocketId = refunds.find((r) => r[0] === "cartera")?.[1];
    const c = createClient(NETWORK, { accountId: pocketId, key: pocketKey });
    const r = await submit(c, new TransferTransaction().addHbarTransfer(vaultId, Hbar.fromTinybars((-bal).toString())).addHbarTransfer(funderId, Hbar.fromTinybars(bal.toString())), [rescueKey]);
    c.close();
    console.log(`   bóveda: ${r.ok ? `${formatHbar(bal)} HBAR devueltos` : r.status}`);
  }
}
for (const [label, id, key] of refunds) {
  let result = "";
  for (let attempt = 0; attempt < 4 && !result; attempt++) {
    if (attempt) await sleep(5000);
    const amount = ((await mirror.account(id.toString()).catch(() => null))?.balance ?? 0n) - HBAR / 20n;
    if (amount <= 0n) {
      result = "nada que devolver";
      break;
    }
    const c = createClient(NETWORK, null);
    const r = await submit(c, new TransferTransaction().addHbarTransfer(id, Hbar.fromTinybars((-amount).toString())).addHbarTransfer(funderId, Hbar.fromTinybars(amount.toString())).setTransactionId(TransactionId.generate(id)), [key]);
    c.close();
    if (r.ok) result = `${formatHbar(amount)} HBAR devueltos`;
    else if (r.status !== "INSUFFICIENT_PAYER_BALANCE" || attempt === 3) result = r.status;
  }
  console.log(`   ${label}: ${result}`);
}
await sleep(5000);
const end = (await mirror.account(funderId.toString()))?.balance ?? startBalance;
const failed = checks.filter((c) => !c.pass);
console.log(`\n══ ${checks.length - failed.length}/${checks.length} comprobaciones correctas · coste ${formatHbar(startBalance - end)} HBAR de prueba`);
funder.close();
process.exit(failed.length ? 1 : 0);
