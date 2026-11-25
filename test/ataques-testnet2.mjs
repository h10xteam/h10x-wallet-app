// ATAQUES 2 en testnet REAL: lo que la red simulada no puede demostrar por sí sola.
//
//   1. Operación «cargada» (llave del móvil): una programada cuyo pagador no ha firmado.
//      1a. SIN guardián vigilando: ¿Hedera guarda la firma del notario y deja dispararla después?
//      1b. CON el guardián en marcha: la bloquea antes de que acabe la cuenta atrás.
//   2. Token trampa: Hedera cobra su comisión fija a quien envía; al evacuar, el token se queda y los
//      HBAR salen enteros.
//   3. Comisión añadida durante la cuenta atrás: el guardián (0.14+) bloquea la retirada en cuanto la ve, porque su
//      emisor tiene la llave de comisiones (y se comprueba en el propio guardián que es por eso); y el emisor, que
//      podría completarla él mismo al acabar (approve es de cualquiera), ya no puede.
//   4. Aviso que no es una operación (guardián 0.8.0+): tras él, el guardián sigue bloqueando.
//
//   Con el guardián en marcha:
//     npm run ataques:red2
//
// Paga la cuenta de guardian/.env (hacen falta unos 190 HBAR de testnet; solo «2,3», unos 130). Al final devuelve lo que sobre
// y escribe informe-ataques2.md. Variables opcionales: ATAQUE_RETIRADA (s, 60), GUARDIAN_URL y
// ATAQUE_SOLO (p. ej. «2,3» para repetir solo los tokens, sin la bóveda A: unos 70 HBAR).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Interface } from "ethers";
import { accountsOfKey, sweepAccounts } from "./helpers/limpieza.mjs";
import {
  AccountCreateTransaction,
  AccountId,
  ContractExecuteTransaction,
  CustomFixedFee,
  Hbar,
  Mnemonic,
  PrivateKey,
  ScheduleCreateTransaction,
  ScheduleSignTransaction,
  Timestamp,
  TokenCreateTransaction,
  TokenFeeScheduleUpdateTransaction,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import {
  HBAR,
  Mirror,
  NETWORKS,
  NOTARY2_ARTIFACT,
  buildVaultTransfer,
  callNotary2,
  createClient,
  evacuateVault,
  formatHbar,
  loadVaultActivity,
  nowSeconds,
  parsePrivateKey,
  requestWithdrawalV2,
  sendToken,
  setupVaultV2,
  signRegistration,
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
const NETWORK = (
  process.env.HEDERA_NETWORK ??
  env.HEDERA_NETWORK ??
  "testnet"
).toLowerCase();
if (!["testnet", "previewnet", "local"].includes(NETWORK))
  throw new Error("Este programa solo corre en testnet, previewnet o local.");
const W = Number(process.env.ATAQUE_RETIRADA ?? 60);
const R = W * 2;
const GUARDIAN_URL = (
  process.env.GUARDIAN_URL ?? `http://127.0.0.1:${env.PORT ?? 8787}`
).replace(/\/$/, "");
const keyText = process.env.OPERATOR_KEY ?? env.OPERATOR_KEY;
if (!keyText) throw new Error("Falta OPERATOR_KEY en guardian/.env");
const ONLY = (process.env.ATAQUE_SOLO ?? "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);
const RUN1 = !ONLY.length || ONLY.includes("1");
const RUN23 = !ONLY.length || ONLY.includes("2") || ONLY.includes("3");
// Medido en testnet (15-nov-2026): con todo, unos 190; solo tokens, unos 130. Crear un token con comisiones
// exige además 60 HBAR LIBRES en ese momento (la comisión máxima), aunque luego cueste mucho menos.
const NEEDED_HBAR = NETWORK === "local" ? 0n : RUN1 && RUN23 ? 190n : RUN23 ? 130n : 110n;
/** Comisión máxima para crear tokens: con comisiones propias cuesta unos 2 $ (más que el tope por defecto). */
const TOKEN_FEE = new Hbar(60);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Antes de crear un token: la red exige tener libre la comisión máxima (60 HBAR). Si no, se para con un mensaje claro. */
async function needFree(what) {
  if (NETWORK === "local") return;
  const free = (await mirror.account(funderId.toString()))?.balance ?? 0n;
  if (free < 65n * HBAR) throw new Error(`para ${what} hacen falta 65 HBAR libres en ${funderId} y hay ${formatHbar(free)}: recárgala y repite con ATAQUE_SOLO=2,3`);
}
const hb = (n) => BigInt(Math.round(n * 1e8));
const mirror = new Mirror(process.env.MIRROR_URL ?? NETWORKS[NETWORK].mirror);
const hashscan = NETWORKS[NETWORK].hashscan;
const link = (kind, id) =>
  hashscan ? `${hashscan}/${kind}/${id}` : `${kind} ${id}`;

const funderKey = parsePrivateKey(
  keyText,
  process.env.OPERATOR_KEY_TYPE ?? env.OPERATOR_KEY_TYPE,
);
const funderIdText = process.env.OPERATOR_ID ?? env.OPERATOR_ID;
const funderAcc = funderIdText
  ? await mirror.account(funderIdText)
  : await mirror.account(`0x${funderKey.publicKey.toEvmAddress()}`);
if (!funderAcc)
  throw new Error("No encuentro la cuenta de guardian/.env en la red");
const funderId = funderAcc.id;
const funder = createClient(NETWORK, { accountId: funderId, key: funderKey });
console.log(
  `Red ${NETWORK} · paga ${funderId} (${formatHbar(funderAcc.balance)} HBAR) · cuenta atrás ${W} s · guardián ${GUARDIAN_URL}\n`,
);
if (funderAcc.balance < NEEDED_HBAR * HBAR) {
  console.log(
    `⛔ Hacen falta unos ${NEEDED_HBAR} HBAR de testnet. Recarga ${funderAcc.evmAddress} en ${NETWORKS[NETWORK].faucet}`,
  );
  process.exit(1);
}
const guardianInfo = await fetch(`${GUARDIAN_URL}/info`)
  .then((r) => r.json())
  .catch(() => null);
if (!guardianInfo?.evmAddress) {
  console.log(
    `⛔ El guardián no responde en ${GUARDIAN_URL}. Arráncalo (hvault-vps arrancar) y vuelve a probar.`,
  );
  process.exit(1);
}
console.log(
  `Guardián ${guardianInfo.version} · cuenta ${guardianInfo.account}`,
);

// ---- registro de resultados -----------------------------------------------------------------------
/** @type {{ id: string, title: string, pass: boolean, detail: string }[]} */
const results = [];
const check = (id, title, pass, detail) => {
  results.push({ id, title, pass, detail });
  console.log(`${pass ? "✅" : "❌"} ${id}  ${title}\n      ${detail}`);
};
const section = (t) => console.log(`\n── ${t}`);
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
const balance = async (id) =>
  (await mirror.account(id.toString()))?.balance ?? 0n;
const executed = async (scheduleId) => {
  await sleep(NETWORK === "local" ? 1000 : 6000);
  return Boolean((await mirror.schedule(scheduleId.toString()))?.executed);
};
const clients = [];
const clientFor = (id, key) => {
  const c = createClient(NETWORK, { accountId: id, key });
  clients.push(c);
  return c;
};
/** @type {{ id: AccountId, key: PrivateKey }[]} */
const scratch = [];
/** Llaves de kits aún sin cuenta conocida (si la preparación se para a medias, se buscan al limpiar). */
const kitKeys = [];
async function newAccount(
  label,
  key,
  hbar,
  { alias = false, tokens = false } = {},
) {
  const tx = new AccountCreateTransaction()
    .setInitialBalance(Hbar.fromTinybars(hb(hbar).toString()))
    .setAccountMemo(`ataques2 · ${label}`);
  if (alias) tx.setECDSAKeyWithAlias(key.publicKey);
  else tx.setKeyWithoutAlias(key.publicKey);
  if (tokens) tx.setMaxAutomaticTokenAssociations(-1);
  const out = await submit(funder, tx, alias ? [key] : []);
  if (!out.ok || !out.receipt?.accountId)
    throw new Error(`no se pudo crear ${label}: ${out.status}`);
  scratch.push({ id: out.receipt.accountId, key });
  return out.receipt.accountId;
}

/** Cartera + kit + notario + bóveda (y registro en el guardián si se pide). */
async function makeVault(label, initialHbar, register) {
  const pocketKey = PrivateKey.generateECDSA();
  const pocketId = await newAccount(
    `${label} · cartera`,
    pocketKey,
    initialHbar + 40,
    { alias: true },
  );
  const pocketEvm = `0x${pocketKey.publicKey.toEvmAddress()}`.toLowerCase();
  await waitFor(() => mirror.account(pocketEvm), 60_000);
  const device = clientFor(pocketId, pocketKey);
  const rescueKey = await (
    await Mnemonic.generate()
  ).toStandardEd25519PrivateKey("", 0);
  kitKeys.push(rescueKey);
  const { notaryId, vaultId, rescueAccountId } = await setupVaultV2({
    client: device,
    mirror,
    pocket: { evmAddress: pocketEvm, publicKey: pocketKey.publicKey },
    rescuePublicKey: rescueKey.publicKey,
    guardianEvm: guardianInfo.evmAddress,
    withdrawDelay: W,
    recoveryDelay: R,
    initialTinybars: hb(initialHbar),
  });
  scratch.push({ id: rescueAccountId, key: rescueKey });
  await waitFor(() => mirror.account(vaultId.toString()), 60_000);
  info(
    `${label}: bóveda ${link("account", vaultId)} · notario ${notaryId} · cartera ${pocketId}`,
  );
  if (register) {
    const body = signRegistration(pocketKey, {
      vaultId: vaultId.toString(),
      notaryId: notaryId.toString(),
      pocketId: pocketId.toString(),
      pushToken: null,
      timestamp: nowSeconds(),
    });
    let res = null;
    for (let i = 0; i < 6 && res?.status !== 200; i++) {
      res = await fetch(`${GUARDIAN_URL}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status !== 200) await sleep(5000);
    }
    info(`${label}: registro en el guardián → ${res?.status}`);
    if (res?.status !== 200)
      throw new Error(
        `el guardián no registró la bóveda: ${await res?.text()}`,
      );
  }
  return {
    pocketKey,
    pocketId,
    device,
    rescueKey,
    rescueAccountId,
    vaultId,
    notaryId,
  };
}

/** La operación «cargada»: sale de la bóveda hacia el ladrón y la paga su otra cuenta, que NO firma. */
async function loaded(v, thiefId, amount) {
  const inner = buildVaultTransfer({
    vaultId: v.vaultId,
    to: thiefId,
    tinybars: amount,
  });
  const out = await submit(
    v.device,
    new ScheduleCreateTransaction()
      .setScheduledTransaction(inner)
      .setPayerAccountId(thiefId)
      .setScheduleMemo("ataques2 · cargada")
      .setExpirationTime(
        Timestamp.fromDate(new Date((nowSeconds() + W + 900) * 1000)),
      )
      .setWaitForExpiry(false),
  );
  if (!out.ok || !out.receipt?.scheduleId)
    throw new Error(`no se pudo programar: ${out.status}`);
  const req = await callNotary2({
    client: v.device,
    notaryId: v.notaryId,
    call: "request",
    schedule: out.receipt.scheduleId,
  });
  if (!req.ok)
    throw new Error(`el notario no la anunció: ${req.status} ${req.reason}`);
  return out.receipt.scheduleId;
}

let A, B;
const thiefKey = PrivateKey.generateED25519();
let thiefId;
try {
  section(
    RUN1
      ? "Montaje: dos bóvedas (A sin registrar en el guardián, B registrada) y un ladrón"
      : "Montaje: una bóveda registrada en el guardián",
  );
  thiefId = await newAccount("ladrón", thiefKey, 3);
  const thief = clientFor(thiefId, thiefKey);
  if (RUN1) A = await makeVault("A", 5, false);
  B = await makeVault("B", 8, true);

  if (RUN1) {
    // ---- 1a. Operación cargada SIN guardián -------------------------------------------------------
    section(
      "1a. Operación «cargada» sin guardián: ¿se puede disparar después de aprobarla?",
    );
    const sA = await loaded(A, thiefId, hb(2));
    info(
      `programada ${link("schedule", sA)}; esperando la cuenta atrás (${W} s)…`,
    );
    await sleep((W + 5) * 1000);
    const ap = await callNotary2({
      client: funder,
      notaryId: A.notaryId,
      call: "approve",
      schedule: sA,
    });
    const afterApprove = await executed(sA);
    info(
      `aprobada por un tercero: ${ap.ok ? "sí" : `no (${ap.status} ${ap.reason})`} · ejecutada: ${afterApprove}`,
    );
    const beforeThief = await balance(thiefId);
    await submit(thief, new ScheduleSignTransaction().setScheduleId(sA));
    const fired = await executed(sA);
    const gained = (await balance(thiefId)) - beforeThief;
    check(
      "1a",
      "Sin guardián, Hedera guarda la firma del notario y el ladrón la dispara cuando quiere",
      ap.ok && !afterApprove && fired,
      `aprobada ${ap.ok} · sin ejecutar tras aprobar ${!afterApprove} · ejecutada al firmar el ladrón ${fired} (ladrón ${gained >= 0n ? "+" : ""}${formatHbar(gained)} HBAR). ` +
        "Si es ✅, el ataque existe en la red real y la defensa tiene que ser el guardián (o la app).",
    );

    // ---- 1b. Con el guardián ------------------------------------------------------------------------
    section("1b. La misma operación con el guardián vigilando");
    const sB = await loaded(B, thiefId, hb(2));
    const vetoed = await waitFor(
      async () =>
        (
          await loadVaultActivity({ mirror, notaryId: B.notaryId.toString() })
        ).items.find((m) => m.scheduleId === sB.toString())?.status ===
        "vetoed",
      (W - 5) * 1000,
    );
    check(
      "1b",
      "El guardián la bloquea antes de que acabe la cuenta atrás",
      Boolean(vetoed),
      vetoed ? "bloqueada" : "¡no la ha bloqueado a tiempo!",
    );
    await sleep(Math.max(0, W + 5) * 1000);
    const ap2 = await callNotary2({
      client: thief,
      notaryId: B.notaryId,
      call: "approve",
      schedule: sB,
    });
    await submit(thief, new ScheduleSignTransaction().setScheduleId(sB));
    const fired2 = await executed(sB);
    check(
      "1b+",
      "Pasada la cuenta atrás, ni aprobándola ni firmándola sale",
      !ap2.ok && !fired2,
      `aprobar → ${ap2.ok ? "¡aceptado!" : ap2.reason || ap2.status} · ejecutada ${fired2}`,
    );

    // ---- 4. Aviso que no es una operación (guardián 0.8.0+) ------------------------------------------
    section("4. Aviso que no es una operación y, después, otra operación «cargada»");
    const iface = new Interface(NOTARY2_ARTIFACT.abi);
    const bogus = await submit(
      B.device,
      new ContractExecuteTransaction()
        .setContractId(B.notaryId)
        .setGas(90_000)
        .setFunctionParameters(Buffer.from(iface.encodeFunctionData("request", ["0x00000000ffffffffffffffff0000000000000001"]).slice(2), "hex")),
    );
    info(`aviso con una dirección que no es una programada: ${bogus.status}`);
    const s4 = await loaded(B, thiefId, hb(1));
    const vetoed4 = await waitFor(
      async () =>
        (
          await loadVaultActivity({ mirror, notaryId: B.notaryId.toString() })
        ).items.find((m) => m.scheduleId === s4.toString())?.status ===
        "vetoed",
      (W - 5) * 1000,
    );
    check(
      "4",
      "Tras un aviso ilegible, el guardián sigue viendo y bloquea lo siguiente",
      bogus.ok && Boolean(vetoed4),
      `aviso ${bogus.status} · operación siguiente ${vetoed4 ? "bloqueada" : "¡no la ha bloqueado a tiempo!"}`,
    );
  }

  if (RUN23) {
    // ---- 2. Token trampa ------------------------------------------------------------------------------
    section("2. Token trampa con comisión fija de 2 HBAR");
    await needFree("crear el token trampa");
    const trapOut = await submit(
      funder,
      new TokenCreateTransaction()
        .setTokenName("Trampa ataques2")
        .setTokenSymbol("TRAMPA")
        .setDecimals(0)
        .setInitialSupply(1000)
        .setTreasuryAccountId(funderId)
        .setCustomFees([
          new CustomFixedFee()
            .setHbarAmount(new Hbar(2))
            .setFeeCollectorAccountId(funderId),
        ])
        .setMaxTransactionFee(TOKEN_FEE),
    );
    if (!trapOut.ok)
      throw new Error(`no se pudo crear el token: ${trapOut.status}`);
    const trap = trapOut.receipt.tokenId.toString();
    info(`token ${link("token", trap)}`);
    // Control: Hedera cobra la comisión a quien envía.
    const sKey = PrivateKey.generateED25519();
    const sId = await newAccount("control · envía", sKey, 5, { tokens: true });
    const tId = await newAccount(
      "control · recibe",
      PrivateKey.generateED25519(),
      0.5,
      { tokens: true },
    );
    await sendToken({
      client: funder,
      from: funderId,
      to: sId,
      tokenId: trap,
      amount: 10n,
    });
    await sleep(NETWORK === "local" ? 500 : 5000);
    const sBefore = await balance(sId);
    await submit(
      clientFor(sId, sKey),
      new TransferTransaction()
        .addTokenTransfer(trap, sId, -1)
        .addTokenTransfer(trap, tId, 1)
        .addHbarTransfer(sId, Hbar.fromTinybars(-1))
        .addHbarTransfer(tId, Hbar.fromTinybars(1)),
    );
    await sleep(NETWORK === "local" ? 500 : 6000);
    const paid = sBefore - (await balance(sId));
    check(
      "2a",
      "La red cobra la comisión fija a quien envía el token",
      paid >= hb(2),
      `quien envía pagó ${formatHbar(paid)} HBAR (comisión + red)`,
    );
    // Regalo a la bóveda B (desde la tesorería, sin comisión).
    await sendToken({
      client: funder,
      from: funderId,
      to: B.vaultId,
      tokenId: trap,
      amount: 100n,
    });

    // ---- 3. Comisión añadida durante la cuenta atrás -------------------------------------------------
    section("3. Token sin comisión… hasta que se pide la retirada");
    await needFree("crear el segundo token");
    const chgOut = await submit(
      funder,
      new TokenCreateTransaction()
        .setTokenName("Cambia ataques2")
        .setTokenSymbol("CAMBIA")
        .setDecimals(0)
        .setInitialSupply(1000)
        .setTreasuryAccountId(funderId)
        .setFeeScheduleKey(funderKey.publicKey)
        .setMaxTransactionFee(TOKEN_FEE),
    );
    if (!chgOut.ok)
      throw new Error(`no se pudo crear el token: ${chgOut.status}`);
    const chg = chgOut.receipt.tokenId.toString();
    await sendToken({
      client: funder,
      from: funderId,
      to: B.vaultId,
      tokenId: chg,
      amount: 50n,
    });
    await sleep(NETWORK === "local" ? 500 : 5000);
    const vaultBefore = await balance(B.vaultId);
    const { scheduleId: sC } = await requestWithdrawalV2({
      client: B.device,
      vaultId: B.vaultId,
      notaryId: B.notaryId,
      to: B.pocketId,
      tokens: [{ tokenId: chg, amount: 20n }],
      withdrawDelay: W,
    });
    const upd = await submit(
      funder,
      new TokenFeeScheduleUpdateTransaction()
        .setTokenId(chg)
        .setCustomFees([
          new CustomFixedFee()
            .setHbarAmount(new Hbar(3))
            .setFeeCollectorAccountId(funderId),
        ])
        .setMaxTransactionFee(TOKEN_FEE),
    );
    info(
      `retirada ${link("schedule", sC)} pedida; comisión de 3 HBAR añadida: ${upd.status}. Esperando la cuenta atrás y al guardián…`,
    );
    await sleep((W + 40) * 1000);
    // El emisor intenta completarla él mismo: con el guardián 0.13 la retirada seguía abierta y lo conseguía.
    const byIssuer = await callNotary2({ client: funder, notaryId: B.notaryId, call: "approve", schedule: sC }).catch((e) => ({ ok: false, status: "ERROR", reason: e instanceof Error ? e.message : String(e) }));
    await sleep(NETWORK === "local" ? 500 : 6000);
    const ranC = await executed(sC);
    const vaultAfter = await balance(B.vaultId);
    // ¿Por qué? Tiene que ser la llave de comisiones (o la comisión), no otra cosa. Desde este servidor (sin pasar por
    // Caddy) el guardián lo enseña todo; desde fuera, solo si la bóveda está registrada.
    const gv = await fetch(`${GUARDIAN_URL}/vaults/${B.vaultId}`).then((r) => r.json()).catch(() => null);
    const why = gv?.pending?.[sC.toString()];
    const reason = why?.feeRisk ? `${why.feeRisk.reason} (${why.feeRisk.token})` : why ? `estado ${why.status}` : "no se sabe (¿GUARDIAN_URL pasa por Caddy?)";
    check(
      "3",
      "El guardián bloquea la retirada de un token cuyo emisor puede ponerle comisiones, y el emisor no puede completarla",
      !ranC && !byIssuer.ok && vaultAfter >= vaultBefore && why?.status === "vetoed" && Boolean(why?.feeRisk),
      `ejecutada ${ranC} · el emisor la completa: ${byIssuer.ok ? "sí" : `no (${byIssuer.reason || byIssuer.status})`} · bóveda ${formatHbar(vaultBefore)} → ${formatHbar(vaultAfter)} HBAR · motivo: ${reason}`,
    );

    // ---- Evacuación de B: los HBAR salen enteros y los tokens con comisión se quedan --------------------
    section("Evacuación de B (móvil + kit) a la cuenta que paga");
    const hbarB = await balance(B.vaultId);
    const ev = await evacuateVault({
      client: B.device,
      mirror,
      vaultId: B.vaultId,
      to: funderId,
      rescueKey: B.rescueKey,
    });
    const skipped = ev.skippedTokens.map((x) => x.tokenId);
    check(
      "2b",
      "Al evacuar, los HBAR salen enteros y los tokens con comisión se quedan",
      ev.tinybars >= hbarB && skipped.includes(trap) && skipped.includes(chg),
      `HBAR en la bóveda ${formatHbar(hbarB)} → enviados ${formatHbar(ev.tinybars)} · dejados: ${skipped.join(", ") || "ninguno"}`,
    );
  }
} catch (e) {
  console.log(
    `\n⛔ Se ha parado: ${e instanceof Error ? e.message : String(e)}`,
  );
  results.push({
    id: "—",
    title: "El programa se paró",
    pass: false,
    detail: e instanceof Error ? e.message : String(e),
  });
} finally {
  section("Limpieza: lo que sobra vuelve a la cuenta que paga");
  for (const v of [A, B].filter(Boolean)) {
    try {
      if ((await balance(v.vaultId)) > 0n)
        await evacuateVault({
          client: v.device,
          mirror,
          vaultId: v.vaultId,
          to: funderId,
          rescueKey: v.rescueKey,
        });
    } catch {
      // ya vacía
    }
  }
  for (const k of kitKeys) {
    if (scratch.some((s) => s.key === k)) continue;
    for (const id of await accountsOfKey({ mirror, publicKey: k.publicKey })) scratch.push({ id, key: k });
  }
  const emptied = await sweepAccounts({ clientFor, mirror, accounts: scratch, to: funderId, log: info });
  info(`cuentas de prueba vaciadas: ${emptied}`);
  await sleep(NETWORK === "local" ? 500 : 5000);
  const end = await balance(funderId);
  info(
    `la cuenta que paga termina con ${formatHbar(end)} HBAR (gastado ${formatHbar(funderAcc.balance - end)})`,
  );
  const lines = [
    `# Ataques 2 en ${NETWORK} · ${new Date().toISOString()}`,
    "",
    `Guardián ${guardianInfo.version} (${guardianInfo.account}) · cuenta atrás ${W} s`,
    "",
    "| | Prueba | Resultado | Detalle |",
    "| --- | --- | --- | --- |",
    ...results.map(
      (r) =>
        `| ${r.id} | ${r.title} | ${r.pass ? "✅" : "❌"} | ${r.detail.replace(/\|/g, "/")} |`,
    ),
  ];
  writeFileSync("informe-ataques2.md", lines.join("\n") + "\n");
  console.log(
    `\n${results.filter((r) => r.pass).length}/${results.length} correctas · informe en informe-ataques2.md`,
  );
  for (const c of clients) c.close();
  funder.close();
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}
