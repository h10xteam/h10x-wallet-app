// H10X dentro de la wallet (core/src/h10x.js), los avisos del guardián (guardian/src/h10x-watch.js) y el registro v3,
// SIN red. Los datos de ejemplo siguen el formato real de nav.json y dao.json de h10xindex.xyz (nav-service.js y
// dao.js del proyecto H10X) y los eventos de la bóveda son copias de logs reales de mainnet.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@hiero-ledger/sdk";
import {
  H10X_MAINNET,
  H10X_TOKEN_BY_NETWORK,
  H10X_VAULT_EVENTS,
  cleanLabel,
  daoPhaseAt,
  h10xPrefsCode,
  h10xShare,
  parseDao,
  parseDaoMessage,
  parseH10xPrefs,
  parseHistory,
  parseNav,
  registrationMessage,
  signRegistration,
  vaultBasketEvent,
  verifyRegistration,
} from "@boveda/core";
import { createH10xWatcher } from "../guardian/src/h10x-watch.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** nav.json como lo publica nav-service.js (modo bóveda), recortado a dos componentes. */
const NAV = {
  updatedAt: "2026-11-19T09:00:00.000Z",
  network: "mainnet",
  mode: "vault",
  nav: 0.66,
  change24h: 1.25,
  change7d: -3.5,
  hbarUsd: 0.059,
  tvlUsd: 2146,
  supply: 3251.555,
  vault: { id: "0.0.10907483", tokenId: "0.0.10907484" },
  pools: [
    { venue: "V2", priceUsd: 0.655, premiumBps: -76 },
    { venue: "V1", priceUsd: 0.65, premiumBps: -152 },
  ],
  components: [
    { key: "WHBAR", symbol: "WHBAR", name: "Wrapped HBAR", tokenId: "0.0.1456986", decimals: 8, units: 2.21, priceUsd: 0.059, weight: 0.2, targetWeight: 0.2, change24h: 0.5 },
    { key: "WBTC", symbol: "WBTC", name: "Wrapped BTC", tokenId: "0.0.10082597", decimals: 8, units: 0.0000014, priceUsd: 94000, weight: 0.2, targetWeight: 0.2, change24h: 1.1 },
  ],
};

test("nav.json: se valida, se limpia y da tu parte de la cesta", () => {
  const nav = parseNav(NAV);
  assert.ok(nav);
  assert.equal(nav.nav, 0.66);
  assert.equal(nav.tokenId, H10X_MAINNET.tokenId);
  assert.equal(nav.components.length, 2);
  assert.deepEqual(nav.pools.map((p) => p.venue), ["V2", "V1"]);
  const share = h10xShare(nav, 250_000_000n); // 2,5 H10X
  assert.equal(share.h10x, 2.5);
  assert.ok(Math.abs(share.usd - 1.65) < 1e-9);
  assert.ok(Math.abs(share.items[0].amount - 5.525) < 1e-9, "2,5 × 2,21 WHBAR");
  assert.ok(Math.abs(share.hbar - 1.65 / 0.059) < 1e-9);

  // Modo índice (sin bóveda), otra red o un NAV raro: no vale
  assert.equal(parseNav({ ...NAV, mode: "model" }), null);
  assert.equal(parseNav({ ...NAV, network: "testnet" }), null);
  assert.equal(parseNav({ ...NAV, nav: -1 }), null);
  assert.equal(parseNav({ ...NAV, components: [] }), null);
  assert.equal(parseNav("hola"), null);
  // Textos raros o con enlaces se quitan
  const evil = parseNav({ ...NAV, components: [{ ...NAV.components[0], symbol: "WHBAR‮", name: "Reclama en https://falso.example/" }, NAV.components[1]] });
  assert.equal(evil.components[0].symbol, "WHBAR");
  assert.equal(evil.components[0].name, "WHBAR", "un nombre con enlace se cambia por el símbolo");
  assert.equal(cleanLabel("x".repeat(50), 12).length, 12);
  assert.equal(cleanLabel("visita www.falso.com"), "");
});

test("history.json: en orden y sin puntos raros", () => {
  assert.deepEqual(parseHistory({ points: [[1, 0.6], [2, null], [2, 0.61], [1, 0.62], [3, 0.63], ["x", 1]] }), [
    [1, 0.6],
    [2, 0.61],
    [3, 0.63],
  ]);
  assert.deepEqual(parseHistory(null), []);
});

