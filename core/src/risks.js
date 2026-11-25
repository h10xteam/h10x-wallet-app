// @ts-check
// Riesgos de un token antes de moverlo desde la bóveda.
//
// Un token puede llevar comisiones propias que cobra la red al moverlo. Las FIJAS las paga quien envía
// (en HBAR o en otro token): un token regalado a la bóveda con una comisión enorme vaciaría sus HBAR
// al evacuarla. Y si el emisor tiene la llave de comisiones, puede ponerlas DESPUÉS de que pidas la
// retirada. Por eso se miran justo antes de mover nada.

/**
 * Comisión fija en HBAR que se tolera al mover un token (0,2 HBAR): por debajo, como mucho cuesta eso
 * cada vez; por encima (o si se cobra en otro token), el token no se mueve sin que lo decidas tú.
 */
export const TOKEN_FEE_TOLERANCE_TINYBARS = 20_000_000n;

/** Llaves del emisor que le dejan intervenir en tu saldo. */
const ISSUER_POWERS = new Set(["freeze", "wipe", "pause", "kyc", "feeSchedule"]);

/**
 * @param {import("./mirror.js").TokenInfo | null | undefined} info
 * @param {{ tolerance?: bigint }} [opts]
 */
export function tokenRisks(info, { tolerance = TOKEN_FEE_TOLERANCE_TINYBARS } = {}) {
  const f = info?.fees;
  const fixedHbar = f?.fixedHbar ?? 0n;
  const fixedTokens = f?.fixedTokens ?? [];
  return {
    /** Moverlo cobra a quien envía (a la bóveda) más de lo tolerable. */
    chargesOnMove: fixedHbar > tolerance || fixedTokens.length > 0,
    /** Cobra algo, aunque sea poco. */
    anyFixedFee: fixedHbar > 0n || fixedTokens.length > 0,
    fixedHbar,
    fixedTokens,
    /** Se queda una parte del propio token al moverlo. */
    takesShare: (f?.fractional ?? 0) > 0,
    royalty: (f?.royalty ?? 0) > 0,
    /** Qué puede hacer el emisor con tu saldo: congelarlo, borrarlo, pausarlo, exigir KYC o cambiar comisiones. */
    issuerCan: (info?.issuerKeys ?? []).filter((k) => ISSUER_POWERS.has(k)),
    /**
     * El emisor puede poner o subir comisiones EN CUALQUIER MOMENTO (tiene la llave de comisiones): también
     * en los segundos que el mirror tarda en enseñarlo. El guardián no completa solo lo que mueva uno de
     * estos, y al evacuar salen los últimos, cuando ya no queda en la bóveda nada con que pagarlas.
     */
    canChangeFees: (info?.issuerKeys ?? []).includes("feeSchedule"),
  };
}
