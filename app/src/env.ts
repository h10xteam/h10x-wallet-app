import Constants, { ExecutionEnvironment } from "expo-constants";
import { H10X_TOKEN_BY_NETWORK, MAINNET_BETA, SERVICE_FEES, parseHbar, requireVerifiedFor, type NetworkName } from "@boveda/core";

/** Expo Go (la app gratuita de la App Store) no tiene avisos push ni Face ID para el llavero. */
export const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

export const NETWORK: NetworkName = ((process.env.EXPO_PUBLIC_HEDERA_NETWORK as NetworkName | undefined) ?? "testnet");

/**
 * Dirección del guardián:
 *   1. EXPO_PUBLIC_GUARDIAN_URL si está puesta (p. ej. https://guardian.tudominio.com);
 *   2. si no, en desarrollo, el propio servidor de Expo del VPS, que reenvía /guardian al guardián.
 *      Con `expo start --tunnel` eso va por HTTPS sin abrir puertos en el VPS.
 */
export function guardianUrl(): string | null {
  const explicit = process.env.EXPO_PUBLIC_GUARDIAN_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  const host = Constants.expoConfig?.hostUri?.replace(/\/$/, "");
  if (!host) return null;
  // Con túnel (expo start --tunnel) la dirección es pública y va por HTTPS en el puerto estándar.
  const isTunnel = /\.exp\.direct|\.ngrok|\.expo\.app/.test(host);
  return isTunnel ? `https://${host.replace(/:(80|443)$/, "")}/guardian` : `http://${host}/guardian`;
}

/**
 * WalletConnect: exigir que el dominio de la dApp esté verificado. Por defecto, sí en mainnet y no en
 * testnet (allí se permite con aviso). Se fuerza con EXPO_PUBLIC_REQUIRE_VERIFIED_DOMAIN=1 (o =0).
 */
export const requireVerifiedDomain: boolean = (() => {
  const v = (process.env.EXPO_PUBLIC_REQUIRE_VERIFIED_DOMAIN ?? "").trim();
  if (v === "1" || v === "0") return v === "1";
  return requireVerifiedFor(NETWORK);
})();

/** ID del proyecto de EAS: hace falta para los avisos push (se crea con `eas init`). */
export const easProjectId: string | undefined =
  (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ?? Constants.easConfig?.projectId;

/**
 * Comisiones del servicio: preparadas pero APAGADAS hasta compilar la app con
 * EXPO_PUBLIC_FEE_COLLECTOR (la cuenta que cobra). Por defecto 2 HBAR al guardar y 2 al sacar;
 * se pueden cambiar con EXPO_PUBLIC_DEPOSIT_FEE_HBAR y EXPO_PUBLIC_WITHDRAW_FEE_HBAR ("0" = sin esa comisión).
 */
export const serviceFees: { collector: string; deposit: bigint; withdraw: bigint } | null = (() => {
  const collector = (process.env.EXPO_PUBLIC_FEE_COLLECTOR ?? "").trim();
  if (!/^0\.0\.\d+$/.test(collector)) return null;
  const amount = (raw: string | undefined, fallback: bigint) => {
    const v = (raw ?? "").trim();
    if (!v) return fallback;
    if (/^0+([.,]0*)?$/.test(v)) return 0n;
    return parseHbar(v) ?? fallback;
  };
  return {
    collector,
    deposit: amount(process.env.EXPO_PUBLIC_DEPOSIT_FEE_HBAR, SERVICE_FEES.depositTinybars),
    withdraw: amount(process.env.EXPO_PUBLIC_WITHDRAW_FEE_HBAR, SERVICE_FEES.withdrawTinybars),
  };
})();

/**
 * WalletConnect (sección dApps): ID de proyecto de Reown (gratis en dashboard.reown.com). No es secreto.
 * Se pone en app/.env como EXPO_PUBLIC_WC_PROJECT_ID o en app.json → extra.wcProjectId.
 */
export const wcProjectId: string | null =
  (process.env.EXPO_PUBLIC_WC_PROJECT_ID ?? "").trim() || ((Constants.expoConfig?.extra as { wcProjectId?: string } | undefined)?.wcProjectId ?? "").trim() || null;

/** Red de Hedera en formato WalletConnect (CAIP-2). */
export const CHAIN_ID = NETWORK === "mainnet" ? "hedera:mainnet" : NETWORK === "previewnet" ? "hedera:previewnet" : NETWORK === "local" ? "hedera:devnet" : "hedera:testnet";

/** App de mainnet (beta): dinero de verdad. */
export const isMainnet = NETWORK === "mainnet";

/** Plazos de minutos («Prueba»): solo en las redes de pruebas. En mainnet el guardián tampoco los acepta. */
export const allowTestDelays = !isMainnet;

/**
 * Tope de HBAR por bóveda que trae la compilación (EXPO_PUBLIC_MAX_VAULT_HBAR). En mainnet siempre hay uno
 * (MAINNET_BETA.maxVaultHbar si no se pone), y vale aunque el guardián no responda. 0 = sin tope (solo testnet).
 */
export const buildMaxVaultHbar: number = (() => {
  const n = Math.floor(Number((process.env.EXPO_PUBLIC_MAX_VAULT_HBAR ?? "").trim()));
  if (Number.isFinite(n) && n > 0) return n;
  return isMainnet ? MAINNET_BETA.maxVaultHbar : 0;
})();

/**
 * Pestaña Swap: el token que se cambia por HBAR en SaucerSwap. Por defecto, H10X en mainnet y SAUCE en testnet (H10X
 * no tiene pool con HBAR en la red de pruebas). Se cambia con EXPO_PUBLIC_SWAP_TOKEN_ID=0.0.X.
 */
/**
 * 0.10.2 · Acciones tokenizadas (SODAX) en Cambiar. Se pueden quitar de una compilación con EXPO_PUBLIC_STOCKS=0. En
 * testnet se ven con los precios reales de mainnet, pero no se puede comprar (SODAX solo funciona en mainnet).
 */
export const stocksEnabled: boolean = (process.env.EXPO_PUBLIC_STOCKS ?? "1").trim() !== "0";

export const swapTokenOverride: string | null = (process.env.EXPO_PUBLIC_SWAP_TOKEN_ID ?? "").trim() || null;

/**
 * Comprar con tarjeta: APAGADO salvo que la app se compile con EXPO_PUBLIC_ONRAMP_URL (la página del proveedor con
 * {address} donde va la Cartera). Ver core/src/onramp.js.
 */
export const onrampTemplate: string | null = (process.env.EXPO_PUBLIC_ONRAMP_URL ?? "").trim() || null;

/**
 * Token H10X de esta red, para enseñar tu saldo en la pantalla H10X. Mainnet: 0.0.10907484. Testnet: el de la bóveda
 * del programa de recompensas (0.0.10872951). Se cambia con EXPO_PUBLIC_H10X_TOKEN_ID. Los precios, la cesta y la DAO
 * siempre son los de H10X en mainnet.
 */
export const h10xTokenId: string | null = (() => {
  const v = (process.env.EXPO_PUBLIC_H10X_TOKEN_ID ?? "").trim();
  if (/^0\.0\.\d+$/.test(v)) return v;
  return (H10X_TOKEN_BY_NETWORK as Record<string, string | undefined>)[NETWORK] ?? null;
})();
