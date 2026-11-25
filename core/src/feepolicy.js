// @ts-check
// Tokens que no se pueden mover con una cuenta atrás.
//
// El notario deja que CUALQUIERA llame a approve() cuando acaba la cuenta atrás (comprobado en el código desplegado en
// mainnet). Si una retirada o una recuperación mueve un token que cobra al moverlo, o cuyo emisor tiene la llave de
// comisiones, ese emisor puede ponerle una comisión fija justo antes y completar él mismo la operación: la pagaría la
// bóveda, con sus HBAR o con otro de sus tokens. Que el guardián «no la complete» no basta (lo demostró la prueba A2
// en testnet: la petición se quedó abierta 24 horas). Por eso:
//   - la app no pide esas operaciones (esos tokens salen con «Evacuar», móvil + kit, y los últimos);
//   - el guardián bloquea en cuanto la ve cualquier retirada que los mueva;
//   - la recuperación con el kit los deja para cuando en la bóveda ya no quede nada con qué pagar.
// Sin dependencias: lo usan la app, el guardián y las pruebas sin red.
import { tokenRisks } from "./risks.js";
import { TOKENS_PER_TRANSFER } from "./config.js";

/**
 * @typedef {"charges" | "feeKey" | "unknown"} FeeReason
 *   charges: cobra al moverlo (comisión fija alta o en otro token) · feeKey: su emisor puede poner comisiones cuando
 *   quiera · unknown: no se sabe qué es (el mirror no lo da)
 * @typedef {import("./mirror.js").TokenInfo | null | undefined} MaybeTokenInfo
 * @typedef {{ trusted?: ReadonlySet<string> | null }} FeePolicyOptions trusted: tokens con llave de comisiones de emisores de confianza
 */

/**
 * Por qué un token NO puede ir en una operación con cuenta atrás, o null si puede.
 * @param {MaybeTokenInfo} info lo que dice el mirror del token ahora mismo (null: no se sabe)
 * @param {FeePolicyOptions} [opts]
 * @returns {FeeReason | null}
 */
export function countdownFeeReason(info, { trusted = null } = {}) {
  if (!info) return "unknown";
  const r = tokenRisks(info);
  if (r.chargesOnMove) return "charges";
  if (r.canChangeFees && !(trusted && trusted.has(info.tokenId))) return "feeKey";
  return null;
}

/**
 * El primer token de la lista que no puede ir en una operación con cuenta atrás, o null si todos pueden.
 * @param {Iterable<string>} tokenIds @param {(tokenId: string) => MaybeTokenInfo} infoOf @param {FeePolicyOptions} [opts]
 * @returns {{ tokenId: string, reason: FeeReason } | null}
 */
export function firstCountdownFeeRisk(tokenIds, infoOf, opts = {}) {
  for (const tokenId of new Set(tokenIds)) {
    const reason = countdownFeeReason(infoOf(tokenId), opts);
    if (reason) return { tokenId, reason };
  }
  return null;
}

/**
 * Lista de confianza a partir de un texto «0.0.1,0.0.2» (lo que no tenga forma de ID se ignora).
 * @param {string | null | undefined} text
 * @returns {Set<string>}
 */
export const parseTokenList = (text) =>
  new Set(
    String(text ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter((x) => /^0\.0\.\d+$/.test(x)),
  );

/**
 * @template {{ tokenId: string, balance: bigint }} T
 * @template {{ tokenId: string, serial: number }} N
 * @typedef {{ tinybars: bigint, tokens: T[], nfts: N[], later: { tokenId: string, reason: FeeReason }[], keyedOnly: boolean }} RecoveryPlan
 *   later: lo que se queda en la bóveda por ahora (y por qué) · keyedOnly: esta vez solo van tokens con llave de comisiones
 */

/**
 * Qué se pide en una recuperación con el kit. Cada grupo será una operación con su cuenta atrás, y cualquiera podrá
 * completarlas en el orden que quiera al acabar.
 *   - Lo que cobra al moverse, o lo que no se sabe qué es, se queda siempre.
 *   - Los tokens con llave de comisiones solo van cuando en la bóveda no queda NADA más (ni HBAR ni otros tokens ni
 *     NFT): entonces una comisión no tiene con qué pagarse. Y van como mucho 5 juntos, en una sola operación (una
 *     comisión en otro de ellos tampoco se podría pagar: sale entero en la misma transferencia).
 *   - Si queda algo más, esos tokens se dejan para una segunda recuperación, cuando la primera haya llegado.
 * @template {{ tokenId: string, balance: bigint }} T
 * @template {{ tokenId: string, serial: number }} N
 * @param {{ tinybars: bigint, tokens: T[], nfts: N[], infoOf: (tokenId: string) => MaybeTokenInfo, trusted?: ReadonlySet<string> | null }} p
 * @returns {RecoveryPlan<T, N>}
 */
export function planRecovery({ tinybars, tokens, nfts, infoOf, trusted = null }) {
  const held = tokens.filter((t) => t.balance > 0n);
  /** @type {Map<string, FeeReason | null>} */
  const reasonOf = new Map();
  for (const id of new Set([...held.map((t) => t.tokenId), ...nfts.map((n) => n.tokenId)])) reasonOf.set(id, countdownFeeReason(infoOf(id), { trusted }));
  const safeTokens = held.filter((t) => reasonOf.get(t.tokenId) == null);
  const safeNfts = nfts.filter((n) => reasonOf.get(n.tokenId) == null);
  const keyedTokens = held.filter((t) => reasonOf.get(t.tokenId) === "feeKey");
  const keyedNfts = nfts.filter((n) => reasonOf.get(n.tokenId) === "feeKey");
  const nothingElse = tinybars <= 0n && safeTokens.length === 0 && safeNfts.length === 0;

  /** @type {T[]} */
  let goTokens = safeTokens;
  /** @type {N[]} */
  let goNfts = safeNfts;
  let keyedOnly = false;
  if (nothingElse && (keyedTokens.length > 0 || keyedNfts.length > 0)) {
    keyedOnly = true;
    // Primero los tokens (5 como mucho, en una sola operación); las colecciones de NFT, cuando ya no quede ninguno.
    goTokens = keyedTokens.slice(0, TOKENS_PER_TRANSFER);
    goNfts = keyedTokens.length > 0 ? [] : keyedNfts.filter((n) => n.tokenId === keyedNfts[0].tokenId).slice(0, 2 * TOKENS_PER_TRANSFER);
  }
  const going = new Set([...goTokens.map((t) => t.tokenId), ...goNfts.map((n) => `${n.tokenId}#${n.serial}`)]);
  /** @type {Map<string, FeeReason>} */
  const later = new Map();
  for (const t of held) if (!going.has(t.tokenId)) later.set(t.tokenId, /** @type {FeeReason} */ (reasonOf.get(t.tokenId) ?? "feeKey"));
  for (const n of nfts) if (!going.has(`${n.tokenId}#${n.serial}`)) later.set(n.tokenId, /** @type {FeeReason} */ (reasonOf.get(n.tokenId) ?? "feeKey"));
  return {
    tinybars: keyedOnly ? 0n : tinybars,
    tokens: goTokens,
    nfts: goNfts,
    later: [...later.entries()].map(([tokenId, reason]) => ({ tokenId, reason })),
    keyedOnly,
  };
}
