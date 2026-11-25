// CONTRASEÑA DE DESEMPATE (notario v3) en testnet REAL.
//
//   Escenario: un ladrón tiene la llave del móvil; el dueño tiene el kit y la contraseña.
//   P1. La bóveda nace con notario v3 y la dirección de la contraseña dentro.
//   P2. El ladrón pide una retirada a su cuenta y congela las recuperaciones.
//   P3. Con el kit pero la contraseña equivocada, el notario la rechaza.
//   P4. Con la contraseña buena, la recuperación prioritaria entra aunque las recuperaciones estén congeladas.
//   P5. El ladrón no puede bloquearla, congelar otra vez no la anula y no puede pedir más retiradas.
//   P6. El guardián la completa al acabar la cuenta atrás: el dinero llega al dueño y la retirada del ladrón no sale.
//
//   Con el guardián en marcha:
//     npm run desempate:red
//
// Paga la cuenta de guardian/.env (hacen falta unos 55 HBAR de testnet; casi todo vuelve). Al final
// devuelve lo que sobre y escribe informe-desempate.md. Opcionales: DESEMPATE_RETIRADA (s, 60), GUARDIAN_URL.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { AccountCreateTransaction, Hbar, Mnemonic, PrivateKey } from "@hiero-ledger/sdk";
import { accountsOfKey, sweepAccounts } from "./helpers/limpieza.mjs";
import {
  CHAIN_IDS,
  HBAR,
  Lane,
  Mirror,
  NETWORKS,
  callNotary2,
  createClient,
  evacuateVault,
  formatHbar,
  loadVaultActivity,
  normalizePassword,
  notary2Config,
  nowSeconds,
  parsePrivateKey,
  requestPriorityRecoveryV3,
  requestWithdrawalV2,
  setupVaultV2,
  signRegistration,
  submit,
  suggestPassphrase,
  tiebreakerAddress,
  tiebreakerKey,
} from "@boveda/core";

