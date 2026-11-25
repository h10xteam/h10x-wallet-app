// @ts-check
// Guardián: servicio que corre en el VPS.
//   - vigila los notarios registrados (gratis, vía mirror node);
//   - avisa al móvil cuando se pide, bloquea o envía una retirada (si la app tiene avisos push);
//   - al acabar la cuenta atrás, pide al notario que aporte su firma, y la retirada se ejecuta.
// No guarda llaves de nadie: solo la de su propia cuenta, que paga esas llamadas y puede vetar.
import "dotenv/config";
import { createServer } from "node:http";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AccountId, ContractId, KeyList, PublicKey, ScheduleId } from "@hiero-ledger/sdk";
import { Interface } from "ethers";
import {
  Lane,
  Mirror,
  allowedInWithdrawLane,
  tokenRisks,
  NETWORKS,
  NOTARY_ARTIFACT,
  callNotary,
  callNotary2,
  contractAddress,
  decodeNotary2Log,
  isVaultKeyV2For,
  notary2Config,
  actionTokenIds,
  createClient,
  fetchPrices,
  formatCountdown,
  formatHbar,
  inspectVaultV2,
  summarizeAction,
  verifyTheftNotice,
  isVaultKeyFor,
  keyFingerprint,
  nowSeconds,
  parsePrivateKey,
  scheduleIdOfAddress,
  checkDelays,
  takeBudget,
  uncheckedVerdict,
  HBAR,
  SCHEDULE_MAX_LIFETIME_SECONDS,
  vaultDeviceKey,
  verifyRegistration,
  isValidEmail,
  maskEmail,
  normalizeEmail,
  verifyEmailNotice,
  readNoticeFile,
  parseH10xPrefs,
  formatDateTime,
  H10X_MAINNET,
  MAINNET_BETA,
  checkNotaryFactory,
  countdownFeeReason,
  parseTokenList,
  pickEviction,
  statusAudience,
  vaultStatusView,
} from "@boveda/core";
import { alertText, codeText, emailConfig, sendEmail } from "./email.js";
import { createH10xWatcher } from "./h10x-watch.js";

const VERSION = "0.14.0";
/** El modo robo se apaga solo a los 60 días (o antes, al vaciarse la bóveda). */
const THEFT_MAX_SECONDS = 60 * 24 * 3600;
const NETWORK = /** @type {import("@boveda/core").NetworkName} */ ((process.env.HEDERA_NETWORK ?? "testnet").toLowerCase());
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const POLL_MS = Math.max(3, Number(process.env.POLL_SECONDS ?? 10)) * 1000;
const MAX_VAULTS = Number(process.env.MAX_VAULTS ?? 500);
/** Mainnet (beta): dinero de verdad. Exige topes y baja los presupuestos diarios por defecto. */
const IS_MAINNET = String(NETWORK) === "mainnet";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(ROOT, process.env.DATA_DIR ?? "data");
const STATE_FILE = join(DATA_DIR, "state.json");
const MIRROR_URL = process.env.MIRROR_URL ?? NETWORKS[NETWORK]?.mirror;
/** Cuenta que cobra las comisiones del servicio (vacía = apagadas): solo para describirlas en los avisos. */
const FEE_COLLECTOR = (process.env.FEE_COLLECTOR ?? "").trim() || null;
/** Clave de la API de SaucerSwap (opcional): precios de los tokens para la app. */
const SAUCERSWAP_API_KEY = (process.env.SAUCERSWAP_API_KEY ?? "").trim();
/** Número entero (≥ 0) de una variable de entorno, o el valor por defecto si falta o no es un número. */
const envInt = (/** @type {string} */ name, /** @type {number} */ def) => {
  const raw = process.env[name];
  const n = Number(raw);
  return raw != null && raw.trim() !== "" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
};
/**
 * Topes diarios, por bóveda, de las llamadas al notario que paga el guardián. Sin tope, cualquiera con una
 * bóveda propia podría hacerle gastar hasta dejarlo sin saldo, y sin saldo no bloquea nada de nadie.
 * Agotados los bloqueos del día, congela el carril de retirada: una sola llamada lo anula todo.
 */
const BUDGET = {
  approve: envInt("BUDGET_APPROVES_DAY", IS_MAINNET ? MAINNET_BETA.budget.approve : 100),
  veto: envInt("BUDGET_VETOES_DAY", IS_MAINNET ? MAINNET_BETA.budget.veto : 100),
  freeze: envInt("BUDGET_FREEZES_DAY", IS_MAINNET ? MAINNET_BETA.budget.freeze : 30),
  email: envInt("EMAIL_PER_DAY", 30),
};
/** Por debajo de MIN_BALANCE_HBAR el guardián avisa; por debajo de RESERVE_HBAR solo bloquea (no completa). */
const MIN_BALANCE = BigInt(envInt("MIN_BALANCE_HBAR", 10)) * HBAR;
const RESERVE = BigInt(envInt("RESERVE_HBAR", 2)) * HBAR;
/** Opcional: tema de ntfy para avisar a quien administra el guardián (p. ej. https://ntfy.sh/un-tema-secreto). */
const ADMIN_NTFY_URL = (process.env.ADMIN_NTFY_URL ?? "").trim();
/** Vueltas seguidas que puede fallar la lectura de un mismo aviso antes de dejarlo «sin leer» y seguir. */
const UNREADABLE_AFTER = Math.max(1, envInt("UNREADABLE_AFTER", 5));
/** En redes de prueba valen también los plazos de minutos; en mainnet, solo los de la app (24 h a 7 días y 7 o 14 días). */
const ALLOW_TEST_DELAYS = String(NETWORK) !== "mainnet";
/** Correo de los avisos graves (EMAIL_PROVIDER, EMAIL_API_KEY, EMAIL_FROM). Sin configurar, apagado. */
const EMAIL = emailConfig(process.env, DATA_DIR);
/**
 * Tokens con llave de comisiones de emisores de confianza (p. ej. un estable): pueden ir en una retirada con cuenta
 * atrás. Una retirada con cualquier otro token con esa llave se bloquea en cuanto se ve (core/src/feepolicy.js).
 */
const TRUSTED_FEE_KEY_TOKENS = parseTokenList(process.env.TRUSTED_FEE_KEY_TOKENS);
/**
 * Topes de la beta (0 = sin tope). MAX_VAULT_HBAR: HBAR que la app deja guardar en cada bóveda; el guardián lo
 * anuncia en /info y /notice y avisa al dueño (una vez al día) si la bóveda pasa de ahí. MAX_VAULTS: bóvedas
 * que vigila (ya existía; 500 por defecto).
 */
const MAX_VAULT_HBAR = envInt("MAX_VAULT_HBAR", 0);
/** Aviso de emergencia para todas las bóvedas: lo escribe `hvault-vps aviso` (scripts/aviso.mjs). */
const NOTICE_FILE = join(DATA_DIR, "aviso.json");
/**
 * Fábrica de notarios de esta red: la escribe `hvault-vps fabrica desplegar` (scripts/fabrica.mjs). El guardián solo la
 * anuncia en /info; la app comprueba por su cuenta que su código es el bueno antes de usarla.
 */
const FACTORY_FILE = join(DATA_DIR, "fabrica.json");
/** Cada cuánto se comprueban los topes (segundos). */
const CAP_CHECK_MS = Math.max(60, envInt("CAP_CHECK_SECONDS", 1800)) * 1000;
/**
 * Avisos de H10X (DAO y cesta), leyendo el mirror PÚBLICO de mainnet (solo lectura; no usa la clave del guardián).
 * H10X_ALERTS=0 los apaga (en la red local de pruebas van apagados salvo H10X_ALERTS=1). Por defecto, el topic de la
 * DAO, la cuenta oficial y la bóveda de H10X en mainnet.
 */
const H10X_ALERTS = process.env.H10X_ALERTS ? process.env.H10X_ALERTS !== "0" : NETWORK !== "local";
const H10X_POLL_MS = Math.max(5, envInt("H10X_POLL_SECONDS", 120)) * 1000;
const h10xWatcher = createH10xWatcher({
  mirrorUrl: process.env.H10X_MIRROR_URL || H10X_MAINNET.mirror,
  topic: process.env.H10X_DAO_TOPIC || H10X_MAINNET.daoTopic,
  ops: process.env.H10X_DAO_OPS || H10X_MAINNET.daoOps,
  vault: process.env.H10X_VAULT_ID || H10X_MAINNET.vaultId,
});
/** Cada cuánto se mira el saldo del guardián (segundos). */
const BALANCE_CHECK_MS = Math.max(3, envInt("BALANCE_CHECK_SECONDS", 300)) * 1000;

if (!["mainnet", "testnet", "previewnet", "local"].includes(NETWORK)) {
  console.error(`HEDERA_NETWORK=${NETWORK}: el guardián funciona en mainnet, testnet, previewnet o local.`);
  process.exit(1);
}
// Mainnet solo con los topes de la beta puestos a mano en su .env (no valen los de por defecto).
if (IS_MAINNET) {
  const problems = [];
  if (!(MAX_VAULT_HBAR > 0 && MAX_VAULT_HBAR <= MAINNET_BETA.guardianMaxVaultHbar)) problems.push(`MAX_VAULT_HBAR (de 1 a ${MAINNET_BETA.guardianMaxVaultHbar})`);
  if (!(process.env.MAX_VAULTS ?? "").trim() || !Number.isInteger(MAX_VAULTS) || MAX_VAULTS < 1 || MAX_VAULTS > MAINNET_BETA.guardianMaxVaults) problems.push(`MAX_VAULTS (de 1 a ${MAINNET_BETA.guardianMaxVaults})`);
  if (problems.length) {
    console.error(`HEDERA_NETWORK=mainnet: faltan los topes de la beta en el .env: ${problems.join(" y ")}. Sin ellos el guardián de mainnet no arranca.`);
    process.exit(1);
  }
}
if (!process.env.OPERATOR_KEY) {
  console.error("Falta OPERATOR_KEY en guardian/.env (la cuenta que paga las llamadas al notario).");
  process.exit(1);
}

const log = (/** @type {string} */ msg) => console.log(`${new Date().toISOString()}  ${msg}`);
const mirror = new Mirror(MIRROR_URL, fetch, { feeCollector: FEE_COLLECTOR });
const operatorKey = parsePrivateKey(process.env.OPERATOR_KEY, process.env.OPERATOR_KEY_TYPE);
const notaryAbi = new Interface(NOTARY_ARTIFACT.abi);

// ---- Estado persistente --------------------------------------------------------------------------

/**
 * @typedef {{ status: "requested" | "vetoed" | "approved" | "executed" | "expired" | "failed" | "superseded",
 *   executableAt: number, attempts: number, nextTryAt: number, summary: string, lane?: "withdraw" | "recovery",
 *   forbidden?: boolean, unchecked?: boolean, held?: boolean, feeHold?: boolean,
 *   vetoTries?: number, nextVetoAt?: number, vetoGaveUp?: boolean, priority?: boolean,
 *   requestedAt?: number, unreadable?: boolean, warned?: boolean, keyHold?: boolean,
 *   feeRisk?: { token: string, reason: import("@boveda/core").FeeReason } }} Pending
 *   feeRisk: retirada que mueve un token que no puede ir con cuenta atrás (cobra al moverlo, su emisor puede ponerle
 *     comisiones o no se sabe qué es): cualquiera puede completarla al acabar, también ese emisor, así que se bloquea;
 *   keyHold: mueve un token cuyo emisor puede cambiar las comisiones: el guardián no la completa solo;
 *   forbidden: operación que la app nunca pide por ese carril (se bloquea);
 *   unreadable: pasó media cuenta atrás sin poder leerla en el mirror: se bloquea (lo que no se lee, no sale);
 *   warned: ya se avisó al dueño de esta recuperación (no se repite);
 *   unchecked: aún no se ha podido leer qué hace (no se completa hasta saberlo);
 *   held: no se ejecutaría al aprobarla (le falta la firma de quien paga o de la llave del carril):
 *     quedaría «cargada» para dispararla más tarde, así que el guardián nunca la aprueba;
 *   feeHold: mueve un token que cobraría comisión a la bóveda; no se completa mientras siga así;
 *   priority: recuperación con kit + contraseña (notario v3): congelar no la anula y el móvil no la bloquea
 * @typedef {{ notaryId: string, pocketId: string, pushToken: string | null, lastLog?: string, version?: 1 | 2,
 *   lang?: "es" | "en", pending: Record<string, Pending>, registeredAt: number,
 *   theft?: { since: number, until: number }, deviceKey?: string, rescueKey?: string,
 *   spend?: import("@boveda/core").BudgetSpend, budgetNoted?: number, nextFreezeAt?: number,
 *   stuck?: { key: string, tries: number }, bogusAt?: number,
 *   email?: { address: string, since: number }, emailPending?: { address: string, hash: string, expires: number, tries: number },
 *   emailCodes?: { day: number, count: number }, capWarnedDay?: number, h10x?: { dao: boolean, basket: boolean },
 *   readHash?: string }} VaultEntry
 *   readHash: sha256 del código de lectura que el registro da a la app (GET /vaults/<id> con x-h10x-token); sin él
 *     (registrada por una app anterior a la 0.10), se enseña lo que veía esa app, sin las operaciones pendientes
 *   h10x: avisos de H10X que quiere el dueño (firmado en el registro; sin él, los dos)
 *   email: correo que recibe los avisos graves (solo se pone, cambia o quita con el kit);
 *   emailPending: correo a la espera del código; emailCodes: códigos pedidos hoy
 *   deviceKey / rescueKey: claves públicas (DER) de las llaves del móvil y del kit, para comprobar firmas
 *   sin depender del mirror (p. ej. el aviso de robo aunque alguien inunde el guardián)
 *   spend: llamadas al notario pagadas hoy por esta bóveda (tope diario); budgetNoted: día en que se avisó
 *   del tope; nextFreezeAt: no volver a congelar antes de esa hora; stuck: aviso cuya lectura está fallando
 *   y cuántas vueltas lleva; bogusAt: último aviso de «han anunciado algo que no es una operación»
 *   capWarnedDay: último día (UTC) en que se avisó de que la bóveda pasa del tope de la beta
 * @typedef {{ vaults: Record<string, VaultEntry>, noticeSent?: string, h10x?: import("./h10x-watch.js").H10xWatchState }} State
 *   noticeSent: ID del último aviso de emergencia ya mandado a todas las bóvedas
 *   h10x: por dónde va la lectura del topic de la DAO y de los eventos de la bóveda de H10X
 */

