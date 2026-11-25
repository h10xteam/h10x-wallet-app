// Idioma de la app: español o inglés. "auto" sigue al del iPhone (español si está en español; si no, inglés).
import { Platform } from "react-native";
import { getLocales } from "expo-localization";
import { formatDateTime, setCoreLanguage, type Fiat, type Lang } from "@boveda/core";

export type LangSetting = "auto" | Lang;

function device(): { lang: Lang; currency: string | null } {
  try {
    const l = getLocales()[0];
    return { lang: l?.languageCode === "es" ? "es" : "en", currency: l?.currencyCode ?? null };
  } catch {
    return { lang: "es", currency: null };
  }
}

let current: Lang = device().lang;
setCoreLanguage(current);

/** Fija el idioma (también el de los errores y formatos del núcleo). */
export function applyLang(setting: LangSetting): Lang {
  current = setting === "auto" ? device().lang : setting;
  setCoreLanguage(current);
  return current;
}

/** Idioma en uso. */
export const lang = (): Lang => current;

/**
 * Texto según el idioma: t("Guardar", "Save"). En Android no hay Face ID: los textos lo dicen como «biometría»
 * (huella o cara, lo que tenga el teléfono).
 */
export const t = (es: string, en: string): string => {
  const s = current === "en" ? en : es;
  return Platform.OS === "android" ? s.replace(/Face ID/g, current === "en" ? "biometrics" : "biometría") : s;
};

/** Fecha y hora cortas. */
export const when = (unix: number) => formatDateTime(unix, current);

/** Moneda por defecto: la del iPhone si es euro o dólar. */
export function deviceCurrency(): Fiat {
  const c = device().currency;
  if (c === "USD" || c === "EUR") return c;
  return current === "es" ? "EUR" : "USD";
}
