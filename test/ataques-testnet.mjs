// PROGRAMA DE ATAQUES contra la bóveda v2 en testnet REAL.
//
// Crea una bóveda v2 de prueba y hace de ladrón con cada llave filtrada:
//   A. sin ninguna llave (un desconocido)
//   B. con el kit de rescate (las 24 palabras filtradas)
//   C. con la llave del móvil (malware o móvil robado)
//   D. con la llave del guardián (servidor hackeado)
// y prueba todas las vías conocidas para sacar el dinero: transferencia directa, cambio de llave,
// borrado de la cuenta, permisos de gasto, anunciar por el carril que no le toca, adelantar la
// cuenta atrás, llamar al Schedule Service directamente o desde un contrato trampa, borrar o
// cambiar el notario… Comprueba también que el dueño SÍ puede usar su dinero: retirada normal,
// recuperación con el kit y evacuación inmediata con las dos llaves.
//
//   npm run ataques          (usa la cuenta de guardian/.env para pagar; no hace falta el guardián)
//
// Variables opcionales: ATAQUE_RETIRADA (s, 30 por defecto), ATAQUE_RECUPERACION (s, 60).
// Al final devuelve lo que sobre a la cuenta que paga y escribe informe-ataques.md.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  AccountAllowanceApproveTransaction,
  AccountCreateTransaction,
  AccountDeleteTransaction,
  AccountId,
  AccountUpdateTransaction,
  ContractCreateTransaction,
  ContractDeleteTransaction,
  ContractExecuteTransaction,
  ContractId,
  ContractUpdateTransaction,
  Hbar,
  Mnemonic,
  PrivateKey,
  TransactionId,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { Interface, getBytes } from "ethers";
import {
  HBAR,
  Lane,
  Mirror,
  NETWORKS,
  callNotary2,
  contractAddress,
  createClient,
  createVaultV2,
  deployNotary2,
  encodeNotary2,
  formatHbar,
  notary2Abi,
  nowSeconds,
  parsePrivateKey,
  scheduleAddress,
  scheduleVaultTransfer,
  submit,
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
const W = Number(process.env.ATAQUE_RETIRADA ?? 30); // cuenta atrás de retirada (s)
const R = Number(process.env.ATAQUE_RECUPERACION ?? 60); // cuenta atrás de recuperación (s)
if (!(W > 0 && R >= W)) throw new Error("ATAQUE_RECUPERACION debe ser mayor o igual que ATAQUE_RETIRADA");
const keyText = process.env.OPERATOR_KEY ?? env.OPERATOR_KEY;
if (!keyText) throw new Error("Falta OPERATOR_KEY en guardian/.env");
const NEEDED_HBAR = NETWORK === "local" ? 0n : 80n;

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
const startBalance = funderAcc.balance;
console.log(`Red ${NETWORK} · paga y hace de guardián ${funderId} (${formatHbar(startBalance)} HBAR)`);
console.log(`Cuenta atrás de retirada ${W} s · de recuperación ${R} s\n`);
if (startBalance < NEEDED_HBAR * HBAR) {
  console.log(`⛔ Hacen falta unos ${NEEDED_HBAR} HBAR de testnet y la cuenta tiene ${formatHbar(startBalance)}.`);
  console.log(`   Recárgala en ${NETWORKS[NETWORK].faucet} pegando esta dirección: ${funderAcc.evmAddress}`);
  process.exit(1);
}

// ---- registro de resultados -----------------------------------------------------------------------
/** @type {{ group: string, id: string, title: string, pass: boolean, detail: string }[]} */
const results = [];
let group = "";
const section = (title) => {
  group = title;
  console.log(`\n── ${title}`);
};
const check = (id, title, pass, detail) => {
  results.push({ group, id, title, pass, detail });
  console.log(`${pass ? "✅" : "❌"} ${id}  ${title}\n      ${detail}`);
};
const info = (text) => console.log(`   ${text}`);
const statusText = (out) => `${out.status}${out.reason ? ` · ${out.reason}` : ""}`;
/**
 * Ataque bloqueado: la red o el notario rechazan la operación POR EL MOTIVO ESPERADO (un fallo por
 * otra causa, p. ej. falta de saldo del ladrón, no cuenta como bloqueo).
 */
const blocked = (id, title, out, reason, statuses) => {
  const pass = !out.ok && (!reason || (out.reason ?? "").startsWith(reason)) && (!statuses || statuses.includes(out.status));
  check(id, title, pass, out.ok ? "¡la red la aceptó!" : statusText(out));
};

const waitFor = async (fn, ms) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(2500);
  }
};
const untilTime = async (unixSeconds, label) => {
  const wait = unixSeconds - nowSeconds();
  if (wait > 0) {
    info(`esperando ${wait} s (${label})…`);
    await sleep(wait * 1000);
  }
};
/** Saldo estable según el mirror node (dos lecturas seguidas iguales). */
const stableBalance = async (id) => {
  let prev = -1n;
  for (let i = 0; i < 12; i++) {
    const b = (await mirror.account(id.toString()))?.balance ?? 0n;
    if (b === prev) return b;
    prev = b;
    await sleep(3000);
  }
  return prev;
};
const executed = async (scheduleId) => {
  await sleep(4000); // margen para que el mirror node vea una posible ejecución
  return Boolean((await mirror.schedule(scheduleId.toString()))?.executed);
};

