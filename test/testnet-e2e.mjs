// Prueba en testnet REAL del núcleo + guardián, sin el móvil. Hace lo mismo que hará la app:
//   cartera nueva desde una dirección EVM (como el faucet) → bóveda → registro en el guardián →
//   retirada con cuenta atrás completada por el guardián → bloqueo → intento directo → rescate.
// Al final devuelve lo que sobre a la cuenta que paga.
//
//   npm run prueba:red      (con el guardián arrancado y guardian/.env relleno)
import { readFileSync, existsSync } from "node:fs";
import { AccountId, Hbar, Mnemonic, PrivateKey, TransactionId, TransferTransaction } from "@hiero-ledger/sdk";
import {
  HBAR,
  Mirror,
  NETWORKS,
  WalletError,
  callNotary,
  createClient,
  formatHbar,
  loadWithdrawals,
  nowSeconds,
  parsePrivateKey,
  requestWithdrawal,
  rescueVault,
  sendHbar,
  setupVault,
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
const GUARDIAN = process.env.GUARDIAN_URL ?? `http://127.0.0.1:${env.PORT ?? 8787}`;
const DELAY = Number(process.env.DELAY_SECONDS ?? 60);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (id, title, pass, detail) => {
  checks.push({ id, pass });
  console.log(`${pass ? "✅" : "❌"} ${id}  ${title}\n      ${detail}`);
};

if (!["testnet", "previewnet", "local"].includes(NETWORK)) throw new Error("Esta prueba solo corre en testnet, previewnet o local.");
const keyText = process.env.OPERATOR_KEY ?? env.OPERATOR_KEY;
if (!keyText) throw new Error("Falta OPERATOR_KEY en guardian/.env");

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

const info = await fetch(`${GUARDIAN}/info`).then((r) => r.json()).catch(() => null);
if (!info?.evmAddress) throw new Error(`El guardián no responde en ${GUARDIAN}: arráncalo primero (npm run guardian).`);
console.log(`Guardián: cuenta ${info.account}\n`);

const waitFor = async (what, fn, ms) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(3000);
  }
};

