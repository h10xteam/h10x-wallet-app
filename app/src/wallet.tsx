// Estado de la cartera y todas las acciones de la app, en un único contexto de React.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { AccountId, AccountUpdateTransaction, ContractId, KeyList, Mnemonic, PrivateKey, PublicKey, ScheduleId } from "@hiero-ledger/sdk";
import {
  HBAR,
  Lane,
  Mirror,
  NETWORKS,
  WalletError,
  actionTokenIds,
  associateTokens,
  callNotary,
  callNotary2,
  changeVaultDelaysV2,
  chunk,
  createClient,
  evacuateVault,
  findRescueAccount,
  formatHbar,
  friendlyNotary2Error,
  inspectVaultV2,
  loadVaultActivity,
  loadWithdrawals,
  notary2Config,
  nowSeconds,
  parseAccount,
  payServiceFee,
  pickStakingNode,
  requestEnableTokensV2,
  requestStakingV2,
  requestRecoveryV2,
  requestWithdrawal,
  requestWithdrawalV2,
  rescueKeyFromWords,
  rescueVault,
  sendHbar,
  sendNfts,
  sendToken,
  setupVaultV2,
  CHAIN_IDS,
  requestPriorityRecoveryV3,
  tiebreakerAddress,
  tiebreakerKey,
  signRegistration,
  h10xPrefsCode,
  signTheftNotice,
  signEmailNotice,
  normalizeEmail,
  isValidEmail,
  tokenRisks,
  withdrawalsAsMovements,
  type Movement,
  type NftHolding,
  type StakingNode,
  type TokenInfo,
  type Allowance,
  revokeAllowance,
  MOVE_KIT_MIN_TINYBARS,
  MOVE_REQUEST_LIFETIME_SECONDS,
  NOTARY_FACTORY_IDS,
  confirmMove,
  expiryOf,
  findMoveRequests,
  keyStillControls,
  moveFingerprint,
  moveStatus,
  readWalletForMove,
  readWalletOnChain,
  requestMove,
  resolveNotaryFactory,
  vaultSetupReserve,
  countdownFeeReason,
  planRecovery,
  FIRST_WALLET_ID,
  type FeeReason,
  type MoveWallet,
  type NotaryFactory,
} from "@boveda/core";
import { wipeDerec } from "./derec/wipe";
import { NETWORK, allowTestDelays, easProjectId, guardianUrl, isExpoGo, isMainnet, serviceFees } from "./env";
import { lang, t } from "./i18n";
import { walletStorage, type PendingKit, type PendingMove, type Profile, type WalletStorage } from "./storage";

const mirror = new Mirror(NETWORKS[NETWORK].mirror, fetch, { feeCollector: serviceFees?.collector ?? null });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Activo: "HBAR" o el ID de un token (0.0.x). */
export const HBAR_ASSET = "HBAR";
export type TokenBalance = { tokenId: string; symbol: string; name: string; decimals: number; balance: bigint };

type Balances = { pocket: bigint | null; vault: bigint | null };
type Tokens = { pocket: TokenBalance[]; vault: TokenBalance[] };
/** Un NFT (con su colección) en la Cartera o en la bóveda. */
export type NftItem = NftHolding;
export type NftRef = { tokenId: string; serial: number };
type Nfts = { pocket: NftItem[]; vault: NftItem[] };
type PocketAccess = { client: ReturnType<typeof createClient>; key: PrivateKey; accountId: AccountId };
type Locks = { withdraw: number; recovery: number };
type SetupStep = (i: number) => void;
type Fee = { collector: AccountId; tinybars: bigint } | null;

export type RecoverResult =
  | { kind: "v1"; tinybars: bigint; txId: string; to: string; here: boolean }
  | {
      kind: "v2";
      tinybars: bigint;
      tokens: number;
      nfts: number;
      scheduleId: string;
      executableAt: number;
      to: string;
      here: boolean;
      /** Robo del móvil: retiradas congeladas hasta esta hora y si el guardián quedó avisado. */
      stolen?: { frozenUntil: number; guardianNotified: boolean };
      /** Con la contraseña de desempate: el móvil antiguo no la puede parar ni congelar. */
      priority?: boolean;
      /** 0.10: tokens que se quedan en la bóveda por ahora (pueden cobrar comisión): van en otra recuperación. */
      later?: number;
      /** 0.10: esta vez solo van tokens cuyo emisor puede poner comisiones (en la bóveda ya no queda nada más). */
      keyedOnly?: boolean;
    };

export type EvacuateResult = {
  tinybars: bigint;
  txId: string;
  tokens: { tokenId: string; amount: bigint }[];
  failedTokens: { tokenId: string; status: string }[];
  nfts: NftRef[];
  failedNfts: (NftRef & { status: string })[];
  /** Se quedan en la bóveda porque moverlos le cobraría una comisión (token trampa o con comisión alta). */
  skippedTokens: { tokenId: string; amount: bigint; fixedHbar: bigint }[];
  skippedNfts: NftRef[];
};

/** Una petición de cambio de móvil vista desde el móvil viejo: a qué móvil, sus palabras de comprobación y cuándo caduca. */
export type MoveRequestView = { id: string; name: string; words: string[]; code: string; expiresAt: number; parts: number };
/** Lo que ha visto el móvil viejo: peticiones válidas y programadas raras que ha creado la cuenta del kit. */
export type MoveRequestsState = { requests: MoveRequestView[]; suspicious: number };
/** Cómo va un cambio de móvil visto desde el móvil nuevo. */
export type MoveInState = "none" | "waiting" | "half" | "expired" | "done";

/** Rendimiento de la bóveda (staking nativo). `earned`: lo ya cobrado (null mientras no se sabe). */
export type Staking = { nodeId: number | null; pending: bigint; earned: bigint | null };

type WalletCtx = {
  ready: boolean;
  /** 0.10: la wallet de este contexto (puede haber varias en el móvil). */
  walletId: string;
  /** 0.10: el guardián ya no vigila esta bóveda (p. ej. estaba lleno): hay que volver a conectarla. */
  guardianLost: boolean;
  /** 0.10: lo firmado para dApps desde esta wallet (para el historial). */
  dappLog: () => Promise<import("@boveda/core").DappLogEntry[]>;
  addDappLog: (e: import("@boveda/core").DappLogEntry) => Promise<void>;
  staking: Staking | null;
  /** Nodos de consenso (se cargan al pedirlos y se guardan un rato). */
  stakingNodes: StakingNode[];
  loadStakingNodes: (force?: boolean) => Promise<StakingNode[]>;
  /** Cambia el nodo de staking (o lo quita con null) por la cuenta atrás de retirada. */
  requestStaking: (nodeId: number | null) => Promise<string>;
  /** Cobra las recompensas pendientes ya: un movimiento mínimo (1 tinybar) de la Cartera a la bóveda. */
  collectRewards: () => Promise<string>;
  profile: Profile | null;
  balances: Balances;
  tokens: Tokens;
  nfts: Nfts;
  /** ¿Acepta la bóveda tokens sin asociarlos antes? (las creadas antes de esta versión, no). */
  vaultTokensOn: boolean | null;
  pocketTokensOn: boolean | null;
  meta: (tokenId: string) => TokenInfo | undefined;
  movements: Movement[];
  locks: Locks;
  refreshing: boolean;
  isV2: boolean;
  fees: { deposit: bigint; withdraw: bigint } | null;
  /** Refresca en silencio (el refresco periódico y tras cada operación). */
  refresh: () => Promise<void>;
  /** Refresco que pide el usuario al deslizar hacia abajo: solo este enseña la rueda de carga. */
  pullRefresh: () => Promise<void>;
  createWallet: () => Promise<string>;
  /**
   * DeRec (amigos de confianza): instala en este móvil la wallet que han devuelto los amigos (llave de la Cartera y
   * perfil). Antes comprueba en la red que esa llave sigue mandando en la Cartera (y en la bóveda v2).
   */
  installFromFriends: (p: { key: Uint8Array; perfil: Uint8Array }) => Promise<{ vault: boolean }>;
  /**
   * Crea la bóveda. Con `words` (un kit generado con newKitWords y ya comprobado por el dueño) usa ese kit y no lo
   * guarda en el móvil. `stakedNodeId`: nodo de staking de la bóveda y de la Cartera ("auto": el que más paga; null: sin
   * staking). `name`: nombre de la wallet.
   */
  setupVault: (p: { withdrawDelay: number; recoveryDelay: number; depositTinybars: bigint; password?: string | null; hbarUsd?: number | null; onStep: SetupStep; words?: string[]; stakedNodeId?: number | null | "auto"; name?: string }) => Promise<{ words: string[]; vaultId: string }>;
  /** 24 palabras nuevas para el kit, generadas en el móvil (todavía no se ha creado nada en la red). */
  newKitWords: () => Promise<string[]>;
  /** Cambia el nombre de la wallet (vacío: sin nombre). */
  renameWallet: (name: string) => Promise<void>;
  migrateToV2: (p: { oldWords: string; withdrawDelay: number; recoveryDelay: number; password?: string | null; onStep: SetupStep }) => Promise<{ words: string[]; vaultId: string; moved: bigint }>;
  confirmRecovery: () => Promise<void>;
  /** El kit recién creado y aún sin comprobar (pide Face ID). null si ya no está guardado. */
  openPendingKit: () => Promise<PendingKit | null>;
  /**
   * Kit sin apuntar ni guardado y bóveda vacía: deja esa bóveda (pasa a «anteriores») para crear otra con un kit nuevo.
   * La Cartera no cambia. Falla si la bóveda tiene algo.
   */
  restartVault: (opts?: { lostKit?: boolean }) => Promise<void>;
  send: (to: string, asset: string, amount: bigint) => Promise<string>;
  deposit: (asset: string, amount: bigint) => Promise<string>;
  withdraw: (to: string, asset: string, amount: bigint) => Promise<string>;
  enableVaultTokens: () => Promise<string>;
  addPocketToken: (tokenId: string) => Promise<TokenInfo>;
  /** NFT: guardar en la bóveda (desde la Cartera), sacar (con cuenta atrás) y enviar desde la Cartera. */
  depositNfts: (nfts: NftRef[]) => Promise<string>;
  withdrawNfts: (to: string, nfts: NftRef[]) => Promise<string>;
  sendNftsFromPocket: (to: string, nfts: NftRef[]) => Promise<string>;
  /** Cambia los plazos de la bóveda (hacen falta las 24 palabras). Pasos: 0 comprobar · 1 notario · 2 llave · 3 guardián. */
  /** `password`: sin pasarla, se mantiene la contraseña de desempate que tuviera; con ella, se pone o se cambia. */
  changeDelays: (p: { words: string; withdrawDelay: number; recoveryDelay: number; password?: string; onStep?: SetupStep }) => Promise<void>;
  /** Acceso a la Cartera (pide Face ID si la llave lo tiene). Solo para firmar lo que el usuario ya ha visto. */
  withPocket: <T>(fn: (p: PocketAccess) => Promise<T>) => Promise<T>;
  veto: (m: Movement) => Promise<void>;
  completeNow: (m: Movement) => Promise<void>;
  freezeRecovery: () => Promise<void>;
  evacuate: (p: { words: string; to: string }) => Promise<EvacuateResult>;
  rescue: (p: { words: string; vaultId: string; to: string }) => Promise<{ tinybars: bigint; txId: string }>;
  recoverWithKit: (p: { words: string; vaultId: string; here: boolean; to?: string; stolen?: boolean; password?: string; onStep?: SetupStep }) => Promise<RecoverResult>;
  /** Modo robo en el guardián: consultar y desactivar (con las 24 palabras). */
  theftStatus: () => Promise<{ active: boolean; until: number } | null>;
  stopTheftMode: (words: string) => Promise<void>;
  /** Avisos por correo: estado (correo a medias) y poner, confirmar o quitar (siempre con las 24 palabras). */
  emailStatus: () => Promise<EmailStatus | null>;
  emailStart: (p: { words: string; email: string }) => Promise<string>;
  emailConfirm: (p: { words: string; email: string; code: string }) => Promise<string>;
  emailRemove: (words: string) => Promise<void>;
  /** Permisos de gasto que ha dado la Cartera, y quitar uno (lo firma la Cartera). */
  pocketAllowances: () => Promise<Allowance[]>;
  revokePocketAllowance: (a: Allowance) => Promise<void>;
  completeRecovery: () => Promise<void>;
  registerGuardian: () => Promise<string>;
  /** Avisos de H10X (DAO y cambios de cesta): se guardan y se firman en el registro del guardián. */
  setH10xAlerts: (prefs: { dao: boolean; basket: boolean }) => Promise<void>;
  wipe: () => Promise<void>;
  /** ¿Hay fábrica de notarios comprobada para crear la bóveda más barata? (null: aún no se sabe). */
  factoryReady: boolean | null;
  /** Cambio de móvil, en el móvil NUEVO: pedirlo con el kit. Pasos: 0 comprobar · 1 llave · 2 pedir · 3 listo. */
  moveIn: (p: { vaultId: string; words: string; name: string; onStep?: SetupStep }) => Promise<void>;
  /** Móvil nuevo: ¿ha confirmado ya el viejo? Si sí, deja la wallet lista en este móvil. */
  checkMoveIn: () => Promise<MoveInState>;
  /** Móvil nuevo: olvidar el cambio (solo si no se llegó a pedir o ya caducó). */
  cancelMoveIn: () => Promise<void>;
  /** Palabras de comprobación del cambio en curso (móvil nuevo). */
  moveInFingerprint: { words: string[]; code: string } | null;
  /** Móvil viejo: peticiones de cambio de móvil (null mientras no se ha mirado). */
  moveRequests: MoveRequestsState | null;
  /** Móvil viejo: confirma (con Face ID) y, cuando la red lo refleja, borra la wallet de este móvil. */
  confirmMoveOut: (r: MoveRequestView) => Promise<{ name: string }>;
  /** La wallet ya no es de este móvil (se pasó a otro): solo queda borrarla de aquí. */
  movedAway: boolean;
};

