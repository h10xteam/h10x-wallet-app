// WalletConnect (HIP-820) para la sección dApps. Solo la Cartera; las dApps de la lista y, con aviso, otras de
// Hedera con su dominio certificado (core/dapps.js). Cada operación se enseña traducida y se confirma con Face ID.
// También se abre desde fuera: h10xwallet://wc?uri=… y https://h10xindex.xyz/app/wc?uri=… (mismo camino que el QR).
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Linking } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Core } from "@walletconnect/core";
import { WalletKit, type IWalletKit, type WalletKitTypes } from "@reown/walletkit";
import { buildApprovedNamespaces, getSdkError } from "@walletconnect/utils";
import {
  DappError,
  WALLET_LINKS,
  Mirror,
  NETWORKS,
  approvedNamespaces,
  createClient,
  dappById,
  dappForUrl,
  describeDappTransaction,
  executeDappRequest,
  freezeDappRequest,
  hip820Error,
  parseDappRequest,
  printableMessage,
  storageKeys,
  tokenIdsOfBodies,
  vetProposal,
  wcPairingTopic,
  isWcUri,
  mirrorTxId,
  vetRequestOrigin,
  wcUriFromWalletLink,
  type Dapp,
  type DappRequest,
  type TokenInfo,
  type TxDescription,
} from "@boveda/core";
import { CHAIN_ID, NETWORK, requireVerifiedDomain, wcProjectId } from "./env";
import { lang, t } from "./i18n";
import { useWallet } from "./wallet";
import { useWallets } from "./wallets";
import { authenticate } from "./LockGate";

const mirror = new Mirror(NETWORKS[NETWORK].mirror);
// Por red (testnet con el nombre de siempre): las sesiones de testnet no aparecen en la app de mainnet.
const META_KEY = storageKeys(NETWORK).wcSessions;

/** Cómo se comprobó el dominio: por WalletConnect (Verify), porque la abriste en el navegador de H10X Wallet, o sin comprobar. */
export type DappVia = "verify" | "browser" | null;
export type DappSession = { topic: string; dapp: Dapp; verified: boolean; via: DappVia; expiry: number; icon: string | null };

export type Prompt =
  | { kind: "proposal"; id: number; dapp: Dapp; verified: boolean; via: DappVia; warning: string | null; proposal: WalletKitTypes.SessionProposal }
  | { kind: "request"; id: number; topic: string; dapp: Dapp; req: DappRequest; description: TxDescription | null; message: string | null }
  | { kind: "info"; id: number; title: string; message: string };

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type PromptInput = DistOmit<Prompt, "id"> & { id?: number };

type Ctx = {
  /** "off": falta el ID de proyecto; "starting"; "ready"; "error". */
  status: "off" | "starting" | "ready" | "error";
  error: string | null;
  sessions: DappSession[];
  prompt: Prompt | null;
  /** `openedFrom`: la dApp cuya página, abierta en el navegador de H10X Wallet, pidió conectar. */
  pair: (uri: string, opts?: { openedFrom?: string }) => Promise<void>;
  disconnect: (topic: string) => Promise<void>;
  approve: (p: Prompt) => Promise<void>;
  reject: (p: Prompt) => Promise<void>;
};

const WcCtx = createContext<Ctx | null>(null);
export const useDapps = () => {
  const c = useContext(WcCtx);
  if (!c) throw new Error("useDapps fuera de DappsProvider");
  return c;
};

type Meta = Record<string, { dappId: string; verified: boolean; via?: DappVia }>;
const readMeta = async (): Promise<Meta> => {
  try {
    return JSON.parse((await AsyncStorage.getItem(META_KEY)) ?? "{}") as Meta;
  } catch {
    return {};
  }
};
const writeMeta = (m: Meta) => AsyncStorage.setItem(META_KEY, JSON.stringify(m)).catch(() => undefined);

/** Cómo se presenta H10X Wallet ante las dApps (WalletConnect y el navegador interno). */
export const WALLET_META = {
  id: "h10x-wallet",
  name: "H10X Wallet",
  description: "H10X Wallet: a Hedera wallet with a countdown vault",
  url: "https://h10xindex.xyz",
  icon: "https://h10xindex.xyz/icon-512.png",
};

/** dApp de una sesión: la que se aprobó (guardada por H10X Wallet), y solo si la web de la sesión no dice ser otra de la lista. */
const sessionDapp = (meta: Meta[string] | undefined, peerUrl: string | undefined): Dapp | null => {
  const dapp = meta ? dappById(meta.dappId) : null;
  if (!dapp) return null;
  const claimed = dappForUrl(peerUrl);
  return claimed && claimed.id !== dapp.id ? null : dapp;
};

