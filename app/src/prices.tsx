// Precios en € y $. Primero los del guardián (que los cachea y puede tener clave de SaucerSwap para
// los tokens); si no responde, el HBAR directamente de CoinGecko.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";
import { fetchPrices, fiatOf, formatFiat, type Prices } from "@boveda/core";
import { guardianUrl } from "./env";
import { usePrefs } from "./prefs";

type PricesCtx = {
  prices: Prices | null;
  /** Valor en la moneda elegida, o null si no hay precio. HBAR si no se da token. */
  fiat: (amount: bigint, decimals: number, tokenId?: string) => string | null;
  /** Lo mismo, como número (para sumar). */
  fiatValue: (amount: bigint, decimals: number, tokenId?: string) => number | null;
  format: (value: number) => string;
};

const Ctx = createContext<PricesCtx | null>(null);
export const usePrices = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error("usePrices fuera de PricesProvider");
  return c;
};

const valid = (p: unknown): p is Prices =>
  !!p && typeof p === "object" && typeof (p as Prices).hbar?.usd === "number" && typeof (p as Prices).hbar?.eur === "number" && (p as Prices).hbar.usd > 0;

async function load(): Promise<Prices | null> {
  const g = guardianUrl();
  if (g) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 6000);
      const res = await fetch(`${g}/prices`, { signal: ac.signal }).finally(() => clearTimeout(timer));
      const body = await res.json();
      if (res.ok && valid(body)) return body;
    } catch {
      // sin guardián: se pide directo
    }
  }
  try {
    return await fetchPrices();
  } catch {
    return null;
  }
}

export function PricesProvider({ children }: { children: React.ReactNode }) {
  const { prefs, lang } = usePrefs();
  const [prices, setPrices] = useState<Prices | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = () => void load().then((p) => alive && p && setPrices(p));
    tick();
    let timer = setInterval(tick, 60_000);
    const sub = AppState.addEventListener("change", (s) => {
      clearInterval(timer);
      if (s === "active") {
        tick();
        timer = setInterval(tick, 60_000);
      }
    });
    return () => {
      alive = false;
      clearInterval(timer);
      sub.remove();
    };
  }, []);

  const key = prefs.currency === "EUR" ? "eur" : "usd";
  const fiatValue = useCallback(
    (amount: bigint, decimals: number, tokenId?: string) => {
      const unit = tokenId ? prices?.tokens?.[tokenId]?.[key] : prices?.hbar[key];
      return unit ? fiatOf(amount, decimals, unit) : null;
    },
    [prices, key],
  );
  const format = useCallback((value: number) => formatFiat(value, prefs.currency, lang), [prefs.currency, lang]);
  const fiat = useCallback(
    (amount: bigint, decimals: number, tokenId?: string) => {
      const v = fiatValue(amount, decimals, tokenId);
      return v == null ? null : format(v);
    },
    [fiatValue, format],
  );
  const value = useMemo(() => ({ prices, fiat, fiatValue, format }), [prices, fiat, fiatValue, format]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
