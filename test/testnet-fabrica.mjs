// Prueba en testnet REAL de la fábrica de notarios por el MISMO camino que usa la app (core/src/factory.js y v2.js):
//   · La fábrica: la de guardian/data/fabrica.json (la que anuncia el guardián) o, si no hay, se despliega con
//     deployNotaryFactory y se guarda ahí (lo mismo que «hvault-vps fabrica desplegar»).
//   · Crear la wallet con setupVaultV2({ factory }): el notario sale de la fábrica y se verifica byte a byte.
//   · Que funciona igual: guardián, carriles, recuperación prioritaria con la dirección real, cambiar plazos con la
//     fábrica y evacuar. Y los ataques: copia de tu notario, datos absurdos, una fábrica falsa.
// Al final devuelve lo que sobre a la cuenta que paga (la del guardián de testnet).
//
//   npm run prueba:fabrica      (con el guardián de testnet arrancado; ≈ 5 minutos; ≈ 30 HBAR de prueba, ≈ 75 si hay
//                                que desplegar la fábrica)
//   FABRICA_COMPARAR=0 npm run prueba:fabrica   (sin crear el notario directo de comparación: ≈ 23 HBAR menos)
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  AccountId,
  ContractId,
  Hbar,
  KeyList,
  Mnemonic,
  PrivateKey,
  TransactionId,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { Interface, getBytes } from "ethers";
import { ContractExecuteTransaction } from "@hiero-ledger/sdk";
import {
  FACTORY3_RUNTIME_KECCAK,
  HBAR,
  Mirror,
  NETWORKS,
  callNotary2,
  changeVaultDelaysV2,
  checkNotaryFactory,
  createClient,
  deployNotaryFactory,
  deployNotary2,
  evacuateVault,
  expectedNotary3Runtime,
  factory3Abi,
  formatHbar,
  hasNoAdmin,
  inspectVaultV2,
  isVaultKeyV2For,
  loadVaultActivity,
  longZeroAddress,
  notary2Config,
  notaryEvmAddress,
  nowSeconds,
  parsePrivateKey,
  requestPriorityRecoveryV3,
  requestRecoveryV2,
  requestWithdrawalV2,
  rescueKeyFromWords,
  sendHbar,
  setupVaultV2,
  signRegistration,
  submit,
  tiebreakerAddress,
  tiebreakerKey,
  verifyNotary3,
} from "@boveda/core";

const env = Object.fromEntries(
  (existsSync("guardian/.env") ? readFileSync("guardian/.env", "utf8") : "")
    .split("\n")
    .map((l) => l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const NETWORK = (process.env.HEDERA_NETWORK ?? env.HEDERA_NETWORK ?? "testnet").toLowerCase();
if (!["testnet", "previewnet"].includes(NETWORK)) throw new Error("Esta prueba solo corre en testnet o previewnet (la red simulada no crea contratos desde otro contrato).");
const GUARDIAN = process.env.GUARDIAN_URL ?? `http://127.0.0.1:${env.PORT ?? 8787}`;
const W = Number(process.env.DELAY_SECONDS ?? 30);
const R = Number(process.env.RECOVERY_SECONDS ?? 60);
const COMPARE = process.env.FABRICA_COMPARAR !== "0";
const keyText = process.env.OPERATOR_KEY ?? env.OPERATOR_KEY;
if (!keyText) throw new Error("Falta OPERATOR_KEY en guardian/.env");
const MIRROR_URL = process.env.MIRROR_URL ?? NETWORKS[NETWORK].mirror;
const CHAIN_ID = NETWORK === "testnet" ? 296 : 297;
const DATA_DIR = resolve("guardian", env.DATA_DIR || "data");
const FACTORY_FILE = join(DATA_DIR, "fabrica.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (id, title, pass, detail) => {
  checks.push({ id, title, pass });
  console.log(`${pass ? "✅" : "❌"} ${id}  ${title}\n      ${detail}`);
};
const note = (id, title, detail) => console.log(`ℹ️  ${id}  ${title}\n      ${detail}`);
const waitFor = async (fn, ms) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(3000);
  }
};
const mirror = new Mirror(MIRROR_URL);
const balanceOf = async (id) => (await mirror.account(id.toString()).catch(() => null))?.balance ?? 0n;
/** Lo que se gastó una cuenta en un paso (espera a que el mirror lo refleje). */
async function spent(id, before) {
  await sleep(6000);
  return before - (await balanceOf(id));
}
const savedFactory = () => {
  try {
    const f = JSON.parse(readFileSync(FACTORY_FILE, "utf8"));
    return f?.network === NETWORK ? f.factoryId : null;
  } catch {
    return null;
  }
};

