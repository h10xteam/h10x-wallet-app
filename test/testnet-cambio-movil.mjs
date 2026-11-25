// Prueba en testnet REAL del cambio de móvil (antes de llevarlo a la app de mainnet):
//   wallet como la de la app → el móvil nuevo pide el cambio con el kit → ataques mientras está pendiente → el móvil
//   viejo confirma → comprobaciones en la red de verdad:
//     1) la dirección de la Cartera no cambia y el notario la sigue aceptando (retirada completada por el guardián);
//     2) la llave vieja ya no sirve para nada (tampoco con transacciones de estilo Ethereum, lo que solo se puede ver en
//        la red real);
//     3) el guardián acepta la llave nueva;
//     4) las firmas de mensajes (dApps) se comprueban con la llave nueva.
// Al final devuelve lo que sobre a la cuenta que paga (la del guardián de testnet).
//
//   npm run prueba:cambio-movil      (con el guardián de testnet arrancado; ≈ 4 minutos; ≈ 30 HBAR de prueba)
import { existsSync, readFileSync } from "node:fs";
import {
  AccountId,
  AccountUpdateTransaction,
  ContractId,
  EthereumTransaction,
  Hbar,
  KeyList,
  Mnemonic,
  PrivateKey,
  PublicKey,
  ScheduleCreateTransaction,
  ScheduleId,
  ScheduleSignTransaction,
  TransactionId,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { Wallet, getBytes, parseUnits, toUtf8Bytes, verifyMessage } from "ethers";
import {
  HBAR,
  MOVE_MEMO_PREFIX,
  Mirror,
  NETWORKS,
  buildVaultKeyV2,
  confirmMove,
  createClient,
  evacuateVault,
  findMoveRequests,
  formatHbar,
  isVaultKeyV2For,
  keyStillControls,
  moveFingerprint,
  moveStatus,
  nowSeconds,
  parsePrivateKey,
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

const env = Object.fromEntries(
  (existsSync("guardian/.env") ? readFileSync("guardian/.env", "utf8") : "")
    .split("\n")
    .map((l) => l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const NETWORK = (process.env.HEDERA_NETWORK ?? env.HEDERA_NETWORK ?? "testnet").toLowerCase();
if (!["testnet", "previewnet", "local"].includes(NETWORK)) throw new Error("Esta prueba solo corre en testnet, previewnet o local.");
const REAL = NETWORK !== "local";
const GUARDIAN = process.env.GUARDIAN_URL ?? `http://127.0.0.1:${env.PORT ?? 8787}`;
const W = Number(process.env.DELAY_SECONDS ?? 30);
const R = Number(process.env.RECOVERY_SECONDS ?? 60);
const keyText = process.env.OPERATOR_KEY ?? env.OPERATOR_KEY;
if (!keyText) throw new Error("Falta OPERATOR_KEY en guardian/.env");
const NEEDED = REAL ? 48n * HBAR : 0n;
const MIRROR_URL = process.env.MIRROR_URL ?? NETWORKS[NETWORK].mirror;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (id, title, pass, detail) => {
  checks.push({ id, title, pass });
  console.log(`${pass ? "✅" : "❌"} ${id}  ${title}\n      ${detail}`);
};
const info_ = (id, title, detail) => console.log(`ℹ️  ${id}  ${title}\n      ${detail}`);
const waitFor = async (fn, ms) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(3000);
  }
};
const balanceOf = async (id) => (await mirror.account(id.toString()).catch(() => null))?.balance ?? 0n;

const mirror = new Mirror(MIRROR_URL);
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
if (!info?.evmAddress) throw new Error(`El guardián no responde en ${GUARDIAN}: arráncalo primero.`);
console.log(`Guardián ${info.version}: cuenta ${info.account} · cuenta atrás de retirada ${W} s\n`);
const register = (key, fields) =>
  fetch(`${GUARDIAN}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signRegistration(key, { ...fields, timestamp: nowSeconds() })) });

/** Transacción de estilo Ethereum (la que usan MetaMask y compañía) firmada con `key`: manda `tinybars` desde su cuenta. */
async function ethTransfer(key, fromId, tinybars) {
  const acc = await fetch(`${MIRROR_URL}/api/v1/accounts/${fromId}`).then((r) => r.json());
  const chainId = NETWORK === "testnet" ? 296 : 297;
  const signed = await new Wallet(`0x${Buffer.from(key.toBytesRaw()).toString("hex")}`).signTransaction({
    type: 2,
    chainId,
    nonce: Number(acc.ethereum_nonce ?? 0),
    to: funderAcc.evmAddress,
    value: tinybars * 10_000_000_000n, // 1 tinybar = 10^10 weibar
    gasLimit: 30_000n,
    maxFeePerGas: parseUnits("3000", "gwei"),
    maxPriorityFeePerGas: 0n,
  });
  return submit(funder, new EthereumTransaction().setEthereumData(getBytes(signed)).setMaxGasAllowanceHbar(new Hbar(1)));
}

/** Cuentas a las que devolver el saldo al final: [nombre, id, llaves que pueden valer (se prueban en orden)]. */
const refunds = [];
let vaultId;
let evacuated = false;
let k1;
let k2;
let rescueKey;

try {
  // ---- 0. la wallet de siempre (móvil viejo) ------------------------------------------------------------
  console.log("── Wallet como la de la app (móvil viejo)");
  k1 = PrivateKey.generateECDSA();
  const carteraEvm = `0x${k1.publicKey.toEvmAddress()}`.toLowerCase();
  await sendHbar({ client: funder, from: funderId, to: AccountId.fromEvmAddress(0, 0, carteraEvm), tinybars: 42n * HBAR });
  const cartera = await waitFor(() => mirror.account(carteraEvm), 60_000);
  if (!cartera) throw new Error("la cartera no aparece en el mirror node");
  refunds.push(["cartera", cartera.id, () => [k2, k1].filter(Boolean)]);
  const oldPhone = createClient(NETWORK, { accountId: cartera.id, key: k1 });
  const words = (await Mnemonic.generate()).toString();
  rescueKey = await rescueKeyFromWords(words);
  const out = await setupVaultV2({
    client: oldPhone,
    mirror,
    pocket: { evmAddress: carteraEvm, publicKey: k1.publicKey },
    rescuePublicKey: rescueKey.publicKey,
    guardianEvm: info.evmAddress,
    withdrawDelay: W,
    recoveryDelay: R,
    initialTinybars: 5n * HBAR,
  });
  vaultId = out.vaultId;
  const { notaryId, rescueAccountId } = out;
  refunds.push(["kit", rescueAccountId, () => [rescueKey]]);
  const nId = ContractId.fromString(notaryId.toString());
  console.log(`   cartera ${cartera.id} · kit ${rescueAccountId} · notario ${notaryId} · bóveda ${vaultId} · ${hashscan}/account/${vaultId}`);
  // La cuenta del kit nace con 3 HBAR; para esta prueba (con los «ataques») se le añaden 3 más.
  await sendHbar({ client: funder, from: funderId, to: rescueAccountId, tinybars: 3n * HBAR });
  const fields = { vaultId: vaultId.toString(), notaryId: notaryId.toString(), pocketId: cartera.id.toString(), pushToken: null };
  let reg;
  for (let i = 0; i < 8; i++) {
    reg = await register(k1, fields);
    if (reg.ok) break;
    await sleep(4000);
  }
  check("M0", "Wallet creada y registrada en el guardián con la llave del móvil viejo", reg.ok, `HTTP ${reg.status}`);

  if (REAL) {
    const ctl = await ethTransfer(k1, cartera.id, HBAR / 10n);
    info_("M0b", "Control: con su llave de siempre, la Cartera SÍ puede firmar una transacción de estilo Ethereum", `${ctl.status} (si no es SUCCESS, la comprobación M7e no dirá nada)`);
  }

  // ---- 1. el móvil nuevo pide el cambio con el kit --------------------------------------------------------
  console.log("── Móvil nuevo: pide el cambio con las 24 palabras");
  k2 = PrivateKey.generateECDSA();
  const wrong = await rescueKeyFromWords((await Mnemonic.generate()).toString());
  const wrongKit = await readWalletForMove({ mirror, vaultId: vaultId.toString(), rescuePublicKey: wrong.publicKey }).then(() => false, (e) => /no son el kit/.test(e.message));
  const w = await waitFor(() => readWalletForMove({ mirror, vaultId: vaultId.toString(), rescuePublicKey: rescueKey.publicKey }), 60_000);
  check(
    "M1",
    "Con el ID de la bóveda y las 24 palabras, el móvil nuevo encuentra la wallet (y con otras palabras, no)",
    !!w && wrongKit && w.carteraId === cartera.id.toString() && w.kitAccountId === rescueAccountId.toString(),
    w ? `cartera ${w.carteraId} · kit ${w.kitAccountId} (${formatHbar(w.kitBalance)} HBAR)` : "no la encuentra",
  );
  const kitClient = createClient(NETWORK, { accountId: rescueAccountId, key: rescueKey });
  const kitBefore = await balanceOf(rescueAccountId);
  const ids = await requestMove({ client: kitClient, w, newKey: k2, name: "Móvil nuevo (prueba)" });
  await sleep(5000);
  const pending = await Promise.all([ids.vault, ids.cartera].map((id) => mirror.schedule(id)));
  check("M2", "Las dos peticiones quedan pendientes: con el kit y la llave nueva solos no se ejecutan", pending.every((s) => s && !s.executed), `bóveda ${ids.vault} · cartera ${ids.cartera}`);
  const kitAfter = await balanceOf(rescueAccountId);
  info_("M2b", "Coste de pedir el cambio (lo paga la cuenta del kit)", `${formatHbar(kitBefore - kitAfter)} HBAR`);

  // ---- 2. ataques mientras está pendiente --------------------------------------------------------------------
  console.log("── Ataques con el kit robado (mientras está pendiente)");
  const k3 = PrivateKey.generateECDSA();
  const thief = await requestMove({ client: kitClient, w, newKey: k3, name: "ladrón" });
  const trick = async (inner, signers = [k3]) => {
    const r = await submit(kitClient, new ScheduleCreateTransaction().setScheduledTransaction(inner).setPayerAccountId(rescueAccountId).setScheduleMemo(`${MOVE_MEMO_PREFIX} · cartera · x`), signers);
    return r.receipt?.scheduleId?.toString() ?? null;
  };
  const tricks = {
    sinNotario: await trick(new AccountUpdateTransaction().setAccountId(vaultId).setKey(new KeyList([k3.publicKey, rescueKey.publicKey], 1))),
    otroKit: await trick(new AccountUpdateTransaction().setAccountId(vaultId).setKey(buildVaultKeyV2({ deviceKey: k3.publicKey, rescueKey: PrivateKey.generateED25519().publicKey, notaryId: nId }))),
    carteraConMemo: await trick(new AccountUpdateTransaction().setAccountId(cartera.id).setKey(k3.publicKey).setAccountMemo("hola")),
  };
  await sleep(6000);
  const ow = await readWalletOnChain({ mirror, vaultId: vaultId.toString() });
  const found = await waitFor(async () => {
    const f = await findMoveRequests({ mirror, w: ow });
    return f.requests.length >= 2 && f.suspicious.length >= 3 ? f : null;
  }, 60_000);
  const mine = found?.requests.find((r) => r.newKey.toStringRaw() === k2.publicKey.toStringRaw());
  if (!found) {
    const raw = await mirror.schedulesCreatedBy(rescueAccountId.toString(), { limit: 20 }).catch((e) => e.message);
    console.log(`      (diagnóstico) programadas del kit en el mirror: ${typeof raw === "string" ? raw : raw.map((x) => `${x.id} caduca=${x.expiresAt || "—"} creada=${x.createdAt}`).join(" · ")}`);
  }
  const flagged = new Set(found?.suspicious.map((s) => s.id) ?? []);
  check(
    "M3",
    "El móvil viejo ve la petición del dueño, la del ladrón (aviso: alguien más tiene el kit) y descarta las trucadas",
    !!mine && found.requests.length === 2 && Object.values(tricks).every((id) => id && flagged.has(id)),
    found ? `peticiones ${found.requests.length} · trucadas detectadas ${Object.values(tricks).filter((id) => id && flagged.has(id)).length}/3 · palabras ${moveFingerprint(k2.publicKey).words.join(" ")}` : "no las ve",
  );
  const anyRan = (await Promise.all([...Object.values(tricks), thief.vault, thief.cartera].filter(Boolean).map((id) => mirror.schedule(id)))).some((s) => s?.executed);
  check("M4", "Nada de lo que pide el ladrón con el kit se ejecuta", !anyRan, anyRan ? "¡algo se ejecutó!" : "todo pendiente");
  const direct = await submit(oldPhone, new AccountUpdateTransaction().setAccountId(vaultId).setKey(buildVaultKeyV2({ deviceKey: k3.publicKey, rescueKey: rescueKey.publicKey, notaryId: nId })), [k3]);
  check("M5", "Con solo el móvil viejo no se cambia la llave de la bóveda", direct.status === "INVALID_SIGNATURE", direct.status);

  // ---- 3. el dueño confirma en el móvil viejo -----------------------------------------------------------------
  console.log("── El móvil viejo confirma");
  if (!mine) throw new Error("el móvil viejo no encuentra la petición del dueño: no se puede seguir");
  const cartBefore = await balanceOf(cartera.id);
  await confirmMove({ client: oldPhone, request: mine });
  const st = await waitFor(async () => {
    const s = await moveStatus({ mirror, w, newKey: k2.publicKey });
    return s.done ? s : null;
  }, 60_000);
  const after = await mirror.account(cartera.id.toString());
  const vaultAcc = await mirror.account(vaultId.toString());
  check(
    "M6",
    "Confirmado: la Cartera y la bóveda pasan a la llave nueva al momento, con la MISMA dirección de la Cartera",
    !!st && after.evmAddress === carteraEvm && vaultAcc.key instanceof KeyList && isVaultKeyV2For(vaultAcc.key, nId),
    `dirección ${after.evmAddress} (antes ${carteraEvm}) · coste de confirmar ${formatHbar(cartBefore - (await balanceOf(cartera.id)))} HBAR`,
  );

  // ---- 4. la llave vieja ya no sirve ---------------------------------------------------------------------------
  console.log("── La llave vieja");
  const t1 = await submit(oldPhone, new TransferTransaction().addHbarTransfer(cartera.id, new Hbar(-1)).addHbarTransfer(funderId, new Hbar(1)));
  check("M7a", "Ya no mueve los HBAR de la Cartera", t1.status === "INVALID_SIGNATURE", t1.status);
  const t2 = await submit(oldPhone, new TransferTransaction().addHbarTransfer(vaultId, new Hbar(-1)).addHbarTransfer(funderId, new Hbar(1)), [rescueKey]);
  check("M7b", "Ni con el kit vacía la bóveda (la ruta «móvil + kit» es ya la del móvil nuevo)", t2.status === "INVALID_SIGNATURE", t2.status);
  const t3 = await submit(oldPhone, new ScheduleSignTransaction().setScheduleId(ScheduleId.fromString(thief.cartera)));
  check("M7c", "No puede firmar la petición del ladrón", t3.status === "INVALID_SIGNATURE", t3.status);
  const t4 = await register(k1, fields);
  check("M7d", "El guardián ya no la acepta", t4.status === 401, `HTTP ${t4.status}`);
  if (REAL) {
    const before = await balanceOf(cartera.id);
    const t5 = await ethTransfer(k1, cartera.id, HBAR);
    await sleep(6000);
    const moved = before - (await balanceOf(cartera.id)) >= HBAR;
    check("M7e", "Tampoco con una transacción de estilo Ethereum (la red comprueba la llave de la cuenta, no solo la dirección)", t5.status !== "SUCCESS" && !moved, `${t5.status}${moved ? " · ¡se movió 1 HBAR!" : ""}`);
    const t6 = await ethTransfer(k2, cartera.id, HBAR).catch((e) => ({ status: e.message }));
    info_("M7f", "Con la llave nueva, las transacciones de estilo Ethereum tampoco salen de esta Cartera (la app no las usa)", String(t6.status));
  } else {
    info_("M7e", "Transacciones de estilo Ethereum", "solo en la red real");
  }

  // ---- 5. el móvil nuevo -------------------------------------------------------------------------------------------
  console.log("── El móvil nuevo");
  const newPhone = createClient(NETWORK, { accountId: cartera.id, key: k2 });
  const reg2 = await register(k2, fields);
  check("M8", "El guardián acepta la llave nueva", reg2.status === 200, `HTTP ${reg2.status}`);
  const vBefore = await balanceOf(vaultId);
  const wd = await requestWithdrawalV2({ client: newPhone, vaultId, notaryId: nId, to: cartera.id, tinybars: HBAR, withdrawDelay: W });
  const ran = await waitFor(async () => (await mirror.schedule(wd.scheduleId.toString()))?.executed, (W + 90) * 1000);
  check("M9", "El notario acepta a la Cartera con la llave nueva y el guardián completa su retirada", !!ran && vBefore - (await balanceOf(vaultId)) >= HBAR, ran ? `retirada ${wd.scheduleId} ejecutada` : "no se ejecutó a tiempo");
  const msg = "H10X Wallet · prueba de firma";
  const sig = k2.sign(toUtf8Bytes(msg));
  const keyNow = (await mirror.account(cartera.id.toString())).key;
  const verifies = keyNow instanceof PublicKey && keyNow.verify(toUtf8Bytes(msg), sig);
  const oldVerifies = keyNow instanceof PublicKey && keyNow.verify(toUtf8Bytes(msg), k1.sign(toUtf8Bytes(msg)));
  check("M10", "Una dApp que comprueba la firma con la llave de la cuenta acepta la del móvil nuevo y rechaza la del viejo", verifies && !oldVerifies, `nueva ${verifies ? "válida" : "no"} · vieja ${oldVerifies ? "¡válida!" : "rechazada"}`);
  const evmSigner = verifyMessage(msg, await new Wallet(`0x${Buffer.from(k2.toBytesRaw()).toString("hex")}`).signMessage(msg)).toLowerCase();
  info_("M10b", "Firmas de estilo Ethereum (personal_sign)", `salen de ${evmSigner}, que ya no es la dirección de la Cartera (${carteraEvm}): una dApp que las compare con la dirección no las aceptaría. La app firma al estilo Hedera.`);
  const again = await submit(newPhone, new ScheduleSignTransaction().setScheduleId(ScheduleId.fromString(ids.vault)));
  check("M11", "Repetir las firmas no hace nada", again.status === "SCHEDULE_ALREADY_EXECUTED", again.status);
  const leftover = await findMoveRequests({ mirror, w: await readWalletOnChain({ mirror, vaultId: vaultId.toString() }) });
  check("M12", "En el móvil nuevo sale la petición pendiente del ladrón (el kit está comprometido: hay que avisar)", leftover.requests.length === 1, `${leftover.requests.length} pendiente(s)`);
  const ev = await evacuateVault({ client: newPhone, mirror, vaultId, to: cartera.id, rescueKey }).catch((e) => ({ error: e.message }));
  evacuated = !ev.error;
  check("M13", "Móvil nuevo + kit: evacuar sigue funcionando", !ev.error, ev.error ?? `${formatHbar(ev.tinybars)} HBAR · ${ev.txId}`);
  const still = await keyStillControls({ mirror, vaultId: vaultId.toString(), carteraId: cartera.id.toString(), key: k1.publicKey });
  check("M14", "La llave del móvil viejo no controla ni la Cartera ni la bóveda (ya se puede borrar)", !still.vault && !still.cartera, JSON.stringify(still));
  newPhone.close();
  kitClient.close();
  oldPhone.close();
} catch (e) {
  console.log(`\n⛔ Interrumpida: ${e instanceof Error ? e.stack : String(e)}`);
  checks.push({ id: "abort", title: "interrumpida", pass: false });
}

// ---- devolver lo que sobre ------------------------------------------------------------------------------------
// Las llaves pueden haber cambiado a mitad (si la prueba se interrumpe): se prueban la nueva y la vieja.
console.log("\n── Devolviendo el saldo sobrante");
if (vaultId && rescueKey && !evacuated) {
  const bal = await balanceOf(vaultId);
  const carteraId = refunds.find((r) => r[0] === "cartera")?.[1];
  let done = bal <= 0n ? "nada que devolver" : "";
  for (const key of [k2, k1].filter(Boolean)) {
    if (done) break;
    const cl = createClient(NETWORK, { accountId: carteraId, key });
    const r = await submit(cl, new TransferTransaction().addHbarTransfer(vaultId, Hbar.fromTinybars((-bal).toString())).addHbarTransfer(funderId, Hbar.fromTinybars(bal.toString())), [rescueKey]);
    cl.close();
    if (r.ok) done = `${formatHbar(bal)} HBAR devueltos`;
  }
  console.log(`   bóveda: ${done || "no se pudo (INVALID_SIGNATURE con las dos llaves)"}`);
}
for (const [label, id, keysOf] of refunds) {
  let result = "";
  for (const key of keysOf()) {
    for (let attempt = 0; attempt < 3 && !result; attempt++) {
      if (attempt) await sleep(5000);
      const amount = (await balanceOf(id)) - HBAR / 20n;
      if (amount <= 0n) {
        result = "nada que devolver";
        break;
      }
      const c = createClient(NETWORK, null);
      const r = await submit(c, new TransferTransaction().addHbarTransfer(id, Hbar.fromTinybars((-amount).toString())).addHbarTransfer(funderId, Hbar.fromTinybars(amount.toString())).setTransactionId(TransactionId.generate(id)), [key]);
      c.close();
      if (r.ok) result = `${formatHbar(amount)} HBAR devueltos`;
      else if (r.status === "INVALID_SIGNATURE") break; // esta llave ya no es la suya: se prueba la otra
      else if (r.status !== "INSUFFICIENT_PAYER_BALANCE" || attempt === 2) result = r.status;
    }
    if (result) break;
  }
  console.log(`   ${label}: ${result || "no se pudo"}`);
}
await sleep(5000);
const end = (await mirror.account(funderId.toString()))?.balance ?? startBalance;
const failed = checks.filter((c) => !c.pass);
console.log(`\n══ Cambio de móvil: ${checks.length - failed.length}/${checks.length} comprobaciones correctas · coste ${formatHbar(startBalance - end)} HBAR de prueba`);
if (failed.length) console.log(`   Fallan: ${failed.map((c) => c.id).join(", ")}`);
funder.close();
process.exit(failed.length ? 1 : 0);