/** @returns {State} */
function loadState() {
  if (!existsSync(STATE_FILE)) return { vaults: {} };
  return JSON.parse(readFileSync(STATE_FILE, "utf8"));
}
const state = loadState();
function saveState() {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, STATE_FILE);
}

// ---- Avisos al móvil (Expo Push) -----------------------------------------------------------------

/**
 * Avisos que NO van por correo: lo rutinario (lo que el propio dueño hace o espera). Todo lo demás, también
 * lo que se añada en el futuro, va por correo si la bóveda tiene uno: así un aviso nuevo nunca se queda solo
 * en el móvil (que puede estar en manos del ladrón).
 */
const ROUTINE = new Set([
  "Operación completada", "Operation completed",
  "Operación caducada", "Operation expired",
  "Retirada bloqueada", "Withdrawal blocked",
  "Operación bloqueada", "Operation blocked",
  "No se pudo completar", "Could not complete",
  "Retirada bloqueada (modo robo)", "Withdrawal blocked (theft mode)",
]);

/**
 * Manda el aviso al correo de la bóveda (sin esperar: un servicio de correo lento no retrasa bloqueos).
 * Con tope diario por bóveda, para que nadie llene el buzón de nadie.
 * @param {VaultEntry} v @param {string} title @param {string} body @param {string} vaultId
 */
function mailOwner(v, title, body, vaultId) {
  if (!EMAIL.enabled || !v.email) return;
  if (!takeBudget(v, "email", BUDGET, nowSeconds())) {
    log(`   tope diario de correos de ${vaultId || v.pocketId}: este aviso va solo al móvil`);
    return;
  }
  const clean = title.replace(/^⚠️\s*/, "");
  void sendEmail(EMAIL, { to: v.email.address, subject: `H10X Wallet · ${clean}`, text: alertText(v.lang ?? "es", `${clean}\n\n${body}`, vaultId) }).then((r) => {
    if (!r.ok) log(`   no se pudo enviar el correo de ${vaultId}: ${r.error}`);
  });
}

/**
 * Solo funciona con la versión propia de la app (development build): Expo Go no recibe avisos push.
 * @param {VaultEntry} v @param {string} title @param {string} body @param {Record<string, string>} data
 * @param {{ mail?: boolean }} [opts] mail: mandarlo también por correo (por defecto, salvo lo rutinario)
 */
