// Preferencias de este iPhone: idioma, moneda y bloqueo con Face ID.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Fiat, Lang } from "@boveda/core";
import { applyLang, deviceCurrency, type LangSetting } from "./i18n";

export type Prefs = {
  lang: LangSetting;
  currency: Fiat;
  /** Pedir Face ID (o el código del iPhone) al abrir la app y al volver a ella. */
  appLock: boolean;
  /**
   * 0.10.2 · Acciones tokenizadas: lo que aceptó el usuario (país, que no es persona de EE. UU. y que leyó el aviso del
   * emisor), como piden las condiciones de SODAX. null: todavía no. Se comprueba con stockEligibility del núcleo.
   */
  stocks: StockConsent | null;
};
export type StockConsent = { version: number; country: string; notUsPerson: boolean; readNotice: boolean; at: number };

const KEY = "hvault.prefs.v1";

type PrefsCtx = { prefs: Prefs; lang: Lang; setPrefs: (p: Partial<Prefs>) => Promise<void> };
const Ctx = createContext<PrefsCtx | null>(null);

export const usePrefs = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error("usePrefs fuera de PrefsProvider");
  return c;
};

export function PrefsProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setState] = useState<Prefs | null>(null);
  const [lang, setLang] = useState<Lang>("es");

  useEffect(() => {
    void AsyncStorage.getItem(KEY)
      .then((raw) => (raw ? (JSON.parse(raw) as Partial<Prefs>) : {}))
      .catch(() => ({}) as Partial<Prefs>)
      .then((saved) => {
        const p: Prefs = { lang: saved.lang ?? "auto", currency: saved.currency ?? deviceCurrency(), appLock: saved.appLock ?? true, stocks: saved.stocks ?? null };
        setLang(applyLang(p.lang));
        setState(p);
      });
  }, []);

  const setPrefs = useCallback(async (patch: Partial<Prefs>) => {
    setState((old) => {
      const next = { ...(old as Prefs), ...patch };
      void AsyncStorage.setItem(KEY, JSON.stringify(next));
      if (patch.lang) setLang(applyLang(next.lang));
      return next;
    });
  }, []);

  const value = useMemo(() => (prefs ? { prefs, lang, setPrefs } : null), [prefs, lang, setPrefs]);
  if (!value) return null; // se lee en milisegundos: así nada aparece en el idioma equivocado
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