// ---- montaje ------------------------------------------------------------------------------------
const created = { accounts: /** @type {{ label: string, id: AccountId, key: PrivateKey }[]} */ ([]) };
const clients = [];
const clientFor = (id, key) => {
  const c = createClient(NETWORK, { accountId: id, key });
  clients.push(c);
  return c;
};
/** @param {string} label @param {PrivateKey} key @param {number} hbar @param {{ alias?: boolean }} [o] */
async function newAccount(label, key, hbar, o = {}) {
  const tx = new AccountCreateTransaction().setInitialBalance(Hbar.fromTinybars(hb(hbar).toString())).setAccountMemo(`ataques · ${label}`);
  if (o.alias) tx.setECDSAKeyWithAlias(key.publicKey);
  else tx.setKeyWithoutAlias(key.publicKey);
  const out = await submit(funder, tx, o.alias ? [key] : []);
  if (!out.ok || !out.receipt?.accountId) throw new Error(`no se pudo crear la cuenta ${label}: ${out.status}`);
  created.accounts.push({ label, id: out.receipt.accountId, key });
  return out.receipt.accountId;
}

const deviceKey = PrivateKey.generateECDSA();
const mnemonic = await Mnemonic.generate();
const rescueKey = await mnemonic.toStandardEd25519PrivateKey("", 0);
const attackerKey = PrivateKey.generateED25519();
const safeKey = PrivateKey.generateED25519();
const VAULT_START = hb(10);
const L1_AMOUNT = hb(1);
const L2_AMOUNT = hb(2);
const hssIface = new Interface(["function authorizeSchedule(address schedule) returns (int64)"]);
const HSS_ID = ContractId.fromString("0.0.363");
const rogueArt = JSON.parse(readFileSync(new URL("./build/RogueCaller.json", import.meta.url), "utf8"));
const rogueIface = new Interface(rogueArt.abi);

let vaultId, notaryId, deviceId, rescueId, attackerId, safeId;
let device, rescue, attacker;
const guardian = funder;
const attackerSchedules = [];
let attackerStart = 0n;
let preEvacuation = null;
let evacuated = false;