/** dao.json como lo publica dao.js (publicJson + tallyRound), con dos candidatos. */
const DAO = {
  v: 1,
  updatedAt: "2026-11-19T09:00:00.000Z",
  network: "mainnet",
  topicId: "0.0.10939164",
  round: {
    id: "2027Q1",
    phase: "propose",
    proposeEnd: 1795856400, // 28-nov-2026 10:00 Madrid
    voteStart: 1796115600,
    voteEnd: 1796720400,
    slots: 2,
    rules: { token: "0.0.10907484", decimals: 8, minPropose: "100", holdDays: 7, fee: "10", feeAccount: "0.0.10353916", quorumBps: 1000 },
    key: { revealAt: 1796893200 },
    revealed: null,
    candidates: [
      { token: "0.0.3210123", symbol: "STEAM", proposer: "0.0.10894592", team: true, filter: { official: false, status: "pending" }, votes: null },
      { token: "0.0.999", proposer: "0.0.1234", team: false, filter: { official: true, status: "rejected" }, votes: { weight: "12500000000", count: 3 } },
    ],
    quorum: { reached: false },
    winners: [],
    result: null,
  },
  past: [{ id: "2026Q4", voteEnd: 1790000000, winners: ["0.0.1460200"], quorum: true }],
};

test("dao.json: fases por los plazos, candidatos y rondas anteriores", () => {
  const r = DAO.round;
  assert.equal(daoPhaseAt(r, r.proposeEnd - 1), "propose");
  assert.equal(daoPhaseAt(r, r.proposeEnd), "review");
  assert.equal(daoPhaseAt(r, r.voteStart + 10), "vote");
  assert.equal(daoPhaseAt(r, r.voteEnd), "closed");
  const s = parseDao(DAO, r.proposeEnd - 3600);
  assert.ok(s?.round);
  assert.equal(s.round.phase, "propose");
  assert.equal(s.round.quorumPct, 10);
  assert.equal(s.round.minPropose, "100");
  assert.deepEqual(
    s.round.candidates.map((c) => [c.symbol, c.filter, c.team, c.votes]),
    [
      ["STEAM", "pending", true, null],
      ["", "rejected", false, 125],
    ],
  );
  assert.equal(s.past[0].winners[0], "0.0.1460200");
  // Acabada la votación pero con los votos aún cerrados: escrutinio
  assert.equal(parseDao(DAO, r.voteEnd + 60).round.phase, "counting");
  assert.equal(parseDao({ ...DAO, round: { ...r, revealed: "result", phase: "closed" } }, r.voteEnd + 60).round.phase, "closed");
  // Datos raros: no vale o se ignora la ronda
  assert.equal(parseDao({ ...DAO, v: 2 }, 0), null);
  assert.equal(parseDao({ ...DAO, round: { ...r, voteStart: r.voteEnd + 1 } }, 0).round, null);
  assert.equal(parseDao({ ...DAO, round: { ...r, id: "../../" } }, 0).round, null);
});

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const msg = (seq, ts, payer, body, extra = {}) => ({ sequence_number: seq, consensus_timestamp: `${ts}.000000001`, payer_account_id: payer, message: b64(body), ...extra });
const ROUND_MSG = { v: 1, type: "round", round: "2027Q1", proposeEnd: 2_000_100, voteStart: 2_000_200, voteEnd: 2_400_000, slots: 2 };

test("mensajes del topic de la DAO", () => {
  const p = parseDaoMessage(msg(5, 2_000_000, H10X_MAINNET.daoOps, ROUND_MSG));
  assert.deepEqual(p, { seq: 5, ts: 2_000_000, payer: H10X_MAINNET.daoOps, body: { type: "round", round: "2027Q1", proposeEnd: 2_000_100, voteStart: 2_000_200, voteEnd: 2_400_000, slots: 2 } });
  const r = parseDaoMessage(msg(9, 2_500_000, H10X_MAINNET.daoOps, { v: 1, type: "result", round: "2027Q1", winners: ["0.0.3210123", "nope"], quorum: true }));
  assert.deepEqual(r.body, { type: "result", round: "2027Q1", winners: ["0.0.3210123"], quorum: true });
  assert.equal(parseDaoMessage(msg(1, 1, "0.0.1", { v: 2, type: "round", round: "2027Q1" })), null);
  assert.equal(parseDaoMessage(msg(1, 1, "0.0.1", { v: 1, type: "round", round: "2027Q5", proposeEnd: 1, voteStart: 2, voteEnd: 3 })), null);
  assert.equal(parseDaoMessage(msg(1, 1, "0.0.1", ROUND_MSG, { chunk_info: { total: 2 } })), null);
  assert.equal(parseDaoMessage({ sequence_number: 1, consensus_timestamp: "1.1", message: Buffer.from("no es json").toString("base64") }), null);
});

