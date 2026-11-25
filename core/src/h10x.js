// @ts-check
// H10X dentro de la wallet: el índice (NAV, cesta y rendimiento), la DAO y los avisos.
//
// Todo es lectura de datos PÚBLICOS de H10X en mainnet:
//   - la web publica /api/nav.json (NAV, cesta con lo que hay de cada token por H10X, pools), /api/history.json (NAV
//     cada 5 min, 7 días) y /api/dao.json (la ronda de la DAO y su recuento), igual que los usa h10xindex.xyz;
//   - el guardián, para los avisos, lee directamente el mirror de mainnet: el topic de la DAO y los eventos de la bóveda.
// Lo que llega se valida y se limpia (solo números y textos cortos, sin enlaces): un servidor caído o alterado no puede
// meter nada raro en la pantalla. Nada de esto mueve fondos ni firma nada.
import { id as eventTopic } from "ethers";

/** Web de H10X y sus datos públicos. */
export const H10X_WEB = "https://h10xindex.xyz";
export const H10X_API = Object.freeze({ nav: `${H10X_WEB}/api/nav.json`, history: `${H10X_WEB}/api/history.json`, dao: `${H10X_WEB}/api/dao.json` });
/** Donde se vota y se propone hoy (con HashPack). */
export const H10X_DAO_WEB = `${H10X_WEB}/#dao`;

/** H10X en mainnet (de la ficha del proyecto). */
export const H10X_MAINNET = Object.freeze({
  tokenId: "0.0.10907484",
  vaultId: "0.0.10907483",
  daoTopic: "0.0.10939164",
  daoOps: "0.0.10894592",
  mirror: "https://mainnet-public.mirrornode.hedera.com",
});
/** Token H10X de cada red (en testnet, el de la bóveda del programa de recompensas, 0.0.10872949). */
export const H10X_TOKEN_BY_NETWORK = Object.freeze({ mainnet: "0.0.10907484", testnet: "0.0.10872951" });