try {
  section("Montaje: cartera, kit, ladrón, cuenta segura, notario v2 y bóveda");
  deviceId = await newAccount("móvil", deviceKey, 5, { alias: true });
  rescueId = await newAccount("kit de rescate", rescueKey, 6);
  attackerId = await newAccount("ladrón", attackerKey, 4);
  safeId = await newAccount("cuenta segura del dueño", safeKey, 0.1);
  const deviceEvm = `0x${deviceKey.publicKey.toEvmAddress()}`.toLowerCase();
  const rescueEvm = `0x${rescueId.toEvmAddress()}`.toLowerCase();
  info(`móvil ${deviceId} · kit ${rescueId} · ladrón ${attackerId} · cuenta segura ${safeId}`);
  await waitFor(() => mirror.account(deviceEvm), 60_000);

  notaryId = await deployNotary2({
    client: funder,
    mirror,
    from: funderAcc.evmAddress,
    device: deviceEvm,
    rescue: rescueEvm,
    guardian: funderAcc.evmAddress,
    withdrawDelay: W,
    recoveryDelay: R,
  });
  const notaryEvm = contractAddress(notaryId);
  ({ vaultId } = await createVaultV2({ client: funder, deviceKey: deviceKey.publicKey, rescueKey: rescueKey.publicKey, notaryId, initialTinybars: VAULT_START }));
  info(`notario ${notaryId} · bóveda ${vaultId} con ${formatHbar(VAULT_START)} HBAR · ${link("account", vaultId)}`);
  device = clientFor(deviceId, deviceKey);
  rescue = clientFor(rescueId, rescueKey);
  attacker = clientFor(attackerId, attackerKey);
  await waitFor(() => mirror.account(vaultId.toString()), 60_000);
  attackerStart = await stableBalance(attackerId);

  /** Lee el estado efectivo de una petición en el notario (simulación gratuita). */
  const statusOf = async (sid) => {
    const r = await mirror.simulate({ to: notaryEvm, data: encodeNotary2("statusOf", sid), gas: 50_000 });
    return r.ok ? Number(notary2Abi.decodeFunctionResult("statusOf", r.result)[0]) : -1;
  };
  /** Espera a que el mirror node refleje un estado concreto (tarda unos segundos tras cada operación). */
  const waitStatus = async (sid, wanted) => Boolean(await waitFor(async () => (await statusOf(sid)) === wanted, 25_000));
  const lockedUntil = async (lane) => {
    const r = await mirror.simulate({ to: notaryEvm, data: notary2Abi.encodeFunctionData("lockedUntil", [lane]), gas: 50_000 });
    return r.ok ? Number(notary2Abi.decodeFunctionResult("lockedUntil", r.result)[0]) : nowSeconds() + R;
  };
  /** Llama a approve hasta que vence la cuenta atrás (o falla por otro motivo). */
  const approveWhenDue = async (sid, dueAt) => {
    await untilTime(dueAt + 3, "cuenta atrás");
    let out;
    for (let i = 0; i < 10; i++) {
      out = await callNotary2({ client: guardian, notaryId, call: "approve", schedule: sid });
      if (out.ok || !out.reason.startsWith("TooEarly")) return out;
      await sleep(3000);
    }
    return out;
  };
  const schedule = async (client, to, amount, lifetime, memo) => {
    const s = await scheduleVaultTransfer({ client, vaultId, to, tinybars: amount, lifetimeSeconds: lifetime, memo });
    if (!s.ok || !s.scheduleId) throw new Error(`no se pudo programar «${memo}»: ${s.status}`);
    return s.scheduleId;
  };
  const steal = (client, signers = []) =>
    submit(client, new TransferTransaction().addHbarTransfer(vaultId, Hbar.fromTinybars((-VAULT_START / 2n).toString())).addHbarTransfer(attackerId, Hbar.fromTinybars((VAULT_START / 2n).toString())), signers);
  const takeOver = (client, signers = []) => submit(client, new AccountUpdateTransaction().setAccountId(vaultId).setKey(attackerKey.publicKey), [attackerKey, ...signers]);
  const destroy = (client, signers = []) => submit(client, new AccountDeleteTransaction().setAccountId(vaultId).setTransferAccountId(attackerId), signers);
  const allowance = (client, signers = []) =>
    submit(client, new AccountAllowanceApproveTransaction().approveHbarAllowance(vaultId, attackerId, Hbar.fromTinybars(VAULT_START.toString())), signers);
  /** Las cuatro vías directas con las llaves que tenga el ladrón. */
  const directAttacks = async (prefix, who, client, signers = []) => {
    const sig = ["INVALID_SIGNATURE"];
    blocked(`${prefix}1`, `${who}: transferencia directa desde la bóveda`, await steal(client, signers), "", sig);
    blocked(`${prefix}2`, `${who}: cambiar la llave de la bóveda por la suya`, await takeOver(client, signers), "", sig);
    blocked(`${prefix}3`, `${who}: borrar la bóveda enviando el saldo a su cuenta`, await destroy(client, signers), "", sig);
    blocked(`${prefix}4`, `${who}: darse permiso de gasto sobre la bóveda`, await allowance(client, signers), "", [...sig, "INVALID_ALLOWANCE_OWNER_ID"]);
  };

  // ---- 1. retirada legítima (corre la cuenta atrás mientras se atacan otras cosas) -----------------
  section("Dueño: retirada normal con el móvil");
  const sL1 = await schedule(device, safeId, L1_AMOUNT, W, "L1 retirada del dueño");
  const reqL1 = await callNotary2({ client: device, notaryId, call: "request", schedule: sL1 });
  if (!reqL1.ok) throw new Error(`el notario no aceptó la retirada del dueño: ${statusText(reqL1)}`);
  const dueL1 = nowSeconds() + W;
  info(`retirada ${sL1} anunciada; sale en ${W} s`);
  blocked("A9", "Desconocido: adelantar la retirada del dueño", await callNotary2({ client: attacker, notaryId, call: "approve", schedule: sL1 }), "TooEarly");
  blocked("D7", "Guardián: adelantar la retirada del dueño", await callNotary2({ client: guardian, notaryId, call: "approve", schedule: sL1 }), "TooEarly");

  // ---- 2. un desconocido -------------------------------------------------------------------------
  section("A. Un desconocido, sin ninguna llave");
  await directAttacks("A", "Desconocido", attacker);
  blocked("A5", "Desconocido: anunciar una retirada", await callNotary2({ client: attacker, notaryId, call: "request", schedule: sL1 }), "NotDevice");
  blocked("A6", "Desconocido: anunciar una recuperación", await callNotary2({ client: attacker, notaryId, call: "requestRecovery", schedule: sL1 }), "NotRescue");
  blocked("A7", "Desconocido: bloquear la retirada del dueño", await callNotary2({ client: attacker, notaryId, call: "veto", schedule: sL1 }), "NotAllowed");
  blocked("A8", "Desconocido: congelar el carril de retirada", await callNotary2({ client: attacker, notaryId, call: "freeze", lane: Lane.Withdraw }), "NotAllowed");
  const sA = await schedule(attacker, attackerId, VAULT_START / 2n, W, "A10 ladrón sin llaves");
  attackerSchedules.push(sA);
  blocked("A10", "Desconocido: aprobar una transacción suya que nadie anunció", await callNotary2({ client: attacker, notaryId, call: "approve", schedule: sA }), "BadStatus");
  const immutable = ["MODIFYING_IMMUTABLE_CONTRACT", "INVALID_SIGNATURE"];
  blocked("A11", "Desconocido: borrar el notario", await submit(attacker, new ContractDeleteTransaction().setContractId(notaryId).setTransferAccountId(attackerId)), "", immutable);
  blocked("A12", "Desconocido: modificar el notario", await submit(attacker, new ContractUpdateTransaction().setContractId(notaryId).setContractMemo("hackeado")), "", immutable);

  // ---- 3. el guardián (servidor hackeado) ----------------------------------------------------------
  section("D. Con la llave del guardián (servidor hackeado)");
  await directAttacks("D", "Guardián", guardian);
  blocked("D5", "Guardián: anunciar una retirada", await callNotary2({ client: guardian, notaryId, call: "request", schedule: sA }), "NotDevice");
  blocked("D6", "Guardián: anunciar una recuperación", await callNotary2({ client: guardian, notaryId, call: "requestRecovery", schedule: sA }), "NotRescue");

  // ---- 4. el kit filtrado: vías instantáneas -------------------------------------------------------
  section("B. Con el kit de rescate filtrado (las 24 palabras)");
  await directAttacks("B", "Kit", rescue);
  blocked("B5", "Kit: anunciar por el carril rápido (el del móvil)", await callNotary2({ client: rescue, notaryId, call: "request", schedule: sA }), "NotDevice");
  const sB = await schedule(rescue, attackerId, VAULT_START / 2n, R, "B ladrón con el kit");
  attackerSchedules.push(sB);
  const hss = await submit(
    rescue,
    new ContractExecuteTransaction().setContractId(HSS_ID).setGas(120_000).setFunctionParameters(getBytes(hssIface.encodeFunctionData("authorizeSchedule", [scheduleAddress(sB)]))).setMaxTransactionFee(new Hbar(2)),
  );
  check("B6", "Kit: pedir la firma directamente al Schedule Service de Hedera", !(await executed(sB)), `${hss.status}; la transacción del ladrón no se ejecutó`);

  info("desplegando el contrato trampa (≈ 1 $ de testnet)…");
  const rogueOut = await submit(funder, new ContractCreateTransaction().setBytecode(getBytes(rogueArt.bytecode)).setGas(800_000).setMaxTransactionFee(new Hbar(40)));
  if (rogueOut.ok && rogueOut.receipt?.contractId) {
    const rogueId = rogueOut.receipt.contractId;
    const callRogue = (fn, args) =>
      submit(rescue, new ContractExecuteTransaction().setContractId(rogueId).setGas(400_000).setFunctionParameters(getBytes(rogueIface.encodeFunctionData(fn, args))).setMaxTransactionFee(new Hbar(3)));
    const r1 = await callRogue("authorizeDirect", [scheduleAddress(sB)]);
    check("B7", "Kit: contrato trampa que llama él al Schedule Service", !(await executed(sB)), `${r1.status}; quien firma es la trampa (${rogueId}), no el notario`);
    const r2 = await callRogue("forgeAndApprove", [notaryEvm, scheduleAddress(sB)]);
    check("B8", "Kit: contrato trampa que ejecuta el código del notario (delegatecall) con un estado falso", !(await executed(sB)), `${r2.status}; la transacción del ladrón no se ejecutó`);
  } else {
    check("B7", "Kit: contrato trampa (no se pudo desplegar)", false, rogueOut.status);
  }

  // ---- 5. el kit filtrado: la cuenta atrás y la reacción del dueño ----------------------------------
  const reqB = await callNotary2({ client: rescue, notaryId, call: "requestRecovery", schedule: sB });
  check("B9", "Kit: anuncia una recuperación hacia su cuenta (se puede, pero tarda y se ve)", reqB.ok, reqB.ok ? `cuenta atrás de ${R} s en marcha · aviso al dueño` : statusText(reqB));
  const dueB = nowSeconds() + R;
  blocked("B10", "Kit: adelantar su recuperación", await callNotary2({ client: rescue, notaryId, call: "approve", schedule: sB }), "TooEarly");
  const frozeR = await callNotary2({ client: device, notaryId, call: "freeze", lane: Lane.Recovery });
  check("B11", "Dueño (móvil): congela el carril de recuperación con un toque", frozeR.ok && (await waitStatus(sB, 2)), frozeR.ok ? "la recuperación del ladrón queda anulada" : statusText(frozeR));
  const sB2 = await schedule(rescue, attackerId, VAULT_START / 2n, R, "B12 segundo intento con el kit");
  attackerSchedules.push(sB2);
  blocked("B12", "Kit: volver a intentarlo con el carril congelado", await callNotary2({ client: rescue, notaryId, call: "requestRecovery", schedule: sB2 }), "LaneLocked");

  // La retirada del dueño sigue su curso aunque haya ataques en marcha.
  section("Dueño: la retirada normal sale a su hora");
  const okL1 = await approveWhenDue(sL1, dueL1);
  check("L1", "Retirada normal del dueño completada tras la cuenta atrás", okL1.ok && (await waitFor(async () => (await mirror.schedule(sL1.toString()))?.executed, 30_000)), okL1.ok ? `${formatHbar(L1_AMOUNT)} HBAR a la cuenta segura` : statusText(okL1));

  // ---- 6. el móvil filtrado -------------------------------------------------------------------------
  section("C. Con la llave del móvil (malware o móvil robado)");
  await directAttacks("C", "Móvil", device);
  blocked("C5", "Móvil: anunciar por el carril del kit", await callNotary2({ client: device, notaryId, call: "requestRecovery", schedule: sB2 }), "NotRescue");
  const sC = await schedule(device, attackerId, VAULT_START / 2n, W, "C ladrón con el móvil");
  attackerSchedules.push(sC);
  const reqC = await callNotary2({ client: device, notaryId, call: "request", schedule: sC });
  check("C6", "Móvil: anuncia una retirada hacia su cuenta (se puede, pero tarda y se ve)", reqC.ok, reqC.ok ? `cuenta atrás de ${W} s en marcha · aviso al dueño` : statusText(reqC));
  const dueC = nowSeconds() + W;
  blocked("C7", "Móvil: adelantar su retirada", await callNotary2({ client: device, notaryId, call: "approve", schedule: sC }), "TooEarly");
  const vetoC = await callNotary2({ client: guardian, notaryId, call: "veto", schedule: sC });
  check("C8", "Guardián: bloquea la retirada que el dueño no reconoce", vetoC.ok, vetoC.ok ? "bloqueada" : statusText(vetoC));
  const sC2 = await schedule(device, attackerId, VAULT_START / 2n, W, "C9 segundo intento con el móvil");
  attackerSchedules.push(sC2);
  const reqC2 = await callNotary2({ client: device, notaryId, call: "request", schedule: sC2 });
  const frozeW = await callNotary2({ client: rescue, notaryId, call: "freeze", lane: Lane.Withdraw });
  check("C9", "Dueño (kit): congela el carril de retirada y anula el segundo intento", reqC2.ok && frozeW.ok && (await waitStatus(sC2, 2)), frozeW.ok ? "anulado; el carril queda cerrado un tiempo" : statusText(frozeW));
  const sC3 = await schedule(device, attackerId, VAULT_START / 2n, W, "C10 tercer intento con el móvil");
  attackerSchedules.push(sC3);
  blocked("C10", "Móvil: volver a intentarlo con el carril congelado", await callNotary2({ client: device, notaryId, call: "request", schedule: sC3 }), "LaneLocked");

  // ---- 7. pasados los plazos, nada de lo bloqueado sale -------------------------------------------------
  section("Pasados los plazos: lo bloqueado no sale nunca");
  await untilTime(Math.max(dueC, dueB) + 3, "a que venzan las cuentas atrás del ladrón");
  blocked("X1", "Ladrón con el móvil: completar su retirada bloqueada", await callNotary2({ client: device, notaryId, call: "approve", schedule: sC }), "BadStatus");
  blocked("X2", "Ladrón con el móvil: completar su retirada anulada por la congelación", await callNotary2({ client: device, notaryId, call: "approve", schedule: sC2 }), "Superseded");
  blocked("X3", "Ladrón con el kit: completar su recuperación anulada", await callNotary2({ client: rescue, notaryId, call: "approve", schedule: sB }), "Superseded");

  // ---- 8. recuperación legítima: el dueño perdió el móvil -----------------------------------------------
  section("Dueño sin móvil: recuperación con el kit");
  await untilTime((await lockedUntil(Lane.Recovery)) + 3, "a que se reabra el carril de recuperación");
  const sL2 = await schedule(rescue, safeId, L2_AMOUNT, R, "L2 recuperación del dueño");
  let reqL2 = await callNotary2({ client: rescue, notaryId, call: "requestRecovery", schedule: sL2 });
  for (let i = 0; i < 8 && !reqL2.ok && reqL2.reason.startsWith("LaneLocked"); i++) {
    await sleep(3000);
    reqL2 = await callNotary2({ client: rescue, notaryId, call: "requestRecovery", schedule: sL2 });
  }
  if (!reqL2.ok) throw new Error(`el notario no aceptó la recuperación del dueño: ${statusText(reqL2)}`);
  const dueL2 = nowSeconds() + R;
  blocked("D8", "Guardián: bloquear la recuperación del dueño", await callNotary2({ client: guardian, notaryId, call: "veto", schedule: sL2 }), "NotAllowed");
  blocked("D9", "Guardián: congelar el carril de recuperación", await callNotary2({ client: guardian, notaryId, call: "freeze", lane: Lane.Recovery }), "NotAllowed");
  blocked("D10", "Guardián: adelantar la recuperación", await callNotary2({ client: guardian, notaryId, call: "approve", schedule: sL2 }), "TooEarly");
  const okL2 = await approveWhenDue(sL2, dueL2);
  check("L2", "Recuperación con el kit completada tras su cuenta atrás", okL2.ok && (await waitFor(async () => (await mirror.schedule(sL2.toString()))?.executed, 30_000)), okL2.ok ? `${formatHbar(L2_AMOUNT)} HBAR a la cuenta segura` : statusText(okL2));

  // ---- 9. integridad y evacuación con las dos llaves -------------------------------------------------
  section("Resultado: ¿se ha movido algo que no debía?");
  const expected = VAULT_START - L1_AMOUNT - L2_AMOUNT;
  preEvacuation = await stableBalance(vaultId);
  check("F1", "La bóveda solo ha perdido lo de las dos operaciones legítimas", preEvacuation === expected, `saldo ${formatHbar(preEvacuation)} HBAR (esperado ${formatHbar(expected)})`);
  const stolen = [];
  for (const s of attackerSchedules) if ((await mirror.schedule(s.toString()))?.executed) stolen.push(s.toString());
  const attackerNow = await stableBalance(attackerId);
  check("F2", "El ladrón no ha recibido ni un tinybar de la bóveda", stolen.length === 0 && attackerNow <= attackerStart, `${attackerSchedules.length} transacciones del ladrón, ${stolen.length} ejecutadas · su saldo ${formatHbar(attackerStart)} → ${formatHbar(attackerNow)} HBAR`);

  section("Dueño con móvil y kit: evacuación inmediata");
  const evac = await submit(
    device,
    new TransferTransaction().addHbarTransfer(vaultId, Hbar.fromTinybars((-preEvacuation).toString())).addHbarTransfer(funderId, Hbar.fromTinybars(preEvacuation.toString())),
    [rescueKey],
  );
  evacuated = evac.ok;
  check("L3", "Con las dos llaves juntas se vacía la bóveda al instante (sin cuenta atrás)", evac.ok, evac.ok ? `${formatHbar(preEvacuation)} HBAR devueltos · ${evac.txId}` : evac.status);
} catch (e) {
  console.log(`\n⛔ Interrumpido: ${e instanceof Error ? e.message : String(e)}`);
  results.push({ group: "error", id: "ERROR", title: "El programa se interrumpió", pass: false, detail: e instanceof Error ? e.message : String(e) });
}

