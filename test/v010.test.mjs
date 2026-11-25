// Pruebas sin red de la 0.10: reglas de tokens con comisiones (A2b), recuperación por partes, guardián (expulsiones y
// /vaults), varias wallets e historial completo. Solo importan módulos sin dependencias: corren con «node --test» a
// secas, también sin node_modules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { countdownFeeReason, firstCountdownFeeRisk, parseTokenList, planRecovery } from "../core/src/feepolicy.js";
import { pickEviction, statusAudience, vaultStatusView } from "../core/src/guard.js";
import { FIRST_WALLET_ID, MAX_WALLETS, addWallet, appendDappLog, dappLogKey, initialRegistry, parseDappLog, parseRegistry, removeWallet, selectWallet, walletStorageNames } from "../core/src/wallets.js";
import { activityHorizon, buildActivity, describeForAccount, memoText, mirrorTxId } from "../core/src/activity.js";
import { storageKeys, walletsRegistryKey } from "../core/src/config.js";

const HBAR = 100_000_000n;
const info = (tokenId, { fixedHbar = 0n, fixedTokens = [], keys = [] } = {}) => ({
  tokenId,
  name: tokenId,
  symbol: "T",
  decimals: 0,
  fungible: true,
  fees: { fixedHbar, fixedTokens, fractional: 0, royalty: 0 },
  issuerKeys: keys,
});

// ---------------------------------------------------------------------------------------------------------------------
// A2b · tokens con llave de comisiones
// ---------------------------------------------------------------------------------------------------------------------

test("A2b · un token con llave de comisiones no va en una operación con cuenta atrás (aunque hoy no cobre)", () => {
  assert.equal(countdownFeeReason(info("0.0.1")), null, "sin comisiones ni llave: vale");
  assert.equal(countdownFeeReason(info("0.0.2", { keys: ["feeSchedule"] })), "feeKey", "la prueba A2 de testnet: CAMBIA tenía la llave");
  assert.equal(countdownFeeReason(info("0.0.3", { fixedHbar: 3n * HBAR })), "charges");
  assert.equal(countdownFeeReason(info("0.0.4", { fixedHbar: 10_000_000n })), null, "0,1 HBAR: tolerado");
  assert.equal(countdownFeeReason(info("0.0.5", { fixedTokens: [{ tokenId: "0.0.9", amount: 1n }] })), "charges");
  assert.equal(countdownFeeReason(null), "unknown", "lo que no se sabe qué es, no");
  assert.equal(countdownFeeReason(info("0.0.6", { keys: ["feeSchedule"] }), { trusted: new Set(["0.0.6"]) }), null, "emisor de confianza");
  assert.equal(countdownFeeReason(info("0.0.7", { keys: ["freeze", "wipe"] })), null, "congelar o borrar no cobra a la bóveda");
  const infos = new Map([["0.0.1", info("0.0.1")], ["0.0.2", info("0.0.2", { keys: ["feeSchedule"] })]]);
  assert.deepEqual(firstCountdownFeeRisk(["0.0.1", "0.0.2"], (id) => infos.get(id)), { tokenId: "0.0.2", reason: "feeKey" });
  assert.equal(firstCountdownFeeRisk(["0.0.1"], (id) => infos.get(id)), null);
  assert.deepEqual([...parseTokenList(" 0.0.5, x ,0.0.6,,0.0.06a")], ["0.0.5", "0.0.6"]);
});