// Logs reales de la bóveda de H10X en mainnet (lanzamiento del 10-nov y salida de BONZO).
const LOG_ADDED = { topics: ["0x76da6cf8b40dd2b2c223a5956831e0ff4e75522538a86782108a0bbe1577e298", "0x0000000000000000000000000000000000000000000000000000000000163b5a"], timestamp: "1791292795.640834104" };
const LOG_WEIGHTS = { topics: ["0xcb9413bed8f2ec44dc670303b6e1fe09ad516a972f69488c3d1e5976a733057a"], timestamp: "1791706281.787482105" };
const LOG_REMOVED = { topics: ["0xc605d0bf97f9b921340106a2e59f9428d5eb9039b16866159e0cdd2bf8e963df", "0x000000000000000000000000000000000000000000000000000000000011afa2"], timestamp: "1791706578.324497608" };

test("eventos de cesta de la bóveda de H10X (logs reales)", () => {
  assert.equal(H10X_VAULT_EVENTS.added, LOG_ADDED.topics[0]);
  assert.deepEqual(vaultBasketEvent(LOG_ADDED), { kind: "added", token: "0.0.1456986" });
  assert.deepEqual(vaultBasketEvent(LOG_REMOVED), { kind: "removed", token: "0.0.1159074" });
  assert.deepEqual(vaultBasketEvent(LOG_WEIGHTS), { kind: "weights", token: null });
  assert.equal(vaultBasketEvent({ topics: ["0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0"] }), null, "otros eventos no cuentan");
});

test("preferencias de avisos y registro v3 firmado", () => {
  assert.equal(h10xPrefsCode({ dao: true, basket: true }), "db");
  assert.equal(h10xPrefsCode({ dao: false, basket: false }), "-");
  assert.deepEqual(parseH10xPrefs("b"), { dao: false, basket: true });
  assert.deepEqual(parseH10xPrefs("-"), { dao: false, basket: false });
  for (const bad of ["", "x", "bd", "dd", null, 1]) assert.equal(parseH10xPrefs(bad), null, String(bad));

  const key = PrivateKey.generateECDSA();
  const base = { vaultId: "0.0.5", notaryId: "0.0.6", pocketId: "0.0.7", pushToken: null, timestamp: 1700000000, lang: "es" };
  assert.match(registrationMessage({ ...base, h10x: "d" }), /^boveda-registro:v3\|0\.0\.5\|0\.0\.6\|0\.0\.7\|\|1700000000\|es\|d$/);
  assert.match(registrationMessage(base), /^boveda-registro:v2\|/, "sin preferencias, el formato de siempre");
  const signed = signRegistration(key, { ...base, h10x: "d" });
  assert.ok(verifyRegistration(key.publicKey, signed));
  assert.ok(!verifyRegistration(key.publicKey, { ...signed, h10x: "db" }), "cambiar las preferencias rompe la firma");
  assert.equal(H10X_TOKEN_BY_NETWORK.testnet, "0.0.10872951");
});

// ---- El vigilante del guardián con un mirror de mainnet simulado ----------------------------------

function fakeMirror() {
  const messages = [];
  const logs = [];
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    const json = (o) => ({ ok: true, status: 200, json: async () => o });
    if (u.pathname.endsWith("/messages")) {
      const gt = Number((u.searchParams.get("sequencenumber") || "gt:0").split(":")[1]);
      return json({ messages: messages.filter((m) => m.sequence_number > gt), links: { next: null } });
    }
    if (u.pathname.endsWith("/results/logs")) {
      if (u.searchParams.get("order") === "desc") return json({ logs: logs.slice(-1).reverse(), links: { next: null } });
      const ts = (u.searchParams.get("timestamp") || "gt:0").split(":")[1];
      return json({ logs: logs.filter((l) => Number(l.timestamp) > Number(ts)), links: { next: null } });
    }
    if (u.pathname.startsWith("/api/v1/tokens/")) return json({ symbol: { "0.0.3210123": "STEAM", "0.0.1159074": "BONZO" }[u.pathname.split("/").pop()] ?? "TOK" });
    return { ok: false, status: 500, json: async () => ({}) };
  };
  return { messages, logs, calls, fetchImpl };
}

