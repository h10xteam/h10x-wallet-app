// @ts-check
// Navegador interno de dApps: qué se deja cargar y el pequeño script que avisa a H10X Wallet cuando la dApp
// quiere conectar.
//
// Reglas de seguridad:
//   - La página principal solo puede estar en un dominio de la lista (DAPPS). Cualquier otro enlace
//     web se abre en Safari, fuera de H10X Wallet; los enlaces a otras apps (otras carteras, App Store…)
//     se bloquean.
//   - La dApp pide conectar con el mismo protocolo que usan HashPack y las extensiones de Hedera
//     (HashConnect y DAppConnector). El script solo atiende mensajes de la propia página (no de sus
//     iframes, que pueden ser anuncios) y firma cada aviso con un código secreto que cambia cada vez
//     que se abre el navegador.
//   - Conectar sigue pasando por la hoja de H10X Wallet (con la dApp y la cuenta a la vista), y cada firma
//     por Face ID: el navegador no se salta nada.
import { dappForUrl } from "./dapps.js";

/** Enlace de WalletConnect v2 completo (con la clave de cifrado). */
const WC_RE = /^wc:([0-9a-f]{64})@2\?(?=\S*\bsymKey=[0-9a-f]{64})\S+$/i;

/** @param {unknown} s */
export const isWcUri = (s) => typeof s === "string" && WC_RE.test(s.trim());

/**
 * Tema de emparejamiento de un enlace wc: (en minúsculas), o null.
 * @param {string | null | undefined} uri
 */
export function wcPairingTopic(uri) {
  const m = WC_RE.exec((uri ?? "").trim());
  return m ? m[1].toLowerCase() : null;
}

/**
 * Saca el enlace wc: de una navegación: «wc:…» directo o metido en otro enlace
 * (hashpack://wc?uri=wc%3A…, https://link.cartera.app/wc?uri=wc%3A…).
 * @param {string | null | undefined} url
 * @returns {string | null}
 */
