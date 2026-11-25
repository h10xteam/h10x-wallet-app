// @ts-check
// Cambio de móvil: la Cartera y la bóveda pasan a la llave de un móvil nuevo SIN copiar ninguna llave, sin esperar y
// sin tocar el notario.
//
//   1. El móvil nuevo crea su propia llave (que nunca sale de él) y, con el kit (las 24 palabras), deja en Hedera dos
//      operaciones programadas que paga la cuenta del kit:
//        · la Cartera pasa a la llave nueva;
//        · la bóveda cambia la llave del móvil por la nueva (el mismo kit y el mismo notario).
//      Hedera exige que firme también la llave nueva al cambiar una llave: la pone el móvil nuevo al crearlas.
//   2. Ninguna de las dos se puede ejecutar sin la firma del móvil viejo: la de la Cartera porque es su llave; la de la
//      bóveda porque su ruta «móvil + kit» exige las dos llaves (la ruta del notario necesitaría su cuenta atrás).
//   3. El móvil viejo las encuentra en el mirror (las creó la cuenta del kit), comprueba campo a campo que son
//      exactamente eso y, si su dueño confirma con la huella, las firma: se ejecutan al momento.
//
// El notario reconoce a la Cartera por su dirección EVM (su alias), que no cambia al cambiar la llave de la cuenta: por
// eso no hace falta otro notario ni otra bóveda. Hace falta lo mismo que para evacuar (el móvil y el kit a la vez): no
// abre ninguna puerta nueva. Con solo el kit se puede PEDIR, pero no terminar; el móvil viejo lo ve y avisa.

import {
  AccountId,
  AccountUpdateTransaction,
  ContractId,
  Hbar,
  Key,
  KeyList,
  PublicKey,
  ScheduleCreateTransaction,
  ScheduleSignTransaction,
  ScheduleId,
  Timestamp,
} from "@hiero-ledger/sdk";
import * as HieroProto from "@hiero-ledger/proto";
import { decodeBase64, getBytes, sha256 } from "ethers";
import { tr } from "./i18n.js";
import { WalletError, submit } from "./wallet.js";
import { buildVaultKeyV2, findRescueAccount, inspectVaultV2, isVaultKeyV2For, notary2Config } from "./v2.js";
import { cleanLabel } from "./h10x.js";
import { WORDS_EN, WORDS_ES } from "./words.js";

/** Así empiezan los memos de las dos peticiones (el resto es «cartera|bóveda · nombre del móvil nuevo»). */
export const MOVE_MEMO_PREFIX = "H10X Wallet · cambio de móvil";
/** Comisión máxima de cada cambio de llave programado (lo paga la cuenta del kit; cuesta mucho menos). */
const INNER_MAX_FEE_TINYBARS = 200_000_000n;
/** Lo que conviene que tenga la cuenta del kit para pagar las dos peticiones (unos 0,4 HBAR con el HBAR a 0,05 $). */
export const MOVE_KIT_MIN_TINYBARS = 100_000_000n;
/** Tiempo que tiene el móvil viejo para confirmar (las peticiones caducan solas después). */
export const MOVE_REQUEST_LIFETIME_SECONDS = 3600;
/** Sin caducidad explícita, Hedera borra una programada a los 30 minutos (y el mirror la enseña sin fecha). */
const DEFAULT_SCHEDULE_LIFETIME_SECONDS = 1800;

/**
 * Lo que hace falta saber de una wallet para cambiarla de móvil (todo leído de la red).
 * @typedef {{
 *   vaultId: string, notaryId: string, carteraId: string, carteraEvm: string, kitAccountId: string,
 *   carteraKey: PublicKey, vaultDeviceKey: PublicKey, rescueKey: PublicKey,
 *   withdrawDelay: number, recoveryDelay: number, tiebreaker: boolean, guardianEvm: string, kitBalance: bigint
 * }} MoveWallet
 */