async function push(v, title, body, data, { mail = !ROUTINE.has(title) } = {}) {
  log(`aviso → ${v.pocketId}: ${title} · ${body}`);
  if (mail) mailOwner(v, title, body, data?.vaultId ?? "");
  if (!v.pushToken || !/^Expo(nent)?PushToken\[/.test(v.pushToken)) return;
  try {
    const res = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify([{ to: v.pushToken, title, body, data, sound: "default", priority: "high" }]),
    });
    if (!res.ok) log(`   el servicio de avisos respondió ${res.status}`);
  } catch (e) {
    log(`   no se pudo enviar el aviso: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Texto en el idioma de la bóveda. @param {VaultEntry} v @param {string} es @param {string} en */
const T = (v, es, en) => (v.lang === "en" ? en : es);

/**
 * Resumen de una operación programada, en el idioma de la bóveda: "10 HBAR a 0.0.x · comisión 2 HBAR",
 * y qué operación es.
 * @param {VaultEntry} v @param {string} scheduleId @param {"withdraw" | "recovery"} [lane]
 * @returns {Promise<{ text: string, action: import("@boveda/core").ScheduleAction | null, schedule: import("@boveda/core").MirrorSchedule | null }>}
 */
async function summarize(v, scheduleId, lane = "withdraw") {
  const lang = v.lang ?? "es";
  const s = await mirror.schedule(scheduleId);
  if (!s) return { text: T(v, "operación", "operation"), action: null, schedule: null };
  const ids = actionTokenIds(s.action);
  const infos = new Map();
  for (const id of ids) infos.set(id, await mirror.tokenInfo(id).catch(() => null));
  const sum = summarizeAction(s.action, { lane, meta: (id) => infos.get(id), lang });
  return { text: [sum.title, sum.detail, sum.fee].filter(Boolean).join(" · "), action: s.action, schedule: s };
}

/**
 * Claves de las dos llaves de una bóveda v2 (DER), sacadas de su clave en la red: [móvil, kit].
 * @param {string} vaultId
 */
async function vaultLaneKeys(vaultId) {
  const acc = await mirror.account(vaultId).catch(() => null);
  if (!acc || !(acc.key instanceof KeyList)) return null;
  const [withdraw, recovery] = acc.key.toArray();
  const device = withdraw instanceof KeyList ? withdraw.toArray()[0] : null;
  const kit = recovery instanceof KeyList ? recovery.toArray()[0] : null;
  if (!(device instanceof PublicKey) || !(kit instanceof PublicKey)) return null;
  return { device: device.toStringDer(), kit: kit.toStringDer() };
}

/**
 * ¿Se ejecutará la programada en cuanto el notario la apruebe? Tiene que llevar YA la firma de quien
 * paga y la de la llave del carril (todas las de la app la llevan). Si no, al aprobarla quedaría
 * «cargada» y quien tenga la otra firma podría dispararla cuando quisiera, aunque luego se bloquee.
 * @param {VaultEntry} v @param {string} vaultId @param {import("@boveda/core").MirrorSchedule} s @param {"withdraw" | "recovery"} lane
 */
async function readyToRun(v, vaultId, s, lane) {
  if (!v.deviceKey || !v.rescueKey) {
    const keys = await vaultLaneKeys(vaultId);
    if (keys) {
      v.deviceKey = keys.device;
      v.rescueKey = keys.kit;
    }
  }
  const laneKey = lane === "withdraw" ? v.deviceKey : v.rescueKey;
  if (!laneKey) return false;
  const raw = (/** @type {string} */ der) => PublicKey.fromString(der).toStringRaw().toLowerCase();
  if (!s.signers.includes(raw(laneKey))) return false;
  const payer = await mirror.account(s.payer).catch(() => null);
  return !!payer && payer.key instanceof PublicKey && s.signers.includes(payer.key.toStringRaw().toLowerCase());
}

/**
 * ¿Cobraría alguno de los tokens de la operación una comisión fija a la bóveda? (se mira en el momento:
 * el emisor puede ponerla durante la cuenta atrás)
 * @param {import("@boveda/core").ScheduleAction} action
 * @returns {Promise<string | null>} el primero que cobra, o null
 */
async function feeChargingToken(action) {
  if (action.kind !== "transfer") return null;
  for (const id of new Set([...action.tokens.map((t) => t.tokenId), ...action.nfts.map((n) => n.tokenId)])) {
    const info = await mirror.tokenInfo(id, { fresh: true }).catch(() => null);
    if (!info || tokenRisks(info).chargesOnMove) return info ? `${info.symbol} (${id})` : id;
  }
  return null;
}

/**
 * ¿Mueve la operación un token cuyo emisor puede cambiar las comisiones (y que no es de confianza)? Ese
 * emisor podría ponerle una comisión enorme en los segundos en que el mirror aún no lo enseña, y la pagaría
 * la bóveda: el guardián no la completa solo.
 * @param {import("@boveda/core").ScheduleAction} action
 * @returns {Promise<string | null>} el primero, o null
 */
async function feeKeyToken(action) {
  if (action.kind !== "transfer") return null;
  for (const id of new Set([...action.tokens.map((t) => t.tokenId), ...action.nfts.map((n) => n.tokenId)])) {
    if (TRUSTED_FEE_KEY_TOKENS.has(id)) continue;
    const info = await mirror.tokenInfo(id, { fresh: true }).catch(() => null);
    if (!info || tokenRisks(info).canChangeFees) return info ? `${info.symbol} (${id})` : id;
  }
  return null;
}

/**
 * Por qué un token no puede ir en una retirada con cuenta atrás, para el registro y los avisos.
 * @type {Record<import("@boveda/core").FeeReason, [string, string]>}
 */
const FEE_RISK_TEXT = {
  feeKey: [
    "su emisor puede ponerle una comisión cuando quiera y completar él mismo la retirada al acabar la cuenta atrás (la pagaría la bóveda)",
    "its issuer can add a fee at any time and complete the withdrawal himself when the countdown ends (the vault would pay it)",
  ],
  charges: ["cobra una comisión a la bóveda al moverlo", "it charges the vault a fee to move it"],
  unknown: ["no se sabe qué token es (podría cobrar una comisión a la bóveda)", "it isn't known what token it is (it could charge the vault a fee)"],
};

/**
 * ¿Mueve la operación algún token que no puede ir con cuenta atrás? (core/src/feepolicy.js). El notario deja que
 * cualquiera complete una operación al acabar su cuenta atrás: no completarla no basta, hay que bloquearla.
 * @param {import("@boveda/core").ScheduleAction} action
 * @returns {Promise<{ token: string, reason: import("@boveda/core").FeeReason } | null | undefined>}
 *   undefined: el mirror no ha contestado (se vuelve a mirar en la vuelta siguiente)
 */
async function feeRiskOf(action) {
  if (action.kind !== "transfer") return null;
  for (const id of new Set([...action.tokens.map((t) => t.tokenId), ...action.nfts.map((n) => n.tokenId)])) {
    /** @type {import("@boveda/core").TokenInfo | null} */
    let info;
    try {
      info = await mirror.tokenInfo(id, { fresh: true });
    } catch {
      return undefined;
    }
    const reason = countdownFeeReason(info, { trusted: TRUSTED_FEE_KEY_TOKENS });
    if (reason) return { token: info ? `${info.symbol} (${id})` : id, reason };
  }
  return null;
}

/** Título del aviso de una operación pedida con el móvil. @param {VaultEntry} v @param {import("@boveda/core").ScheduleAction | null} action */
function requestTitle(v, action) {
  if (action?.kind === "staking") return T(v, "Rendimiento: cambio solicitado", "Yield: change requested");
  if (action?.kind === "settings") return T(v, "Cambio de ajustes solicitado", "Settings change requested");
  return T(v, "Retirada solicitada", "Withdrawal requested");
}

// ---- Vigilancia ----------------------------------------------------------------------------------

/** @type {import("@hiero-ledger/sdk").Client} */
let client;
let operatorId = "";
let operatorEvm = "";

// ---- Avisos ilegibles, presupuesto por bóveda y saldo del guardián ---------------------------------

/**
 * Alguien ha anunciado al notario una dirección que no es la de una transacción programada. No puede
 * ejecutarse nunca, pero solo la anuncia quien tiene la llave de ese carril. Como mucho un aviso por hora.
 * @param {string} vaultId @param {VaultEntry} v @param {"withdraw" | "recovery"} lane @param {string} address
 */
async function warnBogus(vaultId, v, lane, address) {
  log(`aviso ilegible en ${vaultId} (${lane}): ${address} no es una transacción programada`);
  if (nowSeconds() - (v.bogusAt ?? 0) < 3600) return;
  v.bogusAt = nowSeconds();
  await push(
    v,
    lane === "recovery" ? T(v, "⚠️ Alguien ha usado tu kit de rescate", "⚠️ Someone used your rescue kit") : T(v, "⚠️ Alguien tiene la llave de tu móvil", "⚠️ Someone has your phone's key"),
    T(
      v,
      "Han anunciado al notario algo que no es una operación. No puede mover dinero, pero la app nunca lo hace: evacúa la bóveda con el móvil y el kit.",
      "Something that isn't an operation was announced to the notary. It can't move money, but the app never does this: evacuate the vault with your phone and kit.",
    ),
    { vaultId },
  );
}

/**
 * Lee qué hace una petición recién anunciada y si se ejecutaría al aprobarla. Si la lectura falla, se
 * reintenta en la vuelta siguiente (lanza, como antes); pero si el MISMO aviso falla UNREADABLE_AFTER
 * vueltas seguidas se deja «sin leer» y se sigue con los demás: un aviso preparado para fallar siempre
 * (o un mirror que no lo enseña) ya no deja ciego al guardián. Lo que queda sin leer nunca se completa y,
 * en el carril de retirada, se bloquea a media cuenta atrás.
 * @param {string} vaultId @param {VaultEntry} v @param {string} scheduleId @param {"withdraw" | "recovery"} lane @param {string} key
 * @returns {Promise<{ summary: string, action: import("@boveda/core").ScheduleAction | null, schedule: import("@boveda/core").MirrorSchedule | null, ready: boolean }>}
 */
async function readRequest(vaultId, v, scheduleId, lane, key) {
  try {
    const { text, action, schedule } = await summarize(v, scheduleId, lane);
    const ready = action && schedule && v.version === 2 ? await readyToRun(v, vaultId, schedule, lane) : true;
    if (v.stuck?.key === key) delete v.stuck;
    return { summary: text, action, schedule, ready };
  } catch (e) {
    const tries = v.stuck?.key === key ? v.stuck.tries + 1 : 1;
    v.stuck = { key, tries };
    if (tries < UNREADABLE_AFTER) throw e;
    delete v.stuck;
    log(`no se puede leer ${scheduleId} de ${vaultId} tras ${tries} intentos (${e instanceof Error ? e.message : String(e)}): queda sin leer`);
    return { summary: T(v, "operación que no se ha podido leer", "operation that could not be read"), action: null, schedule: null, ready: false };
  }
}

/**
 * Un aviso al día, como mucho, de que el guardián ha llegado al tope de lo que paga por esta bóveda.
 * @param {string} vaultId @param {VaultEntry} v @param {string} es @param {string} en
 */
async function budgetNotice(vaultId, v, es, en) {
  const day = Math.floor(nowSeconds() / 86400);
  if (v.budgetNoted === day) return;
  v.budgetNoted = day;
  log(`tope diario de ${vaultId} alcanzado`);
  await push(v, T(v, "El guardián ha llegado a su tope de hoy", "The guardian reached today's limit"), T(v, es, en), { vaultId });
}

/**
 * Tope diario de bloqueos agotado: en vez de bloquear una a una (cada llamada cuesta), el guardián congela
 * el carril de retirada. Una sola llamada anula todo lo pendiente y lo cierra durante el plazo de retirada.
 * @param {string} vaultId @param {VaultEntry} v
 */
async function freezeInstead(vaultId, v) {
  if (nowSeconds() < (v.nextFreezeAt ?? 0)) return;
  if (!takeBudget(v, "freeze", BUDGET, nowSeconds())) {
    v.nextFreezeAt = nowSeconds() + 3600;
    await budgetNotice(
      vaultId,
      v,
      "Hay operaciones que no reconoce y hoy ya no puede bloquear más: congela las retiradas tú desde la app, o evacúa la bóveda con el móvil y el kit.",
      "There are operations it doesn't recognise and it can't block any more today: freeze withdrawals yourself from the app, or evacuate the vault with your phone and kit.",
    );
    return;
  }
  /** @type {{ ok: boolean, status: string, reason: string }} */
  let out;
  try {
    out = await callNotary2({ client, notaryId: ContractId.fromString(v.notaryId), call: "freeze", lane: Lane.Withdraw });
  } catch (e) {
    out = { ok: false, status: "ERROR", reason: e instanceof Error ? e.message : String(e) };
  }
  if (out.ok) {
    // El contrato anula todo lo pendiente del carril de retirada.
    for (const p of Object.values(v.pending)) if ((p.lane ?? "withdraw") === "withdraw" && p.status === "requested" && !p.priority) p.status = "superseded";
    v.nextFreezeAt = nowSeconds() + 30;
    log(`tope diario de bloqueos de ${vaultId}: retiradas congeladas`);
  } else {
    v.nextFreezeAt = nowSeconds() + 60;
    log(`tope diario de bloqueos de ${vaultId}: no se pudo congelar: ${out.status} ${out.reason}`);
  }
}

/** Saldo del guardián por debajo del aviso / por debajo de la reserva (entonces solo bloquea). */
let lowBalance = false;
let lowReserve = false;
let balanceCheckedAt = 0;
let balanceNotedAt = 0;

/** Mira el saldo del guardián cada pocos minutos: avisa si baja del mínimo y, bajo la reserva, deja de completar. */
async function checkBalance() {
  if (!operatorId || Date.now() - balanceCheckedAt < BALANCE_CHECK_MS) return;
  balanceCheckedAt = Date.now();
  const acc = await mirror.account(operatorId).catch(() => null);
  if (!acc) return;
  lowBalance = acc.balance < MIN_BALANCE;
  lowReserve = acc.balance < RESERVE;
  if (!lowBalance || Date.now() - balanceNotedAt < 6 * 3600_000) return;
  balanceNotedAt = Date.now();
  const text = `Guardian ${operatorId} (${NETWORK}): quedan ${formatHbar(acc.balance)} HBAR.${lowReserve ? " Por debajo de la reserva: solo bloquea, no completa." : ""} Hay que recargarlo.`;
  log(`⚠️ saldo bajo · ${text}`);
  if (!ADMIN_NTFY_URL) return;
  try {
    await fetch(ADMIN_NTFY_URL, { method: "POST", headers: { Title: "H10X Wallet: saldo bajo del guardian", Priority: "high", Tags: "warning" }, body: text });
  } catch (e) {
    log(`   no se pudo avisar por ntfy: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Olvida lo que acabó hace más de una semana, para que el estado no crezca sin fin. @param {VaultEntry} v */
function prune(v) {
  const now = nowSeconds();
  for (const [id, p] of Object.entries(v.pending)) {
    if (p.executableAt >= now - 7 * 86400) continue;
    // Lo pendiente o aprobado se conserva mientras la programada pueda seguir viva.
    const live = p.status === "requested" || p.status === "approved";
    if (live && now <= p.executableAt + SCHEDULE_MAX_LIFETIME_SECONDS) continue;
    delete v.pending[id];
  }
}

/** @param {string} vaultId @param {VaultEntry} v */
async function watchVault(vaultId, v) {
  const { events, last } = await mirror.notaryEvents(v.notaryId, v.lastLog);
  for (const ev of events) {
    if (ev.kind === "created") continue;
    // Una dirección que no es la de una programada no puede ejecutarse: se salta (y no atasca al guardián).
    const scheduleId = scheduleIdOfAddress(ev.schedule);
    if (!scheduleId) continue;
    if (ev.kind === "requested") {
      const summary = (await summarize(v, scheduleId).catch(() => ({ text: T(v, "operación", "operation") }))).text;
      v.pending[scheduleId] = { status: "requested", executableAt: ev.executableAt, attempts: 0, nextTryAt: 0, summary };
      const wait = formatCountdown(ev.executableAt - nowSeconds(), v.lang ?? "es");
      await push(v, T(v, "Retirada solicitada", "Withdrawal requested"), T(v, `${summary}. Saldrá en ${wait}. ¿No has sido tú? Abre la app y bloquéala.`, `${summary}. It goes out in ${wait}. Not you? Open the app and block it.`), {
        scheduleId,
        vaultId,
      });
    } else if (ev.kind === "vetoed") {
      const p = v.pending[scheduleId];
      if (p) p.status = "vetoed";
      await push(v, T(v, "Retirada bloqueada", "Withdrawal blocked"), T(v, `${p?.summary ?? scheduleId}: no saldrá de la bóveda.`, `${p?.summary ?? scheduleId}: it will not leave the vault.`), { scheduleId, vaultId });
    } else if (ev.kind === "approved") {
      const p = v.pending[scheduleId];
      if (p && p.status === "requested") p.status = "approved";
    }
  }
  if (last) v.lastLog = last;
  await completeDue(vaultId, v, (scheduleId) =>
    callNotary({ client, notaryId: ContractId.fromString(v.notaryId), scheduleId: ScheduleId.fromString(scheduleId), fn: "approve" }),
  );
}

/**
 * Bóveda v2: dos carriles (retirada con el móvil, recuperación con el kit) y congelación.
 * @param {string} vaultId @param {VaultEntry} v
 */
async function watchVault2(vaultId, v) {
  const { logs, last } = await mirror.contractLogs(v.notaryId, v.lastLog);
  const events = logs.map((l) => decodeNotary2Log(l));
  // Notario v3: la recuperación prioritaria (kit + contraseña) emite Requested, PriorityRequested y
  // Frozen(retiradas) en la misma transacción. Se miran antes para avisar una sola vez y bien.
  const prioritized = new Set(events.flatMap((e) => (e?.kind === "priority" ? [e.schedule] : [])));
  let afterPriority = false;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    // Lo ya leído no se repite: al empezar los avisos de otra transacción, la anterior queda hecha. Si uno
    // falla más adelante, la vuelta siguiente retoma desde ahí (antes repetía los avisos del lote entero).
    if (i > 0 && logs[i].timestamp !== logs[i - 1].timestamp) v.lastLog = logs[i - 1].timestamp;
    if (!ev || ev.kind === "created") continue;
    if (ev.kind === "priority") {
      const pid = scheduleIdOfAddress(ev.schedule);
      const p = pid ? v.pending[pid] : undefined;
      if (p) p.priority = true;
      afterPriority = true;
      continue;
    }
    const quiet = afterPriority && ev.kind === "frozen" && ev.lane === Lane.Withdraw;
    afterPriority = false;
    if (ev.kind === "frozen") {
      const lane = ev.lane === Lane.Recovery ? "recovery" : "withdraw";
      // Congelar anula lo pendiente de ese carril (el contrato avanza su época), salvo lo prioritario.
      for (const p of Object.values(v.pending)) if ((p.lane ?? "withdraw") === lane && p.status === "requested" && !p.priority) p.status = "superseded";
      if (quiet) continue; // el cierre de retiradas de una recuperación prioritaria: ya se avisó con ella
      const span = formatCountdown(ev.until - nowSeconds(), v.lang ?? "es");
      await push(
        v,
        lane === "recovery" ? T(v, "Recuperaciones congeladas", "Recoveries frozen") : T(v, "Retiradas congeladas", "Withdrawals frozen"),
        T(v, `Durante ${span}. Lo pendiente de ese carril queda anulado.`, `For ${span}. Anything pending in that lane is cancelled.`),
        { vaultId },
      );
      continue;
    }
    const scheduleId = scheduleIdOfAddress(ev.schedule);
    if (!scheduleId) {
      // El notario acepta cualquier dirección: esta no es la de una programada y no puede ejecutarse nunca,
      // pero solo la anuncia quien tiene la llave de ese carril. Se avisa y se sigue con lo demás (antes,
      // un aviso así podía dejar al guardián atascado y sin ver nada más de la bóveda).
      if (ev.kind === "requested") await warnBogus(vaultId, v, ev.lane === Lane.Recovery ? "recovery" : "withdraw", ev.schedule);
      continue;
    }
    if (ev.kind === "requested") {
      const lane = ev.lane === Lane.Recovery ? "recovery" : "withdraw";
      const { summary, action, schedule, ready } = await readRequest(vaultId, v, scheduleId, lane, `${ev.schedule}@${ev.requestedAt}`);
      // Por el carril del móvil solo pasa lo que pide la app. Lo demás (cambiar llaves, ajustes de
      // seguridad, mandar las recompensas a otra cuenta, una operación «cargada»…) significa que alguien
      // tiene la llave del móvil. Si el mirror aún no la enseña, se vuelve a mirar en la siguiente vuelta.
      let unchecked = !action || !schedule;
      let forbidden = lane === "withdraw" && !unchecked && (!allowedInWithdrawLane(/** @type {any} */ (action), vaultId) || !ready);
      const held = lane === "recovery" && !unchecked && !ready;
      // Una retirada con un token que no puede ir con cuenta atrás se bloquea ya (la app 0.10 nunca la pide).
      /** @type {{ token: string, reason: import("@boveda/core").FeeReason } | null | undefined} */
      let feeRisk = null;
      if (lane === "withdraw" && !unchecked && !forbidden && v.version === 2) {
        feeRisk = await feeRiskOf(/** @type {import("@boveda/core").ScheduleAction} */ (action));
        if (feeRisk === undefined) unchecked = true; // se vuelve a mirar en la vuelta siguiente
        else if (feeRisk) forbidden = true;
      }
      const priority = lane === "recovery" && prioritized.has(ev.schedule);
      v.pending[scheduleId] = {
        status: "requested",
        lane,
        requestedAt: ev.requestedAt,
        executableAt: ev.executableAt,
        attempts: 0,
        nextTryAt: 0,
        summary,
        ...(forbidden ? { forbidden: true } : {}),
        ...(unchecked ? { unchecked: true } : {}),
        ...(held ? { held: true } : {}),
        ...(priority ? { priority: true } : {}),
        ...(feeRisk ? { feeRisk } : {}),
      };
      const wait = formatCountdown(ev.executableAt - nowSeconds(), v.lang ?? "es");
      if (priority) {
        // Kit + contraseña: el móvil no la puede parar y las retiradas quedan cerradas hasta que salga.
        await push(
          v,
          T(v, "⚠️ Recuperación prioritaria (kit + contraseña)", "⚠️ Priority recovery (kit + password)"),
          held || unchecked
            ? T(v, `${summary}. Retiradas cerradas mientras tanto. Si no has sido tú, evacúa la bóveda con el móvil y el kit cuanto antes.`, `${summary}. Withdrawals are closed meanwhile. If it wasn't you, evacuate the vault with your phone and kit as soon as possible.`)
            : T(v, `${summary}. Saldrá en ${wait} y el móvil no puede pararla; las retiradas quedan cerradas hasta entonces. Si no has sido tú, evacúa la bóveda con el móvil y el kit cuanto antes.`, `${summary}. It goes out in ${wait} and the phone can't stop it; withdrawals are closed until then. If it wasn't you, evacuate the vault with your phone and kit as soon as possible.`),
          { scheduleId, vaultId },
        );
      } else if (forbidden || unchecked) {
        // Lo prohibido se bloquea justo después de leer todos los eventos (ver más abajo) y se avisa entonces.
      } else if (lane === "recovery") {
        await push(
          v,
          T(v, "⚠️ Alguien ha usado tu kit de rescate", "⚠️ Someone used your rescue kit"),
          held
            ? T(v, `${summary}. Está preparada para dispararse más tarde: el guardián no la completará. Congela las recuperaciones desde la app.`, `${summary}. It's set up to be fired later: the guardian won't complete it. Freeze recoveries from the app.`)
            : T(v, `${summary}. Saldrá en ${wait}. Si no has sido tú, abre la app y congela las recuperaciones.`, `${summary}. It goes out in ${wait}. If it wasn't you, open the app and freeze recoveries.`),
          { scheduleId, vaultId },
        );
      } else if (v.theft) {
        // Modo robo: se bloquea justo después de leer todos los eventos (ver más abajo).
      } else {
        await push(v, requestTitle(v, action), T(v, `${summary}. Se hará en ${wait}. ¿No has sido tú? Abre la app y bloquéala.`, `${summary}. It happens in ${wait}. Not you? Open the app and block it.`), { scheduleId, vaultId });
      }
    } else if (ev.kind === "vetoed") {
      const p = v.pending[scheduleId];
      if (p) p.status = "vetoed";
      if (p?.forbidden) continue; // ya se avisó al bloquearla
      await push(v, T(v, "Operación bloqueada", "Operation blocked"), T(v, `${p?.summary ?? scheduleId}: no saldrá de la bóveda.`, `${p?.summary ?? scheduleId}: it will not leave the vault.`), { scheduleId, vaultId });
    } else if (ev.kind === "approved") {
      const p = v.pending[scheduleId];
      if (p && p.status === "requested") p.status = "approved";
    }
  }
  if (last) v.lastLog = last;
  for (const [id, p] of Object.entries(v.pending)) {
    if (!p.unchecked || p.status !== "requested") continue;
    const lane = p.lane ?? "withdraw";
    /** @type {Awaited<ReturnType<typeof summarize>> | null} */
    let seen = null;
    try {
      seen = await summarize(v, id, lane);
    } catch (e) {
      // Un fallo del mirror con esta no impide mirar las demás ni bloquear lo que haya que bloquear.
      log(`sigo sin poder leer ${id} de ${vaultId}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!seen?.action || !seen.schedule) {
      const verdict = uncheckedVerdict(p, nowSeconds(), SCHEDULE_MAX_LIFETIME_SECONDS);
      if (verdict === "expired") {
        p.status = "expired"; // ya no puede ejecutarse: no se mira más
      } else if (verdict === "block" && lane === "withdraw") {
        // Media cuenta atrás sin poder leerla: lo que no se puede leer, no sale (se bloquea más abajo).
        p.forbidden = true;
        p.unreadable = true;
        delete p.unchecked;
      } else if (verdict === "block" && !p.warned) {
        // El guardián no puede bloquear recuperaciones: avisa al dueño. Mientras no se lea, no la completa.
        p.warned = true;
        await push(
          v,
          T(v, "⚠️ Alguien ha usado tu kit de rescate", "⚠️ Someone used your rescue kit"),
          T(v, "El guardián no ha podido leer qué hace esa recuperación y no la completará. Si no has sido tú, abre la app y congela las recuperaciones.", "The guardian could not read what that recovery does and won't complete it. If it wasn't you, open the app and freeze recoveries."),
          { scheduleId: id, vaultId },
        );
      }
      continue;
    }
    const { text, action, schedule } = seen;
    p.summary = text;
    /** @type {{ token: string, reason: import("@boveda/core").FeeReason } | null | undefined} */
    const feeRisk = lane === "withdraw" && v.version === 2 ? await feeRiskOf(action) : null;
    if (feeRisk === undefined) {
      // Sin poder mirar aún sus tokens: como lo que no se puede leer (se vuelve a mirar; a media cuenta atrás, se bloquea).
      const verdict = uncheckedVerdict(p, nowSeconds(), SCHEDULE_MAX_LIFETIME_SECONDS);
      if (verdict === "expired") p.status = "expired";
      else if (verdict === "block") {
        p.forbidden = true;
        p.unreadable = true;
        delete p.unchecked;
      }
      continue;
    }
    delete p.unchecked;
    const ready = v.version === 2 ? await readyToRun(v, vaultId, schedule, lane) : true;
    if (lane === "recovery") {
      if (!ready) p.held = true;
      // Una recuperación que se lee tarde también se avisa (antes se quedaba sin aviso).
      if (!p.priority && !p.warned) {
        p.warned = true;
        const wait = formatCountdown(p.executableAt - nowSeconds(), v.lang ?? "es");
        await push(
          v,
          T(v, "⚠️ Alguien ha usado tu kit de rescate", "⚠️ Someone used your rescue kit"),
          p.held
            ? T(v, `${text}. Está preparada para dispararse más tarde: el guardián no la completará. Congela las recuperaciones desde la app.`, `${text}. It's set up to be fired later: the guardian won't complete it. Freeze recoveries from the app.`)
            : T(v, `${text}. Saldrá en ${wait}. Si no has sido tú, abre la app y congela las recuperaciones.`, `${text}. It goes out in ${wait}. If it wasn't you, open the app and freeze recoveries.`),
          { scheduleId: id, vaultId },
        );
      }
    } else if (!allowedInWithdrawLane(action, vaultId) || !ready) p.forbidden = true;
    else if (feeRisk) {
      p.forbidden = true;
      p.feeRisk = feeRisk;
    } else if (!v.theft) {
      const wait = formatCountdown(p.executableAt - nowSeconds(), v.lang ?? "es");
      await push(v, requestTitle(v, action), T(v, `${text}. Se hará en ${wait}. ¿No has sido tú? Abre la app y bloquéala.`, `${text}. It happens in ${wait}. Not you? Open the app and block it.`), { scheduleId: id, vaultId });
    }
  }
  // Lo que la app nunca pide se bloquea siempre (y se reintenta en cada vuelta si falla): el notario
  // dejaría a cualquiera completarlo al acabar la cuenta atrás.
  const vetoDue = (/** @type {Pending} */ p) => p.status === "requested" && !p.vetoGaveUp && nowSeconds() >= (p.nextVetoAt ?? 0);
  for (const [id, p] of Object.entries(v.pending)) if (p.forbidden && vetoDue(p)) await vetoPending(vaultId, v, id, "forbidden");
  if (v.theft) {
    // Modo robo: toda retirada pendiente se bloquea (y se reintenta si falla).
    for (const [id, p] of Object.entries(v.pending)) if ((p.lane ?? "withdraw") === "withdraw" && vetoDue(p)) await vetoPending(vaultId, v, id, "theft");
  }
  await completeDue(vaultId, v, (scheduleId) =>
    callNotary2({ client, notaryId: ContractId.fromString(v.notaryId), call: "approve", schedule: ScheduleId.fromString(scheduleId) }),
  );
  if (v.theft) await endTheftIfDone(vaultId, v);
}