const funderKey = parsePrivateKey(keyText, process.env.OPERATOR_KEY_TYPE ?? env.OPERATOR_KEY_TYPE);
const funderIdText = process.env.OPERATOR_ID ?? env.OPERATOR_ID;
const funderAcc = funderIdText ? await mirror.account(funderIdText) : await mirror.account(`0x${funderKey.publicKey.toEvmAddress()}`);
if (!funderAcc) throw new Error("No encuentro la cuenta de guardian/.env en la red");
const funderId = funderAcc.id;
const funder = createClient(NETWORK, { accountId: funderId, key: funderKey });
const startBalance = funderAcc.balance;
const existing = await checkNotaryFactory({ mirror, factoryId: savedFactory() });
const NEEDED = ((existing ? 35n : 85n) + (COMPARE ? 25n : 0n)) * HBAR;
console.log(`Red ${NETWORK} · paga ${funderId} (${formatHbar(startBalance)} HBAR) · guardián ${GUARDIAN}`);
if (startBalance < NEEDED) {
  console.log(`⛔ Hacen falta unos ${formatHbar(NEEDED)} HBAR de testnet${existing ? "" : " (incluye desplegar la fábrica, una sola vez)"}. Recarga en ${NETWORKS[NETWORK].faucet} pegando: ${funderAcc.evmAddress}`);
  process.exit(1);
}
const info = await fetch(`${GUARDIAN}/info`).then((r) => r.json()).catch(() => null);
if (!info?.evmAddress) throw new Error(`El guardián no responde en ${GUARDIAN}: arráncalo primero.`);
const rate = await fetch(`${MIRROR_URL}/api/v1/network/exchangerate`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const usdPerHbar = rate ? rate.current_rate.cent_equivalent / rate.current_rate.hbar_equivalent / 100 : null;
const usd = (tinybars) => (usdPerHbar ? `${((Number(tinybars) / 1e8) * usdPerHbar).toFixed(2)} $` : "?");
console.log(`Guardián ${info.version} · HBAR a ${usdPerHbar?.toFixed(4) ?? "?"} $ (cambio de la red)\n`);

const refunds = [];
const costs = {};
let vaultId;
let k1;
let rescueKey;
let evacuated = false;

try {
  // ---- 1. la fábrica, una sola vez ------------------------------------------------------------------------
  console.log("── Fábrica (una sola vez por red, sin clave de administrador)");
  let factory = existing;
  if (!factory) {
    const build = JSON.parse(readFileSync("scripts/build/NotaryFactory3.json", "utf8"));
    const fBefore = await balanceOf(funderId);
    const out = await deployNotaryFactory({ client: funder, mirror, initcode: build.bytecode });
    costs.factoryDeploy = await spent(funderId, fBefore);
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(`${FACTORY_FILE}.tmp`, JSON.stringify({ network: NETWORK, factoryId: out.factoryId, evmAddress: out.evmAddress, txId: out.txId, runtimeKeccak: FACTORY3_RUNTIME_KECCAK, deployedAt: new Date().toISOString() }, null, 2) + "\n");
    renameSync(`${FACTORY_FILE}.tmp`, FACTORY_FILE);
    factory = await checkNotaryFactory({ mirror, factoryId: out.factoryId });
    note("F0", "Fábrica desplegada ahora (y guardada para el guardián)", `${out.factoryId} · ${formatHbar(costs.factoryDeploy)} HBAR (${usd(costs.factoryDeploy)})`);
  }
  check("F1", "La fábrica pasa la comprobación de la app: su código es el compilado y nadie puede cambiarla ni borrarla", !!factory, factory ? `${factory.id} · ${factory.evmAddress}` : "no");
  if (!factory) throw new Error("sin fábrica buena no se puede seguir");
  const advertised = await waitFor(async () => {
    const i = await fetch(`${GUARDIAN}/info`).then((r) => r.json());
    return i?.notaryFactory === factory.id ? i : null;
  }, 75_000);
  check("F2", "El guardián la anuncia en /info (la app la comprueba igualmente por su cuenta)", !!advertised, advertised ? factory.id : "no la anuncia (¿guardián antiguo o sin el archivo?)");
  const fake = await checkNotaryFactory({ mirror, factoryId: funderId.toString() });
  check("F2b", "Una «fábrica» que no es la buena (cualquier otra cuenta o contrato) no se acepta", fake === null, "rechazada");

  // ---- 2. una wallet creada como la crea la app -------------------------------------------------------------
  console.log("── Wallet creada por la app con la fábrica");
  k1 = PrivateKey.generateECDSA();
  const carteraEvm = `0x${k1.publicKey.toEvmAddress()}`.toLowerCase();
  await sendHbar({ client: funder, from: funderId, to: AccountId.fromEvmAddress(0, 0, carteraEvm), tinybars: (COMPARE ? 50n : 25n) * HBAR });
  const cartera = await waitFor(() => mirror.account(carteraEvm), 60_000);
  if (!cartera) throw new Error("la cartera no aparece");
  refunds.push(["cartera", cartera.id, k1]);
  const device = createClient(NETWORK, { accountId: cartera.id, key: k1 });
  const words = (await Mnemonic.generate()).toString();
  rescueKey = await rescueKeyFromWords(words);
  const password = "prueba fabrica notario testnet";
  const tbKey = await tiebreakerKey(password, rescueKey.publicKey);
  const cBefore = await balanceOf(cartera.id);
  const made = await setupVaultV2({
    client: device,
    mirror,
    pocket: { evmAddress: carteraEvm, publicKey: k1.publicKey },
    rescuePublicKey: rescueKey.publicKey,
    guardianEvm: info.evmAddress,
    withdrawDelay: W,
    recoveryDelay: R,
    initialTinybars: 5n * HBAR,
    tiebreaker: tiebreakerAddress(tbKey),
    factory,
  });
  costs.setup = await spent(cartera.id, cBefore);
  vaultId = made.vaultId;
  const kitId = made.rescueAccountId;
  refunds.push(["kit", kitId, rescueKey]);
  const notaryId = made.notaryId;
  check("F3", "La app crea el notario con la fábrica (sin la tarifa fija de crear un contrato)", made.viaFactory, `${made.viaFactory ? "con la fábrica" : `directo (${made.factoryError})`} · notario ${notaryId} · crear la bóveda entera: ${formatHbar(costs.setup - 5n * HBAR - 3n * HBAR)} HBAR de comisiones (${usd(costs.setup - 8n * HBAR)}) + 3 del kit + 5 guardados`);
  const params = { device: carteraEvm, rescue: longZeroAddress(kitId), guardian: info.evmAddress, tiebreaker: tiebreakerAddress(tbKey), withdrawDelay: W, recoveryDelay: R };
  const v = await verifyNotary3({ mirror, notaryId: notaryId.toString(), params });
  const child = await mirror.contractInfo(notaryId.toString());
  check("F4", "El notario es byte a byte el que debe ser con tus datos y nadie puede cambiarlo ni borrarlo", v.ok && !!child && hasNoAdmin(child), v.ok ? `idéntico · dirección EVM ${v.evmAddress} (la «larga de ceros» sería ${longZeroAddress(notaryId)})` : v.why);

  if (COMPARE) {
    console.log("── Notario directo con los mismos datos (para comparar)");
    const dBefore = await balanceOf(cartera.id);
    const direct = await deployNotary2({ client: device, mirror, from: carteraEvm, ...params });
    costs.directNotary = await spent(cartera.id, dBefore);
    const d = await waitFor(() => mirror.contractInfo(direct.toString()), 60_000);
    check("F5", "El notario directo tiene exactamente el mismo código en ejecución", d?.runtimeBytecode === expectedNotary3Runtime(params), `directo ${direct} · ${formatHbar(costs.directNotary)} HBAR (${usd(costs.directNotary)})`);
  }

  // ---- 3. ¿lo ven la app y el guardián? ---------------------------------------------------------------------
  console.log("── Lecturas de la app y del guardián");
  const cfg = await notary2Config({ mirror, notaryId }).catch((e) => ({ error: e.message }));
  check("F6", "La app lee el notario con su ID, como hace hoy", !cfg.error && cfg.device === carteraEvm && cfg.version === 3, cfg.error ?? `móvil ${cfg.device} · v${cfg.version}`);
  const vault = await waitFor(() => mirror.account(vaultId.toString()), 60_000);
  check("F7", "La bóveda tiene la clave de tres rutas apuntando al notario de la fábrica", !!vault && vault.key instanceof KeyList && isVaultKeyV2For(vault.key, notaryId), `bóveda ${vaultId}`);
  const fields = { vaultId: vaultId.toString(), notaryId: notaryId.toString(), pocketId: cartera.id.toString(), pushToken: null };
  let reg;
  for (let i = 0; i < 6; i++) {
    reg = await fetch(`${GUARDIAN}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signRegistration(k1, { ...fields, timestamp: nowSeconds() })) });
    if (reg.ok) break;
    await sleep(4000);
  }
  check("F8", "El guardián la registra (lee el notario y comprueba la bóveda en la red)", reg.ok, `HTTP ${reg.status} ${reg.ok ? "" : await reg.text()}`);

  // ---- 4. los carriles funcionan con el Schedule Service ------------------------------------------------------
  console.log("── Carriles del notario creado por la fábrica");
  const wd = await requestWithdrawalV2({ client: device, vaultId, notaryId, to: cartera.id, tinybars: HBAR, withdrawDelay: W });
  let ran = await waitFor(async () => (await mirror.schedule(wd.scheduleId.toString()))?.executed, (W + 60) * 1000);
  if (!ran) {
    const ap = await callNotary2({ client: device, notaryId, call: "approve", schedule: wd.scheduleId });
    ran = ap.ok && (await waitFor(async () => (await mirror.schedule(wd.scheduleId.toString()))?.executed, 30_000));
  }
  check("F9", "Retirada por el carril del móvil: sale al acabar la cuenta atrás (la completa el guardián)", !!ran, ran ? "ejecutada" : "no se ejecutó");
  const kitClient = createClient(NETWORK, { accountId: kitId, key: rescueKey });
  const rec = await requestRecoveryV2({ client: kitClient, vaultId, notaryId, to: kitId, tinybars: HBAR, recoveryDelay: R, memo: "prueba de veto" });
  const veto = await callNotary2({ client: device, notaryId, call: "veto", schedule: rec.scheduleId });
  const vetoed = await waitFor(async () => (await loadVaultActivity({ mirror, notaryId: notaryId.toString() })).items.find((m) => m.scheduleId === rec.scheduleId.toString() && m.status === "vetoed"), 30_000);
  check("F10", "Recuperación con el kit y bloqueo desde el móvil", veto.ok && !!vetoed, veto.ok ? "bloqueada" : `${veto.status} ${veto.reason}`);
  // La app ya firma la contraseña de desempate sobre la dirección real del notario (la lee del mirror).
  const realEvm = await notaryEvmAddress({ mirror, notaryId });
  const prio = await requestPriorityRecoveryV3({ client: kitClient, vaultId, notaryId, to: kitId, tinybars: HBAR, recoveryDelay: R, tiebreakerKey: tbKey, chainId: CHAIN_ID, mirror }).then(
    (r) => ({ ok: true, detail: `aceptada · ${r.scheduleId}` }),
    (e) => ({ ok: false, detail: e.message }),
  );
  check("F11", "Recuperación prioritaria (kit + contraseña) tal como la pide ahora la app", prio.ok, `${prio.detail} · firmada sobre ${realEvm}`);
  kitClient.close();

  // ---- 5. ataques a la fábrica ---------------------------------------------------------------------------------
  console.log("── Ataques a la fábrica");
  const args = [params.device, params.rescue, params.guardian, params.tiebreaker, BigInt(W), BigInt(R)];
  const copy = await submit(funder, new ContractExecuteTransaction().setContractId(ContractId.fromString(factory.id)).setGas(1_250_000).setFunctionParameters(getBytes(factory3Abi.encodeFunctionData("create", args))).setMaxTransactionFee(new Hbar(20)));
  const vaultNow = await mirror.account(vaultId.toString());
  check("F12", "Un extraño puede crear un notario con TUS datos, pero tu bóveda sigue atada solo al suyo (el otro no sirve para nada)", vaultNow.key instanceof KeyList && isVaultKeyV2For(vaultNow.key, notaryId), `copia: ${copy.status} · tu bóveda sigue con ${notaryId}`);
  const zero = await submit(funder, new ContractExecuteTransaction().setContractId(ContractId.fromString(factory.id)).setGas(1_250_000).setFunctionParameters(getBytes(factory3Abi.encodeFunctionData("create", ["0x0000000000000000000000000000000000000000", ...args.slice(1)]))).setMaxTransactionFee(new Hbar(20)));
  check("F13", "Con datos absurdos (sin móvil) no crea nada", zero.status !== "SUCCESS", zero.status);
  const otherKit = longZeroAddress(funderId);
  const bad = await verifyNotary3({ mirror, notaryId: notaryId.toString(), params: { ...params, rescue: otherKit } });
  check("F14", "La app no aceptaría tu notario como el de otros datos (otro kit): la comprobación es exacta", !bad.ok, bad.ok ? "¡lo aceptó!" : bad.why);

  // ---- 6. cambiar plazos con la fábrica y evacuar ------------------------------------------------------------------
  console.log("── Cambiar plazos (notario nuevo con la fábrica) y evacuar");
  const chBefore = await balanceOf(cartera.id);
  const ch = await changeVaultDelaysV2({ client: device, mirror, vaultId, rescueKey, withdrawDelay: W + 10, recoveryDelay: R + 10, allowTest: true, factory }).catch((e) => ({ error: e.message }));
  costs.delays = await spent(cartera.id, chBefore);
  const chInfo = ch.error ? null : await mirror.contractInfo(ch.notaryId.toString());
  const chOk = !ch.error && !!chInfo && (await verifyNotary3({ mirror, notaryId: ch.notaryId.toString(), params: { ...params, withdrawDelay: W + 10, recoveryDelay: R + 10 } })).ok;
  const viaFactory = !!chInfo && chInfo.evmAddress !== longZeroAddress(ContractId.fromString(chInfo.id));
  const now = ch.error ? null : await inspectVaultV2({ mirror, vaultId: vaultId.toString() });
  check("F15", "Cambiar plazos crea el notario nuevo con la fábrica, verificado, y la bóveda pasa a él", chOk && viaFactory && !!now && now.notaryId.toString() === ch.notaryId.toString(), ch.error ?? `${ch.notaryId} · ${viaFactory ? "con la fábrica" : `directo (${ch.factoryError})`} · ${formatHbar(costs.delays)} HBAR`);
  const ev = await evacuateVault({ client: device, mirror, vaultId, to: cartera.id, rescueKey }).catch((e) => ({ error: e.message }));
  evacuated = !ev.error;
  check("F16", "Móvil + kit: evacuar funciona igual", !ev.error, ev.error ?? `${formatHbar(ev.tinybars)} HBAR`);
  device.close();
} catch (e) {
  console.log(`\n⛔ Interrumpida: ${e instanceof Error ? e.stack : String(e)}`);
  checks.push({ id: "abort", title: "interrumpida", pass: false });
}

// ---- devolver lo que sobre ------------------------------------------------------------------------------------
console.log("\n── Devolviendo el saldo sobrante");
if (vaultId && k1 && rescueKey && !evacuated) {
  const bal = await balanceOf(vaultId);
  if (bal > 0n) {
    const carteraId = refunds.find((r) => r[0] === "cartera")?.[1];
    const cl = createClient(NETWORK, { accountId: carteraId, key: k1 });
    const r = await submit(cl, new TransferTransaction().addHbarTransfer(vaultId, Hbar.fromTinybars((-bal).toString())).addHbarTransfer(funderId, Hbar.fromTinybars(bal.toString())), [rescueKey]);
    cl.close();
    console.log(`   bóveda: ${r.ok ? `${formatHbar(bal)} HBAR devueltos` : r.status}`);
  }
}
for (const [label, id, key] of refunds) {
  let result = "";
  for (let attempt = 0; attempt < 4 && !result; attempt++) {
    if (attempt) await sleep(5000);
    const amount = (await balanceOf(id)) - HBAR / 20n;
    if (amount <= 0n) {
      result = "nada que devolver";
      break;
    }
    const cl = createClient(NETWORK, null);
    const r = await submit(cl, new TransferTransaction().addHbarTransfer(id, Hbar.fromTinybars((-amount).toString())).addHbarTransfer(funderId, Hbar.fromTinybars(amount.toString())).setTransactionId(TransactionId.generate(id)), [key]);
    cl.close();
    if (r.ok) result = `${formatHbar(amount)} HBAR devueltos`;
    else if (r.status !== "INSUFFICIENT_PAYER_BALANCE" || attempt === 3) result = r.status;
  }
  console.log(`   ${label}: ${result}`);
}
await sleep(5000);
const end = (await mirror.account(funderId.toString()))?.balance ?? startBalance;
const failed = checks.filter((x) => !x.pass);
console.log("\n══ Costes");
if (costs.factoryDeploy != null) console.log(`   Fábrica (una sola vez): ${formatHbar(costs.factoryDeploy)} HBAR · ${usd(costs.factoryDeploy)}`);
if (costs.setup != null) console.log(`   Crear la bóveda con la fábrica (comisiones): ${formatHbar(costs.setup - 8n * HBAR)} HBAR · ${usd(costs.setup - 8n * HBAR)} (+ 3 HBAR que se quedan en el kit)`);
if (costs.directNotary != null) console.log(`   Notario directo (sin fábrica): ${formatHbar(costs.directNotary)} HBAR · ${usd(costs.directNotary)}`);
if (costs.delays != null) console.log(`   Cambiar plazos con la fábrica: ${formatHbar(costs.delays)} HBAR · ${usd(costs.delays)}`);
console.log(`\n══ Fábrica: ${checks.length - failed.length}/${checks.length} comprobaciones correctas · coste total ${formatHbar(startBalance - end)} HBAR de prueba`);
if (failed.length) console.log(`   Fallan: ${failed.map((x) => x.id).join(", ")}`);
funder.close();
process.exit(failed.length ? 1 : 0);
