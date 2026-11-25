// Navegador interno de dApps: qué se deja cargar, cómo se detecta la conexión y que nadie más que la
// propia página pueda pedirla.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browserBridgeScript, browserDecision, isWcUri, parseBridgeMessage, vetProposal, wcPairingTopic, wcUriFromUrl } from "@boveda/core";

const TOPIC = "a".repeat(64);
const KEY = "b".repeat(64);
const URI = `wc:${TOPIC}@2?relay-protocol=irn&symKey=${KEY}&expiryTimestamp=1794600000`;
const TOKEN = "0123456789abcdef0123456789abcdef";
const WALLET = { id: "hvault", name: "Hvault Wallet", icon: "https://hvault.example/icon.png", url: "https://hvault.example" };

test("enlaces de WalletConnect: completos, con clave y dentro de otros enlaces", () => {
  assert.equal(isWcUri(URI), true);
  assert.equal(isWcUri(`wc:${TOPIC}@2?relay-protocol=irn`), false, "sin symKey no sirve");
  assert.equal(isWcUri(`wc:${TOPIC}@1?bridge=x&key=${KEY}`), false, "v1 no");
  assert.equal(wcPairingTopic(URI.replace(TOPIC, TOPIC.toUpperCase())), TOPIC);
  assert.equal(wcUriFromUrl(URI), URI);
  assert.equal(wcUriFromUrl(`hashpack://wc?uri=${encodeURIComponent(URI)}`), URI);
  assert.equal(wcUriFromUrl(`https://link.cartera.app/wc?uri=${encodeURIComponent(encodeURIComponent(URI))}`), URI, "doble codificación");
  assert.equal(wcUriFromUrl("https://www.saucerswap.finance/swap?uri=hola"), null);
  assert.equal(wcUriFromUrl("https://www.saucerswap.finance/swap"), null);
});

test("navegación: la página solo en dominios de la lista; lo demás a Safari o bloqueado", () => {
  const top = (url) => browserDecision({ url, isTopFrame: true });
  const frame = (url) => browserDecision({ url, isTopFrame: false });
  assert.deepEqual(top("https://www.saucerswap.finance/swap"), { action: "allow" });
  assert.deepEqual(top("https://app.kabila.app/"), { action: "allow" });
  assert.deepEqual(top("https://saucerswap.finance.evil.io/"), { action: "external", url: "https://saucerswap.finance.evil.io/" });
  assert.deepEqual(top("https://x.com/hvault"), { action: "external", url: "https://x.com/hvault" });
  assert.deepEqual(top("http://www.saucerswap.finance/"), { action: "external", url: "http://www.saucerswap.finance/" }, "sin https no se queda dentro");
  assert.deepEqual(top("hashpack://open"), { action: "block", reason: "scheme" }, "otras carteras nunca");
  assert.deepEqual(top("itms-apps://apps.apple.com/app/id1"), { action: "block", reason: "scheme" });
  assert.deepEqual(top("javascript:alert(1)"), { action: "block", reason: "scheme" });
  assert.deepEqual(top(`hashpack://wc?uri=${encodeURIComponent(URI)}`), { action: "pair", uri: URI }, "elegir cualquier cartera conecta Hvault");
  assert.deepEqual(top("about:blank"), { action: "allow" });
  // iframes: webs seguras sí (Verify, captchas, gráficos); enlaces de conexión o a apps, no.
  assert.deepEqual(frame("https://verify.walletconnect.org/abc"), { action: "allow" });
  assert.deepEqual(frame("http://tracker.example/"), { action: "block", reason: "scheme" });
  assert.deepEqual(frame(URI), { action: "block", reason: "frame_link" });
});

/** Página simulada: window con postMessage real (asíncrono, con source y origin) e iframes. */
function fakePage(origin = "https://www.saucerswap.finance") {
  const listeners = [];
  const sent = [];
  const queue = [];
  const win = {
    location: { origin },
    ReactNativeWebView: { postMessage: (s) => sent.push(s) },
    addEventListener: (type, fn) => type === "message" && listeners.push(fn),
  };
  win.window = win;
  win.parent = win; // página principal: su «padre» es ella misma
  const deliver = (data, source, from) => queue.push({ data: structuredClone(data), source, origin: from });
  let self = win; // dentro del contexto, «window» es el global del contexto
  win.postMessage = (data) => deliver(data, self, origin);
  const iframe = { postToParent: (data, from = "https://ads.example") => deliver(data, iframe, from) };
  const flush = () => {
    while (queue.length) {
      const e = queue.shift();
      for (const fn of [...listeners]) fn(e);
    }
  };
  const ctx = vm.createContext(win);
  self = vm.runInContext("window", ctx);
  return { win, ctx, sent, iframe, flush, listen: (fn) => listeners.push(fn) };
}