/**
 * Bloquea una operación del carril del móvil: en modo robo, o porque la app nunca la pediría.
 * @param {string} vaultId @param {VaultEntry} v @param {string} scheduleId @param {"theft" | "forbidden"} why
 */
async function vetoPending(vaultId, v, scheduleId, why) {
  const p = v.pending[scheduleId];
  // Lo ya ejecutado o caducado no se puede bloquear: no se gasta una llamada en balde.
  const s = await mirror.schedule(scheduleId).catch(() => null);
  if (s?.executed || (s && s.expiresAt > 0 && s.expiresAt < nowSeconds())) {
    if (p) p.status = s.executed ? "executed" : "expired";
    return;
  }
  // Tope diario de bloqueos agotado: en vez de una a una, se congela el carril (una llamada lo anula todo).
  if (!takeBudget(v, "veto", BUDGET, nowSeconds())) return freezeInstead(vaultId, v);
  /** @type {{ ok: boolean, status: string, reason: string }} */
  let out;
  try {
    out = await callNotary2({ client, notaryId: ContractId.fromString(v.notaryId), call: "veto", schedule: ScheduleId.fromString(scheduleId) });
  } catch (e) {
    // Un fallo de red al enviar cuenta como un intento fallido más (se reintenta con espera creciente).
    out = { ok: false, status: "ERROR", reason: e instanceof Error ? e.message : String(e) };
  }
  if (out.ok || /BadStatus\(2\)|Superseded/.test(out.reason)) {
    if (p) p.status = p.status === "requested" ? "vetoed" : p.status;
    if (why === "theft") {
      log(`modo robo: retirada ${scheduleId} de ${vaultId} bloqueada`);
      await push(v, T(v, "Retirada bloqueada (modo robo)", "Withdrawal blocked (theft mode)"), T(v, `${p?.summary ?? scheduleId}: el guardián la ha bloqueado.`, `${p?.summary ?? scheduleId}: the guardian blocked it.`), { scheduleId, vaultId });
    } else if (p?.feeRisk) {
      const [es, en] = FEE_RISK_TEXT[p.feeRisk.reason];
      log(`retirada ${scheduleId} de ${vaultId} bloqueada: ${p.feeRisk.token}: ${es}`);
      await push(
        v,
        T(v, "⚠️ Retirada bloqueada: token con comisiones", "⚠️ Withdrawal blocked: token with fees"),
        T(
          v,
          `${p.summary}. ${p.feeRisk.token}: ${es}. El guardián la ha bloqueado: ese token sale con «Evacuar» (móvil + kit, sin cuenta atrás). Si no la has pedido tú, alguien tiene la llave de tu móvil: evacúa la bóveda.`,
          `${p.summary}. ${p.feeRisk.token}: ${en}. The guardian blocked it: that token leaves with “Evacuate” (phone + kit, no countdown). If you didn't request it, someone has your phone's key: evacuate the vault.`,
        ),
        { scheduleId, vaultId },
      );
    } else if (p?.unreadable) {
      log(`operación sin leer ${scheduleId} de ${vaultId} bloqueada`);
      await push(
        v,
        T(v, "⚠️ Operación bloqueada: no se ha podido leer", "⚠️ Operation blocked: it could not be read"),
        T(
          v,
          "El guardián no ha podido comprobar qué hacía una operación de tu bóveda y la ha bloqueado. Si eras tú, pídela otra vez; si no, evacúa la bóveda con el móvil y el kit.",
          "The guardian could not check what an operation on your vault did and blocked it. If it was you, request it again; if not, evacuate the vault with your phone and kit.",
        ),
        { scheduleId, vaultId },
      );
    } else {
      log(`operación no permitida ${scheduleId} de ${vaultId} bloqueada: ${p?.summary ?? ""}`);
      await push(
        v,
        T(v, "⚠️ Bloqueado: alguien tiene la llave de tu móvil", "⚠️ Blocked: someone has your phone's key"),
        T(
          v,
          `${p?.summary ?? scheduleId}. La app nunca pide esto: el guardián lo ha bloqueado. Evacúa la bóveda con el móvil y el kit.`,
          `${p?.summary ?? scheduleId}. The app never asks for this: the guardian blocked it. Evacuate the vault with your phone and kit.`,
        ),
        { scheduleId, vaultId },
      );
    }
  } else if (/BadStatus\(3\)/.test(out.reason)) {
    // Ya aprobada (p. ej. el guardián estuvo parado): bloquear no sirve. Lo único que la para es evacuar.
    if (p) {
      p.status = "approved";
      p.vetoGaveUp = true;
    }
    log(`no se pudo bloquear ${scheduleId} de ${vaultId}: ya estaba aprobada`);
    await push(
      v,
      T(v, "⚠️ Operación aprobada que no reconoces", "⚠️ Approved operation you don't recognise"),
      T(v, `${p?.summary ?? scheduleId}. Ya no se puede bloquear: evacúa la bóveda con el móvil y el kit cuanto antes.`, `${p?.summary ?? scheduleId}. It can no longer be blocked: evacuate the vault with your phone and kit as soon as possible.`),
      { scheduleId, vaultId },
    );
  } else {
    // Sin reintentos sin fin (cada intento cuesta HBAR): espera creciente y, a los 8, se deja y se avisa.
    if (p) {
      p.vetoTries = (p.vetoTries ?? 0) + 1;
      p.nextVetoAt = nowSeconds() + Math.min(600, 15 * 2 ** p.vetoTries);
      if (p.vetoTries >= 8) {
        p.vetoGaveUp = true;
        await push(v, T(v, "⚠️ El guardián no ha podido bloquearla", "⚠️ The guardian couldn't block it"), T(v, `${p.summary}. Bloquéala tú desde la app.`, `${p.summary}. Block it yourself from the app.`), { scheduleId, vaultId });
      }
    }
    log(`${why === "theft" ? "modo robo" : "operación no permitida"}: no se pudo bloquear ${scheduleId}: ${out.status} ${out.reason}`);
  }
}

