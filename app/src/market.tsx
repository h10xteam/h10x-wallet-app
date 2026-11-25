// Precios y cambio en 24 h de lo que tienes, para las listas al estilo de HashPack (core/src/holdings.js): HBAR y
// tokens con precio del guardián, H10X y los tokens de su cesta con los de nav.json. Un solo proveedor para toda la app,
// así nav.json se pide una vez por minuto y no una por pantalla.
import React, { createContext, useCallback, useContext, useMemo } from "react";
import { dayChange, fiatOf, formatHbar, formatPct, formatPrice, hideLinks, makeQuote, sortHoldings, tokenWarnings, type H10xNav, type Quote } from "@boveda/core";
import { usePrices } from "./prices";
import { usePrefs } from "./prefs";
import { useH10xNav } from "./h10xData";
import { HBAR_ASSET, useWallet } from "./wallet";
import { NETWORK, h10xTokenId } from "./env";
import { lang } from "./i18n";

type Market = {
  nav: H10xNav | null;
  /** Precio en la moneda elegida y cambio en 24 h. null = HBAR. */
  quote: (tokenId: string | null) => Quote;
  /** Valor en la moneda elegida, o null si no hay precio. */
  valueOf: (amount: bigint, decimals: number, tokenId: string | null) => number | null;
  /** 1.234,56 € */
  format: (value: number) => string;
  /** Precio de una unidad (con más decimales si es pequeño). */
  price: (value: number) => string;
  /** +2,4 % */
  pct: (value: number, digits?: number) => string;
};

const Ctx = createContext<Market | null>(null);
export const useMarket = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error("useMarket fuera de MarketProvider");
  return c;
};

export function MarketProvider({ children }: { children: React.ReactNode }) {
  const { prices, format } = usePrices();
  const { prefs } = usePrefs();
  const { nav } = useH10xNav({ withHistory: false });
  const quote = useMemo(() => makeQuote({ prices, nav, currency: prefs.currency, network: NETWORK, h10xTokenId }), [prices, nav, prefs.currency]);
  const valueOf = useCallback(
    (amount: bigint, decimals: number, tokenId: string | null) => {
      const q = quote(tokenId);
      return q.price == null ? null : fiatOf(amount, decimals, q.price);
    },
    [quote],
  );
  const value = useMemo<Market>(
    () => ({
      nav,
      quote,
      valueOf,
      format,
      price: (v: number) => formatPrice(v, prefs.currency, lang()),
      pct: (v: number, digits = 1) => formatPct(v, digits, lang()),
    }),
    [nav, quote, valueOf, format, prefs.currency],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export type Holding = {
  /** HBAR_ASSET o el ID del token (lo que usan enviar, guardar y sacar). */
  id: string;
  tokenId: string | null;
  symbol: string;
  name: string;
  decimals: number;
  amount: bigint;
  price: number | null;
  change24h: number | null;
  value: number | null;
  warn: ReturnType<typeof tokenWarnings>;
};

const NO_WARN: Holding["warn"] = { level: null, short: null, lines: [] };

/** Lo que hay en la bóveda o en la Cartera, en el orden de la lista, con su total y el cambio de hoy. */
export function useHoldings(where: "vault" | "pocket") {
  const { balances, tokens, meta } = useWallet();
  const { quote } = useMarket();
  return useMemo(() => {
    const hbar = (where === "vault" ? balances.vault : balances.pocket) ?? 0n;
    const qh = quote(null);
    const list: Holding[] = [
      {
        id: HBAR_ASSET,
        tokenId: null,
        symbol: "HBAR",
        name: "Hedera",
        decimals: 8,
        amount: hbar,
        price: qh.price,
        change24h: qh.change24h,
        value: qh.price == null ? null : fiatOf(hbar, 8, qh.price),
        warn: NO_WARN,
      },
    ];
    for (const x of where === "vault" ? tokens.vault : tokens.pocket) {
      if (x.balance <= 0n) continue;
      const q = quote(x.tokenId);
      list.push({
        id: x.tokenId,
        tokenId: x.tokenId,
        symbol: hideLinks(x.symbol) || "?",
        name: hideLinks(x.name) || x.tokenId,
        decimals: x.decimals,
        amount: x.balance,
        price: q.price,
        change24h: q.change24h,
        value: q.price == null ? null : fiatOf(x.balance, x.decimals, q.price),
        warn: tokenWarnings({ symbol: x.symbol, name: x.name, info: meta(x.tokenId), lang: lang(), formatHbar: (v) => formatHbar(v) }),
      });
    }
    const sorted = sortHoldings(list);
    // Sin precio del HBAR no hay total en dinero (se enseña en HBAR).
    const total = qh.price == null ? null : sorted.reduce((s, x) => s + (x.value ?? 0), 0);
    return { list: sorted, total, change: dayChange(sorted), hbar, loaded: (where === "vault" ? balances.vault : balances.pocket) != null };
  }, [where, balances, tokens, meta, quote]);
}
