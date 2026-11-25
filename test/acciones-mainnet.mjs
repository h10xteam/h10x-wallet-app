// 0.10.2 · Prueba REAL en MAINNET de las acciones tokenizadas (fase 3), con poco dinero. SODAX no tiene red de pruebas.
// No usa ninguna llave de la bóveda ni del guardián: usa una Cartera de prueba (ECDSA, como la de la app) con una llave
// que se guarda solo en data/ (permisos 600, nunca se enseña ni se empaqueta). La pagas tú desde HashPack.
//
// 1ª pasada (25-nov-2026): compra a la Cartera ✅, compra DIRECTA a una bóveda de prueba ✅ (a los ~3 min) y venta ✅.
// 2ª pasada: compra con HBAR ✅, venta por USDC ✅, compra con USDC ✅; la venta final y la cancelación no llegaron al
// mínimo de SODAX (≈ 1 $ por orden). Esta 3ª pasada:
//   1. busca el mínimo de SODAX (el primer importe que cotiza, +15 %);
//   2. compra AAPL con ese importe (se junta con el resto que quedó por debajo del mínimo);
//   3. vende TODO el AAPL por HBAR;
//   4. una orden que nadie completará (mínimo ×3) y su cancelación: ¿se cierra? ¿vuelve el HBAR a la Cartera?
// Al final, con tu cuenta (hvault-vps prueba acciones-mainnet 0.0.TU_CUENTA), lo que queda va a esa cuenta. Solo
// devolver, sin prueba: hvault-vps prueba acciones-mainnet devolver 0.0.TU_CUENTA. Solo el paso 4 (cancelar una orden):
// hvault-vps prueba acciones-mainnet cancelar 0.0.TU_CUENTA
//
// 25-nov-2026, lección: la 3ª pasada cerró la Cartera con la orden del paso 4 abierta. SODAX la canceló sola al caducar
// y devolvió los 29 HBAR a la misma dirección; como la cuenta estaba borrada, Hedera creó otra con esa dirección
// (0.0.10967057). Desde ahora: las órdenes enviadas se apuntan en data/acciones-pendientes.json y la Cartera NO se
// cierra mientras alguna pueda devolver dinero; y se devuelve primero con una transferencia (vale también para una
// cuenta «hueca», creada solo con la dirección) y después se cierra.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { AccountDeleteTransaction, AccountId, PrivateKey, TransferTransaction, Hbar } from "@hiero-ledger/sdk";
import {
  Mirror,
  SODAX,
  NETWORKS,
  STOCK_ELIGIBILITY,
  STOCK_PAY,
  STOCK_TOKENS,
  cancelStockOrder,
  createClient,
  formatUnits,
  sendStockEvmTx,
  sodaxApi,
  stockAddress,
  stockOrderState,
  stockSwapFromPocket,
  submit,
  verifyIntentBuild,
} from "@boveda/core";