const ID_RE = /^0\.0\.\d{1,12}$/;
const ROUND_RE = /^\d{4}Q[1-4]$/;
const num = (/** @type {unknown} */ v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pos = (/** @type {unknown} */ v) => {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
};
/** Texto corto y limpio: sin caracteres de control ni nada que parezca un enlace. @param {unknown} v @param {number} max */
export function cleanLabel(v, max = 24) {
  if (typeof v !== "string") return "";
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "").trim();
  if (/https?:|www\.|\.[a-z]{2,}\//i.test(s)) return "";
  return s.length > max ? s.slice(0, max) : s;
}
const cleanId = (/** @type {unknown} */ v) => (typeof v === "string" && ID_RE.test(v) ? v : null);

/**
 * @typedef {{ symbol: string, name: string, tokenId: string | null, decimals: number | null, units: number, priceUsd: number, weight: number, targetWeight: number | null, change24h: number | null }} H10xComponent
 * @typedef {{ venue: string, priceUsd: number, premiumBps: number | null }} H10xPool
 * @typedef {{ updatedAt: number, nav: number, hbarUsd: number, change24h: number | null, change7d: number | null, supply: number | null, tvlUsd: number | null, tokenId: string | null, vaultId: string | null, pools: H10xPool[], components: H10xComponent[] }} H10xNav
 */

/**
 * nav.json de la web de H10X, validado. null si no vale (o no es el de la bóveda en mainnet).
 * `units` de cada componente: lo que hay de ese token en la bóveda por cada H10X.
 * @param {unknown} raw
 * @returns {H10xNav | null}
 */
export function parseNav(raw) {
  if (!raw || typeof raw !== "object") return null;
  const r = /** @type {Record<string, any>} */ (raw);
  if (r.network !== "mainnet" || r.mode !== "vault") return null;
  const nav = pos(r.nav);
  const hbarUsd = pos(r.hbarUsd);
  if (!nav || !hbarUsd) return null;
  const updatedAt = Date.parse(String(r.updatedAt));
  /** @type {H10xComponent[]} */
  const components = [];
  for (const c of Array.isArray(r.components) ? r.components.slice(0, 20) : []) {
    const symbol = cleanLabel(c?.symbol ?? c?.key, 12);
    const units = num(c?.units);
    const priceUsd = num(c?.priceUsd);
    const weight = num(c?.weight);
    if (!symbol || units === null || units < 0 || priceUsd === null || priceUsd < 0 || weight === null) continue;
    components.push({
      symbol,
      name: cleanLabel(c?.name, 40) || symbol,
      tokenId: cleanId(c?.tokenId),
      decimals: Number.isInteger(c?.decimals) && c.decimals >= 0 && c.decimals <= 18 ? c.decimals : null,
      units,
      priceUsd,
      weight: Math.min(1, Math.max(0, weight)),
      targetWeight: num(c?.targetWeight),
      change24h: num(c?.change24h),
    });
  }
  if (components.length === 0) return null;
  /** @type {H10xPool[]} */
  const pools = [];
  for (const p of Array.isArray(r.pools) ? r.pools.slice(0, 5) : []) {
    const priceUsd = pos(p?.priceUsd);
    if (!priceUsd) continue;
    pools.push({ venue: cleanLabel(p?.venue, 6) || "?", priceUsd, premiumBps: num(p?.premiumBps) });
  }
  return {
    updatedAt: Number.isFinite(updatedAt) ? Math.floor(updatedAt / 1000) : 0,
    nav,
    hbarUsd,
    change24h: num(r.change24h),
    change7d: num(r.change7d),
    supply: pos(r.supply),
    tvlUsd: pos(r.tvlUsd),
    tokenId: cleanId(r.vault?.tokenId),
    vaultId: cleanId(r.vault?.id),
    pools,
    components,
  };
}

/**
 * history.json: [[ms, nav USD], …] de los últimos 7 días, en orden y sin puntos raros. Como mucho 2.100 puntos.
 * @param {unknown} raw @returns {[number, number][]}
 */
export function parseHistory(raw) {
  const pts = /** @type {any} */ (raw)?.points;
  if (!Array.isArray(pts)) return [];
  /** @type {[number, number][]} */
  const out = [];
  for (const p of pts.slice(-2100)) {
    if (!Array.isArray(p)) continue;
    const t = num(p[0]);
    const v = pos(p[1]);
    if (t === null || v === null) continue;
    if (out.length && t <= out[out.length - 1][0]) continue;
    out.push([t, v]);
  }
  return out;
}

/**
 * Tu parte de la cesta: lo que corresponde a `amount` H10X (unidades mínimas, 8 decimales) de cada token de la
 * bóveda, y su valor. Es exactamente lo que recibirías al reembolsar (antes de la comisión de reembolso).
 * @param {H10xNav} nav @param {bigint} amount
 */
export function h10xShare(nav, amount) {
  const h = Number(amount) / 1e8;
  const items = nav.components.map((c) => ({ symbol: c.symbol, name: c.name, tokenId: c.tokenId, amount: c.units * h, usd: c.units * h * c.priceUsd, weight: c.weight }));
  const usd = nav.nav * h;
  return { h10x: h, usd, hbar: usd / nav.hbarUsd, items };
}

// ---- DAO -----------------------------------------------------------------------------------------

/**
 * @typedef {"propose" | "review" | "vote" | "counting" | "closed"} DaoPhase
 * @typedef {{ token: string, symbol: string, proposer: string, team: boolean, filter: "ok" | "rejected" | "pending", votes: number | null, voters: number | null, winner: boolean }} DaoCandidate
 * @typedef {{ id: string, phase: DaoPhase, proposeEnd: number, voteStart: number, voteEnd: number, revealAt: number | null, slots: number, minPropose: string, holdDays: number, fee: string, feeAccount: string, quorumPct: number, candidates: DaoCandidate[], winners: string[], quorumReached: boolean | null, resultPublished: boolean }} DaoRound
 * @typedef {{ updatedAt: number, topicId: string | null, round: DaoRound | null, past: { id: string, voteEnd: number, winners: string[], quorum: boolean }[] }} DaoState
 */

/** Fase de una ronda por sus plazos (la de «escrutinio» la decide quien publica: votos aún cerrados). */
export function daoPhaseAt(/** @type {{ proposeEnd: number, voteStart: number, voteEnd: number }} */ r, /** @type {number} */ nowSec) {
  if (nowSec < r.proposeEnd) return "propose";
  if (nowSec < r.voteStart) return "review";
  if (nowSec < r.voteEnd) return "vote";
  return "closed";
}

const h10xUnits = (/** @type {unknown} */ s, decimals = 8) => {
  const t = typeof s === "string" ? s : typeof s === "number" ? String(s) : "";
  if (!/^\d{1,30}$/.test(t)) return null;
  return Number(t) / 10 ** decimals;
};

/**
 * dao.json de la web de H10X, validado y reducido a lo que enseña la app.
 * @param {unknown} raw @param {number} nowSec
 * @returns {DaoState | null}
 */
export function parseDao(raw, nowSec) {
  if (!raw || typeof raw !== "object") return null;
  const r = /** @type {Record<string, any>} */ (raw);
  if (r.v !== 1 || r.network !== "mainnet") return null;
  const updated = Date.parse(String(r.updatedAt));
  /** @type {DaoRound | null} */
  let round = null;
  const t = r.round;
  if (t && ROUND_RE.test(String(t.id)) && [t.proposeEnd, t.voteStart, t.voteEnd].every((/** @type {unknown} */ x) => Number.isSafeInteger(x) && Number(x) > 0) && t.proposeEnd <= t.voteStart && t.voteStart < t.voteEnd) {
    const decimals = Number.isInteger(t.rules?.decimals) ? t.rules.decimals : 8;
    const byTime = daoPhaseAt(t, nowSec);
    // acabada la votación, «escrutinio» mientras los votos siguen cerrados (la web lo publica como «counting»)
    /** @type {DaoPhase} */
    const phase = byTime === "closed" && (t.phase === "counting" || !t.revealed) ? "counting" : byTime;
    const winners = Array.isArray(t.winners) ? t.winners.filter((/** @type {unknown} */ x) => ID_RE.test(String(x))).map(String) : [];
    /** @type {DaoCandidate[]} */
    const candidates = [];
    for (const c of Array.isArray(t.candidates) ? t.candidates.slice(0, 30) : []) {
      const token = cleanId(c?.token);
      if (!token) continue;
      const f = c?.filter ?? {};
      candidates.push({
        token,
        symbol: cleanLabel(c?.symbol, 12),
        proposer: cleanId(c?.proposer) ?? "?",
        team: c?.team === true,
        filter: f.official ? (f.status === "ok" ? "ok" : "rejected") : "pending",
        votes: h10xUnits(c?.votes?.weight, decimals),
        voters: Number.isSafeInteger(c?.votes?.count) ? c.votes.count : null,
        winner: c?.winner === true || winners.includes(token),
      });
    }
    round = {
      id: String(t.id),
      phase,
      proposeEnd: t.proposeEnd,
      voteStart: t.voteStart,
      voteEnd: t.voteEnd,
      revealAt: Number.isSafeInteger(t.key?.revealAt) ? t.key.revealAt : null,
      slots: Number.isSafeInteger(t.slots) ? t.slots : 1,
      minPropose: /^\d+(\.\d+)?$/.test(String(t.rules?.minPropose)) ? String(t.rules.minPropose) : "?",
      holdDays: Number.isSafeInteger(t.rules?.holdDays) ? t.rules.holdDays : 0,
      fee: /^\d+(\.\d+)?$/.test(String(t.rules?.fee)) ? String(t.rules.fee) : "?",
      feeAccount: cleanId(t.rules?.feeAccount) ?? "?",
      quorumPct: Number.isSafeInteger(t.rules?.quorumBps) ? t.rules.quorumBps / 100 : 0,
      candidates,
      winners,
      quorumReached: typeof t.quorum?.reached === "boolean" ? t.quorum.reached : null,
      resultPublished: !!t.result,
    };
  }
  const past = [];
  for (const p of Array.isArray(r.past) ? r.past.slice(0, 12) : []) {
    if (!ROUND_RE.test(String(p?.id))) continue;
    past.push({ id: String(p.id), voteEnd: Number.isSafeInteger(p.voteEnd) ? p.voteEnd : 0, winners: Array.isArray(p.winners) ? p.winners.filter((/** @type {unknown} */ x) => ID_RE.test(String(x))).map(String) : [], quorum: p.quorum === true });
  }
  return { updatedAt: Number.isFinite(updated) ? Math.floor(updated / 1000) : 0, topicId: cleanId(r.topicId), round, past };
}

// ---- Mensajes del topic de la DAO (para los avisos del guardián) ----------------------------------

const DAO_TYPES = ["round", "key", "propose", "filter", "vote", "result"];

/**
 * Mensaje del topic tal como lo da el mirror → { seq, ts (s), payer, body } o null. Solo lo que necesitan los avisos:
 * rondas (plazos) y resultados (ganadores). Mensajes de un solo trozo, JSON v1 y como mucho 1024 bytes.
 * @param {any} m
 */
export function parseDaoMessage(m) {
  const seq = Number(m?.sequence_number);
  const ts = Number(String(m?.consensus_timestamp ?? "").split(".")[0]);
  const payer = String(m?.payer_account_id ?? "");
  if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(ts)) return null;
  if (m?.chunk_info && Number(m.chunk_info.total || 1) > 1) return null;
  let text = "";
  try {
    const bin = atob(String(m?.message ?? ""));
    if (bin.length > 1024) return null;
    text = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!o || o.v !== 1 || !DAO_TYPES.includes(o.type) || !ROUND_RE.test(String(o.round))) return null;
  /** @type {Record<string, unknown>} */
  const body = { type: o.type, round: String(o.round) };
  if (o.type === "round") {
    if (![o.proposeEnd, o.voteStart, o.voteEnd].every((/** @type {unknown} */ x) => Number.isSafeInteger(x) && Number(x) > 0) || !(o.proposeEnd <= o.voteStart && o.voteStart < o.voteEnd)) return null;
    Object.assign(body, { proposeEnd: o.proposeEnd, voteStart: o.voteStart, voteEnd: o.voteEnd, slots: Number.isSafeInteger(o.slots) ? o.slots : 1 });
  } else if (o.type === "result") {
    body.winners = Array.isArray(o.winners) ? o.winners.map(String).filter((/** @type {string} */ x) => ID_RE.test(x)).slice(0, 10) : [];
    body.quorum = o.quorum === true;
  }
  return { seq, ts, payer, body };
}

