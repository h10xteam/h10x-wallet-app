// 0.10.2 · Prueba en testnet REAL del swap ampliado (fase 1), contra las pools de SaucerSwap testnet:
//   1. la lista revisada de testnet: cada token se comprueba (checkSwapToken) y se cotiza;
//   2. comprar SAUCE con HBAR a la Cartera (asocia y cambia), como siempre;
//   3. comprar SAUCE DIRECTO A LA BÓVEDA: una cuenta como las bóvedas v2 (asociaciones automáticas ilimitadas) que
//      nunca ha tenido el token; el router se lo manda sin pasar por la Cartera;
//   4. una «bóveda» sin asociaciones automáticas: la app se niega antes de enviar nada;
//   5. vender el SAUCE de la Cartera con el HBAR directo a la bóveda;
//   6. otro token de la lista ida y vuelta (comprar a la bóveda, pasarlo a la Cartera y venderlo);
//   7. de TOKEN A TOKEN (fase 2): SAUCE → USDC de prueba, directo a la bóveda, por la mejor ruta;
//   8. un token pegado fuera de la lista: se avisa como «sin revisar», y disfrazado de SAUCE se bloquea;
//   9. lo que queda en la bóveda se pasa a la Cartera, se vende, y todo vuelve a la cuenta que paga.
// No hace falta el guardián: el swap sale siempre de la Cartera. Paga la cuenta de guardian/.env (testnet).
// No hay ensayo en la red simulada: necesitaría desplegar SaucerSwap entero. La lógica la cubren las pruebas de
// test/swap.test.mjs y test/swaptokens.test.mjs; esto comprueba lo que solo la red real puede demostrar.
//
//   npm run prueba:swap      (como hvault: hvault-vps prueba swap)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { AccountCreateTransaction, Hbar, PrivateKey, TokenAssociateTransaction, TokenId, TransferTransaction } from "@hiero-ledger/sdk";
import {
  HBAR,
  Mirror,
  NETWORKS,
  SWAP_TOKENS,
  bestRouteQuote,
  bestSwapQuote,
  checkPastedToken,
  checkSwapToken,
  createClient,
  describeRoute,
  findRoutes,
  findSwapPools,
  formatHbar,
  parsePrivateKey,
  routeSetup,
  submit,
  swapFromPocket,
  swapSetup,
  swapTokensFromPocket,
} from "@boveda/core";
import { sweepAccounts } from "./helpers/limpieza.mjs";

