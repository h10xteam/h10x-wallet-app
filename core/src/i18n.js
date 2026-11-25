// @ts-check
// Idioma de los textos del núcleo (errores y formatos). La app lo fija con setCoreLanguage().

/** @typedef {"es" | "en"} Lang */

/** @type {Lang} */
let current = "es";

/** @param {string | null | undefined} lang */
export function setCoreLanguage(lang) {
  current = lang === "en" ? "en" : "es";
}

/** @returns {Lang} */
export const coreLanguage = () => current;

/**
 * Elige el texto según el idioma.
 * @param {string} es @param {string} en @param {Lang} [lang]
 */
export const tr = (es, en, lang = current) => (lang === "en" ? en : es);

/** Locale de Intl para el idioma. @param {Lang} [lang] */
export const localeOf = (lang = current) => (lang === "en" ? "en-US" : "es-ES");
