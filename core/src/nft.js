// @ts-check
// NFT de Hedera (HTS, NON_FUNGIBLE_UNIQUE): leer su metadata para enseñarlos.
// La metadata va en la red como bytes (casi siempre un enlace ipfs:// a un JSON con nombre e imagen).
// Solo se lee para mostrarla: nada de lo que diga cambia lo que la app permite hacer.
import { decodeBase64, toUtf8String } from "ethers";

/**
 * Pasarelas públicas para leer IPFS. Se piden todas a la vez y vale la primera que conteste: un CID que una pasarela
 * tarda en encontrar, otra lo tiene ya. La imagen se carga después de la misma pasarela que dio los datos.
 */
export const IPFS_GATEWAYS = ["https://ipfs.io/ipfs/", "https://dweb.link/ipfs/", "https://w3s.link/ipfs/", "https://nftstorage.link/ipfs/", "https://gateway.pinata.cloud/ipfs/"];
/** Tiempo máximo para leer la metadata de un NFT (todas las pasarelas a la vez). */
export const NFT_METADATA_TIMEOUT_MS = 12_000;

const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{40,})(\/.*)?$/;
/**
 * Enlace de Arweave con subdominio (https://<52 letras>.arweave.net/<tx>…), el que dan muchas herramientas de NFT.
 * Es el mismo contenido que https://arweave.net/<tx>: se pasa a esa forma.
 */