test("A2b · recuperación: los tokens con llave se dejan mientras quede algo con qué pagar una comisión", () => {
  const infos = new Map([
    ["0.0.10", info("0.0.10")],
    ["0.0.11", info("0.0.11", { keys: ["feeSchedule"] })],
    ["0.0.12", info("0.0.12", { fixedHbar: 30n * HBAR })],
    ["0.0.13", info("0.0.13")],
    ["0.0.14", info("0.0.14", { keys: ["feeSchedule"] })],
  ]);
  const infoOf = (id) => infos.get(id) ?? null;
  const tokens = [
    { tokenId: "0.0.10", balance: 5n },
    { tokenId: "0.0.11", balance: 7n },
    { tokenId: "0.0.12", balance: 9n },
    { tokenId: "0.0.15", balance: 1n },
    { tokenId: "0.0.16", balance: 0n },
  ];
  const nfts = [
    { tokenId: "0.0.13", serial: 1 },
    { tokenId: "0.0.14", serial: 2 },
  ];
  const first = planRecovery({ tinybars: 40n * HBAR, tokens, nfts, infoOf });
  assert.equal(first.keyedOnly, false);
  assert.equal(first.tinybars, 40n * HBAR);
  assert.deepEqual(first.tokens.map((t) => t.tokenId), ["0.0.10"]);
  assert.deepEqual(first.nfts.map((n) => n.tokenId), ["0.0.13"]);
  assert.deepEqual(
    Object.fromEntries(first.later.map((l) => [l.tokenId, l.reason])),
    { "0.0.11": "feeKey", "0.0.12": "charges", "0.0.15": "unknown", "0.0.14": "feeKey" },
    "el de saldo 0 ni aparece",
  );
  // Cuando la primera ha llegado, en la bóveda solo quedan los de llave (y el que cobra): van solos, 5 como mucho.
  const second = planRecovery({ tinybars: 0n, tokens: [{ tokenId: "0.0.11", balance: 7n }, { tokenId: "0.0.12", balance: 9n }], nfts: [{ tokenId: "0.0.14", serial: 2 }], infoOf });
  assert.equal(second.keyedOnly, true);
  assert.equal(second.tinybars, 0n);
  assert.deepEqual(second.tokens.map((t) => t.tokenId), ["0.0.11"]);
  assert.deepEqual(second.nfts, [], "las colecciones con llave, cuando ya no quede ningún token con llave");
  assert.deepEqual(second.later.map((l) => l.tokenId).sort(), ["0.0.12", "0.0.14"]);
  const third = planRecovery({ tinybars: 0n, tokens: [{ tokenId: "0.0.12", balance: 9n }], nfts: [{ tokenId: "0.0.14", serial: 2 }, { tokenId: "0.0.14", serial: 3 }], infoOf });
  assert.equal(third.keyedOnly, true);
  assert.deepEqual(third.nfts.map((n) => n.serial), [2, 3]);
  // Muchos con llave: de 5 en 5, en una sola operación cada vez.
  const many = Array.from({ length: 7 }, (_, i) => ({ tokenId: `0.0.${100 + i}`, balance: 1n }));
  const keyed = (id) => info(id, { keys: ["feeSchedule"] });
  const m = planRecovery({ tinybars: 0n, tokens: many, nfts: [], infoOf: keyed });
  assert.equal(m.tokens.length, 5);
  assert.equal(m.later.length, 2);
  // Con algo de HBAR (p. ej. recompensas que llegan después), vuelven a quedarse.
  assert.equal(planRecovery({ tinybars: 1n, tokens: many, nfts: [], infoOf: keyed }).tokens.length, 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// Guardián: nadie sale en silencio y /vaults no cuenta nada a desconocidos
// ---------------------------------------------------------------------------------------------------------------------

test("guardián lleno: nunca sale una bóveda en modo robo o con algo pendiente; las de correo, las últimas", () => {
  const c = (id, balance, extra = {}) => ({ id, balance, busy: false, email: false, theft: false, ...extra });
  assert.equal(pickEviction([c("0.0.1", 0n), c("0.0.2", 5n)], 1n), "0.0.1");
  assert.equal(pickEviction([c("0.0.1", 0n, { email: true }), c("0.0.2", 5n)], 10n), "0.0.2", "la del correo se queda aunque esté vacía");
  assert.equal(pickEviction([c("0.0.1", 0n, { email: true }), c("0.0.2", 50n)], 10n), "0.0.1", "si no hay otra, también puede salir");
  assert.equal(pickEviction([c("0.0.1", 0n, { theft: true }), c("0.0.2", 0n, { busy: true })], 10n), null);
  assert.equal(pickEviction([c("0.0.1", 50n)], 50n), null, "solo si tiene MENOS que la que llega");
  assert.equal(pickEviction([], 10n), null);
});

test("/vaults: a un desconocido solo le dice si está registrada; al dueño (con su código) y al servidor, más", () => {
  const v = { pushToken: "ExpoPushToken[x]", theft: { since: 1, until: 2 }, email: { address: "dueno@correo.es", since: 1 }, emailPending: { address: "otro@correo.es", expires: 100 }, pending: { "0.0.9": { status: "requested" } }, h10x: { dao: true, basket: false } };
  const mask = (e) => `${e[0]}***`;
  assert.deepEqual(vaultStatusView(undefined, "public", { now: 50, mask }), { registered: false });
  assert.deepEqual(vaultStatusView(v, "public", { now: 50, mask }), { registered: true });
  const owner = vaultStatusView(v, "owner", { now: 50, mask });
  assert.equal(owner.email, "d***");
  assert.equal(owner.emailPending, "o***");
  assert.equal("pending" in owner, false, "las operaciones pendientes no salen ni para la app");
  assert.equal(vaultStatusView(v, "owner", { now: 200, mask }).emailPending, null, "código caducado");
  assert.ok(vaultStatusView(v, "admin", { now: 50, mask }).pending);
  // Quién pregunta: Caddy y el túnel de Expo SIEMPRE ponen X-Forwarded-For (aunque sea vacía).
  assert.equal(statusAudience({ remote: "127.0.0.1", forwarded: undefined, tokenOk: false }), "admin");
  assert.equal(statusAudience({ remote: "127.0.0.1", forwarded: "", tokenOk: false }), "public");
  assert.equal(statusAudience({ remote: "127.0.0.1", forwarded: "203.0.113.9", tokenOk: true }), "owner");
  assert.equal(statusAudience({ remote: "203.0.113.9", forwarded: undefined, tokenOk: false }), "public");
});

// ---------------------------------------------------------------------------------------------------------------------
// Varias wallets
// ---------------------------------------------------------------------------------------------------------------------

test("varias wallets: la primera conserva los nombres de siempre y las demás guardan aparte", () => {
  const base = storageKeys("mainnet");
  assert.deepEqual(walletStorageNames(base, FIRST_WALLET_ID), base, "actualizar no mueve ninguna llave");
  const w2 = walletStorageNames(base, "w2");
  assert.equal(w2.profile, "boveda.mainnet.profile.v1.w2");
  assert.equal(w2.pocketKey, "boveda.mainnet.pocketKey.v1.w2");
  assert.ok(/^[A-Za-z0-9._-]+$/.test(w2.pocketKey), "nombre válido para el llavero (SecureStore)");
  assert.equal(w2.pocketKey.replace("pocketKey", "kitPending"), "boveda.mainnet.kitPending.v1.w2", "el kit pendiente también va aparte");
  assert.throws(() => walletStorageNames(base, "../x"));
  assert.equal(walletsRegistryKey("testnet"), "boveda.wallets.v1");
  assert.equal(walletsRegistryKey("mainnet"), "boveda.mainnet.wallets.v1");
});

test("varias wallets: registro, añadir, cambiar y quitar", () => {
  assert.deepEqual(parseRegistry(null), initialRegistry());
  assert.deepEqual(parseRegistry("{roto"), initialRegistry());
  assert.deepEqual(parseRegistry(JSON.stringify({ version: 1, active: "w9", wallets: [{ id: "w1" }, { id: "w1" }, { id: "../x" }, { id: "w3", createdAt: 5 }] })), {
    version: 1,
    active: "w1",
    wallets: [
      { id: "w1", createdAt: 0 },
      { id: "w3", createdAt: 5 },
    ],
  });
  let reg = initialRegistry();
  const a = addWallet(reg, 100);
  assert.equal(a.id, "w2");
  assert.equal(a.registry.active, "w2", "la nueva queda activa: la app enseña la bienvenida");
  reg = selectWallet(a.registry, "w1");
  assert.equal(reg.active, "w1");
  assert.throws(() => selectWallet(reg, "w7"));
  reg = removeWallet(reg, "w1", 200);
  assert.deepEqual(reg, { version: 1, active: "w2", wallets: [{ id: "w2", createdAt: 100 }] });
  reg = removeWallet(reg, "w2", 300);
  assert.deepEqual(reg, { version: 1, active: FIRST_WALLET_ID, wallets: [{ id: FIRST_WALLET_ID, createdAt: 300 }] }, "sin ninguna, la de siempre, vacía");
  let full = initialRegistry();
  for (let i = 1; i < MAX_WALLETS; i++) full = addWallet(full, i).registry;
  assert.throws(() => addWallet(full, 99));
});

// ---------------------------------------------------------------------------------------------------------------------
// Historial completo (con transacciones reales de la prueba A2 en testnet: cuentas del propio equipo)
// ---------------------------------------------------------------------------------------------------------------------

const POCKET = "0.0.11443409";
const VAULT = "0.0.11443412";
const NOTARY = "0.0.11443411";
const tx = (o) => ({ token_transfers: [], nft_transfers: [], staking_reward_transfers: [], memo_base64: "", scheduled: false, result: "SUCCESS", entity_id: null, ...o });
const TXS = {
  // La bóveda vacía la envía a otra cuenta (evacuación) y paga la Cartera.
  evacuation: tx({ charged_tx_fee: 313465, consensus_timestamp: "1794584098.001309548", memo_base64: "SHZhdWx0IMK3IGV2YWN1YWNpw7Nu", name: "CRYPTOTRANSFER", transaction_id: "0.0.11443409-1794584094-360878962", transfers: [{ account: "0.0.802", amount: 313465 }, { account: "0.0.11424113", amount: 800000000 }, { account: POCKET, amount: -313465 }, { account: VAULT, amount: -800000000 }] }),
  send: tx({ charged_tx_fee: 156732, consensus_timestamp: "1794584102.085127104", name: "CRYPTOTRANSFER", transaction_id: "0.0.11443409-1794584098-468491801", transfers: [{ account: "0.0.802", amount: 156732 }, { account: "0.0.11424113", amount: 1721200172 }, { account: POCKET, amount: -1721356904 }] }),
  notary: tx({ charged_tx_fee: 6869849, consensus_timestamp: "1794583990.484748170", entity_id: NOTARY, name: "CONTRACTCALL", transaction_id: "0.0.11443409-1794583982-722405685", transfers: [{ account: "0.0.802", amount: 6869849 }, { account: POCKET, amount: -6869849 }] }),
  // Crear la bóveda con 8 HBAR desde la Cartera.
  vaultCreated: tx({ charged_tx_fee: 125386607, consensus_timestamp: "1794583959.524721241", entity_id: VAULT, name: "CRYPTOCREATEACCOUNT", transaction_id: "0.0.11443409-1794583955-402686160", transfers: [{ account: "0.0.802", amount: 125386607 }, { account: POCKET, amount: -925386607 }, { account: VAULT, amount: 800000000 }] }),
  received: tx({ charged_tx_fee: 78523362, consensus_timestamp: "1794583953.884548104", entity_id: POCKET, name: "CRYPTOCREATEACCOUNT", transaction_id: "0.0.11424113-1794583945-898964277", transfers: [{ account: "0.0.802", amount: 78523362 }, { account: "0.0.11424113", amount: -4878523362 }, { account: POCKET, amount: 4800000000 }] }),
  tokenGift: tx({ charged_tx_fee: 79933960, consensus_timestamp: "1794583984.061547488", name: "CRYPTOTRANSFER", transaction_id: "0.0.11424113-1794583976-898094508", transfers: [{ account: "0.0.802", amount: 79933960 }, { account: "0.0.11424113", amount: -79933960 }], token_transfers: [{ token_id: "0.0.11443419", account: "0.0.11424113", amount: -50 }, { token_id: "0.0.11443419", account: VAULT, amount: 50 }] }),
};

test("historial: cada transacción, contada para la Cartera y para la bóveda", () => {
  const acc = { pocket: POCKET, vault: VAULT, notary: NOTARY };
  const send = describeForAccount(TXS.send, "pocket", acc);
  assert.equal(send.kind, "sent");
  assert.equal(send.hbar, -1721200172n, "lo enviado, sin la comisión");
  assert.equal(send.fee, 156732n);
  assert.equal(send.counterparty, "0.0.11424113");
  assert.equal(describeForAccount(TXS.send, "vault", acc), null, "no toca la bóveda");
  assert.equal(describeForAccount(TXS.notary, "pocket", acc).kind, "vaultOp");
  const created = describeForAccount(TXS.vaultCreated, "pocket", acc);
  assert.equal(created.kind, "vaultCreated");
  assert.equal(created.hbar, -800000000n);
  const recv = describeForAccount(TXS.received, "pocket", acc);
  assert.equal(recv.kind, "received");
  assert.equal(recv.hbar, 4800000000n);
  assert.equal(recv.fee, 0n, "la comisión la pagó otro");
  assert.equal(recv.counterparty, "0.0.11424113");
  const gift = describeForAccount(TXS.tokenGift, "vault", acc);
  assert.equal(gift.kind, "received");
  assert.deepEqual(gift.tokens, [{ tokenId: "0.0.11443419", amount: 50n }]);
  assert.equal(memoText(TXS.evacuation.memo_base64), "Hvault · evacuación");
});

test("historial: Cartera y bóveda juntas, sin repetir lo que toca a las dos, y las firmas para dApps", () => {
  const acc = { pocket: POCKET, vault: VAULT, notary: NOTARY };
  const pocket = [TXS.send, TXS.evacuation, TXS.notary, TXS.vaultCreated, TXS.received];
  const vault = [TXS.evacuation, TXS.tokenGift, TXS.vaultCreated];
  const items = buildActivity({ pocket, vault, accounts: acc, dapps: new Map([["0.0.11443409-1794584098-468491801", "SaucerSwap"]]) });
  assert.equal(items.length, 6, "evacuación y creación salen una sola vez");
  assert.deepEqual(items.map((i) => i.consensus), [...items.map((i) => i.consensus)].sort().reverse(), "de lo más nuevo a lo más viejo");
  const evac = items.find((i) => i.txId === TXS.evacuation.transaction_id);
  assert.equal(evac.where, "both");
  assert.equal(evac.kind, "sent", "la bóveda envía; la Cartera solo paga la comisión");
  assert.equal(evac.hbar, -800000000n);
  assert.equal(evac.fee, 313465n);
  assert.equal(evac.counterparty, "0.0.11424113");
  const created = items.find((i) => i.txId === TXS.vaultCreated.transaction_id);
  assert.equal(created.kind, "vaultCreated");
  assert.equal(items.find((i) => i.txId === TXS.send.transaction_id).via, "SaucerSwap");
  // Guardar en la bóveda: un movimiento entre las dos, no dinero que sale.
  const dep = tx({ charged_tx_fee: 100, consensus_timestamp: "1794590000.000000001", name: "CRYPTOTRANSFER", transaction_id: "0.0.11443409-1794589990-1", transfers: [{ account: "0.0.802", amount: 100 }, { account: POCKET, amount: -500000100 }, { account: VAULT, amount: 500000000 }] });
  const [d] = buildActivity({ pocket: [dep], vault: [dep], accounts: acc });
  assert.equal(d.kind, "deposit");
  assert.equal(d.where, "both");
  assert.equal(d.hbar, -500000000n);
  assert.equal(d.counterparty, null);
});

test("historial: cambio por SaucerSwap, staking y un fallo", () => {
  const ROUTER = "0.0.3949434";
  const acc = { pocket: "0.0.5000", vault: "0.0.6000", routers: [ROUTER] };
  const swap = tx({ charged_tx_fee: 1000, consensus_timestamp: "1795000000.000000001", entity_id: ROUTER, name: "CONTRACTCALL", transaction_id: "0.0.5000-1794999990-1", transfers: [{ account: "0.0.98", amount: 1000 }, { account: "0.0.5000", amount: -1000001000 }, { account: "0.0.7777", amount: 1000000000 }], token_transfers: [{ token_id: "0.0.10907484", account: "0.0.7777", amount: -123 }, { token_id: "0.0.10907484", account: "0.0.5000", amount: 123 }] });
  const s = describeForAccount(swap, "pocket", acc);
  assert.equal(s.kind, "swap");
  assert.equal(s.hbar, -1000000000n);
  assert.deepEqual(s.tokens, [{ tokenId: "0.0.10907484", amount: 123n }]);
  // Las recompensas vienen dentro de «transfers» (0.0.800 → cuenta) y aparte: no se cuentan dos veces.
  const reward = tx({ charged_tx_fee: 95110073, consensus_timestamp: "1795000001.000000001", name: "CRYPTOAPPROVEALLOWANCE", transaction_id: "0.0.5000-1794999991-1", staking_reward_transfers: [{ account: "0.0.5000", amount: 5911752 }], transfers: [{ account: "0.0.800", amount: -5911752 }, { account: "0.0.802", amount: 95110073 }, { account: "0.0.5000", amount: -89198321 }] });
  const r = describeForAccount(reward, "pocket", acc);
  assert.equal(r.kind, "allowance");
  assert.equal(r.hbar, 0n);
  assert.equal(r.reward, 5911752n);
  assert.equal(r.fee, 95110073n);
  const failed = describeForAccount({ ...TXS.send, result: "INSUFFICIENT_PAYER_BALANCE", transaction_id: "0.0.5000-1-2", transfers: [{ account: "0.0.5000", amount: -5 }, { account: "0.0.3", amount: 5 }], charged_tx_fee: 5 }, "pocket", acc);
  assert.equal(failed.ok, false);
  assert.equal(failed.hbar, 0n, "un fallo solo cuesta la comisión");
});

test("historial: hasta dónde se puede enseñar sin huecos al leer dos cuentas por páginas", () => {
  assert.equal(activityHorizon([{ items: [{ consensus_timestamp: "3" }, { consensus_timestamp: "2" }], done: false }, { items: [{ consensus_timestamp: "5" }], done: false }]), "5");
  assert.equal(activityHorizon([{ items: [{ consensus_timestamp: "3" }], done: true }, { items: [], done: true }]), "");
});

test("firmas para dApps: registro por wallet, de lo más nuevo a lo más viejo, y su transacción en formato del mirror", () => {
  const base = storageKeys("mainnet");
  assert.equal(dappLogKey(base, "w1"), "boveda.mainnet.dapplog.v1.w1");
  assert.equal(dappLogKey(storageKeys("testnet"), "w2"), "boveda.dapplog.v1.w2");
  assert.throws(() => dappLogKey(base, "../x"));
  let raw = null;
  for (let i = 0; i < 205; i++) raw = JSON.stringify(appendDappLog(raw, { at: i, dapp: "SaucerSwap", method: "hedera_signAndExecuteTransaction", txId: null }));
  const log = parseDappLog(raw);
  assert.equal(log.length, 200);
  assert.equal(log[0].at, 204);
  assert.deepEqual(parseDappLog("{roto"), []);
  assert.deepEqual(parseDappLog(JSON.stringify([{ at: "x" }, { at: 1, dapp: "A", method: "m", txId: 5 }, { at: 2, dapp: "B", method: "m", txId: null }])), [{ at: 2, dapp: "B", method: "m", txId: null }]);
  // Del SDK («@» y «.»), del propio mirror y del cuerpo de la transacción (protobuf, con Long): siempre igual.
  assert.equal(mirrorTxId("0.0.5@1794479350.965951975"), "0.0.5-1794479350-965951975");
  assert.equal(mirrorTxId("0.0.5@1794479350.000000005?scheduled"), "0.0.5-1794479350-000000005");
  assert.equal(mirrorTxId("0.0.5-1794479350-5"), "0.0.5-1794479350-000000005");
  const long = (v) => ({ toString: () => String(v) });
  assert.equal(mirrorTxId({ accountID: { shardNum: 0, realmNum: 0, accountNum: long(77) }, transactionValidStart: { seconds: long(1794479350), nanos: 12 } }), "0.0.77-1794479350-000000012");
  assert.equal(mirrorTxId("hola"), null);
  assert.equal(mirrorTxId({ accountID: null }), null);
});

// ---------------------------------------------------------------------------------------------------------------------
// La app (sin red): lo que no se puede ejecutar aquí se comprueba sobre su código
// ---------------------------------------------------------------------------------------------------------------------

const ROOT = new URL("..", import.meta.url);
const read = (f) => readFileSync(new URL(f, ROOT), "utf8");
const body = (src, start, end) => {
  const i = src.indexOf(start);
  assert.ok(i >= 0, `no encuentro «${start}»`);
  const j = src.indexOf(end, i + start.length);
  return src.slice(i, j < 0 ? undefined : j);
};

test("app 0.10: lo que no puede salir con cuenta atrás no se pide, y se mira antes de pedir Face ID", () => {
  const w = read("app/src/wallet.tsx");
  const withdraw = body(w, "const withdraw = useCallback(", "const enableVaultTokens");
  assert.ok(withdraw.indexOf("countdownRisk([asset])") > 0 && withdraw.indexOf("countdownRisk([asset])") < withdraw.indexOf("pocketClient()"), "retirada: primero el token, después Face ID");
  const nfts = body(w, "const withdrawNfts = useCallback(", "const sendNftsFromPocket");
  assert.ok(nfts.indexOf("countdownRisk(") > 0 && nfts.indexOf("countdownRisk(") < nfts.indexOf("pocketClient()"), "NFT: igual");
  assert.match(w, /countdownFeeReason\(info\)/);
  assert.match(w, /«Evacuar»/);
  // La recuperación con el kit deja para el final los tokens con llave de comisiones (core/feepolicy.js).
  const recover = body(w, "const recoverWithKit = useCallback", "/** ¿Está la bóveda de este móvil en modo robo");
  assert.match(recover, /planRecovery\(\{ tinybars: v2\.balance/);
  assert.match(recover, /ask\(\{ tinybars: plan\.tinybars \}\)/);
  assert.doesNotMatch(recover, /ask\(\{ tinybars: v2\.balance \}\)/);
});

test("app 0.10: el código de lectura del guardián se guarda al registrar y se manda al preguntar; si la echan, se ve", () => {
  const w = read("app/src/wallet.tsx");
  assert.match(w, /readToken = typeof out\?\.readToken === "string"/);
  assert.match(w, /"x-h10x-token": token/);
  assert.doesNotMatch(w, /fetchJson\(`\$\{url\}\/vaults\//, "a /vaults siempre con guardianVaultView (con el código)");
  assert.match(w, /setGuardianLost\(!v\.registered\)/);
  assert.match(read("app/src/screens/Home.tsx"), /<GuardianLostCard \/>/);
  assert.match(read("app/src/storage.ts"), /readToken\?: string/);
});

test("app 0.10: varias wallets, cada una con lo suyo; cambiar de wallet monta todo de nuevo sin pedir Face ID otra vez", () => {
  const app = read("app/App.tsx");
  assert.match(app, /<WalletProvider key=\{active\} walletId=\{active\} onWiped=\{removeActive\}/);
  // Lo que depende de la wallet va dentro (se monta de nuevo); precios y logos, fuera.
  const tree = body(app, "function ActiveWallet()", "export default function App()");
  assert.match(tree, /<GuardianStatusProvider>\s*<DappsProvider>\s*<DerecProvider>\s*<Shell \/>\s*<\/DerecProvider>/);
  assert.ok(app.indexOf("<PricesProvider>") < app.indexOf("<WalletsProvider>"));
  const storage = read("app/src/storage.ts");
  assert.match(storage, /walletStorageNames\(BASE, walletId\)/);
  assert.doesNotMatch(storage, /^export async function (loadProfile|saveProfile|readPocketKey|storePocketKey|wipeWallet)/m, "nada de almacenamiento global");
  const w = read("app/src/wallet.tsx");
  assert.match(w, /const store = useMemo\(\(\) => walletStorage\(walletId\), \[walletId\]\)/);
  assert.doesNotMatch(w, /\b(?<!store\.)(loadProfile|saveProfile|readPocketKey|storePocketKey|wipeWallet|clearStaleKey|readPendingKit|clearPendingKit)\(/, "siempre el almacenamiento de su wallet");
  const lock = read("app/src/LockGate.tsx");
  assert.match(lock, /useState\(enabled && !unlockedSession\)/);
  assert.match(lock, /unlockedSession = false;\s*setLocked\(true\)/);
});

test("app 0.10: WalletConnect quita sus oyentes al cambiar de wallet y no firma por una sesión de otra wallet", () => {
  const wc = read("app/src/walletconnect.tsx");
  for (const ev of ["session_proposal", "session_request", "session_delete"]) assert.match(wc, new RegExp(`kit\\.off\\("${ev}"`), ev);
  assert.match(wc, /detach\?\.\(\);\s*kitRef\.current = null;/);
  assert.match(wc, /sessionAccounts\(session\)\.includes\(`\$\{CHAIN_ID\}:\$\{account\}`\)/);
  assert.match(wc, /addDappLog\(\{ at:/);
});

test("app 0.10: historial completo con sus iconos de Android, versión 0.10.x y sin el correo al crear la bóveda", () => {
  const h = read("app/src/history.tsx");
  const map = body(h, "export const KIND_ICON", "};");
  const icons = [...map.matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(icons.length >= 18);
  const ui = read("app/src/ui.tsx");
  const android = body(ui, "const ANDROID_ICONS", "};");
  for (const i of icons) assert.ok(android.includes(`"${i}":`) || new RegExp(`\\b${i}:`).test(android), `sin icono de Android: ${i}`);
  assert.match(h, /mirror\.accountTransactions\(accountId/);
  assert.match(h, /activityHorizon\(/);
  assert.match(read("app/src/screens/Home.tsx"), /<HistoryList history=\{history\} \/>/);
  assert.match(JSON.parse(read("app/app.json")).expo.version, /^0\.10\.\d+$/);
  // Decisión del dueño: en la 0.10 el correo NO se pide al crear la bóveda (se pone en Ajustes, con el kit).
  assert.doesNotMatch(read("app/src/screens/Onboarding.tsx"), /emailStart|EmailStep/);
});

test("guardián 0.14: bloquea al verla la retirada con un token de riesgo; /vaults según quién pregunta; nadie sale en silencio", () => {
  const g = read("guardian/src/index.js");
  assert.match(g, /const VERSION = "0\.14\.0"/);
  assert.match(g, /feeRisk = await feeRiskOf\(/);
  assert.match(g, /if \(keyed && withdrawV2\) \{[\s\S]{0,200}vetoPending\(vaultId, v, scheduleId, "forbidden"\)/);
  assert.match(g, /if \(charging && withdrawV2\) \{[\s\S]{0,200}vetoPending\(vaultId, v, scheduleId, "forbidden"\)/);
  assert.match(g, /return \{ ok: true, readToken \}/);
  assert.match(g, /vaultStatusView\(v, who,/);
  assert.match(g, /const out = pickEviction\(candidates, wanted\)/);
  assert.match(g, /El guardián ya no vigila tu bóveda/);
  // Notas neutras: ni la bóveda ni el kit dicen lo que son.
  const v2 = read("core/src/v2.js");
  assert.doesNotMatch(v2, /setAccountMemo\("H10X Wallet/);
  assert.doesNotMatch(v2, /memo: v3 \? "H10X Wallet/);
});
