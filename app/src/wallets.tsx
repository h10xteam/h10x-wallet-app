// Varias wallets en la misma app (0.10). Cada una es lo de siempre (Cartera + bóveda + notario + kit, y su registro en
// el guardián) y guarda lo suyo aparte (storage.ts → walletStorage). Al cambiar de wallet, App.tsx monta de cero todo
// lo que depende de ella (WalletProvider con key): nada de lo que esté a medias en una puede escribir en otra.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import * as Notifications from "expo-notifications";
import { MAX_WALLETS, addWallet, nowSeconds, removeWallet, selectWallet, type WalletRegistry } from "@boveda/core";
import { isExpoGo } from "./env";
import { loadRegistry, saveRegistry, walletStorage } from "./storage";

/** Lo que se enseña de cada wallet en la lista (sin pedir Face ID: solo el perfil, que no es secreto). */
export type WalletSummary = { id: string; name: string | null; vaultId: string | null; pocket: string | null; empty: boolean };

type Ctx = {
  ready: boolean;
  /** La wallet que está abierta. */
  active: string;
  wallets: WalletSummary[];
  canAdd: boolean;
  /** Añade una wallet vacía y la abre (empieza por la bienvenida). */
  add: () => Promise<void>;
  /** Abre otra wallet. Una wallet vacía de la que se sale se quita de la lista (no hay nada que perder). */
  select: (id: string) => Promise<void>;
  /** Quita de la lista una wallet que no tiene nada guardado (sin perfil). */
  removeEmpty: (id: string) => Promise<void>;
  /** La wallet abierta se ha borrado de este móvil (wipe): se quita de la lista y se abre otra. */
  removeActive: () => Promise<void>;
  /** Vuelve a leer nombres y cuentas (p. ej. tras crear la bóveda o renombrar). */
  reload: () => Promise<void>;
};

const WalletsCtx = createContext<Ctx | null>(null);

export const useWallets = () => {
  const c = useContext(WalletsCtx);
  if (!c) throw new Error("useWallets fuera de WalletsProvider");
  return c;
};

async function summarize(reg: WalletRegistry): Promise<WalletSummary[]> {
  const out: WalletSummary[] = [];
  for (const w of reg.wallets) {
    const p = await walletStorage(w.id)
      .loadProfile()
      .catch(() => null);
    out.push({ id: w.id, name: p?.name ?? null, vaultId: p?.vault?.accountId ?? null, pocket: p ? (p.pocket.accountId ?? p.pocket.evmAddress) : null, empty: !p });
  }
  return out;
}

export function WalletsProvider({ children }: { children: React.ReactNode }) {
  const [registry, setRegistry] = useState<WalletRegistry | null>(null);
  const [wallets, setWallets] = useState<WalletSummary[]>([]);
  const regRef = useRef<WalletRegistry | null>(null);

  const apply = useCallback(async (next: WalletRegistry, save = true) => {
    if (save) await saveRegistry(next);
    // La lista primero y luego las dos cosas a la vez: quien monte la wallet abierta ya ve todas (dApps lo necesita).
    const list = await summarize(next);
    regRef.current = next;
    setWallets(list);
    setRegistry(next);
  }, []);

  useEffect(() => {
    void loadRegistry().then((r) => apply(r, false));
  }, [apply]);

  const reload = useCallback(async () => {
    const r = regRef.current;
    if (r) setWallets(await summarize(r));
  }, []);

  const add = useCallback(async () => {
    const r = regRef.current;
    if (!r) return;
    await apply(addWallet(r, nowSeconds()).registry);
  }, [apply]);

  const select = useCallback(
    async (id: string) => {
      let r = regRef.current;
      if (!r || r.active === id) return;
      // La que se deja, si está vacía (se añadió y no se llegó a crear nada), sobra.
      const leaving = r.active;
      const empty = !(await walletStorage(leaving)
        .loadProfile()
        .catch(() => null));
      r = selectWallet(r, id);
      if (empty) r = removeWallet(r, leaving, nowSeconds());
      await apply(r);
    },
    [apply],
  );

  const removeEmpty = useCallback(
    async (id: string) => {
      const r = regRef.current;
      if (!r || !r.wallets.some((w) => w.id === id)) return;
      const p = await walletStorage(id)
        .loadProfile()
        .catch(() => null);
      if (p) return; // con algo guardado, solo se quita borrándola desde sus Ajustes
      await apply(removeWallet(r, id, nowSeconds()));
    },
    [apply],
  );

  const removeActive = useCallback(async () => {
    const r = regRef.current;
    if (!r) return;
    await apply(removeWallet(r, r.active, nowSeconds()));
  }, [apply]);

  // Los avisos del guardián llevan la bóveda: al tocar uno se abre la wallet de esa bóveda. Con varias wallets, si no,
  // se abriría la que estuviera abierta y no se vería qué hay que bloquear.
  const listRef = useRef<WalletSummary[]>([]);
  listRef.current = wallets;
  const selectRef = useRef(select);
  selectRef.current = select;
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (isExpoGo || !registry) return;
    const open = (r: Notifications.NotificationResponse | null | undefined) => {
      if (!r) return;
      const id = r.notification.request.identifier;
      if (handled.current === id) return;
      handled.current = id;
      const vaultId = (r.notification.request.content.data as Record<string, unknown> | undefined)?.vaultId;
      if (typeof vaultId !== "string") return;
      const owner = listRef.current.find((w) => w.vaultId === vaultId);
      if (owner && owner.id !== regRef.current?.active) void selectRef.current(owner.id);
    };
    const last = (Notifications as { getLastNotificationResponseAsync?: () => Promise<Notifications.NotificationResponse | null> }).getLastNotificationResponseAsync;
    if (typeof last === "function") void last().then(open).catch(() => undefined);
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    return () => sub.remove();
  }, [!!registry]);

  const value = useMemo<Ctx>(
    () => ({
      ready: !!registry,
      active: registry?.active ?? "w1",
      wallets,
      canAdd: (registry?.wallets.length ?? 0) < MAX_WALLETS,
      add,
      select,
      removeEmpty,
      removeActive,
      reload,
    }),
    [registry, wallets, add, select, removeEmpty, removeActive, reload],
  );
  return <WalletsCtx.Provider value={value}>{children}</WalletsCtx.Provider>;
}
