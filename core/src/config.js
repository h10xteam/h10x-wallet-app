// @ts-check
// Redes y constantes compartidas por la app y el guardián.

/** @typedef {"mainnet" | "testnet" | "previewnet" | "local"} NetworkName */

/** @type {Record<NetworkName, { mirror: string, hashscan: string, faucet: string | null }>} */
export const NETWORKS = {
  // Mainnet (beta): dinero de verdad. La app exige un tope por bóveda y el guardián no arranca sin topes.
  mainnet: {
    mirror: "https://mainnet-public.mirrornode.hedera.com",
    hashscan: "https://hashscan.io/mainnet",
    faucet: null,
  },
  testnet: {
    mirror: "https://testnet.mirrornode.hedera.com",
    hashscan: "https://hashscan.io/testnet",
    faucet: "https://portal.hedera.com/faucet",
  },
  previewnet: {
    mirror: "https://previewnet.mirrornode.hedera.com",
    hashscan: "https://hashscan.io/previewnet",
    faucet: "https://portal.hedera.com/faucet",
  },
  local: { mirror: "http://127.0.0.1:5551", hashscan: "", faucet: null },
};

/** 1 HBAR en tinybars. */
export const HBAR = 100_000_000n;

/**
 * Beta en mainnet. La app no deja guardar más de `maxVaultHbar` HBAR por bóveda aunque el guardián no responda (si
 * el guardián publica un tope más bajo, manda el más bajo). El guardián de mainnet no arranca si sus topes no están
 * puestos y dentro de estos límites.
 */
export const MAINNET_BETA = Object.freeze({
  /** Tope por bóveda de la app de mainnet si la compilación no trae EXPO_PUBLIC_MAX_VAULT_HBAR. */
  maxVaultHbar: 1000,
  /** Tope más alto que acepta el guardián de mainnet para MAX_VAULT_HBAR. */
  guardianMaxVaultHbar: 100_000,
  /** Tope más alto que acepta el guardián de mainnet para MAX_VAULTS. */
  guardianMaxVaults: 1000,
  /** Topes diarios por bóveda de las llamadas que paga el guardián en mainnet, si no se ponen en su .env. */
  budget: Object.freeze({ approve: 10, veto: 10, freeze: 4 }),
});

/**
 * Nombres con los que la app guarda sus datos en el móvil, por red. Los de testnet son los de siempre (no cambian:
 * las carteras de prueba ya creadas siguen funcionando). Las demás redes van aparte: si alguien instala la app de
 * mainnet encima de la de testnet, la de mainnet no ve las cuentas de testnet (en mainnet esos números de cuenta son
 * de otras personas: mandarles algo sería perderlo).
 * @param {NetworkName} network
 */
export function storageKeys(network) {
  const ns = network === "testnet" ? "" : `${network}.`;
  return {
    profile: `boveda.${ns}profile.v1`,
    pocketKey: `boveda.${ns}pocketKey.v1`,
    wcSessions: `hvault.${ns}wc.sessions.v1`,
  };
}

/** Dónde guarda la app la lista de wallets de una red (0.10: varias wallets en el mismo móvil). @param {NetworkName} network */
export const walletsRegistryKey = (network) => `boveda.${network === "testnet" ? "" : `${network}.`}wallets.v1`;

/** Límites de gas. Hedera cobra por el gas usado; los límites solo evitan que se dispare. */
export const GAS = { deploy: 900_000, request: 80_000, veto: 80_000, approve: 250_000 };

/** Comisión máxima aceptada por tipo de transacción, en HBAR. */
export const MAX_FEE_HBAR = { deploy: 40, contractCall: 2, default: 5 };

/**
 * Fábricas de notarios fijadas en la app, por red (además, la app acepta la que anuncie el guardián). En los dos casos
 * comprueba antes que su código en la red es exactamente el compilado (core/src/factory.js).
 * @type {Record<string, string[]>}
 */
export const NOTARY_FACTORY_IDS = { mainnet: [], testnet: [], previewnet: [], local: [] };

/** Retardos permitidos para la bóveda, en segundos. */
export const DELAYS = {
  test: 120, // 2 minutos: solo para probar
  standard: 48 * 3600,
  max: 60 * 24 * 3600, // límite del contrato
};

/** Margen de vida de una transacción programada tras acabar la cuenta atrás. */
export const SCHEDULE_GRACE_SECONDS = 24 * 3600;
/** Una transacción programada no puede vivir más de 62 días. */
export const SCHEDULE_MAX_LIFETIME_SECONDS = 62 * 24 * 3600 - 3600;

/** Saldo mínimo de la cartera para crear la bóveda (despliegue del notario incluido). */
export const MIN_POCKET_FOR_VAULT = 25n * HBAR;

/**
 * Comisiones del servicio, preparadas pero APAGADAS: solo se cobran si la app se compila con una
 * cuenta que cobra (EXPO_PUBLIC_FEE_COLLECTOR). Nunca en recuperaciones, evacuaciones ni ajustes.
 */
export const SERVICE_FEES = {
  /** Al guardar en la bóveda (va en la misma transferencia del depósito). */
  depositTinybars: 2n * HBAR,
  /** Al sacar de la bóveda (va dentro de la retirada programada: solo se cobra si sale). */
  withdrawTinybars: 2n * HBAR,
};

/** Tope de seguridad de cualquier comisión del servicio, por si se configura mal. */
export const MAX_SERVICE_FEE_TINYBARS = 10n * HBAR;

/** Tokens por transacción al evacuar o recuperar (Hedera admite 10 movimientos de tokens por transferencia). */
export const TOKENS_PER_TRANSFER = 5;