// ---- configuración ------------------------------------------------------------------------------
const env = Object.fromEntries(
  (existsSync("guardian/.env") ? readFileSync("guardian/.env", "utf8") : "")
    .split("\n")
    .map((l) => l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const NETWORK = (process.env.HEDERA_NETWORK ?? env.HEDERA_NETWORK ?? "testnet").toLowerCase();
if (!["testnet", "previewnet", "local"].includes(NETWORK)) throw new Error("Este programa solo corre en testnet, previewnet o local.");
const W = Number(process.env.DESEMPATE_RETIRADA ?? 60);
const R = W * 2;
const GUARDIAN_URL = (process.env.GUARDIAN_URL ?? `http://127.0.0.1:${env.PORT ?? 8787}`).replace(/\/$/, "");
const keyText = process.env.OPERATOR_KEY ?? env.OPERATOR_KEY;
if (!keyText) throw new Error("Falta OPERATOR_KEY en guardian/.env");
const NEEDED_HBAR = NETWORK === "local" ? 0n : 55n;
const VAULT_HBAR = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hb = (n) => BigInt(Math.round(n * 1e8));
const mirror = new Mirror(process.env.MIRROR_URL ?? NETWORKS[NETWORK].mirror);
const hashscan = NETWORKS[NETWORK].hashscan;
const link = (kind, id) => (hashscan ? `${hashscan}/${kind}/${id}` : `${kind} ${id}`);

const funderKey = parsePrivateKey(keyText, process.env.OPERATOR_KEY_TYPE ?? env.OPERATOR_KEY_TYPE);
const funderIdText = process.env.OPERATOR_ID ?? env.OPERATOR_ID;
const funderAcc = funderIdText ? await mirror.account(funderIdText) : await mirror.account(`0x${funderKey.publicKey.toEvmAddress()}`);
if (!funderAcc) throw new Error("No encuentro la cuenta de guardian/.env en la red");
const funderId = funderAcc.id;
const funder = createClient(NETWORK, { accountId: funderId, key: funderKey });
console.log(`Red ${NETWORK} · paga ${funderId} (${formatHbar(funderAcc.balance)} HBAR) · cuenta atrás ${W} s / ${R} s · guardián ${GUARDIAN_URL}\n`);
if (funderAcc.balance < NEEDED_HBAR * HBAR) {
  console.log(`⛔ Hacen falta unos ${NEEDED_HBAR} HBAR de testnet. Recarga ${funderAcc.evmAddress} en ${NETWORKS[NETWORK].faucet}`);
  process.exit(1);
}
const guardianInfo = await fetch(`${GUARDIAN_URL}/info`)
  .then((r) => r.json())
  .catch(() => null);
if (!guardianInfo?.evmAddress) {
  console.log(`⛔ El guardián no responde en ${GUARDIAN_URL}. Arráncalo (hvault-vps arrancar) y vuelve a probar.`);
  process.exit(1);
}
console.log(`Guardián ${guardianInfo.version} · cuenta ${guardianInfo.account}`);
if (NETWORK !== "local" && !/^0\.(7|8|9|\d{2,})\./.test(String(guardianInfo.version))) {
  console.log("⚠️  Este guardián es anterior a la 0.7.0: no conoce las recuperaciones prioritarias. Actualiza antes de seguir.");
}

// ---- registro de resultados -----------------------------------------------------------------------
/** @type {{ id: string, title: string, pass: boolean, detail: string }[]} */
const results = [];
const check = (id, title, pass, detail) => {
  results.push({ id, title, pass, detail });
  console.log(`${pass ? "✅" : "❌"} ${id}  ${title}\n      ${detail}`);
};
const info = (t) => console.log(`   ${t}`);
const waitFor = async (fn, ms, every = 3000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every);
  }
};
const balance = async (id) => (await mirror.account(id.toString()))?.balance ?? 0n;
const clients = [];
const clientFor = (id, key) => {
  const c = createClient(NETWORK, { accountId: id, key });
  clients.push(c);
  return c;
};
/** @type {{ id: import("@hiero-ledger/sdk").AccountId, key: PrivateKey }[]} */
const scratch = [];
async function newAccount(label, key, hbar, { alias = false } = {}) {
  const tx = new AccountCreateTransaction().setInitialBalance(Hbar.fromTinybars(hb(hbar).toString())).setAccountMemo(`desempate · ${label}`);
  if (alias) tx.setECDSAKeyWithAlias(key.publicKey);
  else tx.setKeyWithoutAlias(key.publicKey);
  const out = await submit(funder, tx, alias ? [key] : []);
  if (!out.ok || !out.receipt?.accountId) throw new Error(`no se pudo crear ${label}: ${out.status}`);
  scratch.push({ id: out.receipt.accountId, key });
  return out.receipt.accountId;
}
const errText = (e) => (e instanceof Error ? e.message : String(e));

