// Logos de los tokens (lista pública de la web de H10X, validada en core/src/logos.js). Se guarda en el móvil para
// enseñarlos al momento y sin red; se vuelve a pedir si tiene más de 12 horas. Si no hay lista, cada token sale con su
// inicial: nada depende de ella.
import React, { createContext, useContext, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { TOKEN_LOGOS_URL, parseTokenLogos, type TokenLogo } from "@boveda/core";

const CACHE_KEY = "h10x.tokenLogos.v1";
const MAX_AGE_MS = 12 * 3600 * 1000;

const Ctx = createContext<Map<string, TokenLogo>>(new Map());
export const useTokenLogos = () => useContext(Ctx);

async function fetchList(): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    const res = await fetch(TOKEN_LOGOS_URL, { signal: ac.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > 3_000_000) throw new Error("lista demasiado grande");
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

export function TokenLogosProvider({ children }: { children: React.ReactNode }) {
  const [logos, setLogos] = useState<Map<string, TokenLogo>>(new Map());
  useEffect(() => {
    let alive = true;
    void (async () => {
      let at = 0;
      try {
        const saved = await AsyncStorage.getItem(CACHE_KEY);
        if (saved) {
          const { at: savedAt, list } = JSON.parse(saved) as { at: number; list: unknown };
          const parsed = parseTokenLogos(list);
          if (alive && parsed.size) setLogos(parsed);
          at = typeof savedAt === "number" ? savedAt : 0;
        }
      } catch {
        // caché rota: se pide de nuevo
      }
      if (Date.now() - at < MAX_AGE_MS) return;
      try {
        const list = await fetchList();
        const parsed = parseTokenLogos(list);
        if (!parsed.size) return;
        if (alive) setLogos(parsed);
        // Se guarda solo lo que ha pasado la validación (y se vuelve a validar al leerlo).
        const clean = Object.fromEntries(Object.entries(list as Record<string, unknown>).filter(([id]) => parsed.has(id)));
        await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), list: clean })).catch(() => undefined);
      } catch {
        // sin red o sin lista: se queda la guardada (o las iniciales)
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  return <Ctx.Provider value={logos}>{children}</Ctx.Provider>;
}