test("script del navegador: HashConnect y DAppConnector conectan; un iframe no", () => {
  const page = fakePage();
  const script = browserBridgeScript({ token: TOKEN, wallet: WALLET });
  vm.runInContext(script, page.ctx);
  vm.runInContext(script, page.ctx); // inyectado dos veces: no duplica

  // DAppConnector (hedera-wallet-connect): pregunta por carteras en iframe y recibe a Hvault.
  const found = [];
  page.listen((e) => e.data?.type === "hedera-iframe-response" && e.data.metadata && found.push(e.data.metadata));
  page.win.parent.postMessage({ type: "hedera-iframe-query" }, "*");
  page.flush();
  assert.equal(found.length, 1);
  assert.equal(found[0].id, "hvault");

  // …y entonces manda el enlace con «hedera-iframe-connect».
  page.win.parent.postMessage({ type: "hedera-iframe-connect", pairingString: URI }, "*");
  page.flush();
  assert.equal(page.sent.length, 1);
  assert.deepEqual(parseBridgeMessage(page.sent[0], TOKEN), { kind: "pair", uri: URI, via: "hedera" });

  // El mismo enlace otra vez (o por otro camino) no se repite.
  page.win.postMessage({ type: "hashconnect2-iframe-pairing", pairingString: URI }, "*");
  page.flush();
  assert.equal(page.sent.length, 1);

  // HashConnect v3: al abrir su ventana de conexión manda «hashconnect2-iframe-pairing» al padre.
  const uri2 = URI.replace(TOPIC, "c".repeat(64));
  page.win.parent.postMessage({ type: "hashconnect2-iframe-pairing", pairingString: uri2 }, "*");
  page.flush();
  assert.equal(page.sent.length, 2);
  assert.equal(parseBridgeMessage(page.sent[1], TOKEN)?.via, "hashconnect");

  // Un iframe de la página (un anuncio) intenta colar su propia conexión: se ignora.
  page.iframe.postToParent({ type: "hedera-iframe-connect", pairingString: URI.replace(TOPIC, "d".repeat(64)) });
  page.iframe.postToParent({ type: "hashconnect2-iframe-pairing", pairingString: URI.replace(TOPIC, "e".repeat(64)) }, "https://www.saucerswap.finance");
  page.flush();
  assert.equal(page.sent.length, 2);

  // Basura: tipos raros, enlaces sin clave, objetos vacíos.
  page.win.postMessage({ type: "hedera-iframe-connect", pairingString: `wc:${"f".repeat(64)}@2?x` }, "*");
  page.win.postMessage("hola", "*");
  page.win.postMessage(null, "*");
  page.flush();
  assert.equal(page.sent.length, 2);
});

test("avisos del script: solo con el código secreto de esta apertura", () => {
  const good = JSON.stringify({ hvault: TOKEN, kind: "pair", uri: URI, via: "hedera" });
  assert.deepEqual(parseBridgeMessage(good, TOKEN), { kind: "pair", uri: URI, via: "hedera" });
  assert.equal(parseBridgeMessage(good, "f".repeat(32)), null, "otro código");
  assert.equal(parseBridgeMessage(JSON.stringify({ kind: "pair", uri: URI, via: "hedera" }), TOKEN), null, "sin código");
  assert.equal(parseBridgeMessage(JSON.stringify({ hvault: TOKEN, kind: "sign", uri: URI, via: "hedera" }), TOKEN), null);
  assert.equal(parseBridgeMessage("{no json", TOKEN), null);
  assert.throws(() => browserBridgeScript({ token: "corto", wallet: WALLET }));
  // Lo que se mete en el script no puede cerrar la etiqueta ni romper la cadena.
  const s = browserBridgeScript({ token: TOKEN, wallet: { ...WALLET, name: "</script><b>" } });
  assert.equal(s.includes("</script>"), false);
});

