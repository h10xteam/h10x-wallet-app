// H10X Wallet · DeRec: el «código de amigo» que se enseña en QR o se manda por mensaje. Lleva el contacto de DeRec
// (ContactMessage, con bigint y bytes), el nombre que se enseñará, la red y para qué es:
//   pair    → emparejar para guardar una parte (el amigo ayudará a quien lo escanee);
//   recover → recuperar: el amigo ya eligió a quién ayuda y añade de qué secreto es (secretId y versión).
// No lleva ningún secreto: solo llaves públicas y el buzón. Aun así, quien lo escanee podrá emparejarse: por eso el
// emparejamiento siempre lo confirma el amigo en su móvil.
import { decodeBase64, encodeBase64 } from "ethers";

const PREFIX = "H10XDEREC1.";
const NETS = ["mainnet", "testnet", "previewnet"];

/** JSON con bigint y bytes. @param {any} v @returns {any} */
function tag(v) {
  if (typeof v === "bigint") return { $n: v.toString() };
  if (v instanceof Uint8Array) return { $b: encodeBase64(v) };
  if (Array.isArray(v)) return v.map(tag);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, tag(x)]));
  return v;
}
/** @param {any} v @returns {any} */
function untag(v) {
  if (Array.isArray(v)) return v.map(untag);
  if (v && typeof v === "object") {
    if (typeof v.$n === "string" && Object.keys(v).length === 1) {
      if (!/^\d{1,20}$/.test(v.$n)) throw new Error("DeRec: código no válido");
      return BigInt(v.$n);
    }
    if (typeof v.$b === "string" && Object.keys(v).length === 1) return Uint8Array.from(decodeBase64(v.$b));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, untag(x)]));
  }
  return v;
}
/** @param {string} s */
const toUrl = (s) => s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** @param {string} s */
const fromUrl = (s) => {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  return b + "=".repeat((4 - (b.length % 4)) % 4);
};

/**
 * @typedef {{ purpose: "pair" | "recover", name: string, network: string, contact: any, secretId?: string, version?: number }} FriendCode
 */

/** @param {FriendCode} c @returns {string} */
export function encodeFriendCode(c) {
  if (c.purpose !== "pair" && c.purpose !== "recover") throw new Error("DeRec: código sin propósito");
  if (!NETS.includes(c.network)) throw new Error("DeRec: red no válida");
  const body = {
    p: c.purpose === "pair" ? 1 : 2,
    n: String(c.name ?? "").slice(0, 40),
    w: c.network,
    c: tag(c.contact),
    ...(c.secretId ? { s: String(c.secretId) } : {}),
    ...(c.version ? { v: Number(c.version) } : {}),
  };
  const json = new TextEncoder().encode(JSON.stringify(body));
  return PREFIX + toUrl(encodeBase64(json));
}

/**
 * Lee un código (del QR, de un enlace o pegado). Lanza si no es un código de H10X para DeRec.
 * @param {string} text @returns {FriendCode}
 */
export function decodeFriendCode(text) {
  const t = String(text ?? "").trim();
  const i = t.indexOf(PREFIX);
  if (i < 0) throw new Error("DeRec: no es un código de amigo de H10X");
  const raw = t.slice(i + PREFIX.length).match(/^[A-Za-z0-9_-]+/)?.[0] ?? "";
  if (raw.length < 10 || raw.length > 8000) throw new Error("DeRec: código no válido");
  /** @type {any} */
  let j;
  try {
    j = JSON.parse(new TextDecoder().decode(decodeBase64(fromUrl(raw))));
  } catch {
    throw new Error("DeRec: código no válido");
  }
  if (!j || (j.p !== 1 && j.p !== 2) || !NETS.includes(j.w) || !j.c || typeof j.c !== "object") throw new Error("DeRec: código no válido");
  const contact = untag(j.c);
  if (typeof contact.channel_id !== "bigint" || !Array.isArray(contact.supported_transports)) throw new Error("DeRec: código no válido");
  if (j.s != null && !/^\d{1,20}$/.test(String(j.s))) throw new Error("DeRec: código no válido");
  return {
    purpose: j.p === 1 ? "pair" : "recover",
    name: String(j.n ?? "").slice(0, 40),
    network: j.w,
    contact,
    ...(j.s != null ? { secretId: String(j.s) } : {}),
    ...(j.v != null ? { version: Number(j.v) } : {}),
  };
}

/** Código corto para comparar en voz alta por teléfono (6 cifras) a partir de la huella de DeRec. @param {string} fingerprint */
export function shortFingerprint(fingerprint) {
  const digits = String(fingerprint ?? "").replace(/[^0-9a-fA-F]/g, "");
  if (digits.length < 8) return String(fingerprint ?? "").slice(0, 12);
  const n = BigInt(`0x${digits.slice(0, 15)}`) % 1_000_000n;
  const s = n.toString().padStart(6, "0");
  return `${s.slice(0, 3)} ${s.slice(3)}`;
}
