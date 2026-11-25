import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { PrivateKey } from "@hiero-ledger/sdk";
import { appendDappLog, dappLogKey, parseDappLog, parseRegistry, storageKeys, walletStorageNames, walletsRegistryKey, type DappLogEntry, type NetworkName, type WalletRegistry } from "@boveda/core";
import { NETWORK, isExpoGo } from "./env";
import { t } from "./i18n";

/** Bóveda de la cartera. Sin `version` es una v1 (creada antes de la v2). */
export type VaultInfo = {
  accountId: string;
  notaryId: string;
  createdAt: number;
  version?: 1 | 2;
  /** Cuenta atrás de retirada (con el móvil). */
  delaySeconds: number;
  /** v2: cuenta atrás de recuperación (con el kit). */
  recoveryDelaySeconds?: number;
  /** v2: cuenta del kit de rescate (paga sus comisiones). */
  rescueAccountId?: string;
  /** Notario v3: la bóveda tiene contraseña de desempate (kit + contraseña ganan al móvil). */
  tiebreaker?: boolean;
};

/** Recuperación con el kit en curso hacia la cartera de este móvil (móvil anterior perdido). */
export type PendingRecovery = {
  vaultId: string;
  notaryId: string;
  /** La del HBAR (o la primera, si la bóveda solo tenía tokens). */
  scheduleId: string;
  /** Las de los tokens, en grupos. */
  extraSchedules?: string[];
  executableAt: number;
  tinybars: string;
  /** Cuántos tokens distintos vienen en camino. */
  tokens?: number;
  /** Cuántos NFT vienen en camino. */
  nfts?: number;
  /** Se pidió por robo del móvil (retiradas congeladas y modo robo en el guardián). */
  stolen?: boolean;
  /** 0.10: tokens que se quedan en la bóveda por ahora (pueden cobrar comisión): van en otra recuperación. */
  later?: number;
  /** Si el móvil antiguo la congeló o bloqueó: desde cuándo se puede pedir otra vez. */
  blockedUntil?: number;
};

/**
 * Cambio de móvil hacia ESTE móvil (el nuevo): pedido con el kit, esperando a que el móvil viejo confirme. La llave
 * nueva ya está guardada en este móvil desde antes de pedirlo: así nunca se pierde.
 */
export type PendingMove = {
  vaultId: string;
  notaryId: string;
  carteraId: string;
  kitAccountId: string;
  /** Llave pública de este móvil (la nueva), en hexadecimal: con ella se ve cuándo ha terminado. */
  newKey: string;
  /** Nombre de este móvil, tal como lo verá el viejo. */
  name: string;
  /** IDs de las dos peticiones (null: aún no pedida, o esa parte ya era de este móvil). */
  vault: string | null;
  cartera: string | null;
  /** Cuándo caducan las peticiones (0 mientras no se han pedido). */
  expiresAt: number;
  withdrawDelay: number;
  recoveryDelay: number;
  tiebreaker: boolean;
  /** Las peticiones ya están en Hedera. */
  requested: boolean;
};

/** Datos no secretos de la cartera. */
export type Profile = {
  version: 1;
  network: NetworkName;
  pocket: { evmAddress: string; accountId?: string };
  vault?: VaultInfo;
  pendingRecovery?: PendingRecovery;
  /** Bóvedas anteriores (p. ej. la v1 tras pasar a la v2). */
  legacyVaults?: string[];
  /**
   * readToken (0.10): código que dio el guardián al registrar la bóveda; con él (cabecera x-h10x-token) dice a esta app
   * cómo está su bóveda (modo robo, correo…). A los demás solo les dice si está registrada.
   */
  guardian?: { url: string; account: string; evmAddress: string; registered: boolean; pushes: boolean; readToken?: string };
  /** Retiradas pedidas desde este móvil: las demás se marcan como "no reconocidas". */
  mySchedules: string[];
  recoveryConfirmed: boolean;
  biometric: boolean;
  /** Avisos de H10X que quiere el dueño (van firmados en el registro del guardián). Sin poner: los dos. */
  h10xAlerts?: { dao: boolean; basket: boolean };
  /**
   * Llave pública de este móvil (hexadecimal, no es secreta). Sirve para ver, sin pedir Face ID, si la wallet se ha
   * pasado a otro móvil. Sin ella (carteras de antes), se compara la dirección de la Cartera con la de su llave.
   */
  devicePublicKey?: string;
  /** Cambio de móvil en curso hacia este móvil. */
  pendingMove?: PendingMove;
  /** Hay un kit recién creado guardado (detrás de Face ID) hasta que se compruebe: se puede volver a ver. */
  kitPending?: boolean;
  /** Nombre que le ha puesto el dueño (solo se guarda en este móvil). */
  name?: string;
};

/** Kit de rescate recién creado, mientras no se ha comprobado. */
export type PendingKit = { words: string[]; vaultId: string; password?: string | null };

// Cada red guarda lo suyo aparte (testnet, con los nombres de siempre). Así la app de mainnet instalada encima de la
// de testnet empieza de cero y nunca usa una cuenta de testnet como si fuera de mainnet.
const BASE = storageKeys(NETWORK);
const REGISTRY_KEY = walletsRegistryKey(NETWORK);

/** Lista de wallets de este móvil (0.10). Sin nada guardado, la de siempre. */
export async function loadRegistry(): Promise<WalletRegistry> {
  return parseRegistry(await AsyncStorage.getItem(REGISTRY_KEY).catch(() => null));
}

export async function saveRegistry(r: WalletRegistry): Promise<void> {
  await AsyncStorage.setItem(REGISTRY_KEY, JSON.stringify(r));
}