/**
 * El modo robo termina al vaciarse la bóveda (la recuperación ya llegó) o a los 60 días.
 * @param {string} vaultId @param {VaultEntry} v
 */
async function endTheftIfDone(vaultId, v) {
  if (!v.theft) return;
  let done = nowSeconds() > v.theft.until;
  if (!done) {
    const acc = await mirror.account(vaultId).catch(() => null);
    const tokens = acc ? await mirror.accountTokens(vaultId).catch(() => []) : [];
    done = !!acc && acc.balance === 0n && tokens.every((t) => t.balance === 0n);
  }
  if (done) {
    v.theft = undefined;
    log(`modo robo de ${vaultId} terminado`);
  }
}

/**
 * Completa lo que ha cumplido su cuenta atrás y vigila lo ya aprobado hasta que se ejecuta.
 * @param {string} vaultId @param {VaultEntry} v
 * @param {(scheduleId: string) => Promise<{ ok: boolean, status: string, txId: string, reason: string }>} approve
 */
async function completeDue(vaultId, v, approve) {
  for (const [scheduleId, p] of Object.entries(v.pending)) {
    if (p.status === "approved") {
      const s = await mirror.schedule(scheduleId).catch(() => null);
      if (s?.executed) {
        p.status = "executed";
        await push(v, T(v, "Operación completada", "Operation completed"), `${p.summary}.`, { scheduleId, vaultId });
      }
      continue;
    }
    if (p.status !== "requested" || nowSeconds() < p.executableAt + 3 || nowSeconds() < p.nextTryAt) continue;
    if (p.forbidden || p.unchecked || p.held) continue; // lo prohibido, lo «cargado» o lo que aún no se ha podido leer, jamás
    if (v.theft && (p.lane ?? "withdraw") === "withdraw") continue; // en modo robo, ninguna retirada se completa

    /** @type {import("@boveda/core").MirrorSchedule | null} */
    let s;
    try {
      s = await mirror.schedule(scheduleId);
    } catch (e) {
      // Sin poder leerla no se pueden mirar sus comisiones: no se completa a ciegas, y las demás siguen.
      log(`no puedo leer ${scheduleId} de ${vaultId} para completarla: ${e instanceof Error ? e.message : String(e)}`);
      p.nextTryAt = nowSeconds() + 30;
      continue;
    }
    if (s && !s.executed && s.expiresAt > 0 && s.expiresAt < nowSeconds()) {
      p.status = "expired";
      await push(v, T(v, "Operación caducada", "Operation expired"), T(v, `${p.summary}: caducó sin ejecutarse.`, `${p.summary}: it expired without running.`), { scheduleId, vaultId });
      continue;
    }
    // Retirada de una bóveda v2: cualquiera puede completarla al acabar la cuenta atrás (también el emisor del token),
    // así que no basta con no completarla: se bloquea. Normalmente ya se bloqueó al verla; esto es por si acaso.
    const withdrawV2 = v.version === 2 && (p.lane ?? "withdraw") === "withdraw";
    // Un token que cobraría comisión a la bóveda al moverlo: no se completa (se vuelve a mirar en 5 min).
    const charging = s ? await feeChargingToken(s.action) : null;
    if (charging && withdrawV2) {
      p.forbidden = true;
      p.feeRisk = { token: charging, reason: "charges" };
      await vetoPending(vaultId, v, scheduleId, "forbidden");
      continue;
    }
    if (charging) {
      if (!p.feeHold) {
        p.feeHold = true;
        log(`no completo ${scheduleId} de ${vaultId}: el token ${charging} cobra comisión al moverlo`);
        await push(
          v,
          T(v, "⚠️ Retirada detenida", "⚠️ Withdrawal held"),
          T(v, `${p.summary}: el token ${charging} cobraría una comisión a la bóveda al moverlo. No se completa; pídela otra vez sin ese token.`, `${p.summary}: the token ${charging} would charge the vault a fee to move it. It won't complete; request it again without that token.`),
          { scheduleId, vaultId },
        );
      }
      p.nextTryAt = nowSeconds() + 300;
      continue;
    }
    p.feeHold = false;
    // Un token cuyo emisor puede cambiar las comisiones. En una retirada v2, se bloquea (ver arriba). En una
    // recuperación (el guardián no puede bloquearlas) la completa el dueño desde la app, cuanto antes: se mira una vez
    // cada 10 min. La app 0.10 solo pide esos tokens cuando en la bóveda ya no queda nada con qué pagar una comisión.
    const keyed = s ? await feeKeyToken(s.action) : null;
    if (keyed && withdrawV2) {
      p.forbidden = true;
      p.feeRisk = { token: keyed, reason: "feeKey" };
      await vetoPending(vaultId, v, scheduleId, "forbidden");
      continue;
    }
    if (keyed) {
      if (!p.keyHold) {
        p.keyHold = true;
        log(`no completo ${scheduleId} de ${vaultId}: el emisor de ${keyed} puede cambiar sus comisiones`);
        await push(
          v,
          T(v, "⚠️ Operación a la espera", "⚠️ Operation waiting"),
          T(
            v,
            `${p.summary}: el emisor de ${keyed} puede cambiar sus comisiones en cualquier momento, así que el guardián no la completa solo. Complétala tú cuanto antes desde la app con «Completar ahora»: las comisiones se comprueban justo antes.`,
            `${p.summary}: the issuer of ${keyed} can change its fees at any time, so the guardian won't complete it on its own. Complete it yourself as soon as possible from the app with “Complete now”: the fees are checked right before.`,
          ),
          { scheduleId, vaultId },
        );
      }
      p.nextTryAt = nowSeconds() + 600;
      continue;
    }
    // Con el saldo por debajo de la reserva el guardián solo bloquea: completar puede hacerlo cualquiera desde la app.
    if (lowReserve) {
      p.nextTryAt = nowSeconds() + 300;
      continue;
    }
    // Tope diario de lo que el guardián paga por esta bóveda.
    if (!takeBudget(v, "approve", BUDGET, nowSeconds())) {
      p.nextTryAt = nowSeconds() + 600;
      await budgetNotice(
        vaultId,
        v,
        `${p.summary}: complétala tú desde la app. El guardián no paga más operaciones de esta bóveda hoy.`,
        `${p.summary}: complete it yourself from the app. The guardian won't pay for more operations on this vault today.`,
      );
      continue;
    }
    log(`completando ${scheduleId} (${p.summary}) de la bóveda ${vaultId}`);
    /** @type {{ ok: boolean, status: string, txId: string, reason: string }} */
    let out;
    try {
      out = await approve(scheduleId);
    } catch (e) {
      // Un fallo de red al enviar cuenta como un intento fallido (y no deja sin mirar las demás).
      out = { ok: false, status: "ERROR", txId: "", reason: e instanceof Error ? e.message : String(e) };
    }
    p.attempts += 1;
    if (out.ok) {
      p.status = "approved";
      log(`   notario: SUCCESS · ${out.txId}`);
    } else if (out.reason.startsWith("Superseded")) {
      p.status = "superseded";
      log("   anulada por una congelación de su carril");
    } else if (out.reason.startsWith("BadStatus")) {
      log(`   ya no está pendiente (${out.reason}); se actualizará con los eventos`);
      p.nextTryAt = nowSeconds() + 30;
    } else {
      log(`   falló: ${out.status} ${out.reason}`);
      p.nextTryAt = nowSeconds() + Math.min(600, 15 * 2 ** p.attempts);
      if (p.attempts >= 6) {
        p.status = "failed";
        await push(v, T(v, "No se pudo completar", "Could not complete"), T(v, `${p.summary}. Ábrela en la app para reintentarlo.`, `${p.summary}. Open it in the app to try again.`), { scheduleId, vaultId });
      }
    }
  }
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await checkBalance().catch(() => undefined);
    await checkNotice().catch((e) => log(`aviso de emergencia: ${e instanceof Error ? e.message : String(e)}`));
    await checkCaps().catch(() => undefined);
    // Aparte y sin esperar: si el mirror de mainnet tarda, no retrasa la vigilancia de las bóvedas.
    if (!h10xRunning) {
      h10xRunning = true;
      void checkH10x()
        .catch((e) => log(`avisos de H10X: ${e instanceof Error ? e.message : String(e)}`))
        .finally(() => (h10xRunning = false));
    }
    for (const [vaultId, v] of Object.entries(state.vaults)) {
      try {
        await (v.version === 2 ? watchVault2(vaultId, v) : watchVault(vaultId, v));
      } catch (e) {
        log(`error vigilando ${vaultId}: ${e instanceof Error ? e.message : String(e)}`);
      }
      prune(v);
    }
    saveState();
  } finally {
    ticking = false;
  }
}

// ---- Fábrica de notarios -------------------------------------------------------------------------------

/** @type {{ at: number, id: string | null }} */
let factoryCache = { at: 0, id: null };

/**
 * ID de la fábrica de notarios que se anuncia (o null). Solo si su código en la red es el bueno: así un archivo
 * cambiado a mano no hace que se anuncie otra. Se guarda 10 minutos (1 si no hay ninguna buena).
 * @returns {Promise<string | null>}
 */
async function notaryFactory() {
  if (Date.now() - factoryCache.at < (factoryCache.id ? 600_000 : 60_000)) return factoryCache.id;
  let id = (process.env.NOTARY_FACTORY ?? "").trim() || null;
  if (!id && existsSync(FACTORY_FILE)) {
    try {
      const f = JSON.parse(readFileSync(FACTORY_FILE, "utf8"));
      if (f && f.network === NETWORK && typeof f.factoryId === "string") id = f.factoryId;
    } catch {
      id = null;
    }
  }
  if (id && !/^0\.0\.\d+$/.test(id)) id = null;
  if (id && !(await checkNotaryFactory({ mirror, factoryId: id }).catch(() => null))) {
    log(`la fábrica ${id} no pasa la comprobación: no se anuncia`);
    id = null;
  }
  factoryCache = { at: Date.now(), id };
  return id;
}