export function wcUriFromUrl(url) {
  if (typeof url !== "string") return null;
  const s = url.trim();
  if (/^wc:/i.test(s)) return isWcUri(s) ? s : null;
  const m = /[?&#](?:uri|wc|wcUri)=([^&#\s]+)/i.exec(s);
  if (!m) return null;
  let v = m[1];
  // A veces llega codificado una o dos veces.
  for (let i = 0; i < 2 && /%[0-9a-f]{2}/i.test(v); i++) {
    try {
      v = decodeURIComponent(v);
    } catch {
      return null;
    }
  }
  return isWcUri(v) ? v : null;
}

/** Enlaces propios de H10X Wallet (WalletGuide y dApps): las dApps añaden «wc?uri=…» al nativo y «/wc?uri=…» al web. */
export const WALLET_LINKS = { native: "h10xwallet://", universal: "https://h10xindex.xyz/app" };

/**
 * Enlace wc: de un enlace que abre H10X Wallet desde fuera: SOLO h10xwallet://wc?uri=… o
 * https://h10xindex.xyz/app/wc?uri=… (y sus variantes sin «wc»). Cualquier otro enlace, null. Abrirlo no conecta
 * nada por sí solo: la propuesta pasa por la hoja de conexión y sus comprobaciones, como con el QR.
 * @param {string | null | undefined} url
 * @returns {string | null}
 */
export function wcUriFromWalletLink(url) {
  if (typeof url !== "string" || url.length > 4096) return null;
  const s = url.trim();
  if (!/^(?:h10xwallet:\/\/\/?(?:wc\/?)?|https:\/\/h10xindex\.xyz\/app(?:\/wc)?\/?)\?/i.test(s)) return null;
  return wcUriFromUrl(s);
}

/**
 * @typedef {{ action: "allow" }
 *   | { action: "block", reason: "scheme" | "frame_link" }
 *   | { action: "external", url: string }
 *   | { action: "pair", uri: string }} BrowserDecision
 */

/**
 * Qué hacer con cada navegación del navegador interno.
 * @param {{ url: string, isTopFrame: boolean }} nav
 * @returns {BrowserDecision}
 */
export function browserDecision({ url, isTopFrame }) {
  const s = typeof url === "string" ? url.trim() : "";
  const uri = wcUriFromUrl(s);
  if (uri) return isTopFrame ? { action: "pair", uri } : { action: "block", reason: "frame_link" };
  if (/^about:(blank|srcdoc)$/i.test(s)) return { action: "allow" };
  if (!isTopFrame) {
    // Los iframes (gráficos, captchas, el propio Verify de WalletConnect) pueden cargar webs seguras.
    return /^(https:|data:|blob:)/i.test(s) ? { action: "allow" } : { action: "block", reason: "scheme" };
  }
  if (dappForUrl(s)) return { action: "allow" };
  if (/^https?:\/\/[^\s]+$/i.test(s) || /^mailto:[^\s]+$/i.test(s)) return { action: "external", url: s };
  // Enlaces a otras apps (otras carteras, App Store, llamadas…): nunca se abren desde una dApp.
  return { action: "block", reason: "scheme" };
}

/**
 * @typedef {{ id: string, name: string, icon: string, url: string }} BridgeWallet
 * @typedef {{ kind: "pair", uri: string, via: "hedera" | "hashconnect" }} BridgeMessage
 */

/**
 * Script que se inyecta en la página principal antes de que cargue. Responde a la dApp como lo haría
 * HashPack dentro de su navegador y pasa a H10X Wallet el enlace de conexión.
 * @param {{ token: string, wallet: BridgeWallet }} p
 */
export function browserBridgeScript({ token, wallet }) {
  if (!/^[0-9a-f]{32,}$/i.test(token)) throw new Error("token del navegador no válido");
  const cfg = JSON.stringify({ token, wallet: { id: wallet.id, name: wallet.name, icon: wallet.icon, url: wallet.url } }).replace(/</g, "\\u003c");
  return `(function () {
  if (window.__hvaultBridge) return;
  try { Object.defineProperty(window, "__hvaultBridge", { value: true }); } catch (e) { return; }
  var C = ${cfg};
  var WC = /^wc:([0-9a-f]{64})@2\\?(?=\\S*\\bsymKey=[0-9a-f]{64})\\S+$/i;
  var seen = {};
  var meta = { id: C.wallet.id, name: C.wallet.name, icon: C.wallet.icon, url: C.wallet.url };
  var post = window.postMessage.bind(window);
  var bridge = null;
  function send(msg) {
    try {
      bridge = bridge || window.ReactNativeWebView;
      if (!bridge || typeof bridge.postMessage !== "function") return;
      msg.hvault = C.token;
      bridge.postMessage(JSON.stringify(msg));
    } catch (e) {}
  }
  function pair(uri, via) {
    if (typeof uri !== "string") return;
    var m = WC.exec(uri.trim());
    if (!m) return;
    var topic = m[1].toLowerCase();
    if (seen[topic]) return;
    seen[topic] = 1;
    send({ kind: "pair", uri: uri.trim(), via: via });
  }
  window.addEventListener("message", function (e) {
    // Solo la propia página: los iframes (anuncios, widgets) no pueden pedir conexiones.
    if (e.source !== window) return;
    if (e.origin && e.origin !== window.location.origin) return;
    var d = e.data;
    if (!d || typeof d !== "object" || typeof d.type !== "string") return;
    if (d.type === "hedera-iframe-query") {
      post({ type: "hedera-iframe-response", metadata: meta }, "*");
    } else if (d.type === "hedera-iframe-connect" || d.type.indexOf("hedera-extension-connect-") === 0) {
      // Algunas dApps nos enseñan como «HashPack · Detected» y piden conectar con el ID de la extensión de HashPack:
      // dentro de este navegador no hay otra cartera, así que cualquier petición de la propia página llega aquí
      // (y sigue pasando por la hoja de conexión y Verify, como un QR).
      pair(d.pairingString, "hedera");
    } else if (d.type === "hashconnect2-iframe-pairing") {
      pair(d.pairingString, "hashconnect");
    }
  }, false);
})();
true;`;
}

/**
 * Lee un aviso del script. Devuelve null si no lleva el código secreto o no tiene la forma esperada.
 * @param {string} raw
 * @param {string} token
 * @returns {BridgeMessage | null}
 */
export function parseBridgeMessage(raw, token) {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  /** @type {any} */
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!m || typeof m !== "object" || m.hvault !== token) return null;
  if (m.kind === "pair" && isWcUri(m.uri) && (m.via === "hedera" || m.via === "hashconnect")) return { kind: "pair", uri: m.uri.trim(), via: m.via };
  return null;
}