test("vigilante de H10X: la primera vez no avisa de lo pasado; después, ronda, votación, últimas 24 h, resultado y cesta", async () => {
  const m = fakeMirror();
  const OPS = H10X_MAINNET.daoOps;
  // Ya había una ronda vieja y un evento de la bóveda antes de arrancar
  m.messages.push(msg(1, 1_000_000, OPS, { ...ROUND_MSG, round: "2026Q4", proposeEnd: 1_000_100, voteStart: 1_000_200, voteEnd: 1_100_000 }));
  m.logs.push(LOG_ADDED);
  const w = createH10xWatcher({ mirrorUrl: "http://mirror.test", fetchImpl: m.fetchImpl });
  const st = {};
  assert.deepEqual(await w.poll(st, 1_900_000), [], "primera vuelta: solo toma nota");
  assert.equal(st.topicSeq, 1);
  assert.equal(st.logTs, LOG_ADDED.timestamp);

  // Ronda nueva (oficial) y otra de alguien que no es la cuenta oficial (no cuenta)
  m.messages.push(msg(2, 2_000_000, OPS, ROUND_MSG));
  m.messages.push(msg(3, 2_000_001, "0.0.666", { ...ROUND_MSG, round: "2027Q2" }));
  let ev = await w.poll(st, 2_000_050);
  assert.deepEqual(ev, [{ kind: "dao-open", round: "2027Q1", proposeEnd: 2_000_100, voteStart: 2_000_200, voteEnd: 2_400_000 }]);
  assert.deepEqual(await w.poll(st, 2_000_060), [], "no se repite");

  ev = await w.poll(st, 2_000_300);
  assert.deepEqual(ev, [{ kind: "dao-vote", round: "2027Q1", voteEnd: 2_400_000 }]);
  ev = await w.poll(st, 2_400_000 - 3600);
  assert.deepEqual(ev, [{ kind: "dao-last24", round: "2027Q1", voteEnd: 2_400_000 }]);

  // Resultado (oficial, después del cierre) y la cesta cambia (sale BONZO, pesos nuevos)
  m.messages.push(msg(4, 2_500_000, OPS, { v: 1, type: "result", round: "2027Q1", winners: ["0.0.3210123"], quorum: true }));
  m.logs.push(LOG_WEIGHTS, LOG_REMOVED);
  ev = await w.poll(st, 2_500_100);
  assert.deepEqual(ev, [
    { kind: "dao-result", round: "2027Q1", winners: ["0.0.3210123"], quorum: true },
    { kind: "basket", added: [], removed: ["0.0.1159074"], weights: true },
  ]);
  assert.equal(await w.symbolOf("0.0.3210123"), "STEAM");
  assert.equal(await w.symbolOf("no-es-id"), "?");
  assert.deepEqual(await w.poll(st, 2_500_200), []);
});

test("vigilante de H10X: si el guardián estuvo parado, no avisa tarde de la votación", async () => {
  const m = fakeMirror();
  const w = createH10xWatcher({ mirrorUrl: "http://mirror.test", fetchImpl: m.fetchImpl });
  const st = {};
  await w.poll(st, 1_000);
  m.messages.push(msg(1, 2_000_000, H10X_MAINNET.daoOps, ROUND_MSG));
  // Vuelve cuando la votación ya acabó: aviso de ronda no (ya cerró), ni de votación ni de 24 h
  assert.deepEqual(await w.poll(st, 2_500_000), []);
});

test("el guardián manda los avisos de H10X sin correo, según las preferencias de cada bóveda", () => {
  const g = fs.readFileSync(path.join(ROOT, "guardian/src/index.js"), "utf8");
  assert.match(g, /await push\(v, title, body, \{ vaultId, kind: `h10x-\$\{ev\.kind\}` \}, \{ mail: false \}\)/);
  assert.match(g, /v\.h10x\?\.basket !== false/);
  assert.match(g, /v\.h10x\?\.dao !== false/);
  assert.match(g, /NETWORK !== "local"/, "en la red local de pruebas, apagado salvo que se pida");
  assert.doesNotMatch(g.slice(g.indexOf("function h10xText"), g.indexOf("async function checkH10x")), /https?:\/\//, "los avisos no llevan enlaces");
  const app = fs.readFileSync(path.join(ROOT, "app/src/wallet.tsx"), "utf8");
  assert.match(app, /h10x: h10xPrefsCode\(p\.h10xAlerts \?\? \{ dao: true, basket: true \}\)/);
});
