// Prueba en testnet REAL de tokens y comisiones, con el guardián arrancado:
//   token de prueba → cartera nueva lo recibe sin asociarlo (HIP-904) → bóveda v2 que acepta tokens →
//   guardar HBAR y token con comisión → sacar token con comisión (el guardián la completa; se cobra solo
//   al salir) → retirada bloqueada: sin comisión → bóveda antigua: activar tokens por su cuenta atrás →
//   recuperar tokens con el kit → evacuar con las dos llaves (HBAR + tokens).
// Al final devuelve el HBAR sobrante a la cuenta que paga (los tokens de prueba no valen nada).
//
//   npm run prueba:tokens      (con el guardián arrancado y guardian/.env relleno)
import { existsSync, readFileSync } from "node:fs";
import { AccountCreateTransaction, AccountId, Hbar, Mnemonic, PrivateKey, TokenCreateTransaction, TransactionId, TransferTransaction } from "@hiero-ledger/sdk";
import {
  HBAR,
  Mirror,
  NETWORKS,
  SERVICE_FEES,
  buildVaultKeyV2,
  callNotary2,
  createClient,
  evacuateVault,
  formatHbar,
  loadVaultActivity,
  nowSeconds,
  parsePrivateKey,
  requestEnableTokensV2,
  requestRecoveryV2,
  requestWithdrawalV2,
  rescueKeyFromWords,
  sendHbar,
  sendToken,
  setupVaultV2,
  signRegistration,
  submit,
  summarizeAction,
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
const NEEDED = NETWORK === "local" ? 0n : 45n * HBAR;
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
if (!/^0\.([3-9]|\d{2,})\./.test(String(info.version ?? ""))) throw new Error(`El guardián es la versión ${info.version}: actualízalo (0.3 o más) y vuelve a arrancarlo.`);
console.log(`Guardián ${info.version}: cuenta ${info.account} · cuenta atrás de retirada ${W} s · de recuperación ${R} s\n`);

/** Cuentas que se crean y a las que hay que devolver el HBAR: [nombre, id, llave]. */
const refunds = [];
const vaultsToEmpty = []; // [nombre, vaultId]
let pocket, pocketKey, rescueKey, device;
const evacuated = new Set();
const tokenBalance = async (account, tokenId) => (await mirror.accountTokens(account.toString())).find((x) => x.tokenId === tokenId)?.balance ?? 0n;
const balance = async (account) => (await mirror.account(account.toString()))?.balance ?? 0n;

try {
  // ---- 1. token de prueba y cartera nueva ---------------------------------------------------------------
  console.log("── Token de prueba y cartera");
  const created = await submit(funder, new TokenCreateTransaction().setTokenName("Hvault Prueba").setTokenSymbol("HVP").setDecimals(6).setInitialSupply(1_000_000_000_000n).setTreasuryAccountId(funderId).setTokenMemo("prueba de Hvault"));
  if (!created.ok) throw new Error(`no se pudo crear el token: ${created.status}`);
  const tokenId = created.receipt.tokenId.toString();
  const U = 1_000_000n; // 1 HVP
  console.log(`   token ${tokenId} · ${hashscan}/token/${tokenId}`);
  pocketKey = PrivateKey.generateECDSA();
  const pocketEvm = `0x${pocketKey.publicKey.toEvmAddress()}`.toLowerCase();
  await sendHbar({ client: funder, from: funderId, to: AccountId.fromEvmAddress(0, 0, pocketEvm), tinybars: 36n * HBAR });
  pocket = await waitFor(() => mirror.account(pocketEvm), 60_000);
  if (!pocket) throw new Error("la cartera no aparece en el mirror node");
  refunds.push(["cartera", pocket.id, pocketKey]);
  const sent = await sendToken({ client: funder, from: funderId, to: pocket.id, tokenId, amount: 500n * U, decimals: 6 }).then(() => true).catch((e) => e.message);
  const got = await waitFor(async () => ((await tokenBalance(pocket.id, tokenId)) === 500n * U ? true : null), 30_000);
  check("T1", "Una cartera creada por dirección EVM recibe tokens sin asociarlos antes", sent === true && !!got, sent === true ? `500 HVP en ${pocket.id} (asociaciones automáticas: ${pocket.maxAutoAssociations})` : String(sent));

  // ---- 2. bóveda v2 que acepta tokens --------------------------------------------------------------------
  console.log("── Bóveda v2");
  device = createClient(NETWORK, { accountId: pocket.id, key: pocketKey });
  const words = (await Mnemonic.generate()).toString();
  rescueKey = await rescueKeyFromWords(words);
  const { notaryId, vaultId, rescueAccountId } = await setupVaultV2({
    client: device,
    mirror,
    pocket: { evmAddress: pocketEvm, publicKey: pocketKey.publicKey },
    rescuePublicKey: rescueKey.publicKey,
    guardianEvm: info.evmAddress,
    withdrawDelay: W,
    recoveryDelay: R,
  });
  refunds.push(["kit", rescueAccountId, rescueKey]);
  vaultsToEmpty.push(["bóveda", vaultId]);
  console.log(`   kit ${rescueAccountId} · notario ${notaryId} · bóveda ${vaultId} · ${hashscan}/account/${vaultId}`);
  const vaultAcc = await waitFor(() => mirror.account(vaultId.toString()), 60_000);
  check("T2", "La bóveda nueva acepta cualquier token (asociaciones automáticas sin límite)", vaultAcc?.maxAutoAssociations === -1, `max_automatic_token_associations = ${vaultAcc?.maxAutoAssociations}`);
  const fields = { vaultId: vaultId.toString(), notaryId: notaryId.toString(), pocketId: pocket.id.toString(), pushToken: null, lang: "es" };
  let reg;
  for (let i = 0; i < 6; i++) {
    reg = await fetch(`${GUARDIAN}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signRegistration(pocketKey, { ...fields, timestamp: nowSeconds() })) });
    if (reg.ok) break;
    await sleep(4000);
  }
  if (!reg.ok) throw new Error(`el guardián no registra la bóveda: ${await reg.text()}`);

  // ---- 3. comisiones (cuenta que cobra, creada para la prueba) -----------------------------------------
  console.log("── Guardar con comisión");
  const collectorKey = PrivateKey.generateED25519();
  const col = await submit(funder, new AccountCreateTransaction().setKeyWithoutAlias(collectorKey.publicKey).setInitialBalance(new Hbar(1)));
  const collector = col.receipt.accountId;
  refunds.push(["cobrador", collector, collectorKey]);
  const feeMirror = new Mirror(process.env.MIRROR_URL ?? NETWORKS[NETWORK].mirror, fetch, { feeCollector: collector.toString() });
  const depositFee = { collector, tinybars: SERVICE_FEES.depositTinybars };
  const withdrawFee = { collector, tinybars: SERVICE_FEES.withdrawTinybars };
  await sendHbar({ client: device, from: pocket.id, to: vaultId, tinybars: 8n * HBAR, fee: depositFee });
  await sendToken({ client: device, from: pocket.id, to: vaultId, tokenId, amount: 300n * U, decimals: 6, fee: depositFee });
  const deposited = await waitFor(async () => ((await tokenBalance(vaultId, tokenId)) === 300n * U && (await balance(collector)) === HBAR + 4n * HBAR ? true : null), 30_000);
  check("T3", "Guardar HBAR y token paga 2 HBAR cada vez, en la misma transferencia", !!deposited, deposited ? "bóveda: 8 HBAR + 300 HVP · cobrador: +4 HBAR" : `bóveda ${await tokenBalance(vaultId, tokenId)} HVP · cobrador ${formatHbar(await balance(collector))} HBAR`);

  // ---- 4. sacar un token con comisión (la completa el guardián) ----------------------------------------
  console.log("── Sacar token con comisión");
  const colBefore = await balance(collector);
  const w = await requestWithdrawalV2({ client: device, vaultId, notaryId, to: pocket.id, tokens: [{ tokenId, amount: 100n * U, decimals: 6 }], fee: withdrawFee, withdrawDelay: W });
  const seen = await waitFor(async () => (await loadVaultActivity({ mirror: feeMirror, notaryId: notaryId.toString() })).items.find((m) => m.scheduleId === w.scheduleId.toString()), 30_000);
  const text = seen ? summarizeAction(seen.action, { meta: () => ({ tokenId, name: "Hvault Prueba", symbol: "HVP", decimals: 6, fungible: true }), lang: "es" }) : null;
  check("T4", "La app describe la retirada del token y su comisión", text?.title === "Retirada de 100 HVP" && text?.fee === "Comisión del servicio: 2 HBAR", text ? `${text.title} · ${text.detail} · ${text.fee}` : "no aparece");
  const notYet = (await balance(collector)) === colBefore;
  const doneW = await waitFor(async () => (await mirror.schedule(w.scheduleId.toString()))?.executed, (W + 90) * 1000);
  await sleep(5000);
  const paid = (await balance(collector)) - colBefore;
  check("T5", "El guardián la completa; la comisión se cobra solo al salir", !!doneW && notYet && paid === 2n * HBAR && (await tokenBalance(vaultId, tokenId)) === 200n * U, `antes de salir sin cobro: ${notYet} · cobrado al salir: ${formatHbar(paid)} HBAR · quedan ${(await tokenBalance(vaultId, tokenId)) / U} HVP`);

  // ---- 5. retirada bloqueada: sin comisión ----------------------------------------------------------------
  console.log("── Retirada bloqueada");
  const colBefore2 = await balance(collector);
  const b = await requestWithdrawalV2({ client: device, vaultId, notaryId, to: pocket.id, tinybars: HBAR, fee: withdrawFee, withdrawDelay: W });
  const vetoed = await callNotary2({ client: device, notaryId, call: "veto", schedule: b.scheduleId });
  await sleep((W + 20) * 1000);
  const blockedFee = (await balance(collector)) - colBefore2;
  check("T6", "Una retirada bloqueada no sale ni cobra comisión", vetoed.ok && blockedFee === 0n && !(await mirror.schedule(b.scheduleId.toString()))?.executed, vetoed.ok ? `cobrado: ${formatHbar(blockedFee)} HBAR` : `${vetoed.status} ${vetoed.reason}`);

  // ---- 6. bóveda antigua sin tokens: activarlos por la cuenta atrás -------------------------------------
  console.log("── Bóveda antigua: activar tokens");
  const oldKey = buildVaultKeyV2({ deviceKey: pocketKey.publicKey, rescueKey: rescueKey.publicKey, notaryId });
  const oldRes = await submit(device, new AccountCreateTransaction().setKeyWithoutAlias(oldKey).setInitialBalance(new Hbar(1)).setAccountMemo("Hvault · prueba bóveda antigua"));
  const oldVault = oldRes.receipt.accountId;
  vaultsToEmpty.push(["bóveda antigua", oldVault]);
  await waitFor(() => mirror.account(oldVault.toString()), 60_000);
  const refused = await sendToken({ client: device, from: pocket.id, to: oldVault, tokenId, amount: U, decimals: 6 }).then(() => "aceptado").catch((e) => (/TOKEN_NOT_ASSOCIATED/.test(e.message) ? "rechazado" : e.message));
  const en = await requestEnableTokensV2({ client: device, vaultId: oldVault, notaryId, withdrawDelay: W });
  const enSeen = await waitFor(async () => (await loadVaultActivity({ mirror, notaryId: notaryId.toString() })).items.find((m) => m.scheduleId === en.scheduleId.toString()), 30_000);
  await sleep((W + 3) * 1000);
  // Esta bóveda no está registrada en el guardián: la completa el móvil.
  const ap = await callNotary2({ client: device, notaryId, call: "approve", schedule: en.scheduleId });
  const enabled = await waitFor(async () => ((await mirror.account(oldVault.toString()))?.maxAutoAssociations === -1 ? true : null), 30_000);
  const accepted = enabled ? await sendToken({ client: device, from: pocket.id, to: oldVault, tokenId, amount: 50n * U, decimals: 6 }).then(() => true).catch((e) => e.message) : "sin activar";
  check(
    "T7",
    "Bóveda sin tokens: rechaza tokens; se activan por la cuenta atrás y después los acepta",
    refused === "rechazado" && enSeen?.action.kind === "settings" && ap.ok && !!enabled && accepted === true,
    `antes: ${refused} · operación: ${enSeen?.action.kind ?? "—"} · completada: ${ap.ok ? "sí" : `${ap.status} ${ap.reason}`} · después: ${accepted === true ? "acepta" : accepted}`,
  );

  // ---- 7. recuperar tokens con el kit ---------------------------------------------------------------------
  console.log("── Recuperar tokens con el kit");
  const kitClient = createClient(NETWORK, { accountId: rescueAccountId, key: rescueKey });
  const pocketTokensBefore = await tokenBalance(pocket.id, tokenId);
  const rec = await requestRecoveryV2({ client: kitClient, vaultId: oldVault, notaryId, to: pocket.id, tokens: [{ tokenId, amount: 50n * U, decimals: 6 }], recoveryDelay: R });
  await sleep((R + 3) * 1000);
  const apR = await callNotary2({ client: device, notaryId, call: "approve", schedule: rec.scheduleId });
  const recovered = await waitFor(async () => ((await tokenBalance(pocket.id, tokenId)) - pocketTokensBefore === 50n * U ? true : null), 30_000);
  check("T8", "Con el kit se recuperan tokens (cuenta atrás de recuperación, sin comisión)", apR.ok && !!recovered, apR.ok ? `${recovered ? "50 HVP" : "no llegaron"} a la cartera` : `${apR.status} ${apR.reason}`);
  kitClient.close();

  // ---- 8. evacuar con las dos llaves: HBAR y tokens --------------------------------------------------------
  console.log("── Evacuar con móvil + kit");
  await sleep(4000);
  const ev = await evacuateVault({ client: device, mirror, vaultId, to: pocket.id, rescueKey }).catch((e) => ({ error: e.message }));
  if (!ev.error) evacuated.add(vaultId.toString());
  const hvp = ev.tokens?.find((x) => x.tokenId === tokenId)?.amount ?? 0n;
  check("T9", "Evacuar se lleva el HBAR y los tokens al momento", !ev.error && hvp === 200n * U && ev.failedTokens.length === 0, ev.error ?? `${formatHbar(ev.tinybars)} HBAR + ${hvp / U} HVP · ${ev.txId}`);
} catch (e) {
  console.log(`\n⛔ Interrumpida: ${e instanceof Error ? e.message : String(e)}`);
  checks.push({ id: "abort", pass: false });
}

// ---- devolver lo que sobre ----------------------------------------------------------------------
console.log("\n── Devolviendo el HBAR sobrante");
for (const [label, id] of vaultsToEmpty) {
  if (evacuated.has(id.toString()) || !pocket || !pocketKey || !rescueKey) continue;
  const bal = (await mirror.account(id.toString()).catch(() => null))?.balance ?? 0n;
  if (bal <= 0n) continue;
  const c = createClient(NETWORK, { accountId: pocket.id, key: pocketKey });
  const r = await submit(c, new TransferTransaction().addHbarTransfer(id, Hbar.fromTinybars((-bal).toString())).addHbarTransfer(funderId, Hbar.fromTinybars(bal.toString())), [rescueKey]);
  c.close();
  console.log(`   ${label}: ${r.ok ? `${formatHbar(bal)} HBAR devueltos` : r.status}`);
}
device?.close();
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