/** Avisos por correo de la bóveda en el guardián. `available`: el guardián tiene el correo configurado. */
export type EmailStatus = { available: boolean; registered: boolean; email: string | null; pending: string | null };

const Ctx = createContext<WalletCtx | null>(null);

export const useWallet = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error("useWallet fuera de WalletProvider");
  return c;
};

/** Comisión del servicio en el formato del núcleo (null si está apagada o es 0). */
const feeOf = (tinybars: bigint | undefined): Fee => (serviceFees && tinybars && tinybars > 0n ? { collector: AccountId.fromString(serviceFees.collector), tinybars } : null);

/** Traduce los errores del notario v1 («BadStatus(2)», «TooEarly(…)») a algo que entienda cualquiera. */
function friendlyNotaryError(fn: "veto" | "approve", reason: string): string {
  const m = /^(\w+)(?:\((.*)\))?$/.exec(reason.trim());
  const name = m?.[1] ?? reason;
  const arg = m?.[2];
  if (name === "BadStatus") {
    if (arg === "2") return fn === "veto" ? t("Esta retirada ya está bloqueada.", "This withdrawal is already blocked.") : t("Esta retirada está bloqueada: no saldrá.", "This withdrawal is blocked: it will not go out.");
    if (arg === "3") return fn === "veto" ? t("Ya no se puede bloquear: la retirada ya se ha completado.", "It can no longer be blocked: the withdrawal has completed.") : t("Esta retirada ya se ha completado.", "This withdrawal has already completed.");
    return t("El notario no tiene esta retirada en un estado que lo permita.", "The notary does not have this withdrawal in a state that allows it.");
  }
  if (name === "TooEarly") return t("Todavía no ha terminado la cuenta atrás.", "The countdown has not finished yet.");
  if (name === "NotVetoer") return t("Esta cartera no puede bloquear retiradas de esta bóveda.", "This wallet cannot block withdrawals from this vault.");
  return `${fn === "veto" ? t("No se pudo bloquear", "Could not block") : t("No se pudo completar", "Could not complete")} (${reason}).`;
}

/** fetch con tiempo límite, para no colgar la app si el guardián no responde. */
async function fetchJson(url: string, init?: RequestInit, ms = 8000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/** Token para avisos push. Solo existe en la versión propia de la app (no en Expo Go). */
async function pushToken(): Promise<string | null> {
  if (isExpoGo || !easProjectId) return null;
  try {
    // Android 13+: el permiso solo se puede pedir con un canal creado. Importancia alta: son avisos de seguridad.
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", {
        name: t("Avisos de la bóveda", "Vault alerts"),
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: "#66DF9C",
      });
    }
    const perm = await Notifications.requestPermissionsAsync();
    if (!perm.granted) return null;
    return (await Notifications.getExpoPushTokenAsync({ projectId: easProjectId })).data;
  } catch {
    return null;
  }
}

/** Fábrica de notarios que anunció el guardián la última vez (la app comprueba su código antes de usarla). */
let advertisedFactory: string | null = null;

/** Fábrica de notarios comprobada para esta red (las fijadas en la app y la que anuncia el guardián), o null. */
async function notaryFactory(): Promise<NotaryFactory | null> {
  return resolveNotaryFactory({ mirror, candidates: [...(NOTARY_FACTORY_IDS[NETWORK] ?? []), advertisedFactory] }).catch(() => null);
}

/** Lo mismo, preguntando antes al guardián si aún no se le ha preguntado en esta sesión. */
async function notaryFactoryFresh(): Promise<NotaryFactory | null> {
  if (!advertisedFactory) await guardianInfo();
  return notaryFactory();
}

/** Clave pública en hexadecimal (para comparar sin pedir Face ID). */
const rawKey = (k: unknown) => (k instanceof PublicKey ? k.toStringRaw().toLowerCase() : "");

/** Datos públicos del guardián, si responde y es de esta red. */
async function guardianInfo(): Promise<Profile["guardian"] | undefined> {
  const url = guardianUrl();
  if (!url) return undefined;
  try {
    const info = await fetchJson(`${url}/info`, undefined, 10000);
    if (info?.network === NETWORK && /^0x[0-9a-f]{40}$/i.test(info.evmAddress)) {
      advertisedFactory = /^0\.0\.\d+$/.test(String(info.notaryFactory ?? "")) ? String(info.notaryFactory) : null;
      return { url, account: info.account, evmAddress: String(info.evmAddress).toLowerCase(), registered: false, pushes: false };
    }
  } catch {
    // sin guardián: la app completará las operaciones cuando la abras
  }
  return undefined;
}

/** Comprueba que unas palabras son el kit de una bóveda v1 (la llave de rescate de su clave). */
async function checkV1Words(vaultId: string, rescuePublic: PublicKey) {
  const acc = await mirror.account(vaultId);
  if (!acc || !(acc.key instanceof KeyList) || acc.key.toArray().length !== 2) return false;
  const rescue = acc.key.toArray()[1];
  return rescue instanceof PublicKey && rescue.toStringRaw() === rescuePublic.toStringRaw();
}

/** Tokens fungibles asociados a una cuenta, con su nombre y decimales. */
async function loadTokens(accountId: string): Promise<TokenBalance[]> {
  const list = await mirror.accountTokens(accountId);
  const out: TokenBalance[] = [];
  for (const h of list) {
    const info = await mirror.tokenInfo(h.tokenId).catch(() => null);
    if (!info || !info.fungible) continue;
    out.push({ tokenId: h.tokenId, symbol: info.symbol, name: info.name, decimals: info.decimals, balance: h.balance });
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/**
 * Tokens que cobrarían a la bóveda una comisión al moverlos (se mira en el momento: el emisor puede
 * ponerla en cualquier momento). Devuelve el primero, con lo que cobra, o null.
 */
async function feeChargingToken(ids: string[]): Promise<{ tokenId: string; label: string; fixedHbar: bigint } | null> {
  for (const id of new Set(ids)) {
    const info = await mirror.tokenInfo(id, { fresh: true }).catch(() => null);
    const r = tokenRisks(info);
    if (!info || r.chargesOnMove) return { tokenId: id, label: info ? `${info.symbol} (${id})` : id, fixedHbar: r.fixedHbar };
  }
  return null;
}
const feeError = (f: { label: string; fixedHbar: bigint }) =>
  new WalletError(
    f.fixedHbar > 0n
      ? t(`El token ${f.label} cobra ${formatHbar(f.fixedHbar)} HBAR a la bóveda cada vez que se mueve. Por seguridad no se saca así: el guardián no lo completaría.`, `The token ${f.label} charges the vault ${formatHbar(f.fixedHbar)} HBAR every time it moves. For safety it isn't withdrawn like this: the guardian wouldn't complete it.`)
      : t(`El token ${f.label} cobra una comisión a la bóveda al moverlo. Por seguridad no se saca así.`, `The token ${f.label} charges the vault a fee to move it. For safety it isn't withdrawn like this.`),
  );

const badWords = () => new WalletError(t("Esas palabras no forman un kit válido. Revisa que sean 24 y estén bien escritas.", "Those words are not a valid kit. Check there are 24 and they are spelled correctly."));

/**
 * Token que no puede salir con cuenta atrás (0.10): cobra al moverlo, su emisor puede ponerle comisiones cuando quiera o
 * no se sabe qué es. El notario deja que CUALQUIERA complete una retirada al acabar la cuenta atrás, también ese emisor
 * después de ponerle una comisión (la pagaría la bóveda); el guardián la bloquearía. Se mira antes de pedir Face ID.
 */
async function countdownRisk(ids: string[]): Promise<{ label: string; reason: FeeReason; fixedHbar: bigint } | null> {
  for (const id of new Set(ids)) {
    let info: TokenInfo | null;
    try {
      info = await mirror.tokenInfo(id, { fresh: true });
    } catch {
      throw new WalletError(t("No puedo comprobar ese token ahora mismo. Prueba en un momento.", "I can't check that token right now. Try again in a moment."));
    }
    const reason = countdownFeeReason(info);
    if (reason) return { label: info ? `${info.symbol} (${id})` : id, reason, fixedHbar: tokenRisks(info).fixedHbar };
  }
  return null;
}
const countdownRiskError = (r: { label: string; reason: FeeReason; fixedHbar: bigint }) =>
  r.reason === "charges"
    ? feeError(r)
    : new WalletError(
        r.reason === "feeKey"
          ? t(
              `El emisor de ${r.label} puede ponerle una comisión cuando quiera y completar él mismo la retirada al acabar la cuenta atrás: la pagaría tu bóveda. Por eso no sale con cuenta atrás: sácalo con «Evacuar» (móvil + kit, al momento), en Ajustes → Emergencias.`,
              `The issuer of ${r.label} can add a fee at any time and complete the withdrawal himself when the countdown ends: your vault would pay it. That's why it doesn't leave with a countdown: take it out with “Evacuate” (phone + kit, instantly), in Settings → Emergencies.`,
            )
          : t(`No puedo saber qué token es ${r.label}: por seguridad no sale con cuenta atrás.`, `I can't tell what token ${r.label} is: for safety it doesn't leave with a countdown.`),
      );

/**
 * Lo que dice el guardián de la bóveda (GET /vaults/<id>), con el código de lectura si lo hay. Sin el código bueno solo
 * dice si está registrada. undefined: no contesta (no se sabe).
 */
async function guardianVaultView(url: string, p: Profile): Promise<Record<string, unknown> & { registered: boolean } | undefined> {
  if (!p.vault) return undefined;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const token = p.guardian?.readToken;
    const res = await fetch(`${url}/vaults/${p.vault.accountId}`, { headers: token ? { "x-h10x-token": token } : {}, signal: ac.signal });
    if (res.status !== 200 && res.status !== 404) return undefined;
    const body = await res.json().catch(() => null);
    return body && typeof body.registered === "boolean" ? body : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

if (!isExpoGo) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
  });
}

/** Guarda el kit recién creado hasta que se compruebe. Si no se puede (Face ID cancelado…), se sigue: está en pantalla. */
async function keepPendingKit(store: WalletStorage, kit: PendingKit, biometric: boolean): Promise<boolean> {
  try {
    await store.storePendingKit(kit, biometric);
    return true;
  } catch {
    return false;
  }
}

/**
 * `walletId`: qué wallet del móvil (0.10). App.tsx lo monta con `key={walletId}`: al cambiar de wallet todo empieza de
 * cero y nada de lo que quede a medias escribe en otra. `onWiped`: la wallet se ha borrado del móvil (se quita de la
 * lista). `onChanged`: ha cambiado su perfil (nombre, bóveda…), para la lista de wallets.
 */