const env = Object.fromEntries(
  (existsSync("guardian/.env") ? readFileSync("guardian/.env", "utf8") : "")
    .split("\n")
    .map((l) => l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const NETWORK = (process.env.HEDERA_NETWORK ?? env.HEDERA_NETWORK ?? "testnet").toLowerCase();
if (NETWORK !== "testnet") {
  console.log("⛔ Esta prueba es solo para testnet (las pools de SaucerSwap de prueba).");
  process.exit(1);
}
const keyText = process.env.OPERATOR_KEY ?? env.OPERATOR_KEY;
if (!keyText) throw new Error("Falta OPERATOR_KEY en guardian/.env");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hb = (n) => BigInt(Math.round(n * 1e8));
const mirror = new Mirror(process.env.MIRROR_URL ?? NETWORKS.testnet.mirror);
const funderKey = parsePrivateKey(keyText, process.env.OPERATOR_KEY_TYPE ?? env.OPERATOR_KEY_TYPE);
const funderIdText = process.env.OPERATOR_ID ?? env.OPERATOR_ID;
const funderAcc = funderIdText ? await mirror.account(funderIdText) : await mirror.account(`0x${funderKey.publicKey.toEvmAddress()}`);
if (!funderAcc) throw new Error("No encuentro la cuenta de guardian/.env en la red");
const funderId = funderAcc.id;
const funder = createClient(NETWORK, { accountId: funderId, key: funderKey });
const NEEDED = 40n;
console.log(`Red testnet · paga ${funderId} (${formatHbar(funderAcc.balance)} HBAR)\n`);
if (funderAcc.balance < NEEDED * HBAR) {
  console.log(`⛔ Hacen falta unos ${NEEDED} HBAR de testnet. Recarga ${funderAcc.evmAddress} en ${NETWORKS.testnet.faucet}`);
  process.exit(1);
}

/** @type {{ id: string, title: string, pass: boolean, detail: string }[]} */
const results = [];
const record = (id, title, pass, detail = "") => {
  results.push({ id, title, pass, detail });
  console.log(`${pass ? "✅" : "❌"} ${id}  ${title}${detail ? `\n      ${detail}` : ""}`);
};
const info = (t) => console.log(`   ${t}`);
const section = (t) => console.log(`\n── ${t}`);

const clients = [];
const clientFor = (id, key) => {
  const c = createClient(NETWORK, { accountId: id, key });
  clients.push(c);
  return c;
};
/** @type {{ id: import("@hiero-ledger/sdk").AccountId, key: PrivateKey }[]} */
const scratch = [];
async function newAccount(label, key, hbar, { alias = false, maxAuto = 0 } = {}) {
  const tx = new AccountCreateTransaction().setInitialBalance(Hbar.fromTinybars(hb(hbar).toString())).setMaxAutomaticTokenAssociations(maxAuto);
  if (alias) tx.setECDSAKeyWithAlias(key.publicKey);
  else tx.setKeyWithoutAlias(key.publicKey);
  const out = await submit(funder, tx, alias ? [key] : []);
  if (!out.ok || !out.receipt?.accountId) throw new Error(`no se pudo crear la cuenta ${label}: ${out.status}`);
  scratch.push({ id: out.receipt.accountId, key });
  return out.receipt.accountId;
}
/** Saldo de un token (espera a que el mirror cambie respecto a `before`, como mucho ~30 s). */
async function tokenBalance(accountId, tokenId, before = null) {
  let last = 0n;
  for (let i = 0; i < 10; i++) {
    const held = await mirror.accountTokens(accountId.toString()).catch(() => []);
    last = held.find((t) => t.tokenId === tokenId)?.balance ?? 0n;
    if (before == null || last !== before) return last;
    await sleep(3000);
  }
  return last;
}
async function hbarBalance(accountId, before = null) {
  let last = 0n;
  for (let i = 0; i < 10; i++) {
    last = (await mirror.account(accountId.toString()))?.balance ?? 0n;
    if (before == null || last !== before) return last;
    await sleep(3000);
  }
  return last;
}

let exitCode = 1;
try {
  // ---- montaje ----------------------------------------------------------------------------------
  section("Montaje: Cartera (ECDSA con alias, como la app), bóveda con asociaciones ilimitadas y otra sin");
  const pocketKey = PrivateKey.generateECDSA();
  const vaultKey = PrivateKey.generateED25519();
  const limitedKey = PrivateKey.generateED25519();
  const pocketId = await newAccount("cartera", pocketKey, 30, { alias: true });
  const vaultId = await newAccount("bóveda", vaultKey, 1, { maxAuto: -1 });
  const limitedId = await newAccount("bóveda sin asociaciones", limitedKey, 1, { maxAuto: 0 });
  const pocket = clientFor(pocketId, pocketKey);
  info(`cartera ${pocketId} · bóveda ${vaultId} · bóveda limitada ${limitedId}`);
  await sleep(5000);

  // ---- 1. la lista ------------------------------------------------------------------------------
  section("1. La lista revisada de testnet: comprobación y cotización (2 HBAR)");
  /** @type {string[]} */
  const quoting = [];
  for (const entry of SWAP_TOKENS.testnet) {
    const setup = swapSetup("testnet", entry.id);
    const ti = await mirror.tokenInfo(entry.id, { fresh: true }).catch(() => null);
    const check = checkSwapToken(entry, ti);
    const pools = setup ? await findSwapPools(mirror, setup).catch(() => []) : [];
    const q = pools.length ? await bestSwapQuote(mirror, setup, pools, "buy", hb(2)).catch(() => null) : null;
    if (check.ok && q) quoting.push(entry.id);
    info(
      `${check.ok ? "✓" : "✗"} ${entry.symbol.padEnd(7)} ${entry.id.padEnd(12)} pools ${pools.length}` +
        (q ? ` · 2 HBAR → ${q.best.amountOut} unidades (${q.best.venue})` : " · sin cotización") +
        (check.problems.length ? ` · ${check.problems.join(" ")}` : ""),
    );
    await sleep(1000);
  }
  record("1", "SAUCE (el token por defecto de testnet) pasa la comprobación y cotiza", quoting.includes("0.0.1183558"), `cotizan ${quoting.length} de ${SWAP_TOKENS.testnet.length}`);

  const SAUCE = "0.0.1183558";
  const setup = swapSetup("testnet", SAUCE);
  const pools = await findSwapPools(mirror, setup);
  const doSwap = async (side, amountIn, recipientId = null, s = setup, p = pools) => {
    const q = await bestSwapQuote(mirror, s, p, side, amountIn);
    if (!q) throw new Error("sin cotización");
    return swapFromPocket({ client: pocket, accountId: pocketId, mirror, setup: s, pools: p, side, amountIn, agreedOut: q.best.amountOut, slippageBps: 300, recipientId, onUnverified: async () => false });
  };

  // ---- 2. a la Cartera ---------------------------------------------------------------------------
  section("2. Comprar SAUCE con 5 HBAR, a la Cartera");
  const r2 = await doSwap("buy", hb(5));
  const pocketSauce = await tokenBalance(pocketId, SAUCE, 0n);
  record("2", "Compra a la Cartera (asocia y cambia)", pocketSauce >= r2.minOut, `recibido ${pocketSauce} (mínimo ${r2.minOut}) · ${r2.venue} · ${r2.txId}`);

  // ---- 3. directo a la bóveda --------------------------------------------------------------------
  section("3. Comprar SAUCE con 5 HBAR, DIRECTO a la bóveda (sin asociarlo antes)");
  const before3 = await tokenBalance(vaultId, SAUCE);
  const r3 = await doSwap("buy", hb(5), vaultId.toString());
  const vaultSauce = await tokenBalance(vaultId, SAUCE, before3);
  const pocketAfter3 = await tokenBalance(pocketId, SAUCE);
  record(
    "3",
    "Lo comprado llega a la bóveda y la Cartera no cambia",
    before3 === 0n && vaultSauce >= r3.minOut && pocketAfter3 === pocketSauce,
    `bóveda ${before3} → ${vaultSauce} (mínimo ${r3.minOut}) · Cartera ${pocketSauce} → ${pocketAfter3} · ${r3.venue} · ${r3.txId}`,
  );

  // ---- 4. bóveda que no puede recibirlo ----------------------------------------------------------
  section("4. Una «bóveda» sin asociaciones automáticas: no se envía nada");
  const hbarBefore4 = await hbarBalance(pocketId);
  let refused = "";
  try {
    await doSwap("buy", hb(1), limitedId.toString());
  } catch (e) {
    refused = String(e?.status ?? e?.message ?? e);
  }
  await sleep(4000);
  const hbarAfter4 = await hbarBalance(pocketId);
  record("4", "La app se niega antes de enviar (DESTINATION_NOT_ASSOCIATED) y la Cartera no gasta nada", refused === "DESTINATION_NOT_ASSOCIATED" && hbarAfter4 === hbarBefore4, `motivo ${refused || "—"} · Cartera ${formatHbar(hbarBefore4)} → ${formatHbar(hbarAfter4)} HBAR`);

  // ---- 5. vender con el HBAR a la bóveda ---------------------------------------------------------
  section("5. Vender el SAUCE de la Cartera, con el HBAR directo a la bóveda");
  const vaultHbar5 = await hbarBalance(vaultId);
  const r5 = await doSwap("sell", pocketSauce, vaultId.toString());
  const vaultHbarAfter5 = await hbarBalance(vaultId, vaultHbar5);
  const pocketSauce5 = await tokenBalance(pocketId, SAUCE, pocketSauce);
  record("5", "El HBAR de la venta llega a la bóveda", vaultHbarAfter5 - vaultHbar5 >= r5.minOut && pocketSauce5 === 0n, `bóveda +${formatHbar(vaultHbarAfter5 - vaultHbar5)} HBAR (mínimo ${formatHbar(r5.minOut)}) · SAUCE en la Cartera ${pocketSauce5} · ${r5.venue}`);

  // ---- 6. otro token ida y vuelta ----------------------------------------------------------------
  const otherId = quoting.find((id) => id !== SAUCE);
  section(`6. Otro token de la lista ida y vuelta${otherId ? ` (${otherId})` : ""}`);
  if (!otherId) {
    record("6", "Otro token de la lista ida y vuelta", true, "ningún otro token de testnet cotiza ahora mismo: se salta");
  } else {
    const s6 = swapSetup("testnet", otherId);
    const p6 = await findSwapPools(mirror, s6);
    const r6 = await doSwap("buy", hb(2), vaultId.toString(), s6, p6);
    const got = await tokenBalance(vaultId, otherId, 0n);
    // La bóveda lo pasa a la Cartera (que lo asocia antes) y la Cartera lo vende.
    await submit(pocket, new TokenAssociateTransaction().setAccountId(pocketId).setTokenIds([TokenId.fromString(otherId)]));
    const move = await submit(clientFor(vaultId, vaultKey), new TransferTransaction().addTokenTransfer(TokenId.fromString(otherId), vaultId, -Number(got)).addTokenTransfer(TokenId.fromString(otherId), pocketId, Number(got)));
    await tokenBalance(pocketId, otherId, 0n);
    const r6b = move.ok ? await doSwap("sell", got, null, s6, p6) : null;
    record("6", "Comprar a la bóveda, pasarlo a la Cartera y venderlo", got >= r6.minOut && move.ok && !!r6b, `recibido ${got} (mínimo ${r6.minOut}) · paso a la Cartera ${move.status} · venta ${r6b?.txId ?? "—"}`);
  }

  // ---- 7. de token a token -----------------------------------------------------------------------
  const USDC = SWAP_TOKENS.testnet.find((t) => t.symbol === "USDC")?.id ?? "0.0.5449";
  section(`7. De token a token: SAUCE → USDC (${USDC}), directo a la bóveda`);
  await doSwap("buy", hb(4));
  const sauce7 = await tokenBalance(pocketId, SAUCE, 0n);
  const rs7 = routeSetup("testnet", SAUCE, USDC);
  const routes7 = rs7 ? await findRoutes(mirror, rs7) : [];
  const q7 = routes7.length && rs7 ? await bestRouteQuote(mirror, rs7, routes7, sauce7) : null;
  if (!rs7 || !q7) {
    record("7", "De token a token, directo a la bóveda", false, `sin ruta entre SAUCE y USDC (${routes7.length} rutas)`);
  } else {
    const before7 = await tokenBalance(vaultId, USDC);
    const r7 = await swapTokensFromPocket({ client: pocket, accountId: pocketId, mirror, rs: rs7, routes: routes7, amountIn: sauce7, agreedOut: q7.best.amountOut, slippageBps: 300, recipientId: vaultId.toString(), onUnverified: async () => false });
    const after7 = await tokenBalance(vaultId, USDC, before7);
    const left7 = await tokenBalance(pocketId, SAUCE, sauce7);
    const names = { [SAUCE]: "SAUCE", [USDC]: "USDC", [rs7.whbar]: "HBAR" };
    record(
      "7",
      "De token a token, directo a la bóveda (permiso exacto y sin pasar por la Cartera)",
      after7 - before7 >= r7.minOut && left7 === 0n,
      `ruta ${describeRoute(r7.route, (id) => names[id] ?? id)} (${routes7.length} rutas) · bóveda +${after7 - before7} (mínimo ${r7.minOut}) · SAUCE en la Cartera ${left7} · ${r7.txId}`,
    );
  }

  // ---- 8. token pegado ---------------------------------------------------------------------------
  section("8. Un token pegado, fuera de la lista revisada");
  const JUNK = "0.0.5768679";
  const jinfo = await mirror.tokenInfo(JUNK, { fresh: true }).catch(() => null);
  if (!jinfo) {
    record("8", "Un token fuera de la lista se avisa como «sin revisar»", true, `${JUNK} ya no existe en testnet: se salta`);
  } else {
    const jc = checkPastedToken("testnet", jinfo);
    // Y el mismo token disfrazado de SAUCE (lo que haría un estafador): se bloquea.
    const fake = checkPastedToken("testnet", { ...jinfo, symbol: "SAUCE" });
    record(
      "8",
      "Un token fuera de la lista se avisa como «sin revisar», y disfrazado de SAUCE se bloquea",
      jc.reviewed === false && jc.warnings.some((w) => /lista revisada/.test(w)) && !fake.ok,
      `${jinfo.symbol} · ${[...jc.problems, ...jc.warnings].join(" ")} · disfrazado: ${fake.problems.join(" ")}`,
    );
  }

  // ---- 9. limpieza -------------------------------------------------------------------------------
  section("9. Lo que queda en la bóveda vuelve a HBAR y todo a la cuenta que paga");
  for (const tokenId of [...new Set([SAUCE, USDC, ...(otherId ? [otherId] : [])])]) {
    const left = await tokenBalance(vaultId, tokenId);
    if (left <= 0n) continue;
    await submit(pocket, new TokenAssociateTransaction().setAccountId(pocketId).setTokenIds([TokenId.fromString(tokenId)])).catch(() => null);
    const had = await tokenBalance(pocketId, tokenId);
    const mv = await submit(clientFor(vaultId, vaultKey), new TransferTransaction().addTokenTransfer(TokenId.fromString(tokenId), vaultId, -Number(left)).addTokenTransfer(TokenId.fromString(tokenId), pocketId, Number(left)));
    if (!mv.ok) continue;
    const now = await tokenBalance(pocketId, tokenId, had);
    const s9 = swapSetup("testnet", tokenId);
    const p9 = s9 ? await findSwapPools(mirror, s9).catch(() => []) : [];
    if (s9 && p9.length) await doSwap("sell", now, null, s9, p9).catch((e) => info(`no se pudo vender el ${tokenId} sobrante: ${e?.message ?? e}`));
  }
  await sleep(5000);
  const emptied = await sweepAccounts({ clientFor, mirror, accounts: scratch, to: funderId, log: info });
  info(`cuentas de prueba vaciadas: ${emptied}`);
  exitCode = results.every((r) => r.pass) ? 0 : 1;
} catch (e) {
  record("!", "La prueba se ha parado", false, e instanceof Error ? e.message : String(e));
  try {
    await sweepAccounts({ clientFor, mirror, accounts: scratch, to: funderId, log: info });
  } catch {
    // lo que no se pueda vaciar se queda (son HBAR de testnet)
  }
} finally {
  await sleep(4000);
  const end = (await mirror.account(funderId.toString()))?.balance ?? 0n;
  info(`la cuenta que paga termina con ${formatHbar(end)} HBAR (gastado ${formatHbar(funderAcc.balance - end)})`);
  const lines = [
    `# Swap ampliado en testnet · ${new Date().toISOString()}`,
    "",
    "| | Prueba | Resultado | Detalle |",
    "| --- | --- | --- | --- |",
    ...results.map((r) => `| ${r.id} | ${r.title} | ${r.pass ? "✅" : "❌"} | ${r.detail.replace(/\|/g, "/")} |`),
  ];
  writeFileSync("informe-swap.md", lines.join("\n") + "\n");
  console.log(`\n${results.filter((r) => r.pass).length}/${results.length} correctas · informe en informe-swap.md`);
  for (const c of clients) c.close();
  funder.close();
  process.exit(exitCode);
}