// ---- devolver lo que sobre ------------------------------------------------------------------------
console.log("\n── Devolviendo el saldo de las cuentas de prueba");
if (vaultId && !evacuated) {
  // Si el programa se cortó, la bóveda se vacía con las dos llaves (las tenemos todas).
  const balance = (await mirror.account(vaultId.toString()).catch(() => null))?.balance ?? 0n;
  if (balance > 0n) {
    const c = createClient(NETWORK, { accountId: deviceId, key: deviceKey });
    const out = await submit(c, new TransferTransaction().addHbarTransfer(vaultId, Hbar.fromTinybars((-balance).toString())).addHbarTransfer(funderId, Hbar.fromTinybars(balance.toString())), [rescueKey]);
    c.close();
    console.log(`   bóveda: ${out.ok ? `${formatHbar(balance)} HBAR devueltos` : out.status}`);
  }
}
for (const { label, id, key } of created.accounts) {
  let result = "";
  for (let attempt = 0; attempt < 4 && !result; attempt++) {
    if (attempt) await sleep(5000);
    const balance = (await mirror.account(id.toString()).catch(() => null))?.balance ?? 0n;
    const amount = balance - HBAR / 20n;
    if (amount <= 0n) {
      result = "nada que devolver";
      break;
    }
    const c = createClient(NETWORK, null);
    const out = await submit(
      c,
      new TransferTransaction().addHbarTransfer(id, Hbar.fromTinybars((-amount).toString())).addHbarTransfer(funderId, Hbar.fromTinybars(amount.toString())).setTransactionId(TransactionId.generate(id)),
      [key],
    );
    c.close();
    if (out.ok) result = `${formatHbar(amount)} HBAR devueltos`;
    else if (out.status !== "INSUFFICIENT_PAYER_BALANCE" || attempt === 3) result = out.status;
  }
  console.log(`   ${label}: ${result}`);
}
for (const c of clients) c.close();
await sleep(5000);
const end = (await mirror.account(funderId.toString()))?.balance ?? startBalance;
funder.close();