export function WalletProvider({ children, walletId = FIRST_WALLET_ID, onWiped, onChanged }: { children: React.ReactNode; walletId?: string; onWiped?: () => void | Promise<void>; onChanged?: () => void | Promise<void> }) {
  const store = useMemo(() => walletStorage(walletId), [walletId]);
  const hooks = useRef({ onWiped, onChanged });
  hooks.current = { onWiped, onChanged };
  const [ready, setReady] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [balances, setBalances] = useState<Balances>({ pocket: null, vault: null });
  const [tokens, setTokens] = useState<Tokens>({ pocket: [], vault: [] });
  const [nfts, setNfts] = useState<Nfts>({ pocket: [], vault: [] });
  const [vaultTokensOn, setVaultTokensOn] = useState<boolean | null>(null);
  const [pocketTokensOn, setPocketTokensOn] = useState<boolean | null>(null);
  const [metaMap, setMetaMap] = useState<Record<string, TokenInfo>>({});
  const [movements, setMovements] = useState<Movement[]>([]);
  const [locks, setLocks] = useState<Locks>({ withdraw: 0, recovery: 0 });
  const [refreshing, setRefreshing] = useState(false);
  const [staking, setStaking] = useState<Staking | null>(null);
  const [stakingNodes, setStakingNodes] = useState<StakingNode[]>([]);
  const nodesAt = useRef(0);
  const earnedAt = useRef<{ at: number; key: string; value: bigint | null }>({ at: 0, key: "", value: null });
  const profileRef = useRef<Profile | null>(null);
  const tokensRef = useRef<Tokens>({ pocket: [], vault: [] });
  const [factoryReady, setFactoryReady] = useState<boolean | null>(null);
  const [moveRequests, setMoveRequests] = useState<MoveRequestsState | null>(null);
  const [movedAway, setMovedAway] = useState(false);
  const moveCheckAt = useRef(0);
  const moveWallet = useRef<{ at: number; vaultId: string; w: MoveWallet } | null>(null);
  // ¿Sigue el guardián vigilando la bóveda? (0.10) y ¿hace falta pedirle otro código de lectura?
  const [guardianLost, setGuardianLost] = useState(false);
  const guardianCheckAt = useRef(0);
  const needsReadToken = useRef(false);
  const registerWithKeyRef = useRef<((key: PrivateKey) => Promise<boolean>) | null>(null);

  const update = useCallback(
    async (p: Profile | null) => {
      const before = profileRef.current;
      profileRef.current = p;
      setProfile(p);
      if (p) await store.saveProfile(p);
      // La lista de wallets enseña el nombre y la bóveda: se le avisa si cambian.
      if (p && (!before || before.name !== p.name || before.vault?.accountId !== p.vault?.accountId || before.pocket.accountId !== p.pocket.accountId)) void hooks.current.onChanged?.();
    },
    [store],
  );

  useEffect(() => {
    void store.loadProfile().then((p) => {
      profileRef.current = p;
      setProfile(p);
      setReady(true);
    });
  }, [store]);

  /** Cliente con la cartera del móvil como operador (pide Face ID si la llave lo tiene). */
  const pocketClient = useCallback(async () => {
    const p = profileRef.current;
    if (!p?.pocket.accountId) throw new WalletError(t("La cartera todavía no existe en la red: recibe HBAR primero.", "The wallet does not exist on the network yet: receive some HBAR first."));
    const key = await store.readPocketKey(p.biometric);
    // 0.10: el código de lectura del guardián se pide con una firma de esta llave. Si falta (bóveda registrada con una
    // app anterior) o ya no vale, se aprovecha esta lectura, en segundo plano y sin otro Face ID.
    if (needsReadToken.current && registerWithKeyRef.current) {
      needsReadToken.current = false;
      void registerWithKeyRef.current(key).catch(() => {
        needsReadToken.current = true;
      });
    }
    return { client: createClient(NETWORK, { accountId: p.pocket.accountId, key }), key, accountId: AccountId.fromString(p.pocket.accountId) };
  }, [store]);

  /**
   * Móvil viejo: ¿ha pedido alguien (con el kit) pasar la wallet a otro móvil? Primero una consulta barata (lo que ha
   * creado la cuenta del kit y sigue vivo); solo si hay algo, la comprobación completa campo a campo.
   */
  const checkMoveRequests = useCallback(async (p: Profile) => {
    if (p.vault?.version !== 2) return;
    let kit = p.vault.rescueAccountId;
    if (!kit) {
      // Bóvedas de antes que no guardaron la cuenta del kit: se busca una vez en la red y se guarda.
      const w = await readWalletOnChain({ mirror, vaultId: p.vault.accountId });
      if (!w) return;
      kit = w.kitAccountId;
      const cur = profileRef.current;
      if (cur?.vault && cur.vault.accountId === p.vault.accountId) await update({ ...cur, vault: { ...cur.vault, rescueAccountId: kit } });
    }
    const now = nowSeconds();
    const list = await mirror.schedulesCreatedBy(kit, { limit: 10 });
    if (!list.some((s) => !s.executed && !s.deleted && expiryOf(s) > now)) {
      setMoveRequests({ requests: [], suspicious: 0 });
      return;
    }
    const cached = moveWallet.current;
    const w = cached && cached.vaultId === p.vault.accountId && Date.now() - cached.at < 120_000 ? cached.w : await readWalletOnChain({ mirror, vaultId: p.vault.accountId });
    if (!w) return;
    moveWallet.current = { at: Date.now(), vaultId: p.vault.accountId, w };
    const found = await findMoveRequests({ mirror, w, now });
    setMoveRequests({
      requests: found.requests.map((r) => {
        const fp = moveFingerprint(r.newKey, lang());
        return { id: rawKey(r.newKey), name: r.name, words: fp.words, code: fp.code, expiresAt: r.expiresAt, parts: (r.vault ? 1 : 0) + (r.cartera ? 1 : 0) };
      }),
      suspicious: found.suspicious.length,
    });
  }, [update]);

  /**
   * ¿Sigue el guardián vigilando esta bóveda? (0.10, cada 10 minutos como mucho). Si un guardián lleno la ha dejado,
   * Inicio lo dice y ofrece volver a conectarla (antes salía en silencio). Si el guardián no contesta, no se sabe: nada.
   */
  const checkGuardian = useCallback(async () => {
    const p = profileRef.current;
    if (p?.vault?.version !== 2 || !p.guardian?.registered || p.pendingMove) return;
    if (Date.now() - guardianCheckAt.current < 10 * 60_000) return;
    guardianCheckAt.current = Date.now();
    const url = guardianUrl() ?? p.guardian.url;
    const v = await guardianVaultView(url, p);
    if (!v) return;
    setGuardianLost(!v.registered);
    // Registrada pero sin código de lectura (o con uno que ya no vale; `legacy`: la registró una app anterior a la
    // 0.10): se pide otro con la próxima firma. Con un guardián anterior al 0.14, nada (no los da).
    if (v.registered && (!("pushes" in v) || v.legacy === true)) needsReadToken.current = true;
  }, []);

  const refreshOnce = useCallback(async () => {
    const p = profileRef.current;
    if (!p) return;
    try {
      const pocket = await mirror.account(p.pocket.evmAddress);
      let next = p;
      if (pocket && p.pocket.accountId !== pocket.id.toString()) {
        next = { ...next, pocket: { ...next.pocket, accountId: pocket.id.toString() } };
        await update(next);
      }
      if (next.pendingRecovery) {
        const r = next.pendingRecovery;
        const s = await mirror.schedule(r.scheduleId);
        // ¿La congeló o bloqueó el móvil antiguo? Entonces hay que pedirla otra vez con el kit.
        const a = await loadVaultActivity({ mirror, notaryId: r.notaryId }).catch(() => null);
        const m = a?.items.find((x) => x.scheduleId === r.scheduleId);
        const blocked = !!m && (m.status === "superseded" || m.status === "vetoed");
        const blockedUntil = blocked ? Math.max(a?.locks.recovery ?? 0, 1) : undefined;
        if (s?.executed || (!blocked && s && s.expiresAt > 0 && s.expiresAt < nowSeconds())) {
          next = { ...next, pendingRecovery: undefined };
          await update(next);
        } else if (blockedUntil !== r.blockedUntil) {
          next = { ...next, pendingRecovery: { ...r, blockedUntil } };
          await update(next);
        }
      }
      // ¿Sigue siendo de este móvil? Si la llave de la Cartera ya no es la suya, la wallet se pasó a otro móvil.
      if (pocket && next.vault && !next.pendingMove && pocket.key instanceof PublicKey) {
        try {
          const mine = next.devicePublicKey ? rawKey(pocket.key) === next.devicePublicKey.toLowerCase() : `0x${pocket.key.toEvmAddress()}`.toLowerCase() === next.pocket.evmAddress.toLowerCase();
          setMovedAway(!mine);
        } catch {
          // una llave que no es ECDSA no tiene dirección EVM: no se puede saber así
        }
      }
      // Peticiones de cambio de móvil (las crea la cuenta del kit): cada 20 s como mucho.
      if (next.vault?.version === 2 && !next.pendingMove && Date.now() - moveCheckAt.current > 20_000) {
        moveCheckAt.current = Date.now();
        await checkMoveRequests(next).catch(() => undefined);
      }
      const vault = next.vault ? await mirror.account(next.vault.accountId) : null;
      setBalances({ pocket: pocket?.balance ?? null, vault: vault?.balance ?? null });
      if (vault) {
        // Lo cobrado se pide cada 5 minutos (o al cambiar de nodo o cobrar), no en cada refresco.
        const key = `${vault.id}:${vault.stakedNodeId}:${vault.balance}`;
        const cache = earnedAt.current;
        if (vault.stakedNodeId != null || cache.value != null) {
          if (cache.key !== key || Date.now() - cache.at > 5 * 60_000) {
            const value = await mirror.stakingRewardsTotal(vault.id.toString()).catch(() => cache.value);
            earnedAt.current = { at: Date.now(), key, value };
          }
        }
        setStaking({ nodeId: vault.stakedNodeId ?? null, pending: vault.pendingReward ?? 0n, earned: earnedAt.current.value });
      } else setStaking(null);
      setPocketTokensOn(pocket ? pocket.maxAutoAssociations !== 0 : null);
      setVaultTokensOn(vault ? vault.maxAutoAssociations !== 0 : null);
      const nextTokens = { pocket: pocket ? await loadTokens(pocket.id.toString()) : [], vault: vault ? await loadTokens(vault.id.toString()) : [] };
      tokensRef.current = nextTokens;
      setTokens(nextTokens);
      const nextNfts = {
        pocket: pocket ? await mirror.accountNfts(pocket.id.toString()).catch(() => []) : [],
        vault: vault ? await mirror.accountNfts(vault.id.toString()).catch(() => []) : [],
      };
      setNfts(nextNfts);
      let items: Movement[] = [];
      if (next.vault?.version === 2) {
        const a = await loadVaultActivity({ mirror, notaryId: next.vault.notaryId });
        items = a.items;
        setLocks(a.locks);
      } else if (next.vault) {
        items = withdrawalsAsMovements(await loadWithdrawals({ mirror, notaryId: next.vault.notaryId }));
        setLocks({ withdraw: 0, recovery: 0 });
      }
      setMovements(items);
      // Nombres y decimales de todos los tokens que aparecen (saldos y movimientos).
      const ids = new Set([...nextTokens.pocket, ...nextTokens.vault, ...nextNfts.pocket, ...nextNfts.vault].map((x) => x.tokenId));
      for (const m of items) for (const id of actionTokenIds(m.action)) ids.add(id);
      const found: Record<string, TokenInfo> = {};
      for (const id of ids) {
        const info = await mirror.tokenInfo(id).catch(() => null);
        if (info) found[id] = info;
      }
      setMetaMap(found);
      await checkGuardian();
    } catch {
      // sin conexión: se reintenta en el siguiente ciclo
    }
  }, [update, checkMoveRequests, checkGuardian]);

  // Un refresco cada vez: si se pide otro mientras uno está en marcha (el periódico, tras una operación o al deslizar),
  // se repite al acabar, para no quedarse con datos de antes de la operación.
  const refreshRun = useRef<Promise<void> | null>(null);
  const refreshAgain = useRef(false);
  const refresh = useCallback((): Promise<void> => {
    if (refreshRun.current) {
      refreshAgain.current = true;
      return refreshRun.current;
    }
    const run = async () => {
      do {
        refreshAgain.current = false;
        await refreshOnce();
      } while (refreshAgain.current);
    };
    refreshRun.current = run().finally(() => {
      refreshRun.current = null;
    });
    return refreshRun.current;
  }, [refreshOnce]);
  // La rueda de carga de arriba solo sale cuando el usuario desliza hacia abajo; el refresco de cada 10 s, en silencio
  // (en iPhone la rueda nativa empujaba la pantalla hacia abajo cada vez).
  const pullRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  // Refresco periódico mientras la app está abierta.
  useEffect(() => {
    if (!profile) return;
    void refresh();
    let timer = setInterval(() => void refresh(), 10_000);
    const sub = AppState.addEventListener("change", (s) => {
      clearInterval(timer);
      if (s === "active") {
        void refresh();
        timer = setInterval(() => void refresh(), 10_000);
      }
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [profile?.pocket.evmAddress, profile?.vault?.accountId, refresh]);

  const meta = useCallback((tokenId: string) => metaMap[tokenId], [metaMap]);

  /** Decimales del activo (HBAR: 8). */
  const decimalsOf = useCallback(
    async (asset: string) => {
      if (asset === HBAR_ASSET) return 8;
      const info = metaMap[asset] ?? (await mirror.tokenInfo(asset));
      if (!info) throw new WalletError(t("No encuentro ese token.", "I can't find that token."));
      return info.decimals;
    },
    [metaMap],
  );

  const createWallet = useCallback(async () => {
    await store.clearStaleKey();
    await wipeDerec(walletId);
    const key = PrivateKey.generateECDSA();
    const { biometric } = await store.storePocketKey(key);
    const evmAddress = `0x${key.publicKey.toEvmAddress()}`.toLowerCase();
    await update({ version: 1, network: NETWORK, pocket: { evmAddress }, mySchedules: [], recoveryConfirmed: false, biometric, devicePublicKey: key.publicKey.toStringRaw() });
    return evmAddress;
  }, [store, update, walletId]);

  /** Registra la bóveda en el guardián firmando con la llave ya leída (sin otro Face ID). true: con avisos al móvil. */
  const registerWithKey = useCallback(
    async (key: PrivateKey) => {
      const p = profileRef.current;
      if (!p?.vault || !p.pocket.accountId) throw new Error(t("Primero crea la bóveda.", "Create the vault first."));
      // La dirección actual primero: en desarrollo, la del túnel de Expo cambia en cada arranque.
      const url = guardianUrl() ?? p.guardian?.url;
      if (!url) throw new Error(t("No hay guardián configurado.", "No guardian is configured."));
      const info = p.guardian ?? { ...(await fetchJson(`${url}/info`)), url };
      const token = await pushToken();
      const signed = signRegistration(key, {
        vaultId: p.vault.accountId,
        notaryId: p.vault.notaryId,
        pocketId: p.pocket.accountId,
        pushToken: token,
        timestamp: nowSeconds(),
        lang: lang(),
        h10x: h10xPrefsCode(p.h10xAlerts ?? { dao: true, basket: true }),
      });
      const out = await fetchJson(`${url}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signed) }, 20000);
      // 0.10: el código con el que el guardián le dice a esta app cómo está su bóveda (a los demás, nada).
      const readToken = typeof out?.readToken === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(out.readToken) ? (out.readToken as string) : undefined;
      const cur = profileRef.current ?? p;
      await update({ ...cur, guardian: { url, account: info.account, evmAddress: info.evmAddress, registered: true, pushes: !!token, ...(readToken ? { readToken } : {}) } });
      needsReadToken.current = false;
      guardianCheckAt.current = Date.now();
      setGuardianLost(false);
      return !!token;
    },
    [update],
  );
  registerWithKeyRef.current = registerWithKey;

  const registerGuardian = useCallback(async () => {
    const p = profileRef.current;
    if (!p?.vault || !p.pocket.accountId) throw new Error(t("Primero crea la bóveda.", "Create the vault first."));
    const key = await store.readPocketKey(p.biometric);
    return (await registerWithKey(key))
      ? t("Guardián activo, con avisos al móvil.", "Guardian active, with phone alerts.")
      : t("Guardián activo. Los avisos push llegarán con la versión propia de la app.", "Guardian active. Push alerts will arrive with the app's own build.");
  }, [registerWithKey, store]);

  const setH10xAlerts = useCallback(
    async (prefs: { dao: boolean; basket: boolean }) => {
      const p = profileRef.current;
      if (!p) return;
      const before = p.h10xAlerts;
      await update({ ...p, h10xAlerts: prefs });
      if (!p.guardian?.registered) return; // se mandan en el próximo registro
      try {
        await registerGuardian();
      } catch (e) {
        const now = profileRef.current;
        if (now) await update({ ...now, h10xAlerts: before }); // sin guardián, no se cambia
        throw e;
      }
    },
    [registerGuardian, update],
  );

  /** El mirror node tarda unos segundos en ver la bóveda nueva: se reintenta antes de rendirse. */
  const registerWithRetries = useCallback(async () => {
    for (let i = 0; i < 6; i++) {
      try {
        await registerGuardian();
        return;
      } catch {
        await sleep(4000); // si al final falla, se puede repetir desde Ajustes
      }
    }
  }, [registerGuardian]);

  const installFromFriends = useCallback<WalletCtx["installFromFriends"]>(
    async ({ key: raw, perfil }) => {
      if (profileRef.current?.vault) throw new WalletError(t("Este móvil ya tiene una wallet con bóveda.", "This phone already has a wallet with a vault."));
      let data: { v?: number; profile?: Partial<Profile> };
      try {
        data = JSON.parse(new TextDecoder().decode(perfil));
      } catch {
        throw new WalletError(t("El perfil recuperado no se puede leer.", "The recovered profile can't be read."));
      }
      const p = data?.profile;
      if (data?.v !== 1 || !p || p.network !== NETWORK || !p.pocket || typeof p.pocket.evmAddress !== "string") {
        throw new WalletError(t(`Lo recuperado no es una wallet de ${NETWORK}.`, `What was recovered isn't a ${NETWORK} wallet.`));
      }
      if (raw.length !== 32) throw new WalletError(t("La llave recuperada no es válida.", "The recovered key isn't valid."));
      const key = PrivateKey.fromBytesECDSA(raw);
      // ¿Sigue mandando esa llave? Si se cambió de móvil con el kit después de repartir, ya no: no se instala nada.
      if (p.vault?.version === 2 && p.pocket.accountId) {
        const still = await keyStillControls({ mirror, vaultId: p.vault.accountId, carteraId: p.pocket.accountId, key: key.publicKey }).catch(() => null);
        if (!still?.cartera) throw new WalletError(t("Esa llave ya no manda en tu Cartera (¿cambiaste de móvil con el kit después?). No se ha instalado nada.", "That key no longer controls your Wallet (did you move phones with the kit afterwards?). Nothing was installed."));
      } else if (p.pocket.accountId) {
        const acc = await mirror.account(p.pocket.accountId).catch(() => null);
        if (!acc) throw new WalletError(t("No encuentro tu Cartera en la red.", "I can't find your Wallet on the network."));
        if (acc.key instanceof PublicKey && acc.key.toStringRaw() !== key.publicKey.toStringRaw()) {
          throw new WalletError(t("Esa llave ya no manda en tu Cartera. No se ha instalado nada.", "That key no longer controls your Wallet. Nothing was installed."));
        }
      } else if (`0x${key.publicKey.toEvmAddress()}`.toLowerCase() !== p.pocket.evmAddress.toLowerCase()) {
        throw new WalletError(t("La llave recuperada no es la de esa Cartera.", "The recovered key isn't that Wallet's key."));
      }
      await store.clearStaleKey();
      const { biometric } = await store.storePocketKey(key);
      const guardian = p.vault ? ((await guardianInfo()) ?? p.guardian) : p.guardian;
      await update({
        version: 1,
        network: NETWORK,
        pocket: { evmAddress: p.pocket.evmAddress.toLowerCase(), ...(p.pocket.accountId ? { accountId: p.pocket.accountId } : {}) },
        ...(p.vault ? { vault: p.vault } : {}),
        ...(p.legacyVaults ? { legacyVaults: p.legacyVaults } : {}),
        ...(guardian ? { guardian } : {}),
        mySchedules: Array.isArray(p.mySchedules) ? p.mySchedules : [],
        recoveryConfirmed: true,
        biometric,
        devicePublicKey: key.publicKey.toStringRaw(),
        ...(p.h10xAlerts ? { h10xAlerts: p.h10xAlerts } : {}),
        ...(p.name ? { name: p.name } : {}),
      });
      if (p.vault && guardian) void registerWithRetries();
      return { vault: !!p.vault };
    },
    [store, update, registerWithRetries],
  );

  /**
   * Kit nuevo + notario v2 + bóveda v2 pagados por la cartera. Pasos: 1 kit · 2 notario · 3 bóveda.
   * Con contraseña y fábrica de notarios comprobada, el notario sale de la fábrica (≈ 13 HBAR en total en vez de ≈ 28).
   * Antes de gastar nada se comprueba que hay saldo para el camino que toca.
   */
  const createV2 = useCallback(
    async (
      p: Profile,
      guardian: Profile["guardian"] | undefined,
      withdrawDelay: number,
      recoveryDelay: number,
      depositTinybars: bigint,
      onStep: SetupStep,
      password: string | null = null,
      hbarUsd: number | null = null,
      words: string[] | null = null,
      node: number | null | "auto" = "auto",
      stakePocketToo = false,
    ) => {
      const factory = password ? await notaryFactory() : null;
      const need = vaultSetupReserve(hbarUsd, { factory: !!factory }) + depositTinybars;
      const have = (await mirror.account(p.pocket.evmAddress).catch(() => null))?.balance ?? null;
      if (have != null && have < need) {
        throw new WalletError(
          factory || !password
            ? t(`Crear la bóveda cuesta unos ${formatHbar(need - depositTinybars, 0)} HBAR${depositTinybars > 0n ? ` más los ${formatHbar(depositTinybars)} que guardas` : ""}, y tu cartera tiene ${formatHbar(have)}.`, `Creating the vault costs about ${formatHbar(need - depositTinybars, 0)} HBAR${depositTinybars > 0n ? ` plus the ${formatHbar(depositTinybars)} you store` : ""}, and your wallet has ${formatHbar(have)}.`)
            : t(`Ahora mismo no puedo usar la fábrica de notarios y crear el notario aparte cuesta más: hacen falta unos ${formatHbar(need, 0)} HBAR y tu cartera tiene ${formatHbar(have)}. Prueba en unos minutos o añade HBAR.`, `I can't use the notary factory right now and creating the notary separately costs more: about ${formatHbar(need, 0)} HBAR are needed and your wallet has ${formatHbar(have)}. Try again in a few minutes or add HBAR.`),
        );
      }
      // El kit: el que el dueño ya ha apuntado y comprobado, o uno nuevo.
      const mnemonic = words ? await Mnemonic.fromWords(words) : await Mnemonic.generate();
      const rescueKey = await mnemonic.toStandardEd25519PrivateKey("", 0);
      // Contraseña de desempate: su llave sale de la contraseña y del kit (solo se guarda su dirección, en el notario).
      onStep(1);
      const tiebreaker = password ? tiebreakerAddress(await tiebreakerKey(password, rescueKey.publicKey)) : null;
      // Rendimiento desde el principio: la bóveda nace haciendo staking en el nodo elegido (o, con "auto", en el que
      // más paga; si no se puede elegir, nace sin él y se activa luego desde Ajustes). null: sin staking.
      const stakedNodeId =
        node === "auto"
          ? await mirror
              .nodes()
              .then(pickStakingNode)
              .catch(() => null)
          : node;
      const { client, key, accountId } = await pocketClient();
      try {
        const out = await setupVaultV2({
          stakedNodeId,
          client,
          mirror,
          pocket: { evmAddress: p.pocket.evmAddress, publicKey: key.publicKey },
          rescuePublicKey: rescueKey.publicKey,
          guardianEvm: guardian?.evmAddress ?? null,
          withdrawDelay,
          recoveryDelay,
          initialTinybars: depositTinybars,
          tiebreaker,
          factory,
          onStep: (s) => onStep(s === "kit" ? 1 : s === "notary" ? 2 : 3),
        });
        // La Cartera hace staking en el mismo nodo: es una cuenta normal con la llave del móvil, así que es al momento.
        // Si falla, la bóveda ya está creada: se puede poner luego.
        if (stakePocketToo && stakedNodeId != null) {
          await new AccountUpdateTransaction()
            .setAccountId(accountId)
            .setStakedNodeId(stakedNodeId)
            .execute(client)
            .then((r) => r.getReceipt(client))
            .catch(() => undefined);
        }
        // El primer depósito también paga la comisión de depósito (si algún día se activa).
        const fee = feeOf(serviceFees?.deposit);
        if (fee && depositTinybars > 0n) await payServiceFee({ client, from: accountId, fee, memo: "H10X Wallet · comisión de depósito" }).catch(() => undefined);
        return { ...out, words: mnemonic.toString().split(" "), tiebreaker: !!tiebreaker };
      } finally {
        client.close();
      }
    },
    [pocketClient],
  );

  const newKitWords = useCallback(async () => (await Mnemonic.generate()).toString().split(" "), []);

  const renameWallet = useCallback(
    async (name: string) => {
      const p = profileRef.current;
      if (!p) return;
      const clean = name.replace(/\s+/g, " ").trim().slice(0, 32);
      const { name: _old, ...rest } = p;
      await update(clean ? { ...rest, name: clean } : rest);
    },
    [update],
  );

  const setupVault = useCallback<WalletCtx["setupVault"]>(
    async ({ withdrawDelay, recoveryDelay, depositTinybars, password = null, hbarUsd = null, onStep, words: checked = undefined, stakedNodeId = "auto", name = undefined }) => {
      const p = profileRef.current;
      if (!p) throw new Error(t("No hay cartera.", "There is no wallet."));
      if (checked && (checked.length !== 24 || !(await Mnemonic.fromWords(checked).then(() => true, () => false)))) throw new Error(t("El kit no es válido.", "The kit isn't valid."));
      onStep(0);
      const guardian = await guardianInfo();
      // Mainnet: sin guardián no se crea la bóveda (nadie completaría ni vigilaría, y el tope no estaría confirmado).
      if (isMainnet && !guardian) {
        throw new WalletError(
          t(
            "No puedo hablar con el guardián. En mainnet la bóveda solo se crea con él conectado: prueba otra vez en unos minutos.",
            "I can't reach the guardian. On mainnet the vault is only created with it connected: try again in a few minutes.",
          ),
        );
      }
      const { notaryId, vaultId, rescueAccountId, words, tiebreaker } = await createV2(p, guardian, withdrawDelay, recoveryDelay, depositTinybars, onStep, password, hbarUsd, checked ?? null, stakedNodeId, true);
      // Un kit ya comprobado no se guarda en el móvil: el móvil y el kit nunca juntos.
      const kitPending = checked ? false : await keepPendingKit(store, { words, vaultId: vaultId.toString(), password: password ?? null }, p.biometric);
      const cleanName = name?.replace(/\s+/g, " ").trim().slice(0, 32);
      await update({
        ...p,
        ...(cleanName ? { name: cleanName } : {}),
        kitPending,
        vault: {
          accountId: vaultId.toString(),
          notaryId: notaryId.toString(),
          createdAt: nowSeconds(),
          version: 2,
          delaySeconds: withdrawDelay,
          recoveryDelaySeconds: recoveryDelay,
          rescueAccountId: rescueAccountId.toString(),
          tiebreaker,
        },
        guardian,
        recoveryConfirmed: !!checked,
      });
      onStep(4);
      // El registro en el guardián va en segundo plano: el kit nunca espera por él.
      if (guardian) void registerWithRetries();

      onStep(5);
      return { words, vaultId: vaultId.toString() };
    },
    [createV2, registerWithRetries, store, update],
  );

  /**
   * Bóveda v1 → v2: comprueba las palabras antiguas, crea la v2 y mueve el saldo con el rescate
   * inmediato de la v1 (sin comisión: es tu propio dinero cambiando de bóveda).
   * Pasos: 0 palabras · 1 kit · 2 notario · 3 bóveda · 4 mover · 5 guardián.
   */
  const migrateToV2 = useCallback<WalletCtx["migrateToV2"]>(
    async ({ oldWords, withdrawDelay, recoveryDelay, password = null, onStep }) => {
      const p = profileRef.current;
      if (!p?.vault || p.vault.version === 2) throw new Error(t("No hay bóveda v1 que pasar.", "There is no v1 vault to upgrade."));
      onStep(0);
      const oldKey = await rescueKeyFromWords(oldWords).catch(() => {
        throw badWords();
      });
      if (!(await checkV1Words(p.vault.accountId, oldKey.publicKey))) throw new WalletError(t("Esas palabras no son el kit de tu bóveda antigua.", "Those words are not your old vault's kit."));
      const guardian = (await guardianInfo()) ?? (p.guardian ? { ...p.guardian, registered: false } : undefined);
      const { notaryId, vaultId, rescueAccountId, words, tiebreaker } = await createV2(p, guardian, withdrawDelay, recoveryDelay, 0n, onStep, password);
      const kitPending = await keepPendingKit(store, { words, vaultId: vaultId.toString(), password: password ?? null }, p.biometric);
      const oldVault = p.vault.accountId;
      await update({
        ...p,
        kitPending,
        vault: {
          accountId: vaultId.toString(),
          notaryId: notaryId.toString(),
          createdAt: nowSeconds(),
          version: 2,
          delaySeconds: withdrawDelay,
          recoveryDelaySeconds: recoveryDelay,
          rescueAccountId: rescueAccountId.toString(),
          tiebreaker,
        },
        guardian,
        legacyVaults: [...(p.legacyVaults ?? []), oldVault],
        mySchedules: [],
        recoveryConfirmed: false,
      });
      onStep(4);
      let moved = 0n;
      const fresh = createClient(NETWORK, null);
      try {
        const out = await rescueVault({ client: fresh, mirror, vaultId: AccountId.fromString(oldVault), rescueKey: oldKey, to: vaultId });
        moved = out.tinybars;
      } catch (e) {
        if (!(e instanceof WalletError && e.status === "NOTHING_TO_RESCUE")) throw e; // bóveda antigua vacía: nada que mover
      } finally {
        fresh.close();
      }
      onStep(5);
      if (guardian) void registerWithRetries(); // en segundo plano: el kit nuevo nunca espera por él
      onStep(6);
      return { words, vaultId: vaultId.toString(), moved };
    },
    [createV2, registerWithRetries, store, update],
  );

  const confirmRecovery = useCallback(async () => {
    const p = profileRef.current;
    await store.clearPendingKit();
    if (p) await update({ ...p, recoveryConfirmed: true, kitPending: false });
  }, [store, update]);

  const openPendingKit = useCallback(async () => {
    const p = profileRef.current;
    if (!p?.kitPending || !p.vault) return null;
    const kit = await store.readPendingKit(p.biometric);
    // Solo el kit de ESTA bóveda (uno de una bóveda anterior no sirve para nada)
    return kit && kit.vaultId === p.vault.accountId ? kit : null;
  }, [store]);

  const restartVault = useCallback(async ({ lostKit = false }: { lostKit?: boolean } = {}) => {
    const p = profileRef.current;
    if (!p?.vault) throw new Error(t("No hay bóveda.", "There is no vault."));
    if (p.pendingRecovery) throw new WalletError(t("Hay una recuperación en curso: espera a que termine.", "There's a recovery in progress: wait for it to finish."));
    // Desde Inicio (kit sin comprobar) solo si el kit no está guardado; desde «Hacer un kit nuevo», siempre que esté vacía.
    if (!lostKit && (p.recoveryConfirmed || p.kitPending)) throw new WalletError(t("Tu kit está apuntado o guardado: no hace falta crear otra bóveda.", "Your kit is written down or saved: no need for a new vault."));
    const id = p.vault.accountId;
    const vault = await mirror.account(id);
    if (!vault) throw new WalletError(t("No puedo leer la bóveda ahora. Prueba en un momento.", "I can't read the vault right now. Try again in a moment."));
    const tokens = await loadTokens(id);
    const nfts = await mirror.accountNfts(id);
    // Solo vacía (cabe algún resto de comisiones): con dinero dentro, se saca primero con «Sacar».
    if (vault.balance > 5_000_000n || tokens.some((x) => x.balance > 0n) || nfts.length > 0)
      throw new WalletError(t("La bóveda tiene saldo: sácalo primero a la Cartera con «Sacar» y después crea la bóveda de nuevo.", "The vault has funds: move them to the Wallet with “Withdraw” first, then create the vault again."));
    await store.clearPendingKit();
    const { vault: _old, pendingRecovery: _pr, ...rest } = p;
    await update({ ...rest, legacyVaults: [...(p.legacyVaults ?? []), id], mySchedules: [], recoveryConfirmed: false, kitPending: false });
    setBalances((b) => ({ ...b, vault: null }));
    setMovements([]);
    setLocks({ withdraw: 0, recovery: 0 });
  }, [store, update]);

  /** Envío desde la cartera (HBAR o token), con la comisión que toque en la misma transferencia. */
  const transfer = useCallback(
    async (to: string, asset: string, amount: bigint, fee: Fee) => {
      const { client, accountId } = await pocketClient();
      try {
        const dest = parseAccount(to);
        const txId =
          asset === HBAR_ASSET
            ? await sendHbar({ client, from: accountId, to: dest, tinybars: amount, fee })
            : await sendToken({ client, from: accountId, to: dest, tokenId: asset, amount, decimals: await decimalsOf(asset), fee });
        void refresh();
        return txId;
      } finally {
        client.close();
      }
    },
    [pocketClient, refresh, decimalsOf],
  );

  const send = useCallback((to: string, asset: string, amount: bigint) => transfer(to, asset, amount, null), [transfer]);

  const deposit = useCallback(
    async (asset: string, amount: bigint) => {
      const p = profileRef.current;
      if (!p?.vault) throw new Error(t("No hay bóveda.", "There is no vault."));
      if (asset !== HBAR_ASSET) {
        const vault = await mirror.account(p.vault.accountId);
        const associated = tokensRef.current.vault.some((x) => x.tokenId === asset);
        if (vault && vault.maxAutoAssociations === 0 && !associated) {
          throw new WalletError(t("Tu bóveda todavía no acepta tokens. Actívalos primero en la pantalla principal.", "Your vault does not accept tokens yet. Enable them first on the home screen."));
        }
      }
      return transfer(p.vault.accountId, asset, amount, feeOf(serviceFees?.deposit));
    },
    [transfer],
  );

  /** Anota una operación propia (para no marcarla como "no reconocida"). */
  const remember = useCallback(
    async (scheduleId: string) => {
      const p = profileRef.current;
      if (p) await update({ ...p, mySchedules: [...p.mySchedules, scheduleId] });
    },
    [update],
  );

  const withdraw = useCallback(
    async (to: string, asset: string, amount: bigint) => {
      const p = profileRef.current;
      if (!p?.vault) throw new Error(t("No hay bóveda.", "There is no vault."));
      // 0.10: lo que no puede salir con cuenta atrás no se pide (y se mira antes de pedir Face ID).
      if (p.vault.version === 2 && asset !== HBAR_ASSET) {
        const risk = await countdownRisk([asset]);
        if (risk) throw countdownRiskError(risk);
      }
      const { client } = await pocketClient();
      try {
        const vaultId = AccountId.fromString(p.vault.accountId);
        const notaryId = ContractId.fromString(p.vault.notaryId);
        const dest = parseAccount(to);
        let scheduleId: ScheduleId;
        if (p.vault.version === 2) {
          const isHbar = asset === HBAR_ASSET;
          const tokenList = isHbar ? [] : [{ tokenId: asset, amount, decimals: await decimalsOf(asset) }];
          ({ scheduleId } = await requestWithdrawalV2({ client, vaultId, notaryId, to: dest, tinybars: isHbar ? amount : 0n, tokens: tokenList, fee: feeOf(serviceFees?.withdraw), withdrawDelay: p.vault.delaySeconds }));
        } else {
          if (asset !== HBAR_ASSET) throw new WalletError(t("La bóveda v1 solo guarda HBAR. Pásate a la v2.", "The v1 vault only holds HBAR. Upgrade to v2."));
          ({ scheduleId } = await requestWithdrawal({ client, vaultId, notaryId, to: dest, tinybars: amount, delaySeconds: p.vault.delaySeconds }));
        }
        const id = scheduleId.toString();
        await remember(id);
        void refresh();
        return id;
      } finally {
        client.close();
      }
    },
    [pocketClient, refresh, remember, decimalsOf],
  );

  /** Bóvedas creadas antes de esta versión: activar tokens por el carril de retirada (con su cuenta atrás). */
  const enableVaultTokens = useCallback(async () => {
    const p = profileRef.current;
    if (p?.vault?.version !== 2) throw new Error(t("Solo las bóvedas v2 pueden guardar tokens.", "Only v2 vaults can hold tokens."));
    const { client } = await pocketClient();
    try {
      const { scheduleId } = await requestEnableTokensV2({ client, vaultId: AccountId.fromString(p.vault.accountId), notaryId: ContractId.fromString(p.vault.notaryId), withdrawDelay: p.vault.delaySeconds });
      const id = scheduleId.toString();
      await remember(id);
      void refresh();
      return id;
    } finally {
      client.close();
    }
  }, [pocketClient, refresh, remember]);

  const loadStakingNodes = useCallback(async (force = false) => {
    if (!force && stakingNodes.length && Date.now() - nodesAt.current < 30 * 60_000) return stakingNodes;
    const list = await mirror.nodes();
    nodesAt.current = Date.now();
    setStakingNodes(list);
    return list;
  }, [stakingNodes]);

  /** Rendimiento: cambiar o quitar el nodo de staking, por el carril de retirada (con su cuenta atrás). */
  const requestStaking = useCallback(
    async (nodeId: number | null) => {
      const p = profileRef.current;
      if (p?.vault?.version !== 2) throw new Error(t("El rendimiento necesita la bóveda v2.", "Yield needs the v2 vault."));
      const { client } = await pocketClient();
      try {
        const { scheduleId } = await requestStakingV2({ client, vaultId: AccountId.fromString(p.vault.accountId), notaryId: ContractId.fromString(p.vault.notaryId), nodeId, withdrawDelay: p.vault.delaySeconds });
        const id = scheduleId.toString();
        await remember(id);
        void refresh();
        return id;
      } finally {
        client.close();
      }
    },
    [pocketClient, refresh, remember],
  );

  /** Hedera paga lo pendiente cuando cambia el saldo de la cuenta: basta con mandarle 1 tinybar. */
  const collectRewards = useCallback(async () => {
    const p = profileRef.current;
    if (!p?.vault) throw new Error(t("Primero crea la bóveda.", "Create the vault first."));
    const { client, accountId } = await pocketClient();
    try {
      const txId = await sendHbar({ client, from: accountId, to: AccountId.fromString(p.vault.accountId), tinybars: 1n, memo: "H10X Wallet · cobrar rendimiento" });
      earnedAt.current = { ...earnedAt.current, at: 0 };
      setTimeout(() => void refresh(), 4000);
      return txId;
    } finally {
      client.close();
    }
  }, [pocketClient, refresh]);

  /** Asocia un token a la cartera (solo hace falta si la cartera no los acepta automáticamente). */
  const addPocketToken = useCallback(
    async (tokenId: string) => {
      const info = await mirror.tokenInfo(tokenId.trim());
      if (!info) throw new WalletError(t("No existe ningún token con ese ID en esta red.", "There is no token with that ID on this network."));
      if (!info.fungible) throw new WalletError(t("Por ahora la app solo maneja tokens normales (no NFT).", "For now the app only handles regular tokens (not NFTs)."));
      const { client, accountId } = await pocketClient();
      try {
        await associateTokens({ client, accountId, tokenIds: [info.tokenId] });
        void refresh();
        return info;
      } finally {
        client.close();
      }
    },
    [pocketClient, refresh],
  );

  /** Permisos de gasto que ha dado la Cartera (a dApps y contratos). */
  const pocketAllowances = useCallback(async (): Promise<Allowance[]> => {
    const id = profileRef.current?.pocket.accountId;
    return id ? mirror.allowances(id) : [];
  }, []);

  /** Quita un permiso de la Cartera. */
  const revokePocketAllowance = useCallback(
    async (allowance: Allowance) => {
      const { client, accountId } = await pocketClient();
      try {
        await revokeAllowance({ client, accountId, allowance });
      } finally {
        client.close();
      }
    },
    [pocketClient],
  );

  /** NFT de la Cartera a la bóveda (comisión de depósito si está activada). */
  const depositNfts = useCallback(
    async (list: NftRef[]) => {
      const p = profileRef.current;
      if (p?.vault?.version !== 2) throw new WalletError(t("Solo las bóvedas v2 guardan NFT.", "Only v2 vaults hold NFTs."));
      const vault = await mirror.account(p.vault.accountId);
      if (vault && vault.maxAutoAssociations === 0) {
        throw new WalletError(t("Tu bóveda todavía no acepta tokens. Actívalos primero en la pantalla principal.", "Your vault does not accept tokens yet. Enable them first on the home screen."));
      }
      const { client, accountId } = await pocketClient();
      try {
        const txId = await sendNfts({ client, from: accountId, to: AccountId.fromString(p.vault.accountId), nfts: list, fee: feeOf(serviceFees?.deposit) });
        void refresh();
        return txId;
      } finally {
        client.close();
      }
    },
    [pocketClient, refresh],
  );

  /** Sacar NFT de la bóveda: misma cuenta atrás que el dinero, visible y bloqueable. */
  const withdrawNfts = useCallback(
    async (to: string, list: NftRef[]) => {
      const p = profileRef.current;
      if (p?.vault?.version !== 2) throw new WalletError(t("Solo las bóvedas v2 guardan NFT.", "Only v2 vaults hold NFTs."));
      // 0.10: una colección cuyo emisor puede poner comisiones tampoco sale con cuenta atrás (sale con «Evacuar»).
      const risk = await countdownRisk(list.map((n) => n.tokenId));
      if (risk) throw countdownRiskError(risk);
      const { client } = await pocketClient();
      try {
        const { scheduleId } = await requestWithdrawalV2({
          client,
          vaultId: AccountId.fromString(p.vault.accountId),
          notaryId: ContractId.fromString(p.vault.notaryId),
          to: parseAccount(to),
          nfts: list,
          fee: feeOf(serviceFees?.withdraw),
          withdrawDelay: p.vault.delaySeconds,
        });
        const id = scheduleId.toString();
        await remember(id);
        void refresh();
        return id;
      } finally {
        client.close();
      }
    },
    [pocketClient, refresh, remember],
  );

  const sendNftsFromPocket = useCallback(
    async (to: string, list: NftRef[]) => {
      const { client, accountId } = await pocketClient();
      try {
        const txId = await sendNfts({ client, from: accountId, to: parseAccount(to), nfts: list });
        void refresh();
        return txId;
      } finally {
        client.close();
      }
    },
    [pocketClient, refresh],
  );

  /**
   * Nuevos plazos: notario nuevo y llave nueva de la bóveda, con el móvil y el kit a la vez.
   * Lo pendiente en el notario anterior se cancela solo. Después se vuelve a registrar el guardián.
   */
  const changeDelays = useCallback<WalletCtx["changeDelays"]>(
    async ({ words, withdrawDelay, recoveryDelay, password, onStep }) => {
      const p = profileRef.current;
      if (p?.vault?.version !== 2) throw new WalletError(t("Solo las bóvedas v2 tienen plazos configurables.", "Only v2 vaults have configurable delays."));
      const rescueKey = await rescueKeyFromWords(words).catch(() => {
        throw badWords();
      });
      onStep?.(0);
      const tiebreaker = password ? tiebreakerAddress(await tiebreakerKey(password, rescueKey.publicKey)) : undefined;
      const { client } = await pocketClient();
      try {
        const out = await changeVaultDelaysV2({
          client,
          mirror,
          vaultId: AccountId.fromString(p.vault.accountId),
          rescueKey,
          withdrawDelay,
          recoveryDelay,
          tiebreaker,
          allowTest: allowTestDelays,
          factory: await notaryFactoryFresh(),
          onStep: (s) => onStep?.(s === "check" ? 0 : s === "notary" ? 1 : 2),
        });
        const cur = profileRef.current ?? p;
        const cfg = await notary2Config({ mirror, notaryId: out.notaryId }).catch(() => null);
        const base = cur.vault ?? p.vault;
        await update({
          ...cur,
          vault: { ...base, notaryId: out.notaryId.toString(), delaySeconds: withdrawDelay, recoveryDelaySeconds: recoveryDelay, tiebreaker: cfg ? cfg.version === 3 : !!tiebreaker || !!base.tiebreaker },
          guardian: cur.guardian ? { ...cur.guardian, registered: false } : cur.guardian,
          mySchedules: [],
        });
      } finally {
        client.close();
      }
      onStep?.(3);
      if (profileRef.current?.guardian) await registerWithRetries();
      void refresh();
    },
    [pocketClient, refresh, registerWithRetries, update],
  );

  const withPocket = useCallback(async <T,>(fn: (p: PocketAccess) => Promise<T>): Promise<T> => {
    const access = await pocketClient();
    try {
      return await fn(access);
    } finally {
      access.client.close();
    }
  }, [pocketClient]);

  const notaryCall = useCallback(
    async (m: Movement, fn: "veto" | "approve") => {
      const p = profileRef.current;
      if (!p?.vault) throw new Error(t("No hay bóveda.", "There is no vault."));
      const { client } = await pocketClient();
      try {
        const notaryId = ContractId.fromString(p.vault.notaryId);
        const schedule = ScheduleId.fromString(m.scheduleId);
        if (p.vault.version === 2) {
          const out = await callNotary2({ client, notaryId, call: fn, schedule });
          if (!out.ok) throw new WalletError(friendlyNotary2Error(fn, out.reason || out.status), out.status, out.txId);
        } else {
          const out = await callNotary({ client, notaryId, scheduleId: schedule, fn });
          if (!out.ok) throw new WalletError(friendlyNotaryError(fn, out.reason || out.status), out.status, out.txId);
        }
        void refresh();
      } finally {
        client.close();
      }
    },
    [pocketClient, refresh],
  );

  const veto = useCallback((m: Movement) => notaryCall(m, "veto"), [notaryCall]);
  const completeNow = useCallback(
    async (m: Movement) => {
      // Como el guardián: lo que mueva un token que cobra comisión a la bóveda no se completa.
      if (m.action.kind === "transfer") {
        const charging = await feeChargingToken([...m.action.tokens.map((x) => x.tokenId), ...m.action.nfts.map((x) => x.tokenId)]);
        if (charging) throw feeError(charging);
      }
      return notaryCall(m, "approve");
    },
    [notaryCall],
  );

  const freezeRecovery = useCallback(async () => {
    const p = profileRef.current;
    if (p?.vault?.version !== 2) throw new Error(t("Solo las bóvedas v2 tienen carril de recuperación.", "Only v2 vaults have a recovery lane."));
    const { client } = await pocketClient();
    try {
      const out = await callNotary2({ client, notaryId: ContractId.fromString(p.vault.notaryId), call: "freeze", lane: Lane.Recovery });
      if (!out.ok) throw new WalletError(friendlyNotary2Error("freeze", out.reason || out.status), out.status, out.txId);
      void refresh();
    } finally {
      client.close();
    }
  }, [pocketClient, refresh]);

  const evacuate = useCallback<WalletCtx["evacuate"]>(
    async ({ words, to }) => {
      const p = profileRef.current;
      if (p?.vault?.version !== 2) throw new Error(t("La evacuación es de las bóvedas v2.", "Evacuation is for v2 vaults."));
      const rescueKey = await rescueKeyFromWords(words).catch(() => {
        throw badWords();
      });
      const vault = await inspectVaultV2({ mirror, vaultId: p.vault.accountId });
      if (!vault) throw new WalletError(t("No encuentro la bóveda en la red.", "I can't find the vault on the network."));
      if (vault.rescueKey.toStringRaw() !== rescueKey.publicKey.toStringRaw()) throw new WalletError(t("Esas palabras no son el kit de esta bóveda.", "Those words are not this vault's kit."));
      const { client } = await pocketClient();
      try {
        const out = await evacuateVault({ client, mirror, vaultId: vault.vaultId, to: parseAccount(to), rescueKey });
        void refresh();
        return out;
      } finally {
        client.close();
      }
    },
    [pocketClient, refresh],
  );

  /** Rescate inmediato de una bóveda v1 (la v1 lo permite solo con el kit). */
  const rescue = useCallback<WalletCtx["rescue"]>(
    async ({ words, vaultId, to }) => {
      const rescueKey = await rescueKeyFromWords(words).catch(() => {
        throw badWords();
      });
      const client = createClient(NETWORK, null);
      try {
        const out = await rescueVault({ client, mirror, vaultId: AccountId.fromString(vaultId.trim()), rescueKey, to: parseAccount(to) });
        void refresh();
        return out;
      } finally {
        client.close();
      }
    },
    [refresh],
  );

  /**
   * Móvil nuevo, solo con el kit: v1 → rescate inmediato; v2 → recuperación con cuenta atrás
   * (HBAR y, aparte, los tokens en grupos). Sin comisión.
   * Con `stolen` (me han robado el móvil), antes de nada: el kit congela las retiradas y le pide al
   * guardián el modo robo, que bloquea cualquier retirada nueva hasta que llegue la recuperación.
   * Con `here`, el dinero va a una cartera nueva creada en este móvil.
   */
  const recoverWithKit = useCallback<WalletCtx["recoverWithKit"]>(
    async ({ words, vaultId, here, to, stolen = false, password = "", onStep }) => {
      const order = stolen ? ["check", "freeze", "guardian", "wallet", "request", "done"] : ["check", "wallet", "request", "done"];
      const step = (name: string) => onStep?.(order.indexOf(name));
      step("check");
      const id = vaultId.trim();
      const key = await rescueKeyFromWords(words).catch(() => {
        throw badWords();
      });
      const v2 = await inspectVaultV2({ mirror, vaultId: id });
      if (v2) {
        if (v2.rescueKey.toStringRaw() !== key.publicKey.toStringRaw()) throw new WalletError(t("Esas palabras no son el kit de esa bóveda.", "Those words are not that vault's kit."));
        const allNfts = await mirror.accountNfts(id);
        const nftCollections = new Set(allNfts.map((n) => n.tokenId));
        const tokenHoldings = (await mirror.accountTokens(id)).filter((h) => !nftCollections.has(h.tokenId));
        // 0.10: cualquiera puede completar la recuperación al acabar la cuenta atrás, también el emisor de un token que
        // haya puesto una comisión justo antes (la pagaría la bóveda). Lo que cobra o no se sabe qué es, se queda; los
        // tokens con llave de comisiones van solos al final, cuando ya no queda nada con qué pagar (core/feepolicy.js).
        const infos = new Map<string, TokenInfo | null>();
        for (const tid of new Set([...nftCollections, ...tokenHoldings.map((h) => h.tokenId)])) infos.set(tid, await mirror.tokenInfo(tid, { fresh: true }).catch(() => null));
        const plan = planRecovery({ tinybars: v2.balance, tokens: tokenHoldings, nfts: allNfts, infoOf: (x) => infos.get(x) ?? null });
        const holdings = plan.tokens;
        const nftHoldings = plan.nfts;
        if (plan.tinybars <= 0n && holdings.length === 0 && nftHoldings.length === 0) {
          throw new WalletError(
            plan.later.length
              ? t(
                  "Lo que queda en la bóveda son tokens que cobran comisión al moverlos (o que no se sabe qué son): con una recuperación los pagaría la bóveda. Si tienes el móvil, sácalos con «Evacuar».",
                  "What's left in the vault are tokens that charge a fee to move (or unknown ones): with a recovery the vault would pay it. If you have the phone, take them out with “Evacuate”.",
                )
              : t("La bóveda está vacía.", "The vault is empty."),
          );
        }
        const cfg = await notary2Config({ mirror, notaryId: v2.notaryId });
        // Contraseña de desempate: se comprueba aquí, sin gastar nada, contra la dirección que guarda el notario.
        let tbKey: PrivateKey | null = null;
        if (password.trim() && cfg.tiebreaker) {
          tbKey = await tiebreakerKey(password, key.publicKey);
          if (tiebreakerAddress(tbKey) !== cfg.tiebreaker) {
            throw new WalletError(t("La contraseña de desempate no es la de esta bóveda. Revísala o déjala vacía para pedir la recuperación normal.", "That isn't this vault's tiebreaker password. Check it, or leave it empty to request the normal recovery."));
          }
        }
        const kit = await findRescueAccount({ mirror, rescuePublicKey: key.publicKey, rescueAddress: cfg.rescue });
        if (!kit) throw new WalletError(t("No encuentro la cuenta del kit de esa bóveda.", "I can't find that vault's kit account."));
        const kitClient = createClient(NETWORK, { accountId: kit.id, key });
        try {
          let theft: { frozenUntil: number; guardianNotified: boolean } | undefined;
          if (stolen) {
            // 1) Lo primero: congelar las retiradas. Anula lo que haya pedido el ladrón y no deja pedir más un tiempo.
            step("freeze");
            const fz = await callNotary2({ client: kitClient, notaryId: v2.notaryId, call: "freeze", lane: Lane.Withdraw });
            if (!fz.ok && !/^LaneLocked/.test(fz.reason)) throw new WalletError(friendlyNotary2Error("freeze", fz.reason || fz.status), fz.status, fz.txId);
            const lockedUntil = Number(/^LaneLocked\(\d+, ?(\d+)\)/.exec(fz.reason)?.[1] ?? 0);
            // 2) El guardián mantiene el bloqueo mientras dure la recuperación (aunque nadie abra la app).
            step("guardian");
            let guardianNotified = false;
            const url = guardianUrl();
            if (url) {
              const notice = signTheftNotice(key, { action: "on", vaultId: v2.vaultId.toString(), notaryId: v2.notaryId.toString(), timestamp: nowSeconds(), lang: lang() });
              guardianNotified = await fetchJson(`${url}/theft`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(notice) }, 15000)
                .then(() => true)
                .catch(() => false);
            }
            theft = { frozenUntil: lockedUntil || nowSeconds() + cfg.withdrawDelay, guardianNotified };
          }
          let dest: AccountId;
          if (here) {
            step("wallet");
            // Si ya hay una cartera en este móvil (sin bóveda: p. ej. un intento anterior), se reutiliza.
            const existing = profileRef.current && !profileRef.current.vault ? profileRef.current.pocket.evmAddress : null;
            const evm = existing ?? (await createWallet());
            const current = await mirror.account(evm);
            // La cuenta del kit le da 1 HBAR para sus primeras comisiones (y así la crea en la red).
            if (!current || current.balance < HBAR / 2n) {
              await sendHbar({ client: kitClient, from: kit.id, to: AccountId.fromEvmAddress(0, 0, evm), tinybars: HBAR });
            }
            let acc = current && current.balance >= HBAR / 2n ? current : null;
            for (let i = 0; i < 30 && !acc; i++) {
              acc = await mirror.account(evm);
              if (!acc) await sleep(2000);
            }
            if (!acc) throw new WalletError(t("La cartera nueva tarda en aparecer: vuelve a intentarlo en un minuto.", "The new wallet is taking a while to appear: try again in a minute."));
            dest = acc.id;
            const p = profileRef.current;
            if (p) await update({ ...p, pocket: { ...p.pocket, accountId: acc.id.toString() } });
          } else {
            dest = parseAccount(to ?? "");
          }
          step("request");
          const common = { client: kitClient, vaultId: v2.vaultId, notaryId: v2.notaryId, to: dest, recoveryDelay: cfg.recoveryDelay };
          // Con la contraseña, prioritaria: el móvil antiguo no la puede parar y vale aunque haya congelado las recuperaciones.
          const ask = (part: { tinybars?: bigint; tokens?: { tokenId: string; amount: bigint; decimals?: number | null }[]; nfts?: NftRef[] }) =>
            tbKey ? requestPriorityRecoveryV3({ ...common, ...part, tiebreakerKey: tbKey, chainId: CHAIN_IDS[NETWORK as keyof typeof CHAIN_IDS], mirror }) : requestRecoveryV2({ ...common, ...part });
          const scheduleIds: string[] = [];
          // El HBAR va solo: si un token no pudiera llegar al destino, no arrastra al HBAR.
          if (plan.tinybars > 0n) scheduleIds.push((await ask({ tinybars: plan.tinybars })).scheduleId.toString());
          for (const group of chunk(holdings)) {
            const tokenList = group.map((h) => ({ tokenId: h.tokenId, amount: h.balance, decimals: h.decimals }));
            scheduleIds.push((await ask({ tokens: tokenList })).scheduleId.toString());
          }
          // Los NFT también, de 10 en 10 (límite de Hedera por transferencia).
          for (const group of chunk(nftHoldings, 10)) {
            scheduleIds.push((await ask({ nfts: group.map((n) => ({ tokenId: n.tokenId, serial: n.serial })) })).scheduleId.toString());
          }
          const executableAt = nowSeconds() + cfg.recoveryDelay;
          if (here) {
            const p = profileRef.current;
            if (p) {
              await update({
                ...p,
                pendingRecovery: {
                  vaultId: v2.vaultId.toString(),
                  notaryId: v2.notaryId.toString(),
                  scheduleId: scheduleIds[0],
                  extraSchedules: scheduleIds.slice(1),
                  executableAt,
                  tinybars: plan.tinybars.toString(),
                  tokens: holdings.length,
                  nfts: nftHoldings.length,
                  stolen,
                  ...(plan.later.length ? { later: plan.later.length } : {}),
                },
              });
            }
          }
          step("done");
          return {
            kind: "v2",
            tinybars: plan.tinybars,
            tokens: holdings.length,
            nfts: nftHoldings.length,
            scheduleId: scheduleIds[0],
            executableAt,
            to: dest.toString(),
            here,
            stolen: theft,
            priority: !!tbKey,
            later: plan.later.length,
            keyedOnly: plan.keyedOnly,
          };
        } finally {
          kitClient.close();
        }
      }

      // Bóveda v1: el kit solo la vacía al momento (no hay nada que congelar).
      const acc = await mirror.account(id);
      if (!acc) throw new WalletError(t("No encuentro esa bóveda en la red.", "I can't find that vault on the network."));
      if (!(acc.key instanceof KeyList) || !(await checkV1Words(id, key.publicKey))) throw new WalletError(t("Esas palabras no son el kit de esa bóveda.", "Those words are not that vault's kit."));
      let dest: AccountId;
      if (here) {
        step("wallet");
        const existing = profileRef.current && !profileRef.current.vault ? profileRef.current.pocket.evmAddress : null;
        dest = AccountId.fromEvmAddress(0, 0, existing ?? (await createWallet()));
      } else {
        dest = parseAccount(to ?? "");
      }
      step("request");
      const client = createClient(NETWORK, null);
      try {
        // A una dirección sin cuenta, la transferencia la crea: hace falta más margen para la comisión.
        const out = await rescueVault({ client, mirror, vaultId: acc.id, rescueKey: key, to: dest, marginTinybars: here ? HBAR : HBAR / 10n });
        step("done");
        return { kind: "v1", tinybars: out.tinybars, txId: out.txId, to: here ? (profileRef.current?.pocket.evmAddress ?? "") : dest.toString(), here };
      } finally {
        client.close();
      }
    },
    [createWallet, update],
  );

  /** ¿Está la bóveda de este móvil en modo robo en el guardián? (null si no se puede saber). */
  const theftStatus = useCallback(async () => {
    const p = profileRef.current;
    const url = guardianUrl() ?? p?.guardian?.url;
    if (!p?.vault || !url) return null;
    const v = await guardianVaultView(url, p);
    // Sin el código de lectura el guardián no lo dice: no se sabe (se pide otro código en la próxima firma).
    if (v?.legacy === true) needsReadToken.current = true;
    if (!v || !("theft" in v)) {
      if (v?.registered) needsReadToken.current = true;
      return null;
    }
    const theft = v.theft as { until?: number } | null;
    return theft ? { active: true, until: Number(theft.until ?? 0) } : { active: false, until: 0 };
  }, []);

  /** Quita el modo robo (p. ej. si apareció el móvil). Hace falta el kit: el móvil solo no puede. */
  const stopTheftMode = useCallback(async (words: string) => {
    const p = profileRef.current;
    const url = guardianUrl() ?? p?.guardian?.url;
    if (!p?.vault || !url) throw new WalletError(t("No hay guardián configurado.", "No guardian is configured."));
    const key = await rescueKeyFromWords(words).catch(() => {
      throw badWords();
    });
    const vault = await inspectVaultV2({ mirror, vaultId: p.vault.accountId });
    if (!vault || vault.rescueKey.toStringRaw() !== key.publicKey.toStringRaw()) throw new WalletError(t("Esas palabras no son el kit de esta bóveda.", "Those words are not this vault's kit."));
    const notice = signTheftNotice(key, { action: "off", vaultId: p.vault.accountId, notaryId: p.vault.notaryId, timestamp: nowSeconds(), lang: lang() });
    await fetchJson(`${url}/theft`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(notice) }, 15000);
  }, []);

  /** Estado de los avisos por correo (null si no hay guardián o no responde). */
  const emailStatus = useCallback(async (): Promise<EmailStatus | null> => {
    const p = profileRef.current;
    const url = guardianUrl() ?? p?.guardian?.url;
    if (!p?.vault || !url) return null;
    try {
      const info = await fetchJson(`${url}/info`, undefined, 8000);
      const v = await guardianVaultView(url, p);
      if (v?.registered && (!("email" in v) || v.legacy === true)) needsReadToken.current = true;
      return { available: !!info?.emails, registered: !!v?.registered, email: typeof v?.email === "string" ? v.email : null, pending: typeof v?.emailPending === "string" ? v.emailPending : null };
    } catch {
      return null;
    }
  }, []);

  /** Firma con el kit un mensaje para el guardián sobre el correo (comprueba que las palabras son de esta bóveda). */
  const sendEmailNotice = useCallback(async (words: string, action: "start" | "confirm" | "remove", email: string, code?: string) => {
    const p = profileRef.current;
    const url = guardianUrl() ?? p?.guardian?.url;
    if (p?.vault?.version !== 2 || !url) throw new WalletError(t("No hay guardián configurado.", "No guardian is configured."));
    const key = await rescueKeyFromWords(words).catch(() => {
      throw badWords();
    });
    const vault = await inspectVaultV2({ mirror, vaultId: p.vault.accountId });
    if (!vault || vault.rescueKey.toStringRaw() !== key.publicKey.toStringRaw()) throw new WalletError(t("Esas palabras no son el kit de esta bóveda.", "Those words are not this vault's kit."));
    const notice = signEmailNotice(key, { action, vaultId: p.vault.accountId, notaryId: p.vault.notaryId, email, ...(code ? { code } : {}), timestamp: nowSeconds(), lang: lang() });
    return fetchJson(`${url}/email`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(notice) }, 20000);
  }, []);

  const emailStart = useCallback(
    async ({ words, email }: { words: string; email: string }) => {
      const e = normalizeEmail(email);
      if (!isValidEmail(e)) throw new WalletError(t("Ese correo no es válido.", "That email isn't valid."));
      const out = await sendEmailNotice(words, "start", e);
      return String(out?.sentTo ?? e);
    },
    [sendEmailNotice],
  );

  const emailConfirm = useCallback(
    async ({ words, email, code }: { words: string; email: string; code: string }) => {
      const c = code.replace(/\D/g, "");
      if (c.length !== 6) throw new WalletError(t("El código tiene 6 cifras.", "The code has 6 digits."));
      const out = await sendEmailNotice(words, "confirm", normalizeEmail(email), c);
      return String(out?.email ?? "");
    },
    [sendEmailNotice],
  );

  const emailRemove = useCallback(
    async (words: string) => {
      await sendEmailNotice(words, "remove", "");
    },
    [sendEmailNotice],
  );

  /** Si el guardián no completa la recuperación, la cartera nueva puede pedírselo al notario. */
  const completeRecovery = useCallback(async () => {
    const r = profileRef.current?.pendingRecovery;
    if (!r) return;
    const { client } = await pocketClient();
    try {
      for (const id of [r.scheduleId, ...(r.extraSchedules ?? [])]) {
        const out = await callNotary2({ client, notaryId: ContractId.fromString(r.notaryId), call: "approve", schedule: ScheduleId.fromString(id) });
        if (!out.ok && !/BadStatus\(3\)/.test(out.reason)) throw new WalletError(friendlyNotary2Error("approve", out.reason || out.status), out.status, out.txId);
      }
      void refresh();
    } finally {
      client.close();
    }
  }, [pocketClient, refresh]);

  const wipe = useCallback(async () => {
    await store.wipeWallet();
    await wipeDerec(walletId);
    profileRef.current = null;
    setProfile(null);
    setBalances({ pocket: null, vault: null });
    setTokens({ pocket: [], vault: [] });
    setNfts({ pocket: [], vault: [] });
    setMovements([]);
    setLocks({ withdraw: 0, recovery: 0 });
    setMoveRequests(null);
    setMovedAway(false);
    setGuardianLost(false);
    // 0.10: se quita de la lista de wallets (si hay otras, se abre otra).
    await hooks.current.onWiped?.();
  }, [store, walletId]);

  // ---- Fábrica de notarios: ¿se puede crear la bóveda más barata? (se mira antes de crearla) ----------------------
  useEffect(() => {
    if (!profile || profile.vault || profile.pendingMove) return;
    let alive = true;
    void (async () => {
      await guardianInfo();
      const f = await notaryFactory();
      if (alive) setFactoryReady(!!f);
    })();
    return () => {
      alive = false;
    };
  }, [profile?.pocket.evmAddress, !!profile?.vault, !!profile?.pendingMove]);

  // ---- Cambio de móvil: lado del móvil NUEVO -------------------------------------------------------------------

  /**
   * Pide pasar a este móvil la wallet de otro: comprueba el kit contra la bóveda, crea la llave de este móvil (que nunca
   * sale de él), la guarda junto al perfil ANTES de pedir nada (si la app se cierra a mitad, no se pierde) y deja en
   * Hedera las dos peticiones, pagadas por la cuenta del kit. Si este móvil ya tenía un cambio a medias para esa bóveda,
   * usa la misma llave y pide solo lo que falte.
   */
  const moveIn = useCallback<WalletCtx["moveIn"]>(
    async ({ vaultId, words, name, onStep }) => {
      onStep?.(0);
      const id = vaultId.trim();
      const rescueKey = await rescueKeyFromWords(words).catch(() => {
        throw badWords();
      });
      const prev = profileRef.current;
      const resuming = !!prev?.pendingMove && prev.pendingMove.vaultId === id;
      if (prev && !resuming) {
        if (prev.vault) throw new WalletError(t("Este móvil ya tiene una wallet con bóveda.", "This phone already has a wallet with a vault."));
        if (prev.pendingMove) throw new WalletError(t("Este móvil ya está esperando otro cambio de móvil.", "This phone is already waiting for another phone change."));
        // Una cartera sin bóveda (p. ej. se pulsó «Crear»): solo se sustituye si está vacía.
        const acc = await mirror.account(prev.pocket.evmAddress).catch(() => null);
        if (acc && acc.balance > HBAR / 100n) {
          throw new WalletError(t("Este móvil ya tiene una cartera con saldo. Envíalo a otra cuenta tuya antes de traer aquí tu otra wallet.", "This phone already has a wallet with a balance. Send it to another account of yours before bringing your other wallet here."));
        }
      }
      const resumeKey = resuming ? PublicKey.fromStringECDSA(prev!.pendingMove!.newKey) : null;
      const w = await readWalletForMove({ mirror, vaultId: id, rescuePublicKey: rescueKey.publicKey, resumeKey });
      if (w.kitBalance < MOVE_KIT_MIN_TINYBARS) {
        throw new WalletError(
          t(
            `La cuenta de tu kit (${w.kitAccountId}) paga el cambio y necesita al menos 1 HBAR: tiene ${formatHbar(w.kitBalance)}. Mándale 1 HBAR desde cualquier wallet y vuelve a intentarlo.`,
            `Your kit's account (${w.kitAccountId}) pays for the change and needs at least 1 HBAR: it has ${formatHbar(w.kitBalance)}. Send it 1 HBAR from any wallet and try again.`,
          ),
        );
      }
      onStep?.(1);
      let key: PrivateKey;
      let biometric: boolean;
      if (resuming) {
        biometric = prev!.biometric;
        key = await store.readPocketKey(biometric);
        if (rawKey(key.publicKey) !== rawKey(resumeKey)) throw new WalletError(t("La llave de este móvil no es la del cambio pendiente.", "This phone's key isn't the pending change's key."));
      } else {
        await store.clearStaleKey();
        key = PrivateKey.generateECDSA();
        ({ biometric } = await store.storePocketKey(key));
      }
      const pending: PendingMove = {
        vaultId: w.vaultId,
        notaryId: w.notaryId,
        carteraId: w.carteraId,
        kitAccountId: w.kitAccountId,
        newKey: key.publicKey.toStringRaw(),
        name: name.trim().slice(0, 24) || "?",
        vault: null,
        cartera: null,
        expiresAt: 0,
        withdrawDelay: w.withdrawDelay,
        recoveryDelay: w.recoveryDelay,
        tiebreaker: w.tiebreaker,
        requested: false,
      };
      await update({
        version: 1,
        network: NETWORK,
        pocket: { evmAddress: w.carteraEvm, accountId: w.carteraId },
        mySchedules: [],
        recoveryConfirmed: true,
        biometric,
        devicePublicKey: key.publicKey.toStringRaw(),
        h10xAlerts: prev?.h10xAlerts,
        pendingMove: pending,
      });
      onStep?.(2);
      const kitClient = createClient(NETWORK, { accountId: AccountId.fromString(w.kitAccountId), key: rescueKey });
      try {
        const ids = await requestMove({ client: kitClient, w, newKey: key, name: pending.name });
        const cur = profileRef.current;
        if (cur?.pendingMove) await update({ ...cur, pendingMove: { ...cur.pendingMove, ...ids, expiresAt: nowSeconds() + MOVE_REQUEST_LIFETIME_SECONDS, requested: true } });
      } finally {
        kitClient.close();
      }
      onStep?.(3);
    },
    [store, update],
  );

  /** Móvil nuevo: cuando las dos llaves ya son la suya, la wallet queda lista aquí (y el guardián, avisado). */
  const finishMoveIn = useCallback(async () => {
    const p = profileRef.current;
    const pm = p?.pendingMove;
    if (!p || !pm) return;
    const guardian = await guardianInfo();
    // Las retiradas que siguen en marcha no se dan por tuyas: si alguna la pidió quien tuviera una copia de la llave
    // vieja, aquí debe verse como «no reconocida». Las tuyas, las reconoces tú (y el guardián las completa igual).
    const { pendingMove: _done, ...rest } = p;
    await update({
      ...rest,
      vault: {
        accountId: pm.vaultId,
        notaryId: pm.notaryId,
        createdAt: nowSeconds(),
        version: 2,
        delaySeconds: pm.withdrawDelay,
        recoveryDelaySeconds: pm.recoveryDelay,
        rescueAccountId: pm.kitAccountId,
        tiebreaker: pm.tiebreaker,
      },
      guardian,
      mySchedules: [],
      recoveryConfirmed: true,
    });
    if (guardian) void registerWithRetries();
  }, [registerWithRetries, update]);

  const checkMoveIn = useCallback<WalletCtx["checkMoveIn"]>(async () => {
    const pm = profileRef.current?.pendingMove;
    if (!pm) return profileRef.current?.vault ? "done" : "none";
    const st = await moveStatus({ mirror, w: { vaultId: pm.vaultId, carteraId: pm.carteraId }, newKey: PublicKey.fromStringECDSA(pm.newKey) });
    if (st.done) {
      await finishMoveIn();
      return "done";
    }
    if (st.vault || st.cartera) return "half";
    return pm.requested && nowSeconds() > pm.expiresAt ? "expired" : "waiting";
  }, [finishMoveIn]);

  const cancelMoveIn = useCallback(async () => {
    const pm = profileRef.current?.pendingMove;
    if (!pm) return;
    // Mientras las peticiones sigan vivas, el móvil viejo podría confirmarlas: la llave de este móvil no se borra.
    if (pm.requested && nowSeconds() <= pm.expiresAt) {
      throw new WalletError(t("Las peticiones siguen vivas: espera a que caduquen (como mucho una hora) o confirma en tu otro móvil.", "The requests are still live: wait for them to expire (an hour at most) or confirm on your other phone."));
    }
    const st = await moveStatus({ mirror, w: { vaultId: pm.vaultId, carteraId: pm.carteraId }, newKey: PublicKey.fromStringECDSA(pm.newKey) });
    if (st.vault || st.cartera) {
      throw new WalletError(t("Parte de la wallet ya es de este móvil: no se puede cancelar. Pide otra vez el cambio para terminarlo.", "Part of the wallet already belongs to this phone: it can't be cancelled. Request the change again to finish it."));
    }
    await store.wipeWallet();
    profileRef.current = null;
    setProfile(null);
  }, [store]);

  const moveInFingerprint = useMemo(() => {
    const k = profile?.pendingMove?.newKey;
    if (!k) return null;
    try {
      return moveFingerprint(PublicKey.fromStringECDSA(k), lang());
    } catch {
      return null;
    }
  }, [profile?.pendingMove?.newKey]);

  // ---- Cambio de móvil: lado del móvil VIEJO -------------------------------------------------------------------

  /**
   * Confirma una petición: vuelve a leerla de la red (no se fía de lo visto antes), la firma con la llave de este móvil
   * (Face ID) y, cuando la red refleja que la llave de aquí ya no controla nada, borra la wallet de este móvil.
   */
  const confirmMoveOut = useCallback<WalletCtx["confirmMoveOut"]>(
    async (view) => {
      const p = profileRef.current;
      if (p?.vault?.version !== 2) throw new WalletError(t("No hay bóveda v2.", "There's no v2 vault."));
      const w = await readWalletOnChain({ mirror, vaultId: p.vault.accountId });
      if (!w) throw new WalletError(t("No puedo leer la bóveda en la red.", "I can't read the vault on the network."));
      const found = await findMoveRequests({ mirror, w });
      const req = found.requests.find((r) => rawKey(r.newKey) === view.id);
      if (!req) throw new WalletError(t("Esa petición ya no está: ha caducado o ya se ha hecho.", "That request is gone: it expired or was already done."));
      const { client, key } = await pocketClient();
      try {
        await confirmMove({ client, request: req });
      } finally {
        client.close();
      }
      for (let i = 0; i < 25; i++) {
        const still = await keyStillControls({ mirror, vaultId: w.vaultId, carteraId: w.carteraId, key: key.publicKey }).catch(() => null);
        if (still && !still.vault && !still.cartera) {
          await wipe();
          return { name: req.name };
        }
        await sleep(3000);
      }
      setMovedAway(true);
      throw new WalletError(t("Confirmado. La red tarda en reflejarlo: cuando lo haga, borra la wallet de este móvil desde Inicio.", "Confirmed. The network is slow to show it: once it does, delete the wallet from this phone on Home."));
    },
    [pocketClient, wipe],
  );

  const isV2 = profile?.vault?.version === 2;
  const fees = serviceFees ? { deposit: serviceFees.deposit, withdraw: serviceFees.withdraw } : null;

  const dappLog = useCallback(() => store.loadDappLog(), [store]);
  const addDappLog = useCallback((e: import("@boveda/core").DappLogEntry) => store.addDappLog(e), [store]);

  const value = useMemo<WalletCtx>(
    () => ({
      ready,
      walletId,
      guardianLost,
      dappLog,
      addDappLog,
      staking,
      stakingNodes,
      loadStakingNodes,
      requestStaking,
      collectRewards,
      profile,
      balances,
      tokens,
      nfts,
      vaultTokensOn,
      pocketTokensOn,
      meta,
      movements,
      locks,
      refreshing,
      isV2,
      fees,
      refresh,
      pullRefresh,
      createWallet,
      installFromFriends,
      setupVault,
      newKitWords,
      renameWallet,
      migrateToV2,
      confirmRecovery,
      openPendingKit,
      restartVault,
      send,
      deposit,
      withdraw,
      enableVaultTokens,
      addPocketToken,
      depositNfts,
      withdrawNfts,
      sendNftsFromPocket,
      changeDelays,
      withPocket,
      veto,
      completeNow,
      freezeRecovery,
      evacuate,
      rescue,
      recoverWithKit,
      theftStatus,
      stopTheftMode,
      emailStatus,
      emailStart,
      emailConfirm,
      emailRemove,
      pocketAllowances,
      revokePocketAllowance,
      completeRecovery,
      registerGuardian,
      setH10xAlerts,
      wipe,
      factoryReady,
      moveIn,
      checkMoveIn,
      cancelMoveIn,
      moveInFingerprint,
      moveRequests,
      confirmMoveOut,
      movedAway,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ready, walletId, guardianLost, dappLog, addDappLog, staking, stakingNodes, loadStakingNodes, requestStaking, collectRewards, profile, balances, tokens, nfts, vaultTokensOn, pocketTokensOn, meta, movements, locks, refreshing, isV2, refresh, pullRefresh, createWallet, installFromFriends, setupVault, newKitWords, renameWallet, migrateToV2, confirmRecovery, openPendingKit, restartVault, send, deposit, withdraw, enableVaultTokens, addPocketToken, depositNfts, withdrawNfts, sendNftsFromPocket, changeDelays, withPocket, veto, completeNow, freezeRecovery, evacuate, rescue, recoverWithKit, theftStatus, stopTheftMode, emailStatus, emailStart, emailConfirm, emailRemove, pocketAllowances, revokePocketAllowance, completeRecovery, registerGuardian, setH10xAlerts, wipe, factoryReady, moveIn, checkMoveIn, cancelMoveIn, moveInFingerprint, moveRequests, confirmMoveOut, movedAway],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
