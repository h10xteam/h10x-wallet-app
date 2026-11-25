// La app se llama H10X Wallet (antes Hvault). Lo que ve el usuario o una dApp ya no dice Hvault, pero los
// identificadores internos siguen igual: cambiarlos rompería contraseñas de desempate, avisos de robo firmados, las
// llaves guardadas en Expo Go o los datos del móvil.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { theftMessage } from "../core/src/wallet.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const walk = (dir) =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

// Los únicos «hvault» que quedan: claves de almacenamiento, el nombre de la protección de pantalla, el puente del
// navegador interno y las dos firmas.
const ALLOWED = [
  // testnet sigue en "hvault.wc.sessions.v1"; las demás redes, aparte (core/src/config.js → storageKeys)
  "`hvault.${ns}wc.sessions.v1`",
  '"hvault.prefs.v1"',
  '"hvault-palabras"',
  "__hvaultBridge",
  "msg.hvault",
  "m.hvault",
  "hvault-desempate-v1",
  "hvault-robo:v1",
];

test("nada visible dice Hvault: la app, el núcleo, app.json y los textos de iOS", () => {
  const files = [...walk("app/src"), ...walk("core/src"), "app/App.tsx", "app/app.json", "app/locales/es.json", "app/locales/en.json"];
  for (const f of files) {
    let s = read(f);
    for (const a of ALLOWED) s = s.split(a).join("");
    assert.doesNotMatch(s, /hvault|sslip/i, `${f} todavía dice Hvault o enlaza la web vieja`);
  }
});

test("app.json: nombre nuevo, mismo slug (Expo Go guarda las llaves por proyecto)", () => {
  const { expo } = JSON.parse(read("app/app.json"));
  assert.equal(expo.name, "H10X Wallet");
  assert.equal(expo.slug, "boveda", "con otro slug, Expo Go no encontraría las bóvedas de prueba ya creadas");
  assert.equal(expo.ios.bundleIdentifier, "xyz.h10xindex.wallet");
  assert.equal(expo.android.package, "xyz.h10xindex.wallet");
  // Bajo «ios»: si no, Expo también los pasa a Android como textos traducidos sin original y el lint de la compilación
  // de Android la para (ExtraTranslation).
  for (const l of ["es", "en"]) {
    const loc = JSON.parse(read(`app/locales/${l}.json`));
    assert.equal(loc.ios?.CFBundleDisplayName, "H10X Wallet");
    assert.deepEqual(Object.keys(loc), ["ios"], `app/locales/${l}.json: solo textos de iOS`);
  }
});

test("las dApps ven H10X Wallet, con la web y el icono de h10xindex.xyz", () => {
  const wc = read("app/src/walletconnect.tsx");
  assert.match(wc, /name: "H10X Wallet"/);
  assert.match(wc, /url: "https:\/\/h10xindex\.xyz"/);
  assert.match(wc, /icon: "https:\/\/h10xindex\.xyz\/icon-512\.png"/);
});

test("las firmas no cambian: desempate y aviso de robo", () => {
  assert.match(read("core/src/tiebreaker.js"), /const SALT_PREFIX = "hvault-desempate-v1:";/);
  assert.match(read("contracts/VaultNotary3.sol"), /hvault-desempate-v1/);
  assert.ok(theftMessage({ action: "a", vaultId: "0.0.1", notaryId: "0.0.2", timestamp: 1 }).startsWith("hvault-robo:v1|"));
});