// ---- la prueba --------------------------------------------------------------------------------------
let V = null;
/** Llave del kit: si la preparación se para a medias, su cuenta se busca con ella para vaciarla. */
let kitKey = null;
try {
  console.log("\n── Preparación: bóveda con contraseña de desempate");
  const password = suggestPassphrase("es", 5);
  const pocketKey = PrivateKey.generateECDSA();
  const pocketId = await newAccount("cartera", pocketKey, VAULT_HBAR + 40, { alias: true });
  const pocketEvm = `0x${pocketKey.publicKey.toEvmAddress()}`.toLowerCase();
  await waitFor(() => mirror.account(pocketEvm), 60_000);
  const device = clientFor(pocketId, pocketKey);
  const rescueKey = await (await Mnemonic.generate()).toStandardEd25519PrivateKey("", 0);
  kitKey = rescueKey;
  const t0 = Date.now();
  const tbKey = await tiebreakerKey(password, rescueKey.publicKey);
  info(`llave de la contraseña derivada en ${Date.now() - t0} ms`);
  const { notaryId, vaultId, rescueAccountId } = await setupVaultV2({
    client: device,
    mirror,
    pocket: { evmAddress: pocketEvm, publicKey: pocketKey.publicKey },
    rescuePublicKey: rescueKey.publicKey,
    guardianEvm: guardianInfo.evmAddress,
    withdrawDelay: W,
    recoveryDelay: R,
    initialTinybars: hb(VAULT_HBAR),
    tiebreaker: tiebreakerAddress(tbKey),
  });
  scratch.push({ id: rescueAccountId, key: rescueKey });
  const kit = clientFor(rescueAccountId, rescueKey);
  V = { device, rescueKey, vaultId };
  await waitFor(() => mirror.account(vaultId.toString()), 60_000);
  info(`bóveda ${link("account", vaultId)} · notario ${link("contract", notaryId)}`);
  const reg = signRegistration(pocketKey, { vaultId: vaultId.toString(), notaryId: notaryId.toString(), pocketId: pocketId.toString(), pushToken: null, timestamp: nowSeconds() });
  let res = null;
  for (let i = 0; i < 6 && res?.status !== 200; i++) {
    res = await fetch(`${GUARDIAN_URL}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(reg) });
    if (res.status !== 200) await sleep(5000);
  }
  if (res?.status !== 200) throw new Error(`el guardián no registró la bóveda: ${await res?.text()}`);
  info("registrada en el guardián");

  const cfg = await waitFor(async () => {
    const c = await notary2Config({ mirror, notaryId });
    return c.version === 3 ? c : null;
  }, 60_000);
  check("P1", "Notario v3 con la contraseña dentro", !!cfg && cfg.tiebreaker === tiebreakerAddress(tbKey), `versión ${cfg?.version ?? "?"} · desempate ${cfg?.tiebreaker ?? "ninguno"}`);

  const thiefId = await newAccount("ladrón", PrivateKey.generateED25519(), 1);
  const safeId = await newAccount("cuenta segura del dueño", PrivateKey.generateED25519(), 1);

  console.log("\n── El ladrón (llave del móvil) actúa");
  const robo = await requestWithdrawalV2({ client: device, vaultId, notaryId, to: thiefId, tinybars: hb(VAULT_HBAR), withdrawDelay: W });
  const fz = await callNotary2({ client: device, notaryId, call: "freeze", lane: Lane.Recovery });
  check("P2", "El ladrón pide su retirada y congela las recuperaciones", fz.ok, `retirada ${robo.scheduleId} · congelar: ${fz.ok ? "SUCCESS" : fz.reason || fz.status}`);

  console.log("\n── El dueño (kit + contraseña) responde");
  const wrong = await tiebreakerKey(`${password} extra`, rescueKey.publicKey);
  let rejected = "";
  try {
    await requestPriorityRecoveryV3({ client: kit, vaultId, notaryId, to: safeId, tinybars: hb(VAULT_HBAR), recoveryDelay: R, tiebreakerKey: wrong, chainId: CHAIN_IDS[NETWORK] });
  } catch (e) {
    rejected = errText(e);
  }
  check("P3", "Contraseña equivocada: el notario la rechaza", /contraseña de desempate/.test(rejected), rejected || "¡la aceptó!");

  // La misma contraseña escrita de otra forma (mayúsculas y espacios) da la misma llave.
  const typed = await tiebreakerKey(`  ${password.toUpperCase().replace(/ /g, "   ")} `, rescueKey.publicKey);
  info(`escrita de otra forma: ${normalizePassword(password) === normalizePassword(password.toUpperCase()) && tiebreakerAddress(typed) === tiebreakerAddress(tbKey) ? "misma llave" : "¡otra llave!"}`);
  let prio = null;
  let prioErr = "";
  try {
    prio = await requestPriorityRecoveryV3({ client: kit, vaultId, notaryId, to: safeId, tinybars: hb(VAULT_HBAR), recoveryDelay: R, tiebreakerKey: typed, chainId: CHAIN_IDS[NETWORK] });
  } catch (e) {
    prioErr = errText(e);
  }
  check("P4", "Con la contraseña buena entra, aunque las recuperaciones estén congeladas", !!prio, prio ? `recuperación prioritaria ${prio.scheduleId}` : prioErr);
  if (!prio) throw new Error("sin recuperación prioritaria no se puede seguir");

  console.log("\n── El ladrón intenta pararla");
  const veto = await callNotary2({ client: device, notaryId, call: "veto", schedule: prio.scheduleId });
  const fz2 = await callNotary2({ client: device, notaryId, call: "freeze", lane: Lane.Recovery });
  let again = "";
  try {
    await requestWithdrawalV2({ client: device, vaultId, notaryId, to: thiefId, tinybars: hb(1), withdrawDelay: W });
    again = "¡la aceptó!";
  } catch (e) {
    again = errText(e);
  }
  await sleep(NETWORK === "local" ? 1500 : 8000);
  const act = await loadVaultActivity({ mirror, notaryId: notaryId.toString() });
  const mine = act.items.find((m) => m.scheduleId === prio.scheduleId.toString());
  check(
    "P5",
    "No puede bloquearla, congelar no la anula y no puede pedir más retiradas",
    !veto.ok && mine?.status === "requested" && mine?.priority === true && again !== "¡la aceptó!",
    `bloquear: ${veto.ok ? "¡SUCCESS!" : veto.reason || veto.status} · congelar otra vez: ${fz2.ok ? "SUCCESS (no la anula)" : fz2.reason} · estado: ${mine?.status ?? "?"}${mine?.priority ? " (prioritaria)" : ""} · nueva retirada: ${again}`,
  );

  console.log(`\n── Esperando a que acabe la cuenta atrás (${R} s) y la complete el guardián`);
  const done = await waitFor(async () => (await mirror.schedule(prio.scheduleId.toString()))?.executed, (R + 120) * 1000, 5000);
  const got = await balance(safeId);
  const robbed = await mirror.schedule(robo.scheduleId.toString());
  check(
    "P6",
    "El guardián la completa: el dinero llega al dueño y la retirada del ladrón no sale",
    !!done && got >= hb(VAULT_HBAR) && !robbed?.executed,
    `cuenta segura: ${formatHbar(got)} HBAR · retirada del ladrón ejecutada: ${robbed?.executed ? "¡SÍ!" : "no"}`,
  );
} catch (e) {
  console.log(`\n⛔ Se ha parado: ${errText(e)}`);
  results.push({ id: "—", title: "El programa se paró", pass: false, detail: errText(e) });
} finally {
  console.log("\n── Limpieza: lo que sobra vuelve a la cuenta que paga");
  if (V) {
    try {
      if ((await balance(V.vaultId)) > 0n) await evacuateVault({ client: V.device, mirror, vaultId: V.vaultId, to: funderId, rescueKey: V.rescueKey });
    } catch {
      // ya vacía
    }
  }
  if (kitKey && !scratch.some((s) => s.key === kitKey)) {
    for (const id of await accountsOfKey({ mirror, publicKey: kitKey.publicKey })) scratch.push({ id, key: kitKey });
  }
  const emptied = await sweepAccounts({ clientFor, mirror, accounts: scratch, to: funderId, log: info });
  info(`cuentas de prueba vaciadas: ${emptied}`);
  await sleep(NETWORK === "local" ? 500 : 5000);
  const end = await balance(funderId);
  info(`la cuenta que paga termina con ${formatHbar(end)} HBAR (gastado ${formatHbar(funderAcc.balance - end)})`);
  const lines = [
    `# Contraseña de desempate en ${NETWORK} · ${new Date().toISOString()}`,
    "",
    `Guardián ${guardianInfo.version} (${guardianInfo.account}) · cuentas atrás ${W} s / ${R} s`,
    "",
    "| | Prueba | Resultado | Detalle |",
    "| --- | --- | --- | --- |",
    ...results.map((r) => `| ${r.id} | ${r.title} | ${r.pass ? "✅" : "❌"} | ${r.detail.replace(/\|/g, "/")} |`),
  ];
  writeFileSync("informe-desempate.md", lines.join("\n") + "\n");
  console.log(`\n${results.filter((r) => r.pass).length}/${results.length} correctas · informe en informe-desempate.md`);
  for (const c of clients) c.close();
  funder.close();
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}