// ---- Aviso de emergencia y topes de la beta --------------------------------------------------------

/** @type {import("@boveda/core").GuardianNotice | null} */
let currentNotice = null;

/**
 * Lee el aviso de emergencia (data/aviso.json) y, si es nuevo, lo manda una vez a todas las bóvedas, en su idioma,
 * por push y por correo. Va limpio: sin enlaces, cuentas ni direcciones (core/src/notice.js).
 */
async function checkNotice() {
  currentNotice = existsSync(NOTICE_FILE) ? readNoticeFile((f) => readFileSync(f, "utf8"), NOTICE_FILE) : null;
  if (!currentNotice || state.noticeSent === currentNotice.id) return;
  state.noticeSent = currentNotice.id;
  saveState();
  const n = currentNotice;
  const vaults = Object.entries(state.vaults);
  log(`aviso de emergencia «${n.id}» (${n.level}) → ${vaults.length} bóvedas`);
  for (const [vaultId, v] of vaults) {
    const title = n.level === "evacuar" ? T(v, "⚠️ Aviso urgente de H10X Wallet", "⚠️ Urgent H10X Wallet notice") : T(v, "Aviso de H10X Wallet", "H10X Wallet notice");
    await push(v, title, T(v, n.es, n.en), { vaultId, kind: "notice", noticeId: n.id }, { mail: n.level === "evacuar" });
  }
}

let capCheckedAt = 0;
/**
 * Con tope de la beta: avisa (una vez al día) a las bóvedas que pasan de él. No mueve nada: solo recomienda sacar lo
 * que sobra. La app ya no deja guardar más; esto es por si alguien manda HBAR directamente a la bóveda.
 */
async function checkCaps() {
  if (!(MAX_VAULT_HBAR > 0) || Date.now() - capCheckedAt < CAP_CHECK_MS) return;
  capCheckedAt = Date.now();
  const day = Math.floor(nowSeconds() / 86400);
  for (const [vaultId, v] of Object.entries(state.vaults)) {
    if (v.capWarnedDay === day) continue;
    const acc = await mirror.account(vaultId).catch(() => null);
    if (!acc || acc.balance <= BigInt(MAX_VAULT_HBAR) * HBAR) continue;
    v.capWarnedDay = day;
    await push(
      v,
      T(v, "Tu bóveda pasa del tope de la beta", "Your vault is over the beta limit"),
      T(
        v,
        `Durante la beta recomendamos guardar como mucho ${MAX_VAULT_HBAR} HBAR por bóveda y tienes ${formatHbar(acc.balance)}. Saca lo que sobra a tu Cartera cuando puedas.`,
        `During the beta we recommend keeping at most ${MAX_VAULT_HBAR} HBAR per vault and you have ${formatHbar(acc.balance)}. Move the excess to your Wallet when you can.`,
      ),
      { vaultId, kind: "cap" },
      { mail: false },
    );
  }
  saveState();
}

let h10xCheckedAt = 0;
let h10xRunning = false;
/** Fecha y hora de Madrid para los avisos de H10X. @param {VaultEntry} v @param {number} sec */
const madrid = (v, sec) => `${formatDateTime(sec, v.lang ?? "es", "Europe/Madrid")} ${T(v, "(hora de Madrid)", "(Madrid time)")}`;

/**
 * Texto de un aviso de H10X en el idioma de la bóveda. Sin enlaces: «en la app, H10X → DAO».
 * @param {VaultEntry} v @param {import("./h10x-watch.js").H10xEvent} ev @param {Map<string, string>} sym
 * @returns {{ title: string, body: string }}
 */
function h10xText(v, ev, sym) {
  const s = (/** @type {string} */ id) => sym.get(id) ?? id;
  if (ev.kind === "dao-open") {
    return {
      title: T(v, "🗳️ Nueva ronda de la DAO de H10X", "🗳️ New H10X DAO round"),
      body: T(
        v,
        `Ronda ${ev.round}: se pueden proponer tokens hasta el ${madrid(v, ev.proposeEnd)}. Votación del ${madrid(v, ev.voteStart)} al ${madrid(v, ev.voteEnd)}.`,
        `Round ${ev.round}: tokens can be proposed until ${madrid(v, ev.proposeEnd)}. Voting from ${madrid(v, ev.voteStart)} to ${madrid(v, ev.voteEnd)}.`,
      ),
    };
  }
  if (ev.kind === "dao-vote") {
    return {
      title: T(v, "🗳️ Ya se vota en la DAO de H10X", "🗳️ H10X DAO voting is open"),
      body: T(v, `Ronda ${ev.round}: puedes votar hasta el ${madrid(v, ev.voteEnd)}. Detalles en la app, en H10X → DAO.`, `Round ${ev.round}: you can vote until ${madrid(v, ev.voteEnd)}. Details in the app, under H10X → DAO.`),
    };
  }
  if (ev.kind === "dao-last24") {
    return {
      title: T(v, "⏳ Últimas 24 h para votar en la DAO de H10X", "⏳ Last 24 h to vote in the H10X DAO"),
      body: T(v, `La votación de la ronda ${ev.round} acaba el ${madrid(v, ev.voteEnd)}.`, `Voting in round ${ev.round} ends ${madrid(v, ev.voteEnd)}.`),
    };
  }
  if (ev.kind === "dao-result") {
    const names = ev.winners.map(s).join(", ");
    return {
      title: T(v, "Resultado de la DAO de H10X", "H10X DAO result"),
      body: !ev.quorum
        ? T(v, `Ronda ${ev.round}: no hubo quórum; la cesta no cambia.`, `Round ${ev.round}: no quorum; the basket stays the same.`)
        : ev.winners.length
          ? T(v, `Ronda ${ev.round}: entra ${names} en la cesta.`, `Round ${ev.round}: ${names} joins the basket.`)
          : T(v, `Ronda ${ev.round}: ganó dejar el hueco libre; la cesta no cambia.`, `Round ${ev.round}: leaving the slot empty won; the basket stays the same.`),
    };
  }
  const parts = [];
  if (ev.added.length) parts.push(T(v, `Entra ${ev.added.map(s).join(", ")}.`, `${ev.added.map(s).join(", ")} joins.`));
  if (ev.removed.length) parts.push(T(v, `Sale ${ev.removed.map(s).join(", ")}.`, `${ev.removed.map(s).join(", ")} leaves.`));
  if (ev.weights) parts.push(T(v, "Hay pesos nuevos.", "New weights."));
  return { title: T(v, "🧺 La cesta de H10X ha cambiado", "🧺 The H10X basket changed"), body: parts.join(" ") };
}

/** Avisos de H10X: lee lo nuevo de la DAO y de la cesta y lo manda a quien lo quiera (sin correo: no es urgente). */
async function checkH10x() {
  if (!H10X_ALERTS || Date.now() - h10xCheckedAt < H10X_POLL_MS) return;
  h10xCheckedAt = Date.now();
  state.h10x ??= {};
  const events = await h10xWatcher.poll(state.h10x, nowSeconds());
  saveState();
  if (!events.length) return;
  /** @type {Map<string, string>} */
  const sym = new Map();
  for (const ev of events) {
    const ids = ev.kind === "dao-result" ? ev.winners : ev.kind === "basket" ? [...ev.added, ...ev.removed] : [];
    for (const id of ids) if (!sym.has(id)) sym.set(id, await h10xWatcher.symbolOf(id));
  }
  for (const ev of events) {
    const wants = ev.kind === "basket" ? (/** @type {VaultEntry} */ v) => v.h10x?.basket !== false : (/** @type {VaultEntry} */ v) => v.h10x?.dao !== false;
    const vaults = Object.entries(state.vaults).filter(([, v]) => wants(v));
    log(`aviso de H10X (${ev.kind}${"round" in ev ? ` ${ev.round}` : ""}) → ${vaults.length} bóvedas`);
    for (const [vaultId, v] of vaults) {
      const { title, body } = h10xText(v, ev, sym);
      await push(v, title, body, { vaultId, kind: `h10x-${ev.kind}` }, { mail: false });
    }
  }
}

/** Topes de la beta que anuncia el guardián (0 = sin tope). */
const betaLimits = () => ({ maxVaultHbar: MAX_VAULT_HBAR, maxVaults: MAX_VAULTS });

// ---- Registro de bóvedas -------------------------------------------------------------------------

/**
 * Comprueba en la red que la bóveda, el notario y la cartera encajan y que la petición la firma el móvil.
 * @param {any} body
 */
async function register(body) {
  const fields = ["vaultId", "notaryId", "pocketId", "timestamp", "signature"];
  for (const f of fields) if (body?.[f] == null) throw new HttpError(400, `falta ${f}`);
  if (Math.abs(nowSeconds() - Number(body.timestamp)) > 600) throw new HttpError(400, "la firma ha caducado; vuelve a intentarlo");
  const vaultId = AccountId.fromString(entityId(body.vaultId)).toString();
  const notaryId = ContractId.fromString(entityId(body.notaryId));
  const pocketId = AccountId.fromString(entityId(body.pocketId)).toString();

  const pocket = await mirror.account(pocketId);
  if (!pocket || !(pocket.key instanceof PublicKey)) throw new HttpError(400, "no encuentro la cartera o su clave no es simple");
  const lang = body.lang === "en" || body.lang === "es" ? body.lang : undefined;
  // Preferencias de avisos de H10X (registro v3): van firmadas; si no vienen, se mantienen las que hubiera.
  const h10xCode = body.h10x == null ? undefined : String(body.h10x);
  const h10xPrefs = h10xCode === undefined ? undefined : parseH10xPrefs(h10xCode);
  if (h10xCode !== undefined && !h10xPrefs) throw new HttpError(400, "preferencias de avisos de H10X no válidas");
  const signed = {
    vaultId,
    notaryId: notaryId.toString(),
    pocketId,
    pushToken: body.pushToken ?? null,
    timestamp: Number(body.timestamp),
    signature: String(body.signature),
    ...(lang ? { lang } : {}),
    ...(h10xCode ? { h10x: h10xCode } : {}),
  };
  if (!verifyRegistration(pocket.key, signed)) throw new HttpError(401, "la firma no corresponde a la cartera");

  const vault = await mirror.account(vaultId);
  /** @type {1 | 2} */
  let version;
  /** @type {{ device: string, kit: string } | null} */
  let laneKeys = null;
  if (vault && vault.key instanceof KeyList && isVaultKeyV2For(vault.key, notaryId)) {
    const withdrawRoute = /** @type {KeyList} */ (vault.key.toArray()[0]);
    if (keyFingerprint(withdrawRoute.toArray()[0]) !== keyFingerprint(pocket.key)) throw new HttpError(400, "la bóveda no pertenece a esa cartera");
    const cfg = await notary2Config({ mirror, notaryId }).catch(() => null);
    if (!cfg || cfg.device !== pocket.evmAddress) throw new HttpError(400, "el notario no tiene a esa cartera como móvil");
    // Solo los plazos que ofrece la app (en redes de prueba, también los de minutos). Un notario con una
    // cuenta atrás de segundos, o con plazos raros, solo sirve para hacer gastar al guardián.
    try {
      checkDelays(cfg.withdrawDelay, cfg.recoveryDelay, { allowTest: ALLOW_TEST_DELAYS });
    } catch {
      throw new HttpError(400, "los plazos de ese notario no son los de la app");
    }
    version = 2;
    laneKeys = await vaultLaneKeys(vaultId);
  } else if (vault && isVaultKeyFor(vault.key, notaryId)) {
    if (keyFingerprint(vaultDeviceKey(vault.key)) !== keyFingerprint(pocket.key)) throw new HttpError(400, "la bóveda no pertenece a esa cartera");
    const call = await mirror.simulate({ to: contractAddress(notaryId), data: notaryAbi.encodeFunctionData("quorum", []), gas: 50_000 });
    const quorum = call.ok ? String(notaryAbi.decodeFunctionResult("quorum", call.result)[0]).toLowerCase() : "";
    if (quorum !== pocket.evmAddress) throw new HttpError(400, "el notario no tiene a esa cartera como quórum");
    version = 1;
  } else {
    throw new HttpError(400, "la cuenta no es una bóveda de ese notario");
  }

  const existing = state.vaults[vaultId];
  if (!existing && !(await makeRoom(vaultId))) throw new HttpError(503, "el guardián está lleno");
  // Otro destino para los avisos (otro móvil, o ninguno): se avisa al anterior y al correo. Si alguien con
  // la llave del móvil intenta silenciar los avisos, el dueño se entera.
  if (existing && (existing.pushToken ?? null) !== (signed.pushToken ?? null)) {
    await push(
      existing,
      T(existing, "⚠️ Tus avisos van ahora a otro móvil", "⚠️ Your alerts now go to another phone"),
      T(
        existing,
        "Se ha vuelto a registrar la bóveda y los avisos del móvil van a otro sitio (o a ninguno). Si has reinstalado la app o cambiado de móvil, es normal.",
        "The vault was registered again and phone alerts now go somewhere else (or nowhere). If you reinstalled the app or changed phones, that's expected.",
      ),
      { vaultId },
    );
  }
  // Notario nuevo (p. ej. tras cambiar los plazos): lo pendiente del anterior ya no puede ejecutarse.
  const sameNotary = existing?.notaryId === notaryId.toString();
  // Código de lectura para la app: con él, GET /vaults/<id> le dice lo que necesita (modo robo, correo…); a los demás,
  // solo si está registrada. Cada registro (firmado por el móvil) da uno nuevo y el anterior deja de valer.
  const readToken = randomBytes(24).toString("base64url");
  state.vaults[vaultId] = {
    notaryId: notaryId.toString(),
    version,
    pocketId,
    pushToken: signed.pushToken,
    lang: lang ?? existing?.lang ?? "es",
    lastLog: sameNotary ? existing?.lastLog : undefined,
    pending: sameNotary ? (existing?.pending ?? {}) : {},
    registeredAt: existing?.registeredAt ?? nowSeconds(),
    // Volver a registrar (p. ej. desde el móvil robado) NO quita el modo robo: solo lo quita el kit.
    ...(existing?.theft ? { theft: existing.theft } : {}),
    // Ni el correo (solo lo cambia el kit), ni lo gastado hoy (volver a registrar no reinicia los topes).
    ...(existing?.email ? { email: existing.email } : {}),
    ...(existing?.emailPending ? { emailPending: existing.emailPending } : {}),
    ...(existing?.emailCodes ? { emailCodes: existing.emailCodes } : {}),
    ...(existing?.spend ? { spend: existing.spend } : {}),
    ...(existing?.budgetNoted ? { budgetNoted: existing.budgetNoted } : {}),
    ...(existing?.nextFreezeAt ? { nextFreezeAt: existing.nextFreezeAt } : {}),
    ...(existing?.bogusAt ? { bogusAt: existing.bogusAt } : {}),
    ...(sameNotary && existing?.stuck ? { stuck: existing.stuck } : {}),
    ...(laneKeys ? { deviceKey: laneKeys.device, rescueKey: laneKeys.kit } : {}),
    ...(h10xPrefs ? { h10x: h10xPrefs } : existing?.h10x ? { h10x: existing.h10x } : {}),
    ...(existing?.capWarnedDay ? { capWarnedDay: existing.capWarnedDay } : {}),
    readHash: readHash(readToken),
  };
  saveState();
  log(`bóveda v${version} registrada: ${vaultId} (notario ${notaryId}, cartera ${pocketId}, avisos ${signed.pushToken ? "sí" : "no"}, idioma ${lang ?? existing?.lang ?? "es"})`);
  setTimeout(() => void tick(), 500);
  return { ok: true, readToken };
}

