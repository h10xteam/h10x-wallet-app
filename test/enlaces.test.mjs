// h10x14: enlaces que abren H10X Wallet para conectar (WalletGuide) y dApps fuera de la lista en la app.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WALLET_LINKS, wcUriFromWalletLink } from "../core/src/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const WC = `wc:${"a".repeat(64)}@2?relay-protocol=irn&symKey=${"b".repeat(64)}`;
const enc = encodeURIComponent(WC);

test("solo los enlaces propios abren una conexión (y siempre pasando por la hoja de conexión)", () => {
  assert.deepEqual(WALLET_LINKS, { native: "h10xwallet://", universal: "https://h10xindex.xyz/app" });
  for (const u of [`h10xwallet://wc?uri=${enc}`, `h10xwallet:///wc?uri=${enc}`, `https://h10xindex.xyz/app/wc?uri=${enc}`, `https://h10xindex.xyz/app?uri=${enc}`, `h10xwallet://wc?uri=${encodeURIComponent(enc)}`]) {
    assert.equal(wcUriFromWalletLink(u), WC, u);
  }
  for (const u of [
    `https://evil.xyz/app/wc?uri=${enc}`,
    `https://h10xindex.xyz.evil.io/app/wc?uri=${enc}`,
    `http://h10xindex.xyz/app/wc?uri=${enc}`,
    `https://h10xindex.xyz/otra/wc?uri=${enc}`,
    `hashpack://wc?uri=${enc}`,
    "h10xwallet://wc?requestId=1&sessionTopic=abc",
    `h10xwallet://wc?uri=${encodeURIComponent("wc:corto@2?symKey=1")}`,
    `h10xwallet://wc?uri=${enc}${"x".repeat(5000)}`,
    null,
  ]) {
    assert.equal(wcUriFromWalletLink(u), null, String(u).slice(0, 60));
  }
});

test("la app recoge esos enlaces (iOS y Android) y se presenta con ellos a las dApps", () => {
  const app = JSON.parse(read("app/app.json")).expo;
  assert.equal(app.scheme, "h10xwallet");
  assert.deepEqual(app.ios.associatedDomains, ["applinks:h10xindex.xyz"]);
  const f = app.android.intentFilters?.[0];
  assert.equal(f?.autoVerify, true);
  assert.deepEqual(f?.data, [{ scheme: "https", host: "h10xindex.xyz", pathPrefix: "/app" }]);
  const wc = read("app/src/walletconnect.tsx");
  assert.match(wc, /Linking\.getInitialURL\(\)/);
  assert.match(wc, /Linking\.addEventListener\("url"/);
  assert.match(wc, /const uri = wcUriFromWalletLink\(url\);/);
  assert.match(wc, /redirect: \{ native: WALLET_LINKS\.native, universal: WALLET_LINKS\.universal \}/);
  // Un enlace no conecta nada solo: llama a pair(), que lleva a la propuesta y sus comprobaciones.
  assert.match(wc, /pair\(uri\)\.catch/);
  assert.match(wc, /metadataName: p\.proposer\.metadata\.name/);
  assert.match(wc, /const dapp = meta \? dappById\(meta\.dappId\) : null;/);
});

test("dApps fuera de la lista: con su etiqueta y aviso, y nunca en el navegador interno", () => {
  const ui = read("app/src/screens/Dapps.tsx");
  assert.match(ui, /onPress=\{s\.dapp\.unlisted \? undefined : \(\) => onOpen\(s\.dapp\.id\)\}/);
  assert.match(ui, /prompt\.dapp\.unlisted \? <Badge text=\{t\("Fuera de la lista", "Not on the list"\)\} tone="warn" \/> : null/);
  assert.match(ui, /tone=\{prompt\.dapp\.unlisted && !prompt\.verified \? "danger" : "warn"\}/);
  // El navegador interno sigue limitado a la lista.
  assert.match(read("core/src/browser.js"), /if \(dappForUrl\(s\)\) return \{ action: "allow" \};/);
});