/** ¿Se puede guardar la llave detrás de Face ID? No en Expo Go. */
async function biometricAvailable(): Promise<boolean> {
  if (isExpoGo) return false;
  try {
    return SecureStore.canUseBiometricAuthentication();
  } catch {
    return false;
  }
}

export type WalletStorage = ReturnType<typeof walletStorage>;

/**
 * Lo que guarda una wallet en el móvil (0.10: puede haber varias). La primera usa los nombres de siempre; las demás,
 * con su id al final. Cada WalletProvider usa SOLO la suya: así lo que esté a medias de una nunca escribe en otra.
 */
export function walletStorage(walletId: string) {
  const { profile: PROFILE, pocketKey: POCKET_KEY } = walletStorageNames(BASE, walletId);
  // El kit recién creado se guarda aparte, solo en este móvil y detrás de Face ID, hasta que se comprueba: si la app se
  // cierra (o se bloquea el móvil) mientras se apuntan las palabras, no se pierden. Al comprobarlo se borra: el kit
  // nunca se queda en el mismo móvil que la llave (juntos sacan el dinero al momento).
  const KIT_KEY = POCKET_KEY.replace("pocketKey", "kitPending");
  const DAPP_LOG = dappLogKey(BASE, walletId);

  async function loadProfile(): Promise<Profile | null> {
    const raw = await AsyncStorage.getItem(PROFILE);
    if (!raw) return null;
    const p = JSON.parse(raw) as Profile;
    // Segunda barrera: un perfil de otra red no se usa nunca (sus números de cuenta serían de otras personas).
    return p?.network === NETWORK ? p : null;
  }

  async function saveProfile(p: Profile): Promise<void> {
    await AsyncStorage.setItem(PROFILE, JSON.stringify(p));
  }

  /**
   * Guarda la llave del móvil en el llavero de iOS, solo en este dispositivo (no viaja en copias
   * de seguridad) y, si es posible, detrás de Face ID.
   */
  async function storePocketKey(key: PrivateKey): Promise<{ biometric: boolean }> {
    const biometric = await biometricAvailable();
    await SecureStore.setItemAsync(POCKET_KEY, key.toStringRaw(), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      requireAuthentication: biometric,
      authenticationPrompt: t("Protege la llave de tu cartera con Face ID", "Protect your wallet key with Face ID"),
    });
    return { biometric };
  }

  /** Lee la llave para firmar. Si está detrás de Face ID, iOS lo pide aquí. */
  async function readPocketKey(biometric: boolean): Promise<PrivateKey> {
    const raw = await SecureStore.getItemAsync(POCKET_KEY, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      requireAuthentication: biometric,
      authenticationPrompt: t("Confirma para firmar", "Confirm to sign"),
    });
    if (!raw) throw new Error(t("No encuentro la llave de la cartera en este móvil.", "I cannot find the wallet key on this phone."));
    return PrivateKey.fromStringECDSA(raw);
  }

  async function storePendingKit(kit: PendingKit, biometric: boolean): Promise<void> {
    await SecureStore.setItemAsync(KIT_KEY, JSON.stringify(kit), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      requireAuthentication: biometric,
      authenticationPrompt: t("Guarda tu kit detrás de Face ID hasta que lo compruebes", "Keep your kit behind Face ID until you check it"),
    });
  }

  async function readPendingKit(biometric: boolean): Promise<PendingKit | null> {
    const raw = await SecureStore.getItemAsync(KIT_KEY, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      requireAuthentication: biometric,
      authenticationPrompt: t("Ver tu kit de rescate", "Show your rescue kit"),
    });
    if (!raw) return null;
    const k = JSON.parse(raw) as PendingKit;
    const ok = Array.isArray(k?.words) && k.words.length === 24 && k.words.every((w) => typeof w === "string" && /^[a-z]+$/.test(w)) && typeof k.vaultId === "string";
    return ok ? { words: k.words, vaultId: k.vaultId, password: typeof k.password === "string" ? k.password : null } : null;
  }

  async function clearPendingKit(): Promise<void> {
    try {
      await SecureStore.deleteItemAsync(KIT_KEY);
    } catch {
      // no había nada
    }
  }

  /** Lo firmado para dApps desde esta wallet (para el historial). Nunca lanza. */
  async function loadDappLog(): Promise<DappLogEntry[]> {
    return parseDappLog(await AsyncStorage.getItem(DAPP_LOG).catch(() => null));
  }

  async function addDappLog(entry: DappLogEntry): Promise<void> {
    const raw = await AsyncStorage.getItem(DAPP_LOG).catch(() => null);
    await AsyncStorage.setItem(DAPP_LOG, JSON.stringify(appendDappLog(raw, entry))).catch(() => undefined);
  }

  async function wipeWallet(): Promise<void> {
    await SecureStore.deleteItemAsync(POCKET_KEY);
    await clearPendingKit();
    await AsyncStorage.removeItem(PROFILE);
    await AsyncStorage.removeItem(DAPP_LOG).catch(() => undefined);
  }

  /** El llavero de iOS conserva datos aunque se borre la app: al empezar de cero se limpia. */
  async function clearStaleKey(): Promise<void> {
    try {
      await SecureStore.deleteItemAsync(POCKET_KEY);
    } catch {
      // no había nada
    }
    await clearPendingKit();
  }

  return { walletId, loadProfile, saveProfile, storePocketKey, readPocketKey, storePendingKit, readPendingKit, clearPendingKit, loadDappLog, addDappLog, wipeWallet, clearStaleKey };
}