/** sha256 (hex) de un código de lectura. @param {string} token */
const readHash = (token) => createHash("sha256").update(`h10x-read|${token}`).digest("hex");

/**
 * ¿Trae la petición el código de lectura bueno de esa bóveda? (cabecera x-h10x-token)
 * @param {VaultEntry | undefined} v @param {import("node:http").IncomingMessage} req
 */
function readTokenOk(v, req) {
  const given = req.headers["x-h10x-token"];
  if (!v?.readHash || typeof given !== "string" || given.length < 16 || given.length > 128) return false;
  return timingSafeEqual(Buffer.from(readHash(given), "hex"), Buffer.from(v.readHash, "hex"));
}

/** Códigos pedidos hoy por dirección (para que nadie use el guardián para escribir a desconocidos). */
const codesTo = new Map();
const codeHash = (/** @type {string} */ vaultId, /** @type {string} */ address, /** @type {string} */ code) => createHash("sha256").update(`${vaultId}|${address}|${code}`).digest();

/**
 * Avisos por correo: poner (con código), confirmar o quitar el correo de una bóveda. Lo firma la llave del
 * KIT: quien tenga solo el móvil no puede quitarlo ni desviarlo. La bóveda tiene que estar registrada.
 * @param {any} body
 */
async function emailNotice(body) {
  for (const f of ["action", "vaultId", "notaryId", "email", "timestamp", "signature"]) if (body?.[f] == null) throw new HttpError(400, `falta ${f}`);
  if (!["start", "confirm", "remove"].includes(body.action)) throw new HttpError(400, "acción no válida");
  if (Math.abs(nowSeconds() - Number(body.timestamp)) > 600) throw new HttpError(400, "la firma ha caducado; vuelve a intentarlo");
  const vaultId = AccountId.fromString(entityId(body.vaultId)).toString();
  const notaryId = ContractId.fromString(entityId(body.notaryId)).toString();
  const lang = body.lang === "en" || body.lang === "es" ? body.lang : undefined;
  const code = body.code == null ? undefined : String(body.code);
  const vault = await inspectVaultV2({ mirror, vaultId });
  if (!vault || vault.notaryId.toString() !== notaryId) throw new HttpError(400, "no es una bóveda v2 de ese notario");
  const signed = { action: body.action, vaultId, notaryId, email: String(body.email), ...(code != null ? { code } : {}), timestamp: Number(body.timestamp), signature: String(body.signature), ...(lang ? { lang } : {}) };
  if (!verifyEmailNotice(vault.rescueKey, signed)) throw new HttpError(401, "la firma no es la del kit de esta bóveda");
  const v = state.vaults[vaultId];
  if (!v) throw new HttpError(409, "la bóveda no está registrada en este guardián: conéctala primero desde Ajustes");
  const L = lang ?? v.lang ?? "es";
  const now = nowSeconds();

  if (body.action === "remove") {
    const old = v.email?.address;
    delete v.email;
    delete v.emailPending;
    saveState();
    if (old) {
      log(`correo de avisos quitado en ${vaultId} con la llave del kit`);
      void sendEmail(EMAIL, {
        to: old,
        subject: L === "en" ? "H10X Wallet · Email alerts turned off" : "H10X Wallet · Avisos por correo desactivados",
        text: alertText(L, L === "en" ? "This address will no longer receive the alerts of this vault. It was done with the vault's 24 words." : "Este correo ya no recibirá los avisos de esta bóveda. Se ha hecho con las 24 palabras de la bóveda.", vaultId),
      });
      await push(v, T(v, "Avisos por correo desactivados", "Email alerts turned off"), T(v, `Ya no se avisa a ${maskEmail(old)}.`, `${maskEmail(old)} is no longer alerted.`), { vaultId }, { mail: false });
    }
    return { ok: true, email: null };
  }

  if (!EMAIL.enabled) throw new HttpError(503, "este guardián no manda correos");
  const address = normalizeEmail(signed.email);
  if (!isValidEmail(address)) throw new HttpError(400, "ese correo no es válido");

  if (body.action === "start") {
    const day = Math.floor(now / 86400);
    if (!v.emailCodes || v.emailCodes.day !== day) v.emailCodes = { day, count: 0 };
    const sent = codesTo.get(address);
    const toCount = sent && sent.day === day ? sent.count : 0;
    if (v.emailCodes.count >= 5 || toCount >= 3) throw new HttpError(429, "demasiados códigos por hoy; vuelve a intentarlo mañana");
    v.emailCodes.count += 1;
    codesTo.set(address, { day, count: toCount + 1 });
    const fresh = String(randomInt(0, 1_000_000)).padStart(6, "0");
    v.emailPending = { address, hash: codeHash(vaultId, address, fresh).toString("hex"), expires: now + 900, tries: 0 };
    saveState();
    const out = await sendEmail(EMAIL, { to: address, subject: L === "en" ? "H10X Wallet · Your code" : "H10X Wallet · Tu código", text: codeText(L, fresh, vaultId) });
    if (!out.ok) {
      delete v.emailPending;
      saveState();
      log(`no se pudo mandar el código de ${vaultId}: ${out.error}`);
      throw new HttpError(502, "no se pudo mandar el correo; prueba otra vez en un rato");
    }
    log(`código de correo mandado para ${vaultId} a ${maskEmail(address)}`);
    return { ok: true, sentTo: maskEmail(address) };
  }

  // confirm
  const p = v.emailPending;
  if (!p || p.address !== address || p.expires < now) throw new HttpError(400, "no hay ningún código pendiente para ese correo; pide otro");
  const given = /^\d{6}$/.test(code ?? "") ? codeHash(vaultId, address, String(code)) : Buffer.alloc(32);
  if (!timingSafeEqual(given, Buffer.from(p.hash, "hex"))) {
    p.tries += 1;
    if (p.tries >= 5) delete v.emailPending;
    saveState();
    throw new HttpError(400, p.tries >= 5 ? "código incorrecto demasiadas veces; pide otro" : "código incorrecto");
  }
  const old = v.email?.address;
  v.email = { address, since: now };
  delete v.emailPending;
  if (lang) v.lang = lang;
  saveState();
  log(`correo de avisos de ${vaultId}: ${maskEmail(address)}${old && old !== address ? ` (antes ${maskEmail(old)})` : ""}`);
  void sendEmail(EMAIL, {
    to: address,
    subject: L === "en" ? "H10X Wallet · Email alerts on" : "H10X Wallet · Avisos por correo activados",
    text: alertText(
      L,
      L === "en"
        ? "From now on this address receives the important alerts of this vault: withdrawals requested, blocked operations, use of the rescue kit, theft mode and changes of the phone that receives the alerts."
        : "Desde ahora este correo recibe los avisos importantes de esta bóveda: retiradas pedidas, operaciones bloqueadas, uso del kit de rescate, modo robo y cambios del móvil que recibe los avisos.",
      vaultId,
    ),
  });
  if (old && old !== address) {
    void sendEmail(EMAIL, {
      to: old,
      subject: L === "en" ? "H10X Wallet · Alerts moved to another email" : "H10X Wallet · Los avisos van a otro correo",
      text: alertText(L, L === "en" ? `The alerts of this vault now go to ${maskEmail(address)}. It was done with the vault's 24 words.` : `Los avisos de esta bóveda van ahora a ${maskEmail(address)}. Se ha hecho con las 24 palabras de la bóveda.`, vaultId),
    });
  }
  await push(v, T(v, "Avisos por correo activados", "Email alerts on"), T(v, `Si pasa algo importante, también se avisa a ${maskEmail(address)}.`, `If something important happens, ${maskEmail(address)} is alerted too.`), { vaultId }, { mail: false });
  return { ok: true, email: maskEmail(address) };
}

/**
 * Modo robo: lo activa (o lo quita) un mensaje firmado con la llave del KIT de la bóveda.
 * Funciona aunque la bóveda no estuviera registrada (el registro lo hacía el móvil robado).
 * @param {any} body
 */
async function theft(body) {
  for (const f of ["action", "vaultId", "notaryId", "timestamp", "signature"]) if (body?.[f] == null) throw new HttpError(400, `falta ${f}`);
  if (body.action !== "on" && body.action !== "off") throw new HttpError(400, "acción no válida");
  if (Math.abs(nowSeconds() - Number(body.timestamp)) > 600) throw new HttpError(400, "la firma ha caducado; vuelve a intentarlo");
  const vaultId = AccountId.fromString(entityId(body.vaultId)).toString();
  const notaryId = ContractId.fromString(entityId(body.notaryId)).toString();
  const lang = body.lang === "en" || body.lang === "es" ? body.lang : undefined;
  const vault = await inspectVaultV2({ mirror, vaultId });
  if (!vault || vault.notaryId.toString() !== notaryId) throw new HttpError(400, "no es una bóveda v2 de ese notario");
  const signed = { action: body.action, vaultId, notaryId, timestamp: Number(body.timestamp), signature: String(body.signature), ...(lang ? { lang } : {}) };
  if (!verifyTheftNotice(vault.rescueKey, signed)) throw new HttpError(401, "la firma no es la del kit de esta bóveda");

  let v = state.vaults[vaultId];
  if (body.action === "on") {
    if (!v) {
      if (!(await makeRoom(vaultId))) throw new HttpError(503, "el guardián está lleno");
      v = state.vaults[vaultId] = { notaryId, version: 2, pocketId: "", pushToken: null, lang: lang ?? "es", pending: {}, registeredAt: nowSeconds() };
    }
    if (!v.rescueKey) v.rescueKey = vault.rescueKey.toStringDer();
    const now = nowSeconds();
    v.theft = { since: v.theft?.since ?? now, until: now + THEFT_MAX_SECONDS };
    log(`modo robo ACTIVADO en ${vaultId} con la llave del kit`);
    // El aviso va al móvil registrado: si el robo es del kit (no del móvil), así lo sabe el dueño.
    await push(
      v,
      T(v, "⚠️ Modo robo activado con tu kit", "⚠️ Theft mode turned on with your kit"),
      T(v, "Todas las retiradas quedan bloqueadas mientras se recupera la bóveda. Si no has sido tú, evacúa la bóveda con el móvil y el kit.", "All withdrawals are blocked while the vault is recovered. If it wasn't you, evacuate the vault with the phone and the kit."),
      { vaultId },
    );
  } else if (v?.theft) {
    v.theft = undefined;
    log(`modo robo desactivado en ${vaultId} con la llave del kit`);
    await push(v, T(v, "Modo robo desactivado", "Theft mode turned off"), T(v, "Las retiradas vuelven a funcionar con normalidad.", "Withdrawals work normally again."), { vaultId });
  }
  saveState();
  setTimeout(() => void tick(), 300);
  return { ok: true, theft: Boolean(state.vaults[vaultId]?.theft), until: state.vaults[vaultId]?.theft?.until ?? 0 };
}

