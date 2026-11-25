// Datos públicos de H10X para la app: NAV y cesta (nav.json), NAV de 7 días (history.json) y la DAO (dao.json), de la
// web h10xindex.xyz. Se piden al abrir la pantalla y cada minuto mientras está abierta; lo último que se supo se guarda
// en memoria para no enseñar la pantalla vacía al volver. Todo se valida en core/src/h10x.js.
import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import { H10X_API, parseDao, parseHistory, parseNav, nowSeconds, type DaoState, type H10xNav } from "@boveda/core";

type Cache = { nav: H10xNav | null; history: [number, number][]; dao: DaoState | null; navAt: number; daoAt: number };
const cache: Cache = { nav: null, history: [], dao: null, navAt: 0, daoAt: 0 };

async function getJson(url: string): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Repite `fn` cada minuto mientras la pantalla está montada y la app en primer plano. */
function usePolling(fn: () => Promise<void>, everyMs = 60_000) {
  useEffect(() => {
    let alive = true;
    const run = () => void fn().catch(() => undefined);
    run();
    let timer = setInterval(() => alive && run(), everyMs);
    const sub = AppState.addEventListener("change", (s) => {
      clearInterval(timer);
      if (s === "active") {
        run();
        timer = setInterval(() => alive && run(), everyMs);
      }
    });
    return () => {
      alive = false;
      clearInterval(timer);
      sub.remove();
    };
  }, [fn, everyMs]);
}

/**
 * NAV, cesta y (con `withHistory`) NAV de 7 días. `error`: la última lectura falló (se sigue enseñando lo anterior).
 * La tarjeta de Inicio no pide el histórico (son unos 50 KB): solo la pantalla de H10X.
 */
export function useH10xNav({ withHistory = true }: { withHistory?: boolean } = {}) {
  const [state, setState] = useState({ nav: cache.nav, history: cache.history, at: cache.navAt, error: false });
  const load = useCallback(async () => {
    try {
      const [rawNav, rawHist] = await Promise.all([getJson(H10X_API.nav), withHistory ? getJson(H10X_API.history).catch(() => null) : Promise.resolve(null)]);
      const nav = parseNav(rawNav);
      if (!nav) throw new Error("nav.json no válido");
      const history = rawHist ? parseHistory(rawHist) : cache.history;
      Object.assign(cache, { nav, history: history.length ? history : cache.history, navAt: nowSeconds() });
      setState({ nav, history: cache.history, at: cache.navAt, error: false });
    } catch {
      setState((s) => ({ ...s, error: true }));
    }
  }, [withHistory]);
  usePolling(load);
  return { ...state, reload: load };
}

/** Estado de la DAO de H10X. */
export function useDao() {
  const [state, setState] = useState({ dao: cache.dao, at: cache.daoAt, error: false });
  const load = useCallback(async () => {
    try {
      const dao = parseDao(await getJson(H10X_API.dao), nowSeconds());
      if (!dao) throw new Error("dao.json no válido");
      Object.assign(cache, { dao, daoAt: nowSeconds() });
      setState({ dao, at: cache.daoAt, error: false });
    } catch {
      setState((s) => ({ ...s, error: true }));
    }
  }, []);
  usePolling(load);
  return { ...state, reload: load };
}