const pocketKey = PrivateKey.generateECDSA();
const pocketEvm = `0x${pocketKey.publicKey.toEvmAddress()}`;
let pocketClient;
let pocketId;
let vaultId;
let rescueKey;
try {
  // ---- 1. cartera como la del faucet ------------------------------------------------------------
  console.log("── Cartera nueva desde una dirección EVM (como el faucet)");
  await sendHbar({ client: funder, from: funderId, to: AccountId.fromEvmAddress(0, 0, pocketEvm), tinybars: 28n * HBAR });
  const pocket = await waitFor("cartera", () => mirror.account(pocketEvm), 60_000);
  if (!pocket) throw new Error("la cartera no aparece en el mirror node");
  pocketId = pocket.id;
  pocketClient = createClient(NETWORK, { accountId: pocketId, key: pocketKey });
  console.log(`   cartera ${pocketId} · ${hashscan}/account/${pocketId}`);

  // ---- 2. bóveda --------------------------------------------------------------------------------
  console.log(`── Bóveda (cuenta atrás de ${DELAY} s)`);
  const mnemonic = await Mnemonic.generate();
  rescueKey = await mnemonic.toStandardEd25519PrivateKey("", 0);
  const out = await setupVault({
    client: pocketClient,
    mirror,
    pocket: { evmAddress: pocket.evmAddress, publicKey: pocketKey.publicKey },
    rescuePublicKey: rescueKey.publicKey,
    guardianEvm: info.evmAddress,
    delaySeconds: DELAY,
    initialTinybars: 5n * HBAR,
    onStep: (s) => console.log(`   ${s === "notary" ? "desplegando notario…" : "creando bóveda…"}`),
  });
  vaultId = out.vaultId;
  const notaryId = out.notaryId;
  console.log(`   notario ${notaryId} · bóveda ${vaultId} · ${hashscan}/account/${vaultId}`);
  const completed = await waitFor("cartera completada", async () => (await mirror.account(pocketId.toString()))?.key != null, 30_000);
  check("A1", "La cartera creada desde una dirección EVM paga el despliegue y queda completada", !!completed, `clave en la red: ${completed ? "sí" : "no"}`);

  // ---- 3. registro en el guardián ----------------------------------------------------------------
  await waitFor("bóveda en el mirror", () => mirror.account(vaultId.toString()), 30_000);
  const fields = { vaultId: vaultId.toString(), notaryId: notaryId.toString(), pocketId: pocketId.toString(), pushToken: null, timestamp: nowSeconds() };
  let reg;
  for (let i = 0; i < 5; i++) {
    reg = await fetch(`${GUARDIAN}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signRegistration(pocketKey, fields)) });
    if (reg.ok) break;
    await sleep(4000); // el mirror node puede tardar unos segundos en ver la bóveda
  }
  check("A2", "El guardián verifica en la red la bóveda, el notario y la firma, y la registra", reg.ok, `HTTP ${reg.status} ${reg.ok ? "" : await reg.text()}`);

  // ---- 4. intento directo -----------------------------------------------------------------------
  const direct = await submit(pocketClient, new TransferTransaction().addHbarTransfer(vaultId, new Hbar(-1)).addHbarTransfer(funderId, new Hbar(1)));
  check("A3", "Una transferencia directa desde la bóveda con la llave del móvil falla", direct.status === "INVALID_SIGNATURE", `estado ${direct.status}`);

  // ---- 5. retirada completada por el guardián ----------------------------------------------------
  console.log("── Retirada de 1 HBAR a la cuenta que paga");
  const w1 = await requestWithdrawal({ client: pocketClient, vaultId, notaryId, to: funderId, tinybars: HBAR, delaySeconds: DELAY });
  console.log(`   ${w1.scheduleId} · esperando la cuenta atrás y al guardián (hasta ${DELAY + 90} s)…`);
  const listed = await waitFor("retirada en el mirror", async () => (await loadWithdrawals({ mirror, notaryId: notaryId.toString() })).find((w) => w.scheduleId === w1.scheduleId.toString()), 30_000);
  check("A4", "La app ve la retirada pendiente con importe y destino", listed?.status === "requested" && listed.action.kind === "transfer" && listed.action.tinybars === HBAR, `estado ${listed?.status}, ${listed?.action.kind}`);
  const executed = await waitFor("ejecución", async () => (await mirror.schedule(w1.scheduleId.toString()))?.executed, (DELAY + 90) * 1000);
  check("A5", "Al acabar la cuenta atrás, el guardián la completa solo", !!executed, `ejecutada: ${executed ? "sí" : "no"} · ${hashscan}/schedule/${w1.scheduleId}`);

  // ---- 6. bloqueo -------------------------------------------------------------------------------
  console.log("── Retirada que se bloquea");
  const w2 = await requestWithdrawal({ client: pocketClient, vaultId, notaryId, to: funderId, tinybars: 2n * HBAR, delaySeconds: DELAY });
  const veto = await callNotary({ client: pocketClient, notaryId, scheduleId: w2.scheduleId, fn: "veto" });
  console.log(`   veto ${veto.status} · esperando ${DELAY + 30} s para confirmar que no sale…`);
  await sleep((DELAY + 30) * 1000);
  const s2 = await mirror.schedule(w2.scheduleId.toString());
  check("A6", "La retirada bloqueada no sale aunque pase la cuenta atrás", veto.ok && s2 && !s2.executed, `veto ${veto.status}; ejecutada: ${s2?.executed ? "SÍ" : "no"}`);

  // ---- 7. quórum ---------------------------------------------------------------------------------
  let rejected = "";
  try {
    await requestWithdrawal({ client: funder, vaultId, notaryId, to: funderId, tinybars: HBAR, delaySeconds: DELAY });
  } catch (e) {
    rejected = e instanceof WalletError ? e.message : String(e);
  }
  check("A7", "Otra cuenta no puede anunciar retiradas de tu bóveda", /NotQuorum/.test(rejected), rejected || "¡la aceptó!");

  // ---- 8. rescate --------------------------------------------------------------------------------
  console.log("── Rescate con el kit");
  const before = (await mirror.account(vaultId.toString())).balance;
  const fresh = createClient(NETWORK, null);
  const restored = await (await Mnemonic.fromString(mnemonic.toString())).toStandardEd25519PrivateKey("", 0);
  const rescued = await rescueVault({ client: fresh, mirror, vaultId, rescueKey: restored, to: funderId }).catch((e) => ({ error: e.message }));
  fresh.close();
  check("A8", "Con las 24 palabras se vacía la bóveda al momento, sin la cartera", !rescued.error, rescued.error ?? `${formatHbar(rescued.tinybars)} HBAR de ${formatHbar(before)} · ${hashscan}/account/${vaultId}`);
} catch (e) {
  console.log(`\n⛔ Interrumpida: ${e instanceof Error ? e.message : String(e)}`);
  checks.push({ id: "abort", pass: false });
}

// ---- devolver lo que sobre ----------------------------------------------------------------------
console.log("\n── Devolviendo el saldo sobrante");
for (const [label, id, key] of [["cartera", pocketId, pocketKey], ["bóveda", vaultId, rescueKey]]) {
  if (!id || !key) continue;
  try {
    // El mirror node tarda unos segundos en reflejar el rescate: si el saldo que da ya no es real,
    // la red responde INSUFFICIENT_PAYER_BALANCE; entonces esperamos y volvemos a leerlo.
    let result = "";
    for (let attempt = 0; attempt < 4 && !result; attempt++) {
      if (attempt) await sleep(5000);
      const acc = await mirror.account(id.toString());
      const amount = (acc?.balance ?? 0n) - HBAR / 20n;
      if (amount <= 0n) {
        result = "nada que devolver";
        break;
      }
      const c = createClient(NETWORK, null);
      const tx = new TransferTransaction()
        .addHbarTransfer(id, Hbar.fromTinybars((-amount).toString()))
        .addHbarTransfer(funderId, Hbar.fromTinybars(amount.toString()))
        .setTransactionId(TransactionId.generate(id));
      const r = await submit(c, tx, [key]);
      c.close();
      if (r.ok) result = `${formatHbar(amount)} HBAR devueltos`;
      else if (r.status !== "INSUFFICIENT_PAYER_BALANCE" || attempt === 3) result = r.status;
    }
    console.log(`   ${label}: ${result}`);
  } catch (e) {
    console.log(`   ${label}: no se pudo (${e instanceof Error ? e.message : e})`);
  }
}
pocketClient?.close();
await sleep(5000);
const end = (await mirror.account(funderId.toString()))?.balance ?? startBalance;
const failed = checks.filter((c) => !c.pass);
console.log(`\n══ ${checks.length - failed.length}/${checks.length} comprobaciones correctas · coste ${formatHbar(startBalance - end)} HBAR de prueba`);
funder.close();
process.exit(failed.length ? 1 : 0);