/**
 * ID de Hedera (0.0.N) que llega en una petición. Si no tiene esa forma, error 400 (antes salía un 500 del SDK).
 * @param {unknown} v
 */
function entityId(v) {
  const s = String(v ?? "");
  if (!/^0\.0\.\d{1,15}$/.test(s)) throw new HttpError(400, "ID de Hedera no válido");
  return s;
}

class HttpError extends Error {
  /** @param {number} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Precios compartidos por todas las apps: uno cada minuto como mucho (las APIs limitan peticiones). */
let pricesCache = /** @type {{ at: number, data: unknown } | null} */ (null);
let pricesInFlight = /** @type {Promise<unknown> | null} */ (null);
async function prices() {
  if (pricesCache && Date.now() - pricesCache.at < 60_000) return pricesCache.data;
  if (!pricesInFlight) {
    pricesInFlight = fetchPrices({ saucerswapKey: SAUCERSWAP_API_KEY, network: NETWORK })
      .then((data) => {
        pricesCache = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        pricesInFlight = null;
      });
  }
  try {
    return await pricesInFlight;
  } catch (e) {
    if (pricesCache) return pricesCache.data; // mejor un precio de hace un rato que ninguno
    throw new HttpError(503, `sin precios: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Hace sitio para una bóveda nueva cuando el guardián está lleno: se va la registrada con MENOS saldo
 * (sin nada pendiente ni modo robo), solo si tiene menos que la nueva. Así nadie deja fuera a las
 * bóvedas de verdad llenándolo de bóvedas vacías.
 * @param {string} newVaultId
 */
async function makeRoom(newVaultId) {
  if (Object.keys(state.vaults).length < MAX_VAULTS) return true;
  const wanted = (await mirror.account(newVaultId).catch(() => null))?.balance ?? 0n;
  const busy = (/** @type {VaultEntry} */ v) => Object.values(v.pending).some((p) => p.status === "requested" || p.status === "approved");
  const sample = Object.entries(state.vaults)
    .filter(([, v]) => !busy(v) && !v.theft)
    .sort((a, b) => a[1].registeredAt - b[1].registeredAt)
    .slice(0, 25);
  const candidates = [];
  for (const [id, v] of sample) {
    const balance = (await mirror.account(id).catch(() => null))?.balance ?? 0n;
    candidates.push({ id, balance, busy: false, email: Boolean(v.email), theft: false });
  }
  const out = pickEviction(candidates, wanted);
  if (!out) return false;
  const gone = state.vaults[out];
  delete state.vaults[out];
  const balance = candidates.find((c) => c.id === out)?.balance ?? 0n;
  log(`guardián lleno: sale ${out} (${formatHbar(balance)} HBAR) para dejar sitio a ${newVaultId}`);
  // Nunca en silencio: su dueño seguiría creyendo que el guardián la vigila. La app 0.10 también lo nota sola.
  void push(
    gone,
    T(gone, "⚠️ El guardián ya no vigila tu bóveda", "⚠️ The guardian no longer watches your vault"),
    T(
      gone,
      "Estaba lleno y ha dejado sitio a una bóveda con más saldo. Mientras no vuelva a vigilarla, nadie bloquea por ti lo que no reconozcas ni completa tus retiradas. Abre la app para volver a conectarla.",
      "It was full and made room for a vault with a larger balance. Until it watches it again, nobody blocks what you don't recognise for you or completes your withdrawals. Open the app to connect it again.",
    ),
    { vaultId: out },
  );
  return true;
}

/**
 * Quién hace la petición. El móvil llega por el servidor de Expo (proxy en este mismo VPS): entonces
 * cuenta la última dirección de X-Forwarded-For, la que añade ese proxy.
 * @param {import("node:http").IncomingMessage} req
 */
function clientOf(req) {
  const remote = req.socket.remoteAddress ?? "?";
  const local = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  const chain = String(req.headers["x-forwarded-for"] ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return local && chain.length ? chain[chain.length - 1].slice(0, 64) : remote;
}

/**
 * Solo cuentan las peticiones FALLIDAS (firma mala, datos raros): 10 por minuto y dirección, y 300 por
 * minuto en total. Una petición bien firmada nunca se frena por culpa de otro.
 */
const failures = new Map();
/** @type {number[]} */
let allFailures = [];
/** @param {string} who */
function blocked(who) {
  const now = Date.now();
  allFailures = allFailures.filter((t) => now - t < 60_000);
  const mine = (failures.get(who) ?? []).filter((/** @type {number} */ t) => now - t < 60_000);
  failures.set(who, mine);
  return mine.length >= 10 || allFailures.length >= 300;
}
/** @param {string} who */
function failed(who) {
  const now = Date.now();
  failures.set(who, [...(failures.get(who) ?? []), now]);
  allFailures.push(now);
  if (failures.size > 10_000) failures.clear(); // que no crezca sin fin
}

/**
 * Aviso de robo de una bóveda ya registrada: se comprueba con la clave del kit guardada, sin tocar el
 * mirror. Si la firma es buena, pasa aunque alguien esté inundando el guardián.
 * @param {any} body
 */
function trustedTheftNotice(body) {
  try {
    const vaultId = AccountId.fromString(entityId(body?.vaultId)).toString();
    const v = state.vaults[vaultId];
    if (!v?.rescueKey || String(body?.notaryId) !== v.notaryId) return false;
    if (Math.abs(nowSeconds() - Number(body.timestamp)) > 600) return false;
    const lang = body.lang === "en" || body.lang === "es" ? body.lang : undefined;
    const signed = { action: body.action, vaultId, notaryId: v.notaryId, timestamp: Number(body.timestamp), signature: String(body.signature), ...(lang ? { lang } : {}) };
    return verifyTheftNotice(PublicKey.fromString(v.rescueKey), signed);
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  const send = (/** @type {number} */ code, /** @type {unknown} */ obj) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  };
  // Detrás del servidor de Expo (proxy), las rutas llegan con el prefijo /guardian.
  const path = (req.url ?? "/").replace(/^\/guardian/, "").split("?")[0] || "/";
  try {
    if (req.method === "GET" && (path === "/" || path === "/health")) return send(200, { ok: true, version: VERSION });
    if (req.method === "GET" && path === "/info") {
      const factory = await notaryFactory().catch(() => null);
      return send(200, { network: NETWORK, account: operatorId, evmAddress: operatorEvm, version: VERSION, tokenPrices: Boolean(SAUCERSWAP_API_KEY), lowBalance, emails: EMAIL.enabled, limits: betaLimits(), notice: currentNotice, notaryFactory: factory });
    }
    if (req.method === "GET" && path === "/notice") return send(200, { notice: currentNotice, limits: betaLimits() });
    if (req.method === "GET" && path === "/prices") return send(200, await prices());
    if (req.method === "POST" && (path === "/register" || path === "/theft" || path === "/email")) {
      const who = clientOf(req);
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 8192) {
          failed(who);
          throw new HttpError(413, "petición demasiado grande");
        }
      }
      let body;
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        failed(who);
        throw new HttpError(400, "JSON no válido");
      }
      // El aviso de robo bien firmado de una bóveda conocida pasa siempre; lo demás, si no hay abuso.
      if (!(path === "/theft" && trustedTheftNotice(body)) && blocked(who)) throw new HttpError(429, "demasiadas peticiones");
      try {
        return send(200, path === "/theft" ? await theft(body) : path === "/email" ? await emailNotice(body) : await register(body));
      } catch (e) {
        if (e instanceof HttpError && e.code >= 400 && e.code < 500) failed(who);
        throw e;
      }
    }
    if (req.method === "GET" && path.startsWith("/vaults/")) {
      const id = path.slice("/vaults/".length);
      const v = Object.hasOwn(state.vaults, id) ? state.vaults[id] : undefined;
      // A cualquiera, solo si está registrada; a la app de esa bóveda (con su código) y al propio servidor, más.
      const who = statusAudience({ remote: req.socket.remoteAddress, forwarded: req.headers["x-forwarded-for"], tokenOk: readTokenOk(v, req) });
      // Registrada por una app anterior a la 0.10 (sin código): lo que esa app necesita, sin lo pendiente. `legacy`: la
      // app 0.10 pide entonces su código (con su próxima firma) y desde ese momento ya no se enseña a nadie más.
      if (who === "public" && v && !v.readHash) return send(200, { ...vaultStatusView(v, "owner", { now: nowSeconds(), mask: maskEmail }), legacy: true });
      return send(v ? 200 : 404, vaultStatusView(v, who, { now: nowSeconds(), mask: maskEmail }));
    }
    send(404, { error: "no existe" });
  } catch (e) {
    const code = e instanceof HttpError ? e.code : e instanceof SyntaxError ? 400 : 500;
    if (code === 500) log(`error en ${path}: ${e instanceof Error ? e.stack : String(e)}`);
    // Cuerpo demasiado grande: se deja de leer a medias, así que esa conexión ya no sirve. Se cierra para que nadie
    // (p. ej. Caddy, que reutiliza conexiones) mande por ella la petición de otra persona y reciba un error.
    if (code === 413) res.setHeader("connection", "close");
    send(code, { error: e instanceof Error ? e.message : String(e) });
    if (code === 413) res.once("finish", () => req.destroy());
  }
});

// ---- Arranque ------------------------------------------------------------------------------------

async function main() {
  let idText = process.env.OPERATOR_ID;
  if (!idText) {
    if (operatorKey.publicKey.type !== "secp256k1") throw new Error("Falta OPERATOR_ID (solo se deduce con una clave ECDSA).");
    const acc = await mirror.account(`0x${operatorKey.publicKey.toEvmAddress()}`);
    if (!acc) throw new Error("La clave del guardián no tiene cuenta en la red: ¿has usado el faucet?");
    idText = acc.id.toString();
  }
  const account = await mirror.account(idText);
  if (!account) throw new Error(`No encuentro la cuenta ${idText} en el mirror node`);
  operatorId = account.id.toString();
  operatorEvm = account.evmAddress;
  client = createClient(NETWORK, { accountId: operatorId, key: operatorKey });

  server.on("error", (e) => {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "EADDRINUSE") {
      console.error(`⛔ El puerto ${PORT} ya lo está usando otro programa de este servidor.`);
      console.error(`   No lo pares: elige otro puerto para el guardián, por ejemplo:`);
      console.error(`   echo "PORT=${PORT + 10}" >> guardian/.env   y vuelve a arrancarlo.`);
    } else {
      console.error(`⛔ No se pudo abrir ${HOST}:${PORT}: ${e.message}`);
    }
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    log(`guardián ${VERSION} · red ${NETWORK} · cuenta ${operatorId} (${formatHbar(account.balance)} HBAR) · http://${HOST}:${PORT}`);
    log(`${Object.keys(state.vaults).length} bóvedas registradas; revisando cada ${POLL_MS / 1000} s`);
    log(`correo: ${EMAIL.enabled ? `${EMAIL.provider}${EMAIL.provider === "archivo" ? "" : ` desde ${EMAIL.from}`}` : EMAIL.problem}`);
    if (IS_MAINNET) log(`MAINNET (beta): tope ${MAX_VAULT_HBAR} HBAR por bóveda, ${MAX_VAULTS} bóvedas como mucho; presupuesto diario por bóveda ${BUDGET.approve}/${BUDGET.veto}/${BUDGET.freeze}`);
  });
  setInterval(() => void tick(), POLL_MS);
  void tick();
}

const stop = () => {
  log("parando");
  saveState();
  server.close();
  client?.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

main().catch((e) => {
  console.error(`⛔ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