// ---- resumen e informe ----------------------------------------------------------------------------
// B9 y C6 no son ataques bloqueados sino avisos: el ladrón puede EMPEZAR una cuenta atrás, a la vista.
const attacks = results.filter((r) => /^[ABCDX]\d/.test(r.id) && !["B9", "B11", "C6", "C8", "C9"].includes(r.id));
const owner = results.filter((r) => /^(L\d|B11|C8|C9)$/.test(r.id));
const integrity = results.filter((r) => /^F\d$/.test(r.id));
const failed = results.filter((r) => !r.pass);
const count = (list) => `${list.filter((r) => r.pass).length}/${list.length}`;
const limits = [
  "Si roban a la vez el móvil (desbloqueado) y el kit, pueden vaciar la bóveda al instante: es la ruta de las dos llaves.",
  "Con solo el móvil, el ladrón también puede congelar tu recuperación con el kit: empate, el dinero queda congelado, no robado. Si tú conservas el móvil, evacúas con móvil + kit.",
  "Con solo el kit, el ladrón puede anular tus retiradas pendientes y cerrar ese carril un tiempo: retrasa, no roba. Tú evacúas con móvil + kit.",
  "El guardián puede retrasar retiradas (bloquear o congelar ese carril), pero nunca robar ni bloquear tu recuperación.",
  "Si nadie mira los avisos durante toda la cuenta atrás de recuperación, un ladrón con el kit se lleva la bóveda. Por eso hacen falta avisos push y por email.",
];
console.log(`\n══ Ataques bloqueados ${count(attacks)} · el dueño puede usar su dinero ${count(owner)} · integridad ${count(integrity)}`);
console.log(`   Coste: ${formatHbar(startBalance - end)} HBAR de testnet`);
console.log("\nLímites conocidos (no son fallos, son el precio del diseño):");
limits.forEach((l, i) => console.log(` ${i + 1}. ${l}`));

const md = [
  "# Informe del programa de ataques · bóveda v2",
  "",
  `- Fecha: ${new Date().toISOString()}`,
  `- Red: ${NETWORK}`,
  `- Cuenta atrás: retirada ${W} s · recuperación ${R} s`,
  vaultId ? `- Bóveda: [${vaultId}](${link("account", vaultId)}) · notario: [${notaryId}](${link("contract", notaryId)})` : "- Bóveda: no se llegó a crear",
  `- Coste: ${formatHbar(startBalance - end)} HBAR de testnet`,
  "",
  `**Ataques bloqueados ${count(attacks)} · el dueño puede usar su dinero ${count(owner)} · integridad ${count(integrity)}**`,
  "",
  "| | Prueba | Resultado |",
  "|---|---|---|",
  ...results.map((r) => `| ${r.pass ? "✅" : "❌"} ${r.id} | ${r.title} | ${r.detail.replace(/\|/g, "/")} |`),
  "",
  "## Límites conocidos",
  "",
  ...limits.map((l, i) => `${i + 1}. ${l}`),
  "",
].join("\n");
writeFileSync("informe-ataques.md", md);
console.log("\nInforme guardado en informe-ataques.md");
process.exit(failed.length ? 1 : 0);
