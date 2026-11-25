// «Amigos de confianza» (DeRec) de la wallet abierta: el motor del núcleo (core/src/derec) con el SDK nativo, el
// llavero del móvil y el buzón HCS. Mira el buzón a menudo mientras hay algo a medias o una pantalla de DeRec abierta
// (cada 3 s), de vez en cuando si la wallet usa DeRec (cada minuto) y al volver a la app.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { AccountId } from "@hiero-ledger/sdk";
import { DerecDevice, Mirror, NETWORKS, derecThreshold, hcsInbox, hcsTransport, inboxUri, type PendingApproval } from "@boveda/core";
import { NETWORK } from "../env";
import { t } from "../i18n";
import { useWallet } from "../wallet";
import { derecSdk } from "./sdk";
import { secureKV, type DerecKV } from "./kv";
import { deleteMailbox, ensureInboxTopic, findFundedMailbox, fundMailboxFromPocket, loadMailbox, mailboxClient, mailboxEvm, mailboxOrNew, topUpMailbox, type MailboxInfo } from "./mailbox";

const mirror = new Mirror(NETWORKS[NETWORK].mirror);
const SUPPORTED = NETWORK === "mainnet" || NETWORK === "testnet" || NETWORK === "previewnet";
const te = new TextEncoder();
const td = new TextDecoder();

export type FriendLight = "green" | "amber" | "red";
export type FriendView = { channelId: string; name: string; pairedAt: number; light: FriendLight; checkedAt: number | null };
export type HelpedView = { channelId: string; name: string; secretId: string; pairedAt: number; version: number | null };
export type Shared = { version: number; confirmed: number; failed: number; met: boolean; at: number } | null;
export type Recovered = { cartera: Uint8Array; perfil: Uint8Array; secret: unknown; secretId: string; version: number };

type Ctx = {
  /** El SDK nativo está (no es Expo Go) y la red lo admite. */
  available: boolean;
  ready: boolean;
  name: string;
  setName: (n: string) => Promise<void>;
  mailbox: { evm: string; accountId: string | null; topicId: string | null; balance: bigint | null } | null;
  /** Activa el buzón con HBAR de la Cartera (pide Face ID una vez). */
  activate: () => Promise<void>;
  /** Móvil nuevo (sin Cartera): mira si alguien ya mandó HBAR a la dirección del buzón y lo deja listo. */
  activateFunded: () => Promise<boolean>;
  topUp: () => Promise<void>;
  shared: Shared;
  friends: FriendView[];
  helping: HelpedView[];
  approvals: PendingApproval[];
  ownerCode: () => Promise<string>;
  helperCode: (forOwnerChannel?: string, version?: number | null) => Promise<string>;
  /** Escanea o pega un código. `as`: el papel de este móvil (dueño o ayudante). */
  scan: (text: string, as: "owner" | "helper", forOwnerChannel?: string) => Promise<{ name: string; purpose: string; secretId?: string; version?: number }>;
  protect: () => Promise<void>;
  verify: () => Promise<void>;
  answer: (id: string, yes: boolean) => Promise<void>;
  fingerprint: (channelId: string) => Promise<string>;
  recover: (secretId: string, version: number) => Promise<void>;
  /** Tras instalar la wallet recuperada: este móvil se queda como dueño y vuelve a repartir. */
  adopt: (r: Recovered) => Promise<void>;
  /** Lo que llega al recuperar (lo recoge la pantalla de recuperación). */
  recovered: Recovered | null;
  recoveryOutcome: string | null;
  /** Móvil nuevo: de qué secreto y versión es la recuperación (sale del primer código de recuperación escaneado). */
  recoveryTarget: { secretId: string; version: number } | null;
  /** Pantalla de DeRec abierta: mirar el buzón cada 3 s. */
  focus: (on: boolean) => void;
  pumpNow: () => Promise<void>;
  /** Empieza de cero (móvil nuevo que va a recuperar). */
  reset: () => Promise<void>;
  error: string | null;
};

const DerecCtx = createContext<Ctx | null>(null);

export const useDerec = () => {
  const c = useContext(DerecCtx);
  if (!c) throw new Error("useDerec fuera de DerecProvider");
  return c;
};