test("propuestas abiertas desde el navegador: la página manda", () => {
  const ns = { hedera: { chains: [CHAIN_ID()], methods: ["hedera_signMessage"], events: [] } };
  const base = { requiredNamespaces: ns, chainId: CHAIN_ID(), lang: "es" };
  const unknown = { verified: { validation: "UNKNOWN", origin: "https://www.saucerswap.finance" } };

  // Sin navegador: dominio sin certificar, se avisa.
  const plain = vetProposal({ ...base, verifyContext: unknown, metadataUrl: "https://www.saucerswap.finance" });
  assert.equal(plain.ok && plain.verified, false);

  // Desde la página de SaucerSwap en Hvault: verificada por el navegador, sin aviso.
  const fromPage = vetProposal({ ...base, verifyContext: unknown, metadataUrl: "https://www.saucerswap.finance", openedFrom: "saucerswap" });
  assert.equal(fromPage.ok, true);
  assert.equal(fromPage.ok && fromPage.verified, true);
  assert.equal(fromPage.ok && fromPage.via, "browser");
  assert.equal(fromPage.ok && fromPage.warning, null);

  // La propuesta dice ser de otra dApp (o de una web fuera de la lista) que la página abierta: no.
  const other = vetProposal({ ...base, verifyContext: unknown, metadataUrl: "https://sentx.io", openedFrom: "saucerswap" });
  assert.equal(other.ok, false);
  assert.match(!other.ok ? other.message : "", /SentX.*SaucerSwap/);
  assert.equal(vetProposal({ ...base, verifyContext: unknown, metadataUrl: "https://evil.io", openedFrom: "saucerswap" }).ok, false);

  // Verify certifica otro origen que la página: no.
  const valid = { verified: { validation: "VALID", origin: "https://sentx.io" } };
  assert.equal(vetProposal({ ...base, verifyContext: valid, metadataUrl: "https://sentx.io", openedFrom: "saucerswap" }).ok, false);

  // Estafa o INVALID: no, aunque venga del navegador.
  assert.equal(vetProposal({ ...base, verifyContext: { verified: { isScam: true } }, metadataUrl: "https://www.saucerswap.finance", openedFrom: "saucerswap" }).ok, false);
  assert.equal(vetProposal({ ...base, verifyContext: { verified: { validation: "INVALID" } }, metadataUrl: "https://www.saucerswap.finance", openedFrom: "saucerswap" }).ok, false);

  // Datos de la dApp sin dirección válida: vale la página que cargó Hvault.
  const sloppy = vetProposal({ ...base, verifyContext: unknown, metadataUrl: "", openedFrom: "kabila" });
  assert.equal(sloppy.ok && sloppy.dapp.id, "kabila");

  // Una página que no es de la lista no puede usarse como prueba.
  assert.equal(vetProposal({ ...base, verifyContext: unknown, metadataUrl: "https://www.saucerswap.finance", openedFrom: "evil" }).ok, false);

  // Y la red sigue mandando.
  const mainnet = { hedera: { chains: ["hedera:mainnet"], methods: [], events: [] } };
  assert.equal(vetProposal({ ...base, requiredNamespaces: mainnet, verifyContext: unknown, metadataUrl: "https://www.saucerswap.finance", openedFrom: "saucerswap" }).ok, false);
});

function CHAIN_ID() {
  return "hedera:testnet";
}

test("0.9.4: si la dApp nos enseña como «HashPack · Detected» y pide conectar con otro ID de extensión, conecta H10X Wallet (solo desde la propia página)", () => {
  const page = fakePage();
  vm.runInContext(browserBridgeScript({ token: TOKEN, wallet: WALLET }), page.ctx);
  // ID de la extensión de HashPack (cualquier otro vale igual): la petición llega a H10X Wallet.
  page.win.postMessage({ type: "hedera-extension-connect-gjagmgiddbbciopjhllkdnddhcglnemk", pairingString: URI }, "*");
  page.flush();
  assert.equal(page.sent.length, 1);
  assert.deepEqual(parseBridgeMessage(page.sent[0], TOKEN), { kind: "pair", uri: URI, via: "hedera" });
  // Desde un iframe (un anuncio), nada.
  page.iframe.postToParent({ type: "hedera-extension-connect-gjagmgiddbbciopjhllkdnddhcglnemk", pairingString: URI.replace(TOPIC, "c".repeat(64)) });
  page.iframe.postToParent({ type: "hedera-extension-connect-x", pairingString: URI.replace(TOPIC, "b".repeat(64)) }, "https://www.saucerswap.finance");
  page.flush();
  assert.equal(page.sent.length, 1);
  // La pantalla explica qué elegir y avisa una vez si la web intenta abrir otra cartera.
  const screen = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app/src/screens/DappBrowser.tsx"), "utf8");
  assert.match(screen, /sale como detectada: es H10X Wallet/);
  assert.match(screen, /schemeWarned\.current = true/);
});