const raw = (/** @type {PublicKey} */ k) => k.toStringRaw().toLowerCase();
const sameKey = (/** @type {unknown} */ a, /** @type {unknown} */ b) => a instanceof PublicKey && b instanceof PublicKey && raw(a) === raw(b);
const isEcdsa = (/** @type {unknown} */ k) => k instanceof PublicKey && raw(k).length === 66;

/**
 * Cuatro palabras (y un código corto) que salen de la llave nueva: las enseñan los dos móviles para comprobar que es la
 * misma. 44 bits del SHA-256 de la llave.
 * @param {PublicKey} key @param {"es" | "en"} [lang]
 */
export function moveFingerprint(key, lang = "es") {
  const h = getBytes(sha256(key.toBytesRaw()));
  let bits = 0n;
  for (let i = 0; i < 6; i++) bits = (bits << 8n) | BigInt(h[i]);
  const list = lang === "en" ? WORDS_EN : WORDS_ES;
  const words = [0, 1, 2, 3].map((i) => list[Number((bits >> BigInt(37 - i * 11)) & 2047n)]);
  const code = Array.from(h.slice(0, 4), (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return { words, code: `${code.slice(0, 4)} ${code.slice(4)}` };
}

/**
 * Lee de la red la wallet de una bóveda v2 y comprueba que el kit es el suyo (móvil nuevo).
 * `resumeKey`: la llave de ESTE móvil nuevo si ya pidió un cambio que quedó a medias (una parte ya es suya): entonces
 * no se rechaza y se puede pedir solo lo que falta (missingParts).
 * @param {{ mirror: import("./mirror.js").Mirror, vaultId: string, rescuePublicKey: PublicKey, resumeKey?: PublicKey | null }} p
 * @returns {Promise<MoveWallet>}
 */
export async function readWalletForMove({ mirror, vaultId, rescuePublicKey, resumeKey = null }) {
  const id = vaultId.trim();
  if (!/^0\.0\.\d+$/.test(id)) throw new WalletError(tr("El ID de la bóveda tiene la forma 0.0.12345.", "The vault ID looks like 0.0.12345."));
  const v = await inspectVaultV2({ mirror, vaultId: id });
  if (!v) throw new WalletError(tr("Esa cuenta no es una bóveda v2 de H10X Wallet.", "That account isn't an H10X Wallet v2 vault."));
  if (!sameKey(v.rescueKey, rescuePublicKey)) throw new WalletError(tr("Esas palabras no son el kit de esa bóveda.", "Those words are not that vault's kit."));
  const w = await walletOnChain({ mirror, vaultId: id, notaryId: v.notaryId, vaultDeviceKey: v.deviceKey, rescueKey: v.rescueKey });
  const resuming = !!resumeKey && (sameKey(w.carteraKey, resumeKey) || sameKey(w.vaultDeviceKey, resumeKey));
  if (!sameKey(w.carteraKey, w.vaultDeviceKey) && !resuming) {
    throw new WalletError(
      tr(
        "Hay un cambio de móvil a medias: ábrelo en tu otro móvil para terminarlo antes de empezar otro.",
        "There's a phone change half done: open it on your other phone to finish it before starting another.",
      ),
    );
  }
  return w;
}

/**
 * Lo mismo para el móvil viejo, que ya sabe cuál es su bóveda (no comprueba ningún kit).
 * @param {{ mirror: import("./mirror.js").Mirror, vaultId: string }} p
 * @returns {Promise<MoveWallet | null>}
 */
export async function readWalletOnChain({ mirror, vaultId }) {
  const v = await inspectVaultV2({ mirror, vaultId });
  if (!v) return null;
  return walletOnChain({ mirror, vaultId, notaryId: v.notaryId, vaultDeviceKey: v.deviceKey, rescueKey: v.rescueKey });
}

/**
 * @param {{ mirror: import("./mirror.js").Mirror, vaultId: string, notaryId: ContractId, vaultDeviceKey: PublicKey, rescueKey: PublicKey }} p
 * @returns {Promise<MoveWallet>}
 */
async function walletOnChain({ mirror, vaultId, notaryId, vaultDeviceKey, rescueKey }) {
  const cfg = await notary2Config({ mirror, notaryId });
  const cartera = await mirror.account(cfg.device);
  if (!cartera || !(cartera.key instanceof PublicKey)) throw new WalletError(tr("No encuentro la Cartera de esa bóveda.", "I can't find that vault's Wallet."));
  // El notario la conoce por su dirección EVM: tiene que ser la de la cuenta, no otra.
  if (cartera.evmAddress !== cfg.device) throw new WalletError(tr("La Cartera no coincide con la del notario.", "The Wallet doesn't match the notary's."));
  const kit = await findRescueAccount({ mirror, rescuePublicKey: rescueKey, rescueAddress: cfg.rescue });
  if (!kit) throw new WalletError(tr("No encuentro la cuenta del kit de esa bóveda.", "I can't find that vault's kit account."));
  return {
    vaultId,
    notaryId: notaryId.toString(),
    carteraId: cartera.id.toString(),
    carteraEvm: cfg.device,
    kitAccountId: kit.id.toString(),
    carteraKey: cartera.key,
    vaultDeviceKey,
    rescueKey,
    withdrawDelay: cfg.withdrawDelay,
    recoveryDelay: cfg.recoveryDelay,
    tiebreaker: !!cfg.tiebreaker,
    guardianEvm: cfg.guardian,
    kitBalance: kit.balance,
  };
}

/**
 * Partes que aún no son de esta llave (las dos al empezar; una si el cambio quedó a medias).
 * @param {Pick<MoveWallet, "carteraKey" | "vaultDeviceKey">} w @param {PublicKey} key
 * @returns {("vault" | "cartera")[]}
 */
export function missingParts(w, key) {
  /** @type {("vault" | "cartera")[]} */
  const out = [];
  if (!sameKey(w.vaultDeviceKey, key)) out.push("vault");
  if (!sameKey(w.carteraKey, key)) out.push("cartera");
  return out;
}

/** Nombre del móvil nuevo en el memo: corto, limpio y sin enlaces. @param {string} name */
const cleanName = (name) => cleanLabel(name, 24).replace(/·/g, "-") || "?";

/**
 * Móvil nuevo: deja en Hedera las dos peticiones (paga la cuenta del kit) firmadas con el kit y con la llave nueva.
 * `client` tiene como operador la cuenta del kit con su llave (la de las 24 palabras). Si el cambio quedó a medias,
 * solo pide la parte que falta.
 * @param {{ client: import("@hiero-ledger/sdk").Client, w: MoveWallet, newKey: import("@hiero-ledger/sdk").PrivateKey, name: string }} p
 * @returns {Promise<{ vault: string | null, cartera: string | null }>} IDs de las programadas (null: esa parte ya era suya)
 */
export async function requestMove({ client, w, newKey, name }) {
  const k2 = newKey.publicKey;
  if (!isEcdsa(k2)) throw new WalletError(tr("La llave nueva tiene que ser ECDSA.", "The new key must be ECDSA."));
  if (sameKey(k2, w.rescueKey)) throw new WalletError(tr("La llave nueva no puede ser la del kit.", "The new key can't be the kit's."));
  const parts = missingParts(w, k2);
  if (parts.length === 0) throw new WalletError(tr("La wallet ya es de este móvil.", "The wallet already belongs to this phone."));
  const notaryId = ContractId.fromString(w.notaryId);
  const label = cleanName(name);
  const make = async (/** @type {string} */ accountId, /** @type {Key} */ key, /** @type {string} */ which) => {
    const inner = new AccountUpdateTransaction().setAccountId(AccountId.fromString(accountId)).setKey(key).setMaxTransactionFee(Hbar.fromTinybars(INNER_MAX_FEE_TINYBARS.toString()));
    const tx = new ScheduleCreateTransaction()
      .setScheduledTransaction(inner)
      .setPayerAccountId(AccountId.fromString(w.kitAccountId))
      .setScheduleMemo(`${MOVE_MEMO_PREFIX} · ${which} · ${label}`)
      // Caducidad explícita: así el mirror la enseña y el móvil viejo sabe cuánto tiempo queda.
      .setExpirationTime(Timestamp.fromDate(new Date(Date.now() + MOVE_REQUEST_LIFETIME_SECONDS * 1000)))
      .setWaitForExpiry(false);
    const out = await submit(client, tx, [newKey]);
    // Si ya existía una idéntica (se pulsó dos veces), vale la misma.
    const sid = out.receipt?.scheduleId;
    if (!sid || (!out.ok && out.status !== "IDENTICAL_SCHEDULE_ALREADY_CREATED")) {
      throw new WalletError(tr(`No se pudo pedir el cambio (${which}): ${out.status}`, `Couldn't request the change (${which}): ${out.status}`), out.status, out.txId);
    }
    return sid.toString();
  };
  const vault = parts.includes("vault") ? await make(w.vaultId, buildVaultKeyV2({ deviceKey: k2, rescueKey: w.rescueKey, notaryId }), "bóveda") : null;
  const cartera = parts.includes("cartera") ? await make(w.carteraId, k2, "cartera") : null;
  return { vault, cartera };
}

/**
 * Cuándo caduca una programada. Si se creó sin caducidad explícita, el mirror la enseña sin fecha (null) y Hedera la
 * borra a los 30 minutos de crearse. (En testnet real se vio así: antes se tomaba por caducada y no se veía nada.)
 * @param {{ expiresAt: number, createdAt?: number }} s
 */
export function expiryOf(s) {
  if (s.expiresAt > 0) return s.expiresAt;
  if (s.createdAt && s.createdAt > 0) return s.createdAt + DEFAULT_SCHEDULE_LIFETIME_SECONDS;
  return Number.MAX_SAFE_INTEGER;
}

/** Campos de CryptoUpdate que una petición de cambio de móvil NO puede llevar (solo la cuenta y su llave). */
const ALLOWED_UPDATE_FIELDS = new Set(["accountIDToUpdate", "key"]);

/**
 * ¿Es esta programada una petición válida de cambio de móvil para esta wallet? Comprueba TODO lo que se puede comprobar:
 * que la creó y la paga la cuenta del kit, que solo cambia la llave (ni memo, ni staking, ni plazos, ni nada más), que la
 * llave nueva de la Cartera es una sola llave ECDSA distinta de las de ahora y que la de la bóveda es exactamente la de
 * una bóveda v2 con el MISMO kit y el MISMO notario. Devuelve null si no es un cambio de llave (p. ej. una recuperación).
 * @param {{ id: string, executed: boolean, deleted: boolean, expiresAt: number, createdAt?: number, payer: string, creator: string, memo: string, signers: string[], body: string }} s
 * @param {MoveWallet} w @param {number} now segundos
 * @returns {null | { ok: true, which: "cartera" | "vault", newKey: PublicKey, name: string } | { ok: false, reason: string }}
 */
export function checkMoveSchedule(s, w, now) {
  /** @type {any} */
  let body;
  try {
    body = HieroProto.proto.SchedulableTransactionBody.decode(decodeBase64(s.body));
  } catch {
    return { ok: false, reason: "cuerpo ilegible" };
  }
  const op = body.cryptoUpdateAccount;
  if (!op) return null;
  if (s.executed || s.deleted || expiryOf(s) <= now) return null;
  const target = op.accountIDToUpdate;
  const targetId = target && !(target.alias && target.alias.length) ? `0.0.${target.accountNum?.toString() ?? "?"}` : "alias";
  const which = targetId === w.carteraId ? "cartera" : targetId === w.vaultId ? "vault" : null;
  if (!which) return null; // cambia otra cuenta: no es asunto de esta wallet
  if (s.creator !== w.kitAccountId || s.payer !== w.kitAccountId) return { ok: false, reason: "no la creó o no la paga la cuenta del kit" };
  // Nada más: ni memo, ni staking, ni firmas obligatorias, ni plazos… ni «hooks» (programas EVM pegados a la cuenta).
  // protobufjs deja las listas vacías como propias: una lista vacía cuenta como no puesta.
  const isSet = (/** @type {unknown} */ v) => v != null && !(Array.isArray(v) && v.length === 0);
  for (const field of Object.keys(op)) {
    if (!ALLOWED_UPDATE_FIELDS.has(field) && isSet(op[field])) return { ok: false, reason: `cambia algo más que la llave (${field})` };
  }
  if (isSet(body.maxCustomFees)) return { ok: false, reason: "lleva comisiones personalizadas" };
  const fee = BigInt(body.transactionFee?.toString() ?? "0");
  if (fee > INNER_MAX_FEE_TINYBARS) return { ok: false, reason: "comisión máxima demasiado alta" };
  if (body.memo) return { ok: false, reason: "lleva un memo interno" };
  if (!op.key) return { ok: false, reason: "no trae llave" };
  /** @type {Key} */
  let key;
  try {
    key = Key._fromProtobufKey(op.key);
  } catch {
    return { ok: false, reason: "llave ilegible" };
  }
  /** @type {PublicKey} */
  let newKey;
  if (which === "cartera") {
    if (!isEcdsa(key)) return { ok: false, reason: "la llave nueva de la Cartera no es una sola llave ECDSA" };
    newKey = /** @type {PublicKey} */ (key);
    if (sameKey(newKey, w.carteraKey)) return { ok: false, reason: "no cambia nada" };
  } else {
    const notaryId = ContractId.fromString(w.notaryId);
    if (!(key instanceof KeyList) || !isVaultKeyV2For(key, notaryId)) return { ok: false, reason: "la llave nueva de la bóveda no tiene la forma de una bóveda v2 con este notario" };
    const [withdrawRoute, recoveryRoute] = key.toArray();
    const device = /** @type {KeyList} */ (withdrawRoute).toArray()[0];
    const rescue = /** @type {KeyList} */ (recoveryRoute).toArray()[0];
    if (!sameKey(rescue, w.rescueKey)) return { ok: false, reason: "cambia el kit" };
    if (!isEcdsa(device)) return { ok: false, reason: "la llave del móvil nuevo no es ECDSA" };
    newKey = /** @type {PublicKey} */ (device);
    if (sameKey(newKey, w.vaultDeviceKey)) return { ok: false, reason: "no cambia nada" };
  }
  if (sameKey(newKey, w.rescueKey)) return { ok: false, reason: "la llave nueva es la del kit" };
  // Tiene que llevar ya las firmas del kit y de la llave nueva: si no, al firmar el móvil viejo no se ejecutaría.
  if (!s.signers.includes(raw(newKey)) || !s.signers.includes(raw(w.rescueKey))) return { ok: false, reason: "le faltan las firmas del kit o de la llave nueva" };
  const prefix = `${MOVE_MEMO_PREFIX} · `;
  const rest = s.memo.startsWith(prefix) ? s.memo.slice(prefix.length) : "";
  const name = cleanLabel(rest.split(" · ").slice(1).join(" · "), 24) || "?";
  return { ok: true, which, newKey, name };
}

/**
 * @typedef {{ newKey: PublicKey, name: string, vault: string | null, cartera: string | null, expiresAt: number }} MoveRequest
 *   vault/cartera: programada pendiente de cada parte (null si esa parte ya está hecha)
 */

/**
 * Móvil viejo: peticiones de cambio de móvil pendientes, y las programadas raras que haya creado la cuenta del kit sobre
 * la Cartera o la bóveda (alguien con el kit intentando algo).
 * @param {{ mirror: import("./mirror.js").Mirror, w: MoveWallet, now?: number }} p
 * @returns {Promise<{ requests: MoveRequest[], suspicious: { id: string, reason: string }[] }>}
 */
export async function findMoveRequests({ mirror, w, now = Math.floor(Date.now() / 1000) }) {
  const list = await mirror.schedulesCreatedBy(w.kitAccountId, { limit: 50 });
  /** @type {Map<string, MoveRequest>} */
  const byKey = new Map();
  /** @type {{ id: string, reason: string }[]} */
  const suspicious = [];
  for (const s of list) {
    const r = checkMoveSchedule(s, w, now);
    if (!r) continue;
    if (!r.ok) {
      suspicious.push({ id: s.id, reason: r.reason });
      continue;
    }
    const k = raw(r.newKey);
    const e = byKey.get(k) ?? { newKey: r.newKey, name: r.name, vault: null, cartera: null, expiresAt: expiryOf(s) };
    // La lista viene de la más nueva a la más vieja: se queda la más nueva de cada parte.
    if (r.which === "vault" && !e.vault) e.vault = s.id;
    if (r.which === "cartera" && !e.cartera) e.cartera = s.id;
    e.expiresAt = Math.min(e.expiresAt, expiryOf(s));
    byKey.set(k, e);
  }
  /** @type {MoveRequest[]} */
  const requests = [];
  for (const e of byKey.values()) {
    const vaultDone = sameKey(w.vaultDeviceKey, e.newKey);
    const carteraDone = sameKey(w.carteraKey, e.newKey);
    // Completa: las dos partes pendientes. A medias (se firmó una y no la otra): lo que falte.
    if ((e.vault || vaultDone) && (e.cartera || carteraDone) && !(vaultDone && carteraDone)) {
      requests.push({ ...e, vault: vaultDone ? null : e.vault, cartera: carteraDone ? null : e.cartera });
    }
  }
  return { requests, suspicious };
}

/**
 * Móvil viejo: firma las dos peticiones con su llave. Primero la de la bóveda y después la de la Cartera: mientras la
 * Cartera siga siendo suya, puede pagar la segunda firma (si falla a mitad, se repite).
 * `client` tiene como operador la Cartera con la llave de este móvil.
 * @param {{ client: import("@hiero-ledger/sdk").Client, request: MoveRequest }} p
 */
export async function confirmMove({ client, request }) {
  for (const id of [request.vault, request.cartera]) {
    if (!id) continue;
    const out = await submit(client, new ScheduleSignTransaction().setScheduleId(ScheduleId.fromString(id)));
    if (!out.ok && out.status !== "SCHEDULE_ALREADY_EXECUTED") {
      throw new WalletError(tr(`No se pudo confirmar el cambio: ${out.status}`, `Couldn't confirm the change: ${out.status}`), out.status, out.txId);
    }
  }
}

/**
 * ¿Cómo va el cambio? (lo mira el móvil nuevo hasta que las dos llaves son la suya, y el viejo antes de borrarse)
 * @param {{ mirror: import("./mirror.js").Mirror, w: Pick<MoveWallet, "vaultId" | "carteraId">, newKey: PublicKey }} p
 */
export async function moveStatus({ mirror, w, newKey }) {
  const [vault, cartera] = await Promise.all([inspectVaultV2({ mirror, vaultId: w.vaultId }), mirror.account(w.carteraId)]);
  const vaultDone = !!vault && sameKey(vault.deviceKey, newKey);
  const carteraDone = !!cartera && sameKey(cartera.key, newKey);
  return { vault: vaultDone, cartera: carteraDone, done: vaultDone && carteraDone };
}

/**
 * ¿Sigue siendo esta llave la del móvil de la wallet? (si no, el móvil viejo ya no controla nada y se puede borrar)
 * @param {{ mirror: import("./mirror.js").Mirror, vaultId: string, carteraId: string, key: PublicKey }} p
 */
export async function keyStillControls({ mirror, vaultId, carteraId, key }) {
  const [vault, cartera] = await Promise.all([inspectVaultV2({ mirror, vaultId }), mirror.account(carteraId)]);
  return { vault: !!vault && sameKey(vault.deviceKey, key), cartera: !!cartera && sameKey(cartera.key, key) };
}