const AR_SUBDOMAIN = /^https:\/\/[a-z2-7]{52}\.arweave\.net\/([A-Za-z0-9_-]{43})((?:[/?#].*)?)$/;

/**
 * Enlace que guarda la metadata (ipfs://…, https://…, ar://…) o null si no lo parece.
 * @param {string} base64
 */
export function nftMetadataUri(base64) {
  if (!base64) return null;
  let text = "";
  try {
    text = toUtf8String(decodeBase64(base64)).trim();
  } catch {
    return null;
  }
  if (!text || text.length > 600) return null;
  if (/^(ipfs|ar):\/\//i.test(text) || /^https:\/\//i.test(text)) return text;
  if (CID.test(text)) return `ipfs://${text}`;
  return null;
}

/**
 * ¿Es una dirección de las pasarelas públicas de IPFS o de Arweave? A esas se puede pedir sin más: quien ve
 * la petición es la pasarela, no quien creó el NFT. Cualquier otro servidor lo puede poner quien te regala
 * el NFT, y vería tu dirección IP (y cuándo abres la app): solo se le pide si tú lo decides.
 * @param {string | null | undefined} url
 */
export function isPrivateUrl(url) {
  if (!url || typeof url !== "string") return false;
  return [...IPFS_GATEWAYS, "https://arweave.net/"].some((g) => url.startsWith(g)) || AR_SUBDOMAIN.test(url);
}

/** Servidor de una dirección https (para decir de dónde se cargaría algo). @param {string | null | undefined} url */
export function hostOfUrl(url) {
  const m = /^https:\/\/([^/?#:]+)/i.exec(url ?? "");
  return m ? m[1].toLowerCase() : null;
}

/**
 * De dónde sale la metadata de un NFT: dirección, si es de un servidor de terceros y cuál.
 * @param {string} base64 @returns {{ uri: string, url: string, external: boolean, host: string | null } | null}
 */
export function nftMetadataSource(base64) {
  const uri = nftMetadataUri(base64);
  const url = uri ? gatewayUrl(uri) : null;
  if (!uri || !url) return null;
  return { uri, url, external: !isPrivateUrl(url), host: hostOfUrl(url) };
}

/**
 * Lee el cuerpo de una respuesta sin pasar de `max` bytes: si el servidor no declara el tamaño (o miente),
 * se corta al llegar al límite en vez de descargarlo entero. Donde no hay lectura por trozos (la app
 * móvil), se lee entero y se comprueba después. Devuelve null si pasa del límite.
 * @param {any} res @param {number} max @returns {Promise<string | null>}
 */
async function readCapped(res, max) {
  const reader = res.body && typeof res.body.getReader === "function" ? res.body.getReader() : null;
  if (!reader) {
    const text = await res.text();
    return text.length > max ? null : text;
  }
  /** @type {Uint8Array[]} */
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return toUtf8String(all);
}

/**
 * Convierte un enlace ipfs:// o ar:// en una dirección https que se pueda abrir. Solo https.
 * @param {string | null | undefined} uri @param {string} [gateway]
 */
export function gatewayUrl(uri, gateway = IPFS_GATEWAYS[0]) {
  if (!uri || typeof uri !== "string") return null;
  const u = uri.trim();
  const sub = AR_SUBDOMAIN.exec(u);
  if (sub) return `https://arweave.net/${sub[1]}${sub[2]}`;
  if (/^https:\/\//i.test(u)) return u;
  let m = /^ipfs:\/\/(?:ipfs\/)?(.+)$/i.exec(u);
  if (m) return `${gateway}${m[1]}`;
  m = /^ar:\/\/(.+)$/i.exec(u);
  if (m) return `https://arweave.net/${m[1]}`;  if (CID.test(u)) return `${gateway}${u}`;
  return null;
}

/**
 * @typedef {{ name: string, description: string, image: string | null, creator: string, imageExternal: boolean }} NftMetadata
 *   imageExternal: la imagen está en un servidor de terceros (la app solo la carga si se lo pides)
 */

/**
 * Lee la metadata de un NFT (JSON estilo HIP-412). Devuelve null si no se puede leer.
 * Si está en un servidor de terceros (no IPFS ni Arweave), no se pide nada salvo con `allowExternal`.
 * Con IPFS se empieza por la primera pasarela y, si no ha contestado en `staggerMs` (o falla), se pide también a la
 * siguiente; vale la primera que conteste. Si una dice que es demasiado grande, se para todo: es el mismo archivo.
 * @param {string} base64 @param {{ fetchImpl?: typeof fetch, timeoutMs?: number, staggerMs?: number, allowExternal?: boolean }} [opts]
 * @returns {Promise<NftMetadata | null>}
 */
export async function fetchNftMetadata(base64, { fetchImpl = fetch, timeoutMs = NFT_METADATA_TIMEOUT_MS, staggerMs = 2000, allowExternal = false } = {}) {
  const uri = nftMetadataUri(base64);
  if (!uri) return null;
  if (!allowExternal && !isPrivateUrl(gatewayUrl(uri))) return null;
  const isIpfs = /^ipfs:\/\//i.test(uri) || CID.test(uri);
  const gateways = isIpfs ? IPFS_GATEWAYS : [IPFS_GATEWAYS[0]];
  const TOO_BIG = Symbol("demasiado grande");
  /** @param {string} gateway @param {AbortController | null} ctrl @returns {Promise<NftMetadata | null | typeof TOO_BIG>} */
  const attempt = async (gateway, ctrl) => {
    const url = gatewayUrl(uri, gateway);
    if (!url) return null;
    try {
      const res = await fetchImpl(url, ctrl ? { signal: ctrl.signal } : undefined);
      if (!res.ok) return null;
      // Que nadie haga descargar 50 MB al móvil: se mira el tamaño antes de leer.
      const declared = Number(res.headers?.get?.("content-length") ?? 0);
      if (declared > 200_000) return TOO_BIG;
      const text = await readCapped(res, 200_000);
      if (text == null) return TOO_BIG;
      const j = JSON.parse(text);
      const clip = (/** @type {unknown} */ v, n = 120) => (typeof v === "string" ? v.slice(0, n) : "");
      const image = gatewayUrl(typeof j?.image === "string" ? j.image : null, gateway);
      return { name: clip(j?.name), description: clip(j?.description, 400), image, creator: clip(j?.creator, 80), imageExternal: !isPrivateUrl(image) };
    } catch {
      return null;
    }
  };
  return new Promise((resolve) => {
    let done = false;
    let started = 0;
    let failed = 0;
    /** @type {(AbortController | null)[]} */
    const ctrls = [];
    /** @type {ReturnType<typeof setTimeout>[]} */
    const timers = [];
    /** @param {NftMetadata | null} v */
    const finish = (v) => {
      if (done) return;
      done = true;
      timers.forEach((x) => clearTimeout(x));
      ctrls.forEach((c) => c?.abort());
      resolve(v);
    };
    const startNext = () => {
      if (done || started >= gateways.length) return;
      const gateway = gateways[started++];
      const ctrl = typeof AbortController === "function" ? new AbortController() : null;
      ctrls.push(ctrl);
      void attempt(gateway, ctrl).then((r) => {
        if (done) return;
        if (r === TOO_BIG) return finish(null);
        if (r) return finish(r);
        failed += 1;
        if (failed >= gateways.length) finish(null);
        else startNext();
      });
      if (started < gateways.length) timers.push(setTimeout(startNext, staggerMs));
    };
    timers.push(setTimeout(() => finish(null), timeoutMs));
    startNext();
  });
}