const J = (o: unknown) => te.encode(JSON.stringify(o));
const P = <T,>(b: Uint8Array | null): T | null => (b ? (JSON.parse(td.decode(b)) as T) : null);

export function DerecProvider({ children }: { children: React.ReactNode }) {
  const { walletId, profile, withPocket } = useWallet();
  const sdk = SUPPORTED ? derecSdk() : null;
  const available = !!sdk;
  const [kv, setKv] = useState<(DerecKV & { wipe(): Promise<void> }) | null>(null);
  const [mb, setMb] = useState<MailboxInfo | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [name, setNameState] = useState("");
  const [shared, setShared] = useState<Shared>(null);
  const [friends, setFriends] = useState<FriendView[]>([]);
  const [helping, setHelping] = useState<HelpedView[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [recovered, setRecovered] = useState<Recovered | null>(null);
  const [recoveryOutcome, setRecoveryOutcome] = useState<string | null>(null);
  const [recoveryTarget, setRecoveryTarget] = useState<{ secretId: string; version: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(0);
  const deviceRef = useRef<DerecDevice | null>(null);
  const pumping = useRef(false);
  const recoverRef = useRef<{ secretId: string; version: number } | null>(null);

  // Zona del llavero y buzón de esta wallet.
  useEffect(() => {
    if (!available) return;
    let alive = true;
    void (async () => {
      const z = await secureKV(`derec_${NETWORK}_${walletId}`);
      const m = await loadMailbox(walletId);
      const n = P<{ name: string }>(await z.get("me/name"))?.name ?? profile?.name ?? "";
      if (!alive) return;
      setKv(z);
      setMb(m);
      setNameState(n);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, walletId]);

  // El motor existe cuando el buzón tiene cuenta y topic. Cambia si cambia el nombre (es lo que ven los amigos).
  useEffect(() => {
    deviceRef.current?.close();
    deviceRef.current = null;
    if (!sdk || !kv || !mb?.accountId || !mb.topicId) return;
    const client = mailboxClient(mb);
    deviceRef.current = new DerecDevice({
      sdk,
      kv,
      transport: hcsTransport({ client, network: NETWORK }),
      inbox: hcsInbox({ mirrorBase: NETWORKS[NETWORK].mirror, topicId: mb.topicId, kv }),
      ownUri: inboxUri(NETWORK, mb.topicId),
      network: NETWORK,
      name: name || t("Amigo de H10X", "H10X friend"),
    });
    return () => {
      deviceRef.current?.close();
      deviceRef.current = null;
      client.close();
    };
  }, [sdk, kv, mb, name]);

  const need = useCallback(() => {
    const d = deviceRef.current;
    if (!d) throw new Error(t("Primero activa tu buzón de amigos.", "Activate your friends mailbox first."));
    return d;
  }, []);

  const reload = useCallback(async () => {
    const d = deviceRef.current;
    if (!d || !kv) return;
    const st = await d.ownerStatus();
    setShared(st.shared);
    setFriends(st.friends);
    const list: HelpedView[] = [];
    for (const h of await d.helping()) {
      const ow = P<{ version?: number | null }>(await kv.get(`ow/${h.channelId}`));
      list.push({ ...h, version: ow?.version ?? null });
    }
    setHelping(list);
    setApprovals(await d.pendingApprovals());
    const rt = await d.recoveryTarget();
    setRecoveryTarget(rt);
    if (rt && !recoverRef.current) recoverRef.current = rt;
  }, [kv]);

  const refreshBalance = useCallback(async () => {
    if (!mb?.accountId) return setBalance(null);
    const acc = await mirror.account(mb.accountId).catch(() => null);
    setBalance(acc?.balance ?? null);
  }, [mb]);

  /** Mira el buzón una vez y reparte lo que llega. */
  const pumpNow = useCallback(async () => {
    const d = deviceRef.current;
    if (!d || pumping.current) return;
    pumping.current = true;
    try {
      const evs = await d.pump();
      for (const e of evs) {
        const ev = e as { type?: string; secret?: { secrets?: { name?: string; data?: Uint8Array }[] } };
        if (ev.type === "SecretRecovered" && recoverRef.current) {
          const secrets = ev.secret?.secrets ?? [];
          const cartera = secrets.find((x) => x?.name === "cartera")?.data;
          const perfil = secrets.find((x) => x?.name === "perfil")?.data;
          if (cartera && perfil) setRecovered({ cartera, perfil, secret: ev.secret, ...recoverRef.current });
        }
        if (ev.type === "RecoveryIncomplete") setRecoveryOutcome(t("Aún no hay suficientes partes: pide ayuda a otro amigo.", "Not enough shares yet: ask another friend for help."));
        if (ev.type === "RecoveryDisputed" || ev.type === "RecoveryConflict") setRecoveryOutcome(t("Las partes no coinciden. No se ha recuperado nada: avisa a tus amigos.", "The shares don't match. Nothing was recovered: tell your friends."));
      }
      await reload();
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      pumping.current = false;
    }
  }, [reload]);

  // Ritmo: 3 s con una pantalla abierta o algo a medias; 60 s si la wallet usa DeRec; nada si nunca se activó.
  useEffect(() => {
    if (!available) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const loop = async () => {
      const d = deviceRef.current;
      let next = 60_000;
      if (d) {
        const busy = focused > 0 || (await d.busy().catch(() => false));
        const active = busy || (await d.active().catch(() => false));
        if (active) await pumpNow();
        next = busy ? 3000 : 60_000;
      }
      if (alive) timer = setTimeout(() => void loop(), next);
    };
    void loop();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void pumpNow();
    });
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      sub.remove();
    };
  }, [available, focused, pumpNow, mb, kv]);

  useEffect(() => {
    void refreshBalance();
    void reload();
  }, [refreshBalance, reload, mb]);

  const setName = useCallback(
    async (n: string) => {
      const clean = n.trim().slice(0, 40);
      if (!kv) return;
      await kv.set("me/name", J({ name: clean }));
      setNameState(clean);
    },
    [kv],
  );

  const activate = useCallback(async () => {
    if (!profile?.pocket.accountId) throw new Error(t("Tu Cartera aún no tiene cuenta en la red.", "Your Wallet doesn't have an account on the network yet."));
    let m = await mailboxOrNew(walletId);
    if (!m.accountId) m = await withPocket(({ client }) => fundMailboxFromPocket(walletId, client));
    m = await ensureInboxTopic(walletId, m);
    setMb(m);
  }, [profile, walletId, withPocket]);

  const activateFunded = useCallback(async () => {
    let m = await findFundedMailbox(walletId, mirror);
    if (!m) {
      setMb(await mailboxOrNew(walletId));
      return false;
    }
    m = await ensureInboxTopic(walletId, m);
    setMb(m);
    return true;
  }, [walletId]);

  const topUp = useCallback(async () => {
    const m = mb;
    if (!m?.accountId) return;
    await withPocket(({ client, accountId }) => topUpMailbox(m, client, AccountId.fromString(accountId.toString())));
    await refreshBalance();
  }, [mb, withPocket, refreshBalance]);

  const ownerCode = useCallback(async () => need().ownerCode(), [need]);
  const helperCode = useCallback(async (forOwnerChannel?: string, version?: number | null) => need().helperCode({ ...(forOwnerChannel ? { forOwnerChannel } : {}), ...(version ? { version } : {}) }), [need]);

  const scan = useCallback<Ctx["scan"]>(
    async (text, as, forOwnerChannel) => {
      const d = need();
      const r = as === "owner" ? await d.ownerScan(text) : await d.helperScan(text, forOwnerChannel ? { forOwnerChannel } : {});
      if (r.code.purpose === "recover" && as === "owner") {
        recoverRef.current = await d.recoveryTarget();
        setRecoveryTarget(recoverRef.current);
      }
      setFocused((f) => f + 1);
      setTimeout(() => setFocused((f) => Math.max(0, f - 1)), 15 * 60_000);
      void pumpNow();
      return { name: r.code.name, purpose: r.code.purpose, ...(r.code.secretId ? { secretId: r.code.secretId } : {}), ...(r.code.version ? { version: r.code.version } : {}) };
    },
    [need, pumpNow],
  );

  /** Lo que se reparte: la llave de la Cartera (32 bytes) y el perfil de la wallet (sin nada secreto). */
  const protect = useCallback(async () => {
    const d = need();
    if (!profile) throw new Error(t("No hay wallet en este móvil.", "There's no wallet on this phone."));
    const n = friends.length;
    if (n < 2) throw new Error(t("Hacen falta al menos 2 amigos (mejor 3).", "You need at least 2 friends (3 is better)."));
    const perfil = te.encode(JSON.stringify({ v: 1, profile: { ...profile, pendingMove: undefined, pendingRecovery: undefined, kitPending: undefined } }));
    await withPocket(async ({ key }) => {
      await d.protect({ cartera: key.toBytesRaw(), perfil, threshold: derecThreshold(n), description: "H10X Wallet" });
    });
    setFocused((f) => f + 1);
    setTimeout(() => setFocused((f) => Math.max(0, f - 1)), 5 * 60_000);
    void pumpNow();
  }, [need, profile, friends.length, withPocket, pumpNow]);

  const verify = useCallback(async () => {
    const d = need();
    if (!shared?.version) throw new Error(t("Aún no has repartido nada.", "You haven't shared anything yet."));
    await d.verify(shared.version);
    void pumpNow();
  }, [need, shared, pumpNow]);

  const answer = useCallback(
    async (id: string, yes: boolean) => {
      await need().answer(id, yes);
      await reload();
    },
    [need, reload],
  );

  const fingerprint = useCallback(async (channelId: string) => need().fingerprintFor(channelId), [need]);

  const recover = useCallback(
    async (secretId: string, version: number) => {
      recoverRef.current = { secretId, version };
      setRecoveryOutcome(null);
      await need().recover(secretId, version);
      setFocused((f) => f + 1);
      void pumpNow();
    },
    [need, pumpNow],
  );

  const adopt = useCallback(
    async (r: Recovered) => {
      const d = need();
      await d.adopt(r.secret, r.secretId, r.version);
      await pumpNow();
      // Se vuelve a repartir enseguida (versión nueva): las partes viejas dejan de valer.
      const n = (await d.friends()).length;
      if (n >= 2) await d.protect({ cartera: r.cartera, perfil: r.perfil, threshold: derecThreshold(n), description: "H10X Wallet" }).catch(() => undefined);
      setRecovered(null);
      recoverRef.current = null;
      setFocused((f) => Math.max(0, f - 1));
      void pumpNow();
    },
    [need, pumpNow],
  );

  const reset = useCallback(async () => {
    deviceRef.current?.close();
    deviceRef.current = null;
    if (kv) await kv.wipe();
    await deleteMailbox(walletId);
    setMb(null);
    setFriends([]);
    setHelping([]);
    setApprovals([]);
    setShared(null);
    setRecovered(null);
    setRecoveryTarget(null);
    recoverRef.current = null;
  }, [kv, walletId]);

  const focus = useCallback((on: boolean) => setFocused((f) => Math.max(0, f + (on ? 1 : -1))), []);

  const value = useMemo<Ctx>(
    () => ({
      available,
      ready: !!kv,
      name,
      setName,
      mailbox: mb ? { evm: mailboxEvm(mb), accountId: mb.accountId, topicId: mb.topicId, balance } : null,
      activate,
      activateFunded,
      topUp,
      shared,
      friends,
      helping,
      approvals,
      ownerCode,
      helperCode,
      scan,
      protect,
      verify,
      answer,
      fingerprint,
      recover,
      adopt,
      recovered,
      recoveryOutcome,
      recoveryTarget,
      focus,
      pumpNow,
      reset,
      error,
    }),
    [available, kv, name, setName, mb, balance, activate, activateFunded, topUp, shared, friends, helping, approvals, ownerCode, helperCode, scan, protect, verify, answer, fingerprint, recover, adopt, recovered, recoveryOutcome, recoveryTarget, focus, pumpNow, reset, error],
  );
  return <DerecCtx.Provider value={value}>{children}</DerecCtx.Provider>;
}