let kitPromise: Promise<IWalletKit> | null = null;
/** WalletKit único para toda la app. */
function getKit(projectId: string): Promise<IWalletKit> {
  if (!kitPromise) {
    kitPromise = WalletKit.init({
      core: new Core({ projectId }),
      metadata: { name: WALLET_META.name, description: WALLET_META.description, url: WALLET_META.url, icons: [WALLET_META.icon], redirect: { native: WALLET_LINKS.native, universal: WALLET_LINKS.universal } },
    }).catch((e) => {
      kitPromise = null;
      throw e;
    });
  }
  return kitPromise;
}

/** Un enlace de WalletConnect v2 (wc:…@2?…symKey=…). */
export { isWcUri };

/** ¿Es la sesión de esta cuenta? (0.10: con varias wallets, cada sesión es de la Cartera con la que se aprobó). */
const sessionAccounts = (s: { namespaces: Record<string, { accounts?: string[] }> }) => s.namespaces.hedera?.accounts ?? [];

export function DappsProvider({ children }: { children: React.ReactNode }) {
  const { profile, withPocket, refresh, addDappLog } = useWallet();
  const { wallets } = useWallets();
  // Cuentas de las otras wallets de este móvil: sus sesiones se dejan (se ven al volver a esa wallet); las de una cuenta
  // que ya no está en el móvil (p. ej. una wallet borrada) se cortan.
  const otherAccounts = useRef<Set<string>>(new Set());
  otherAccounts.current = new Set(wallets.map((w) => w.pocket).filter((x): x is string => !!x && /^0\.0\.\d+$/.test(x)));
  const walletsKnown = useRef(false);
  walletsKnown.current = wallets.length > 0;
  const accountId = profile?.pocket.accountId ?? null;
  const vaultId = profile?.vault?.accountId ?? null;
  const [status, setStatus] = useState<Ctx["status"]>(wcProjectId ? "starting" : "off");
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<DappSession[]>([]);
  const [queue, setQueue] = useState<Prompt[]>([]);
  const kitRef = useRef<IWalletKit | null>(null);
  const accountRef = useRef<string | null>(accountId);
  accountRef.current = accountId;
  const vaultRef = useRef<string | null>(vaultId);
  vaultRef.current = vaultId;
  // El notario de la bóveda: una dApp nunca puede llamarlo (la Cartera es el «móvil» de la bóveda).
  const notaryRef = useRef<string | null>(profile?.vault?.notaryId ?? null);
  notaryRef.current = profile?.vault?.notaryId ?? null;
  const seq = useRef(1);
  /** Emparejamientos pedidos desde el navegador interno: tema → dApp de la página que lo pidió. */
  const browserPairs = useRef(new Map<string, { dappId: string; at: number }>());

  const push = useCallback((p: PromptInput) => setQueue((q) => [...q, { ...p, id: p.id ?? seq.current++ } as Prompt]), []);
  const info = useCallback((title: string, message: string) => push({ kind: "info", title, message }), [push]);
  const done = useCallback((p: Prompt) => setQueue((q) => q.filter((x) => !(x.kind === p.kind && x.id === p.id))), []);

  const loadSessions = useCallback(async () => {
    const kit = kitRef.current;
    if (!kit) return;
    const meta = await readMeta();
    const out: DappSession[] = [];
    const mine = accountRef.current ? `${CHAIN_ID}:${accountRef.current}` : null;
    for (const s of Object.values(kit.getActiveSessions())) {
      const accounts = sessionAccounts(s);
      if (!mine || !accounts.includes(mine)) {
        // De otra wallet de este móvil: se deja para cuando se vuelva a ella. De una cuenta que ya no está aquí: se corta.
        const owner = accounts.map((a) => a.split(":").pop() ?? "").find((a) => otherAccounts.current.has(a));
        if (!owner && walletsKnown.current && mine) void kit.disconnectSession({ topic: s.topic, reason: getSdkError("USER_DISCONNECTED") }).catch(() => undefined);
        continue;
      }
      const m = meta[s.topic];
      const dapp = sessionDapp(m, s.peer.metadata.url);
      if (!dapp) {
        // Una sesión que H10X Wallet no aprobó (o que ahora dice ser otra dApp de la lista): se corta.
        void kit.disconnectSession({ topic: s.topic, reason: getSdkError("UNSUPPORTED_ACCOUNTS") }).catch(() => undefined);
        continue;
      }
      out.push({ topic: s.topic, dapp, verified: !!m?.verified, via: m?.via ?? (m?.verified ? "verify" : null), expiry: s.expiry, icon: s.peer.metadata.icons?.find((i) => i.startsWith("https://")) ?? null });
    }
    setSessions(out);
  }, []);

  // ---- propuestas de conexión -----------------------------------------------------------------
  const onProposal = useCallback(
    (proposal: WalletKitTypes.SessionProposal) => {
      const kit = kitRef.current;
      if (!kit) return;
      const refuse = (title: string, message: string) => {
        void kit.rejectSession({ id: proposal.id, reason: getSdkError("USER_REJECTED") }).catch(() => undefined);
        info(title, message);
      };
      if (!accountRef.current) return refuse(t("No se puede conectar", "Can't connect"), t("Tu Cartera todavía no existe en la red.", "Your Wallet doesn't exist on the network yet."));
      const p = proposal.params;
      // ¿La pidió una página abierta en el navegador de H10X Wallet? (solo vale unos minutos)
      const fromBrowser = browserPairs.current.get(p.pairingTopic);
      const openedFrom = fromBrowser && Date.now() - fromBrowser.at < 10 * 60_000 ? fromBrowser.dappId : null;
      const vet = vetProposal({
        verifyContext: proposal.verifyContext,
        metadataUrl: p.proposer.metadata.url,
        metadataName: p.proposer.metadata.name,
        requiredNamespaces: p.requiredNamespaces,
        optionalNamespaces: p.optionalNamespaces,
        chainId: CHAIN_ID,
        openedFrom,
        requireVerified: requireVerifiedDomain,
        lang: lang(),
      });
      if (!vet.ok) return refuse(t("Conexión rechazada", "Connection refused"), vet.message);
      push({ kind: "proposal", id: proposal.id, dapp: vet.dapp, verified: vet.verified, via: vet.via, warning: vet.warning, proposal });
    },
    [info, push],
  );

  // ---- peticiones -----------------------------------------------------------------------------
  const respondError = useCallback(async (topic: string, id: number, message: string, code = 9000) => {
    await kitRef.current?.respondSessionRequest({ topic, response: { id, jsonrpc: "2.0", error: { code, message } } }).catch(() => undefined);
  }, []);

  const onRequest = useCallback(
    async (event: WalletKitTypes.SessionRequest) => {
      const kit = kitRef.current;
      if (!kit) return;
      const { topic, id, params, verifyContext } = event;
      const meta = (await readMeta())[topic];
      const session = kit.getActiveSessions()[topic];
      const dapp = session ? sessionDapp(meta, session.peer.metadata.url) : null;
      const account = accountRef.current;
      if (!meta || !dapp || !account) return respondError(topic, id, "Session not allowed");
      // 0.10: la sesión se aprobó con otra de tus wallets: esta no firma por ella.
      if (!session || !sessionAccounts(session).includes(`${CHAIN_ID}:${account}`)) {
        await respondError(topic, id, "Session not allowed");
        return info(t(`${dapp.name}: petición rechazada`, `${dapp.name}: request refused`), t("Esa dApp está conectada a otra de tus wallets. Ábrela para usarla.", "That dApp is connected to another of your wallets. Open it to use it."));
      }
      if (!vetRequestOrigin({ verifyContext, dappId: dapp.id })) {
        await respondError(topic, id, "Origin mismatch");
        return info(t("Petición rechazada", "Request refused"), t(`Una petición decía venir de ${dapp.name} pero llegaba desde otra web.`, `A request claimed to come from ${dapp.name} but came from another site.`));
      }
      let req: DappRequest;
      try {
        req = parseDappRequest({ method: params.request.method, params: params.request.params, chainId: params.chainId, accountId: account });
        if (params.chainId !== CHAIN_ID) throw new DappError("wrong_network", t("La petición es de otra red.", "The request is for another network."));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await respondError(topic, id, msg);
        return info(t(`${dapp.name}: petición rechazada`, `${dapp.name}: request refused`), msg);
      }
      // Lo que no necesita firma se contesta solo.
      if (req.method === "hedera_getNodeAddresses") {
        const client = createClient(NETWORK, null);
        try {
          const result = await executeDappRequest(req, { client, key: undefined as never });
          await kit.respondSessionRequest({ topic, response: { id, jsonrpc: "2.0", result } });
        } finally {
          client.close();
        }
        return;
      }
      let description: TxDescription | null = null;
      let message: string | null = null;
      try {
        if (req.method === "hedera_signMessage") {
          message = printableMessage(req.message);
        } else {
          const client = createClient(NETWORK, null);
          try {
            req = freezeDappRequest(req, client, account);
          } finally {
            client.close();
          }
          const metaMap: Record<string, TokenInfo> = {};
          for (const tid of tokenIdsOfBodies(req.bodies)) {
            const ti = await mirror.tokenInfo(tid).catch(() => null);
            if (ti) metaMap[tid] = ti;
          }
          description = describeDappTransaction(req.bodies[0], { account, vaultId: vaultRef.current, notaryId: notaryRef.current, meta: (x) => metaMap[x], lang: lang() });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await respondError(topic, id, msg);
        return info(t(`${dapp.name}: petición rechazada`, `${dapp.name}: request refused`), msg);
      }
      if (description?.blocked) {
        await respondError(topic, id, "Blocked by H10X Wallet");
        return info(t(`${dapp.name}: bloqueado`, `${dapp.name}: blocked`), description.blocked);
      }
      push({ kind: "request", id, topic, dapp, req, description, message });
    },
    [info, push, respondError],
  );

  // ---- arranque (una sola vez por proceso: WalletConnect no admite dos núcleos) ----------------------
  const handlers = useRef({ onProposal, onRequest, loadSessions });
  handlers.current = { onProposal, onRequest, loadSessions };
  const hasAccount = !!accountId;
  useEffect(() => {
    if (!wcProjectId || !hasAccount) return;
    let cancelled = false;
    // 0.10: el WalletKit es uno para toda la app y esta pantalla se monta otra vez al cambiar de wallet. Sus oyentes se
    // quitan al desmontarla: si no, los de la wallet anterior seguirían contestando (y rechazando) con su cuenta.
    let detach: (() => void) | null = null;
    (async () => {
      try {
        setStatus("starting");
        const kit = await getKit(wcProjectId);
        if (cancelled) return;
        if (kitRef.current !== kit) {
          kitRef.current = kit;
          const onProposalEvent = (e: WalletKitTypes.SessionProposal) => handlers.current.onProposal(e);
          const onRequestEvent = (e: WalletKitTypes.SessionRequest) => void handlers.current.onRequest(e);
          const onDeleteEvent = () => void handlers.current.loadSessions();
          kit.on("session_proposal", onProposalEvent);
          kit.on("session_request", onRequestEvent);
          kit.on("session_delete", onDeleteEvent);
          detach = () => {
            kit.off("session_proposal", onProposalEvent);
            kit.off("session_request", onRequestEvent);
            kit.off("session_delete", onDeleteEvent);
          };
        }
        setStatus("ready");
        await handlers.current.loadSessions();
      } catch (e) {
        if (!cancelled) {
          setStatus("error");
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
      detach?.();
      kitRef.current = null;
    };
  }, [hasAccount]);

  // Si cambia la Cartera de ESTA wallet, sus sesiones antiguas se cortan (apuntaban a la cuenta anterior). Las de las
  // otras wallets del móvil no se tocan.
  const prevAccount = useRef<string | null>(accountId);
  useEffect(() => {
    const kit = kitRef.current;
    const prev = prevAccount.current;
    prevAccount.current = accountId;
    if (!kit || !accountId || !prev || prev === accountId) return;
    for (const s of Object.values(kit.getActiveSessions())) {
      if (sessionAccounts(s).includes(`${CHAIN_ID}:${prev}`)) void kit.disconnectSession({ topic: s.topic, reason: getSdkError("USER_DISCONNECTED") }).catch(() => undefined);
    }
    void loadSessions();
  }, [accountId, loadSessions]);

  const pair = useCallback(async (uri: string, opts?: { openedFrom?: string }) => {
    const kit = kitRef.current;
    if (!kit) throw new Error(t("WalletConnect no está listo todavía.", "WalletConnect isn't ready yet."));
    const clean = uri.trim();
    const topic = wcPairingTopic(clean);
    if (!topic || !isWcUri(clean)) throw new Error(t("Ese enlace no es de WalletConnect (empieza por «wc:»).", "That isn't a WalletConnect link (it starts with “wc:”)."));
    if (opts?.openedFrom) browserPairs.current.set(topic, { dappId: opts.openedFrom, at: Date.now() });
    // El mismo enlace dos veces (la dApp lo manda por dos caminos): basta con el primero.
    if (kit.core.pairing.getPairings().some((p) => p.topic === topic)) return;
    await kit.pair({ uri: clean });
  }, []);

  // Enlaces que abren la app para conectar: se guardan hasta que WalletConnect está listo (con la Cartera ya creada)
  // y siguen el mismo camino que el QR. Solo los enlaces propios (wcUriFromWalletLink); los demás no hacen nada.
  const [linkUri, setLinkUri] = useState<string | null>(null);
  useEffect(() => {
    const take = (url: string | null | undefined) => {
      const uri = wcUriFromWalletLink(url);
      if (uri) setLinkUri(uri);
    };
    void Linking.getInitialURL().then(take).catch(() => undefined);
    const sub = Linking.addEventListener("url", ({ url }) => take(url));
    return () => sub.remove();
  }, []);
  useEffect(() => {
    if (!linkUri || status !== "ready" || !kitRef.current) return;
    const uri = linkUri;
    setLinkUri(null);
    pair(uri).catch((e) => info(t("No se pudo conectar", "Could not connect"), e instanceof Error ? e.message : String(e)));
  }, [linkUri, status, pair, info]);

  const disconnect = useCallback(
    async (topic: string) => {
      await kitRef.current?.disconnectSession({ topic, reason: getSdkError("USER_DISCONNECTED") }).catch(() => undefined);
      const meta = await readMeta();
      delete meta[topic];
      await writeMeta(meta);
      await loadSessions();
    },
    [loadSessions],
  );

  const approve = useCallback(
    async (p: Prompt) => {
      const kit = kitRef.current;
      try {
        if (!kit) throw new Error(t("WalletConnect no está listo.", "WalletConnect isn't ready."));
        if (p.kind === "info") return;
        const account = accountRef.current;
        if (!account) throw new Error(t("No hay Cartera.", "There is no Wallet."));
        if (p.kind === "proposal") {
          const namespaces = buildApprovedNamespaces({ proposal: p.proposal.params, supportedNamespaces: approvedNamespaces({ chainId: CHAIN_ID, accountId: account }) });
          const session = await kit.approveSession({ id: p.id, namespaces });
          const meta = await readMeta();
          meta[session.topic] = { dappId: p.dapp.id, verified: p.verified, via: p.via };
          await writeMeta(meta);
          await loadSessions();
          return;
        }
        // Firmar: siempre con Face ID (o el código del iPhone), aunque la app ya esté desbloqueada.
        const ok = await authenticate(t(`Firmar para ${p.dapp.name}`, `Sign for ${p.dapp.name}`));
        if (!ok) return;
        try {
          const result = await withPocket(({ client, key }) => executeDappRequest(p.req, { client, key }));
          await kit.respondSessionRequest({ topic: p.topic, response: { id: p.id, jsonrpc: "2.0", result } });
          // 0.10: el historial dice para qué dApp se firmó cada cosa (el mensaje firmado no tiene transacción).
          const executed = (result as { transactionId?: unknown } | null)?.transactionId;
          const body = "bodies" in p.req ? p.req.bodies[0] : null;
          void addDappLog({ at: Math.floor(Date.now() / 1000), dapp: p.dapp.name, method: p.req.method, txId: mirrorTxId(executed) ?? mirrorTxId(body?.transactionID) });
          setTimeout(() => void refresh(), 4000);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const status = /([A-Z_]{6,})/.exec(msg)?.[1] ?? "UNKNOWN";
          await kit.respondSessionRequest({ topic: p.topic, response: { id: p.id, jsonrpc: "2.0", error: hip820Error(status) } }).catch(() => undefined);
          throw e;
        }
      } finally {
        done(p);
      }
    },
    [addDappLog, done, loadSessions, refresh, withPocket],
  );

  const reject = useCallback(
    async (p: Prompt) => {
      const kit = kitRef.current;
      try {
        if (!kit || p.kind === "info") return;
        if (p.kind === "proposal") await kit.rejectSession({ id: p.id, reason: getSdkError("USER_REJECTED") });
        else await kit.respondSessionRequest({ topic: p.topic, response: { id: p.id, jsonrpc: "2.0", error: getSdkError("USER_REJECTED") } });
      } catch {
        // la dApp ya se fue: nada que contestar
      } finally {
        done(p);
      }
    },
    [done],
  );

  const value = useMemo<Ctx>(
    () => ({ status: wcProjectId ? (accountId ? status : "starting") : "off", error, sessions, prompt: queue[0] ?? null, pair, disconnect, approve, reject }),
    [status, error, sessions, queue, pair, disconnect, approve, reject, accountId],
  );
  return <WcCtx.Provider value={value}>{children}</WcCtx.Provider>;
}