// ---- Eventos de la bóveda de H10X (cambios de cesta) ---------------------------------------------

export const H10X_VAULT_EVENTS = Object.freeze({
  added: eventTopic("ComponentAdded(address)"),
  removed: eventTopic("ComponentRemoved(address)"),
  weights: eventTopic("TargetWeightsSet(address[],uint16[])"),
});

/**
 * Evento de cesta de la bóveda → { kind, token? } o null. El token va indexado (topic 1) como dirección long-zero.
 * @param {{ topics: string[] }} log
 */
export function vaultBasketEvent(log) {
  const t0 = String(log?.topics?.[0] ?? "").toLowerCase();
  const tokenOf = () => {
    const t1 = String(log?.topics?.[1] ?? "");
    if (!/^0x[0-9a-fA-F]{64}$/.test(t1)) return null;
    const n = BigInt(t1);
    return n > 0n && n < 2n ** 64n ? `0.0.${n}` : null;
  };
  if (t0 === H10X_VAULT_EVENTS.added) return { kind: /** @type {const} */ ("added"), token: tokenOf() };
  if (t0 === H10X_VAULT_EVENTS.removed) return { kind: /** @type {const} */ ("removed"), token: tokenOf() };
  if (t0 === H10X_VAULT_EVENTS.weights) return { kind: /** @type {const} */ ("weights"), token: null };
  return null;
}

// ---- Preferencias de avisos de H10X (van firmadas en el registro del guardián) -------------------

/** @typedef {{ dao: boolean, basket: boolean }} H10xAlertPrefs */

/** {dao, basket} → "db" | "d" | "b" | "-" (lo que va en el registro firmado). @param {H10xAlertPrefs} p */
export const h10xPrefsCode = (p) => `${p.dao ? "d" : ""}${p.basket ? "b" : ""}` || "-";
/** "db" | "d" | "b" | "-" → {dao, basket}; null si no vale. @param {unknown} code */
export function parseH10xPrefs(code) {
  if (typeof code !== "string" || !/^(d?b?|-)$/.test(code) || code === "") return null;
  return { dao: code.includes("d"), basket: code.includes("b") };
}
