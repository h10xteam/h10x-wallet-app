// @ts-check
// Textos que escribe quien crea un token o un NFT: nombre, símbolo y descripción. Cualquiera puede regalarte
// uno con un enlace a una web falsa («reclama tu premio en …»): es la estafa más común en Hedera. Aquí se
// detectan esos enlaces, también los disimulados («claim[.]com», «hbar dot io», «hbar punto com»), para
// esconderlos y avisar, y los tokens que se hacen llamar HBAR sin serlo.
// Sin \p{…} ni «lookbehind»: tiene que funcionar igual en Node y en el motor de JavaScript de la app.
import { tr } from "./i18n.js";

/** Letras y cifras de un nombre de dominio (también acentuadas, griegas y cirílicas: «sаucerswap» con «а» rusa). */
const CH = "a-z0-9\\u00c0-\\u024f\\u0370-\\u03ff\\u0400-\\u04ff";
const LABEL = `[${CH}](?:[${CH}-]{0,61}[${CH}])?`;
/** El punto, o sus disfraces. Con espacios solo los disfraces (o « . » con espacio a los dos lados), para no confundir el final de una frase. */
const DOT = "(?:\\.|\\u3002|\\uff0e|\\s*(?:\\[\\.\\]|\\(\\.\\)|\\{\\.\\})\\s*|\\s+\\.\\s+|\\s*[\\[(]\\s*(?:dot|punto)\\s*[\\])]\\s*|\\s+(?:dot|punto)\\s+)";
/** Terminaciones de dominio habituales (las de siempre y las que más usan las webs que roban). */
const TLDS = [
  "com", "net", "org", "io", "xyz", "app", "finance", "fi", "site", "online", "live", "info", "top", "club", "pro", "gift",
  "me", "co", "cc", "link", "click", "vip", "fun", "us", "to", "gg", "ai", "dev", "art", "network", "exchange", "digital",
  "money", "cash", "claims?", "bond", "world", "today", "space", "store", "shop", "tech", "cloud", "ly", "biz", "win", "bet",
  "run", "zone", "global", "events?", "services", "support", "wallet", "ru", "cn", "su", "tk", "ml", "ga", "cf", "gq", "icu",
  "cyou", "sbs", "buzz", "rest", "lat", "page", "nft", "uk", "eu", "ws", "ink", "life",
].join("|");
const SCHEME = "(?:https?|hxxps?|ipfs|ftp)\\s*[:\\uff1a]\\s*\\/\\s*\\/\\S*";
const WWW = "www\\s*(?:\\.|\\[\\.\\])\\s*\\S+";
const DOMAIN = `${LABEL}(?:${DOT}${LABEL})*${DOT}(?:${TLDS})(?![${CH}-])(?:\\/\\S*)?`;
const LINK = new RegExp(`(^|[^${CH}\\-.])(${SCHEME}|${WWW}|${DOMAIN})`, "gi");
/** Más allá de esto no se mira (y no se enseña): un nombre o una descripción así de largos ya son raros. */
const MAX = 5000;

/** ¿El texto trae un enlace (una web, aunque esté disimulada)? @param {unknown} text */
export function hasLink(text) {
  if (typeof text !== "string" || !text) return false;
  return text.slice(0, MAX).search(LINK) >= 0;
}

/**
 * El texto con los enlaces cambiados por «[enlace oculto]», para enseñarlo sin que nadie copie la web.
 * @param {string} text @param {import("./i18n.js").Lang} [lang]
 */
export function hideLinks(text, lang) {
  if (typeof text !== "string" || !text) return text;
  const hidden = tr("[enlace oculto]", "[link hidden]", lang);
  const cut = text.length > MAX ? `${text.slice(0, MAX)}…` : text;
  return cut.replace(LINK, (_m, before) => `${before}${hidden}`);
}

/** Letras griegas y cirílicas que se ven igual que las latinas de «HBAR». */
const LOOKALIKE = /** @type {Record<string, string>} */ ({ "А": "A", "В": "B", "Е": "E", "Н": "H", "Р": "P", "Α": "A", "Β": "B", "Ε": "E", "Η": "H", "Ρ": "P" });

/** ¿Un token que se hace llamar HBAR (o ℏ) sin serlo? HBAR no es un token: un token con ese nombre es falso. @param {unknown} text */
export function fakesHbar(text) {
  if (typeof text !== "string" || !text) return false;
  const s = text
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[АВЕНРΑΒΕΗΡ]/g, (c) => LOOKALIKE[c] ?? c)
    .replace(/[\s._\-·•*'"]/g, "");
  return ["HBAR", "Ħ", "ĦBAR", "HEDERA", "HEDERAHBAR", "HBARHEDERA"].includes(s);
}