const ROOT = new URL("..", import.meta.url).pathname;
const KEY_FILE = `${ROOT}data/prueba-acciones-mainnet.key`;
const PEND_FILE = `${ROOT}data/acciones-pendientes.json`;
const back = process.argv.slice(2).find((a) => /^0\.0\.\d{1,10}$/.test(a)) ?? null;
const onlyReturn = process.argv.includes("devolver");
const onlyCancel = process.argv.includes("cancelar");
const HB = 100_000_000n;
const mirror = new Mirror(NETWORKS.mainnet.mirror);
const api = sodaxApi();
const AAPL = STOCK_TOKENS.find((t) => t.symbol === "AAPL");
if (!AAPL) throw new Error("falta AAPL");
const ELIGIBLE = { version: STOCK_ELIGIBILITY.version, country: "ES", notUsPerson: true, readNotice: true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hb = (v) => formatUnits(v, 8, 4);

// ---- llave de la Cartera de prueba ------------------------------------------------------------------------------
mkdirSync(`${ROOT}data`, { recursive: true });
let key;
if (existsSync(KEY_FILE)) key = PrivateKey.fromStringDer(readFileSync(KEY_FILE, "utf8").trim());
else {
  key = PrivateKey.generateECDSA();
  writeFileSync(KEY_FILE, key.toStringDer(), { mode: 0o600 });
}
chmodSync(KEY_FILE, 0o600);
const evm = `0x${key.publicKey.toEvmAddress()}`.toLowerCase();
const acc = await mirror.account(evm).catch(() => null);
if (acc?.deleted) {
  console.log(`La Cartera de prueba ${acc.id} está cerrada y no hay otra cuenta con su dirección ${evm}. No hay nada que devolver.`);
  process.exit(0);
}
if (!acc) {
  console.log(`Cartera de prueba en MAINNET: ${evm} (todavía no existe en la red). Manda 60 HBAR a esa dirección y vuelve a ejecutar.`);
  process.exit(0);
}
const me = acc.id;
if (back && back === me.toString()) {
  console.log(`⛔ ${back} es la propia Cartera de prueba. Pon la cuenta de HashPack a la que quieres que vuelva el dinero.`);
  process.exit(1);
}
if (back && !(await mirror.account(back).catch(() => null))) {
  console.log(`⛔ La cuenta ${back} no existe en mainnet.`);
  process.exit(1);
}
if ((onlyReturn || onlyCancel) && !back) {
  console.log(`Uso: hvault-vps prueba acciones-mainnet ${onlyCancel ? "cancelar" : "devolver"} 0.0.TU_CUENTA`);
  process.exit(1);
}
const client = createClient("mainnet", { accountId: me, key });
const results = [];
const log = [];
const say = (s) => (console.log(s), log.push(s));
const check = (n, name, pass, detail = "", warn = false) => {
  results.push({ n, name, pass });
  say(`${pass ? "✅" : warn ? "⚠️" : "⛔"} ${n}  ${name}`);
  if (detail) say(`      ${detail}`);
};
const balances = async () => {
  const a = await mirror.account(me.toString()).catch(() => null);
  const t = await mirror.accountTokens(me.toString()).catch(() => []);
  const tok = (tid) => t.find((x) => x.tokenId === tid)?.balance ?? 0n;
  return { hbar: a?.balance ?? 0n, aapl: tok(AAPL.id), usdc: tok(STOCK_PAY.USDC.tokenId) };
};
const allowanceTo = async (tokenId) => {
  const r = await fetch(`${NETWORKS.mainnet.mirror}/api/v1/accounts/${me}/allowances/tokens?spender.id=0.0.10495847&token.id=${tokenId}`).then((x) => x.json()).catch(() => null);
  return BigInt(r?.allowances?.[0]?.amount ?? 0);
};
const trade = async ({ side, pay, amountIn }) => {
  const inTok = side === "buy" ? STOCK_PAY[pay].address : stockAddress(AAPL.id);
  const outTok = side === "buy" ? stockAddress(AAPL.id) : STOCK_PAY[pay].address;
  const agreedOut = await api.quote({ tokenSrc: inTok, tokenDst: outTok, amount: amountIn });
  const steps = [];
  const t0 = Date.now();
  const r = await stockSwapFromPocket({ client, key, accountId: me, network: "mainnet", mirror, api, trade: { side, stock: AAPL, pay }, amountIn, agreedOut, slippageBps: 100, eligibility: ELIGIBLE, onStep: (s) => steps.push(s) });
  return { ...r, secs: Math.round((Date.now() - t0) / 1000), steps: steps.join("→") };
};
// ---- Órdenes enviadas que todavía pueden devolver dinero a la dirección de la Cartera ----------------------------
/** @returns {{ txHash: string, intent: any, sentAt: number, deadline: number, amount: string }[]} */
const loadPending = () => {
  try {
    const l = JSON.parse(readFileSync(PEND_FILE, "utf8"));
    return Array.isArray(l) ? l : [];
  } catch {
    return [];
  }
};
const savePending = (l) => writeFileSync(PEND_FILE, JSON.stringify(l, null, 1) + "\n", { mode: 0o600 });
const dropPending = (txHash) => savePending(loadPending().filter((p) => p.txHash !== txHash));
const hhmm = (s) => new Date(s * 1000).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid" });
/** ¿Ha vuelto ya el importe de la orden a ESTA cuenta? (transferencia del SpokeAssetManager de SODAX después de enviarla) */
const refundSeen = async (p) => {
  const r = await fetch(`${NETWORKS.mainnet.mirror}/api/v1/transactions?account.id=${me}&timestamp=gt:${p.sentAt}&limit=100&order=asc`)
    .then((x) => x.json())
    .catch(() => null);
  const amt = BigInt(p.intent.inputAmount);
  return (r?.transactions ?? []).some(
    (t) => t.result === "SUCCESS" && (t.transfers ?? []).some((x) => x.account === SODAX.assetManagerId && BigInt(x.amount) === -amt) && (t.transfers ?? []).some((x) => x.account === me.toString() && BigInt(x.amount) === amt),
  );
};
/** Órdenes que aún pueden devolver dinero: mientras haya alguna, la Cartera NO se cierra. Quita las ya resueltas. */
const stillPending = async () => {
  const out = [];
  for (const p of loadPending()) {
    const s = await stockOrderState(api, p.intent, p.txHash);
    if (s.state === "filled" || (await refundSeen(p))) dropPending(p.txHash);
    else out.push({ ...p, state: s.state });
  }
  return out;
};

/** Un paso que falla no para los siguientes. */
const stepDo = async (n, name, fn) => {
  say(`\n── ${n}. ${name}`);
  try {
    await fn();
  } catch (e) {
    check(n, name, false, e instanceof Error ? e.message : String(e));
  }
};

const start = await balances();
say(`Red mainnet · Cartera de prueba ${me} (${evm}) · ${hb(start.hbar)} HBAR${start.aapl ? ` · ${formatUnits(start.aapl, 8, 8)} AAPL` : ""}${start.usdc ? ` · ${formatUnits(start.usdc, 6, 6)} USDC` : ""}`);

if (!onlyReturn) {
  // 1. El mínimo de SODAX por orden (ronda 1 $): el primer importe que cotiza, +15 %.
  let amt = 0n;
  await stepDo(1, "Mínimo de SODAX por orden", async () => {
    let first = 0n;
    for (const h of [20n, 25n, 30n, 35n, 40n]) {
      const q = await api.quote({ tokenSrc: STOCK_PAY.HBAR.address, tokenDst: stockAddress(AAPL.id), amount: h * HB }).catch(() => null);
      if (q && q > 0n) {
        first = h;
        break;
      }
      await sleep(400);
    }
    amt = first ? ((first * 115n + 99n) / 100n) * HB : 0n;
    check(1, "SODAX cotiza a partir de un mínimo", first > 0n, first ? `cotiza desde ${first} HBAR · esta prueba usa ${hb(amt)} HBAR por orden` : "no cotiza ni con 40 HBAR (¿mercado cerrado?)");
  });
  if (!amt) say("\n⛔ Sin cotización no sigo.");
  else if (start.hbar < amt + 6n * HB) say(`\n⛔ Hacen falta unos ${hb(amt + 6n * HB)} HBAR en la Cartera de prueba (hay ${hb(start.hbar)}). Manda la diferencia a ${evm} y vuelve a ejecutar.`);
  else {
    if (!onlyCancel) await stepDo(2, `Comprar AAPL con ${hb(amt)} HBAR (se junta con lo que quedó de la vez anterior)`, async () => {
      const r = await trade({ side: "buy", pay: "HBAR", amountIn: amt });
      check(2, "Llega a la Cartera al menos el mínimo", r.status === "solved" && r.delivered, `${r.steps} · ${r.secs} s · recibido ${r.received != null ? formatUnits(r.received, 8, 8) : "?"} AAPL (mínimo ${formatUnits(r.minOut, 8, 8)})`);
    });
    if (!onlyCancel) await stepDo(3, "Vender TODO el AAPL (también el resto que no llegaba al mínimo)", async () => {
      const b = await balances();
      if (b.aapl === 0n) throw new Error("no hay AAPL en la Cartera");
      const r = await trade({ side: "sell", pay: "HBAR", amountIn: b.aapl });
      const after = await balances();
      check(3, "Vuelve HBAR, la Cartera queda sin AAPL y el permiso en 0", r.status === "solved" && r.delivered && after.aapl === 0n && (await allowanceTo(AAPL.id)) === 0n, `${r.steps} · ${r.secs} s · vendido ${formatUnits(b.aapl, 8, 8)} AAPL · HBAR ${hb(b.hbar)} → ${hb(after.hbar)}`);
    });
    await stepDo(4, `Orden que nadie completará (${hb(amt)} HBAR, mínimo ×3): cancelarla y que vuelva el HBAR`, async () => {
      const src = (await mirror.account(me.toString()))?.evmAddress?.toLowerCase();
      const q = await api.quote({ tokenSrc: STOCK_PAY.HBAR.address, tokenDst: stockAddress(AAPL.id), amount: amt });
      const minOut = q * 3n;
      const deadline = Math.floor(Date.now() / 1000) + 6 * 60;
      const built = await api.buildIntent({ inputToken: STOCK_PAY.HBAR.address, outputToken: stockAddress(AAPL.id), inputAmount: amt, minOutputAmount: minOut, deadline, srcAddress: src, dstAddress: src });
      const v = verifyIntentBuild(built, { payToken: STOCK_PAY.HBAR.address, outputToken: stockAddress(AAPL.id), inputAmount: amt, minOutputAmount: minOut, srcAddress: src, dstAddress: src, hbarIn: true });
      if (!v.ok) throw new Error(`la intención no cuadra: ${v.problems.join(" · ")}`);
      const sentAt = Math.floor(Date.now() / 1000) - 5;
      const sent = await sendStockEvmTx({ client, key, owner: me.toString(), src, mirror, callData: built.tx.data.toLowerCase(), valueTinybars: v.valueTinybars });
      const pend = { txHash: sent.hash, intent: built.intent, sentAt, deadline, amount: amt.toString() };
      savePending([...loadPending(), pend]); // apuntada ANTES de nada más: la Cartera no se cierra hasta que vuelva el dinero
      await api.submitTx({ txHash: sent.hash, walletAddress: src, intent: built.intent, relayData: built.relayData }).catch(() => undefined);
      say(`      orden enviada ${sent.hash} · caduca a las ${hhmm(deadline)} · puede tardar hasta las ${hhmm(deadline + 8 * 60)}`);
      let s4 = null;
      for (let i = 0; i < 30 && s4?.state !== "open"; i++) {
        await sleep(6000);
        s4 = await stockOrderState(api, built.intent, sent.hash);
      }
      let how;
      const t0 = Date.now();
      if (s4?.state === "open") {
        say(`      abierta en SODAX (${s4.intentHash.slice(0, 12)}…) · cancelando…`);
        try {
          const c = await cancelStockOrder({ client, key, accountId: me, network: "mainnet", mirror, api, intent: built.intent, txHash: sent.hash });
          how = `cancelada por la Cartera (${c.cancelTxHash.slice(0, 12)}…, SODAX: ${c.state})`;
        } catch (e) {
          if (e?.status === "CANCEL_MISMATCH") {
            const raw = await api.cancel(built.intent).catch(() => null);
            say(`      datos de la cancelación (para revisar): ${JSON.stringify(raw?.tx ?? null)}`);
          }
          how = `la cancelación no se pudo enviar (${e instanceof Error ? e.message : String(e)}): se espera a que caduque`;
        }
      } else how = `no se vio abierta (${s4?.state ?? "sin respuesta"}): se espera a que caduque`;
      say(`      ${how}`);
      // El HBAR vuelve por la cancelación o, si no, porque SODAX la cancela sola al caducar (≈ 3 min después).
      const until = (deadline + 8 * 60) * 1000;
      let back4 = await refundSeen(pend);
      while (!back4 && Date.now() < until) {
        await sleep(10_000);
        back4 = await refundSeen(pend);
      }
      if (back4) dropPending(sent.hash);
      const end = await stockOrderState(api, built.intent, sent.hash);
      const byUs = how.startsWith("cancelada");
      check(4, "La orden se cierra y los HBAR vuelven a la Cartera", back4, `${how} · SODAX: ${end.state} · ${back4 ? `vuelven ${hb(amt)} HBAR a los ${Math.round((Date.now() - t0) / 1000)} s${byUs ? "" : " (cancelada por SODAX al caducar)"}` : "todavía no han vuelto: la Cartera NO se cierra"}`, !back4 && end.state === "cancelled");
    });
  }
}

// ---- Vuelta del dinero --------------------------------------------------------------------------------------
// Primero una transferencia (también completa una cuenta «hueca» creada solo con la dirección) y después, si no queda
// nada que pueda volver a esta dirección, se cierra la cuenta.
const pending = await stillPending();
const fin = await balances();
if (back) {
  const tokens = fin.aapl > 0n || fin.usdc > 0n;
  const keepOpen = tokens || pending.length > 0;
  const keep = keepOpen ? 2n * HB : HB; // lo justo para las comisiones de después
  let moved = 0n;
  let out = null;
  if (fin.hbar > keep) {
    out = await submit(client, new TransferTransaction().addHbarTransfer(me, Hbar.fromTinybars((-(fin.hbar - keep)).toString())).addHbarTransfer(AccountId.fromString(back), Hbar.fromTinybars((fin.hbar - keep).toString())));
    if (out?.ok) moved = fin.hbar - keep;
  }
  let closed = false;
  if (!keepOpen && (out === null || out.ok)) {
    const del = await submit(client, new AccountDeleteTransaction().setAccountId(me).setTransferAccountId(AccountId.fromString(back)));
    closed = !!del?.ok;
    if (closed) moved = fin.hbar; // lo transferido más el resto que manda el cierre (menos comisiones)
    else if (!out) out = del;
  }
  if (moved > 0n) say(`\nDevuelto a ${back}: ${hb(moved)} HBAR${closed ? " (menos comisiones) · Cartera de prueba cerrada" : ""}.`);
  else say(`\nNo se ha podido devolver (${out?.status ?? "sin saldo"}): sigue en ${me}.`);
  if (tokens) say(`La Cartera de prueba guarda tokens (${formatUnits(fin.aapl, 8, 8)} AAPL · ${formatUnits(fin.usdc, 6, 6)} USDC): no se cierra.`);
  for (const p of pending) say(`⚠️ Orden ${p.txHash.slice(0, 12)}… (${hb(BigInt(p.amount))} HBAR) aún sin volver (SODAX: ${p.state}; caduca a las ${hhmm(p.deadline)}). La Cartera NO se cierra: vuelve a ejecutar «devolver ${back}» cuando haya vuelto.`);
} else say(`\nLa Cartera de prueba ${me} se queda con ${hb(fin.hbar)} HBAR. Para recuperarlos: hvault-vps prueba acciones-mainnet devolver 0.0.TU_CUENTA`);
const pass = results.filter((r) => r.pass).length;
if (!onlyReturn) say(`\n${pass}/${results.length} correctas · informe en informe-acciones-mainnet.md`);
writeFileSync(`${ROOT}informe-acciones-mainnet.md`, log.join("\n") + "\n");
client.close();
process.exit(onlyReturn || (results.length > 0 && pass === results.length) ? 0 : 1);
