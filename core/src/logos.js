// @ts-check
// Logos de tokens para las listas de la app (como en HashPack): los publica la web de H10X en /token-logos.json, un
// objeto { "0.0.x": "data:image/…;base64,…" } con los iconos oficiales de SaucerSwap.
//
// Viene de fuera, así que se valida todo: IDs de Hedera, solo PNG, JPEG, WebP o SVG en base64, tamaños con tope y SVG
// sin nada ejecutable ni externo. Lo que no pasa se descarta y ese token sale con su inicial. Un logo es solo una
// imagen: no cambia lo que se firma ni quita los avisos de riesgo del token, y su ID sigue a la vista.

import { H10X_WEB } from "./h10x.js";

export const TOKEN_LOGOS_URL = `${H10X_WEB}/token-logos.json`;

/** Topes: logos por lista, tamaño de cada uno (base64) y del SVG ya decodificado. */
export const LOGO_LIMITS = Object.freeze({ count: 300, base64: 120_000, svg: 64_000 });

const ID_RE = /^0\.0\.\d{1,12}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const DATA_RE = /^data:image\/(png|jpeg|webp|svg\+xml);base64,(.+)$/;

/** base64 → bytes, sin depender de Buffer (en la app no hay Node). @param {string} b64 */
export function base64Bytes(b64) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = b64.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let j = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = alphabet.indexOf(clean[i]);
    if (v < 0) throw new Error("base64 no válido");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, j);
}

/** ¿SVG sin nada ejecutable ni externo? (el mismo criterio que usa la web de H10X al publicar la lista) @param {string} text */
export function svgIsSafe(text) {
  const s = text.toLowerCase();
  if (!/<svg[\s>]/.test(s)) return false;
  const bad = [/<script/, /<foreignobject/, /<iframe/, /<embed/, /<object/, /\son[a-z]+\s*=/, /javascript:/, /@import/, /<!entity/, /<!doctype/];
  if (bad.some((re) => re.test(s))) return false;
  // referencias: solo internas (#id) o imágenes data: incrustadas
  for (const m of s.matchAll(/(?:xlink:)?href\s*=\s*["']([^"']*)["']/g)) {
    const v = m[1].trim();
    if (!(v.startsWith("#") || v.startsWith("data:image/png") || v.startsWith("data:image/jpeg") || v.startsWith("data:image/webp"))) return false;
  }
  if (/url\(\s*["']?(?!#)/.test(s)) return false; // url(...) solo a #id
  return true;
}

/** Tipo real por los primeros bytes (no el que diga la lista). @param {Uint8Array} b */
function sniffRaster(b) {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  return null;
}

/** @param {Uint8Array} bytes */
function utf8(bytes) {
  if (typeof TextDecoder !== "undefined") return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

/**
 * @typedef {{ kind: "raster", uri: string } | { kind: "svg", xml: string }} TokenLogo
 */

/**
 * Un logo de la lista, validado. null si no vale.
 * @param {unknown} value
 * @returns {TokenLogo | null}
 */
export function parseLogo(value) {
  if (typeof value !== "string" || value.length > LOGO_LIMITS.base64 + 40) return null;
  const m = DATA_RE.exec(value);
  if (!m || m[2].length > LOGO_LIMITS.base64 || !B64_RE.test(m[2])) return null;
  let bytes;
  try {
    bytes = base64Bytes(m[2]);
  } catch {
    return null;
  }
  if (m[1] === "svg+xml") {
    if (bytes.length > LOGO_LIMITS.svg) return null;
    const xml = utf8(bytes);
    return svgIsSafe(xml) ? { kind: "svg", xml } : null;
  }
  const real = sniffRaster(bytes);
  if (!real) return null;
  return { kind: "raster", uri: `data:image/${real};base64,${m[2]}` };
}

/**
 * La lista entera: solo las entradas que pasan. Un objeto que no es una lista de logos da un mapa vacío.
 * @param {unknown} raw
 * @returns {Map<string, TokenLogo>}
 */
export function parseTokenLogos(raw) {
  /** @type {Map<string, TokenLogo>} */
  const out = new Map();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, value] of Object.entries(raw)) {
    if (out.size >= LOGO_LIMITS.count) break;
    if (!ID_RE.test(id)) continue;
    const logo = parseLogo(value);
    if (logo) out.set(id, logo);
  }
  return out;
}
