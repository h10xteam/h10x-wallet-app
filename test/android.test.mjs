// La app compilada para Android y la compilación con EAS.
//
// - Iconos: en Android, SymbolView solo dibuja si recibe un nombre de Material Symbols. Cada SF Symbol que usa la app
//   tiene que tener su equivalente en ANDROID_ICONS (app/src/ui.tsx); si no, saldría un círculo.
// - app.json / eas.json: la compilación de pruebas va a testnet, con el guardián público y sin comisiones.
// - Lo que se sube a EAS: nunca .env, datos ni código del guardián.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const walk = (dir) =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
/** Cadenas de una expresión, sin las de comparaciones («kind === "staking"» no es un icono). */
const literals = (s) => [...s.replace(/[!=]==\s*"[^"\n]*"/g, "").matchAll(/"([^"\n]+)"/g)].map((m) => m[1]);

/** Mapa SF Symbol → Material Symbol de app/src/ui.tsx. */
function androidIcons() {
  const ui = read("app/src/ui.tsx");
  const start = ui.indexOf("const ANDROID_ICONS");
  assert.ok(start > 0, "falta ANDROID_ICONS en app/src/ui.tsx");
  const block = ui.slice(start, ui.indexOf("};", start));
  const map = new Map();
  for (const m of block.matchAll(/^\s*(?:"([^"]+)"|([a-zA-Z0-9_]+))\s*:\s*"([^"]+)"/gm)) map.set(m[1] ?? m[2], m[3]);
  return map;
}

/** Nombres de icono que usa la app: name=/icon= (también en ternarios), «icon: "…"» y «const icon = …». */
function usedIcons() {
  const files = [...walk("app/src"), "app/App.tsx"].filter((f) => /\.tsx?$/.test(f));
  const used = new Map();
  const add = (name, file) => {
    if (!/^[a-z0-9]+(\.[a-z0-9]+)*$/.test(name)) return; // forma de SF Symbol (fuera URLs y textos)
    if (!used.has(name)) used.set(name, new Set());
    used.get(name).add(file);
  };
  for (const f of files) {
    const s = read(f);
    for (const m of s.matchAll(/\b(?:name|icon)=\{([^{}]*)\}/g)) for (const l of literals(m[1])) add(l, f);
    for (const m of s.matchAll(/\b(?:name|icon)="([^"]+)"/g)) add(m[1], f);
    for (const m of s.matchAll(/\bicon:\s*"([^"]+)"/g)) add(m[1], f);
    for (const m of s.matchAll(/\bconst icon\s*=\s*([^;\n]+)/g)) for (const l of literals(m[1])) add(l, f);
  }
  return used;
}

test("cada icono que usa la app tiene su equivalente en Android", () => {
  const map = androidIcons();
  const used = usedIcons();
  assert.ok(used.size > 40, `solo encuentro ${used.size} iconos: ¿ha cambiado la forma de usarlos?`);
  const missing = [...used.keys()].filter((n) => !map.has(n)).map((n) => `${n} (${[...used.get(n)].join(", ")})`);
  assert.deepEqual(missing, [], `iconos sin equivalente en Android:\n  ${missing.join("\n  ")}`);
});

test("los iconos de Android existen en Material Symbols", (t) => {
  const file = path.join(ROOT, "node_modules/expo-symbols/build/android/symbols.json");
  if (!fs.existsSync(file)) return t.skip("sin node_modules/expo-symbols");
  const known = new Set(Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))));
  const bad = [...androidIcons()].filter(([, a]) => !known.has(a)).map(([sf, a]) => `${sf} → ${a}`);
  assert.deepEqual(bad, [], `no existen en Material Symbols: ${bad.join(", ")}`);
  assert.ok(known.has("circle"), "el icono de reserva («circle») tiene que existir");
});

test("Android: barra de pestañas opaca, «biometría» en vez de Face ID y canal de avisos", () => {
  const ui = read("app/src/ui.tsx");
  assert.match(ui, /Platform\.OS === "android"\) return <View style=\{\[styles\.tabBar, styles\.tabBarSolid\]\}/);
  const i18n = read("app/src/i18n.ts");
  assert.match(i18n, /Platform\.OS === "android"/);
  assert.match(i18n, /biometr/);
  const wallet = read("app/src/wallet.tsx");
  assert.match(wallet, /setNotificationChannelAsync\("default"/);
  assert.match(wallet, /AndroidImportance\.HIGH/);
});

test("app.json: sin copias de seguridad, sin permisos de más e icono de avisos blanco de 96×96", () => {
  const { expo } = JSON.parse(read("app/app.json"));
  assert.equal(expo.android.package, "xyz.h10xindex.wallet");
  assert.equal(expo.ios.bundleIdentifier, "xyz.h10xindex.wallet");
  assert.equal(expo.android.allowBackup, false, "las llaves no pueden acabar en una copia de Google");
  for (const p of ["RECORD_AUDIO", "SYSTEM_ALERT_WINDOW", "READ_EXTERNAL_STORAGE", "WRITE_EXTERNAL_STORAGE"]) {
    assert.ok(expo.android.blockedPermissions.includes(`android.permission.${p}`), `falta bloquear ${p}`);
  }
  const notif = expo.plugins.find((p) => Array.isArray(p) && p[0] === "expo-notifications");
  assert.ok(notif, "expo-notifications sin configurar");
  const png = fs.readFileSync(path.join(ROOT, "app", notif[1].icon));
  assert.equal(png.toString("ascii", 1, 4), "PNG");
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [96, 96]);
  assert.equal(png[25], 6, "el icono de avisos necesita transparencia (RGBA)");
  assert.equal(expo.extra?.eas?.projectId, undefined, "el ID de EAS no va en el paquete: se pone al compilar");
});

test("eas.json: TestFlight y el APK de pruebas van a testnet, con el guardián público y sin comisiones", () => {
  const eas = JSON.parse(read("app/eas.json"));
  assert.match(eas.cli.version, /27\.2\.0/);
  assert.equal(eas.cli.appVersionSource, "remote");
  const profile = (name) => {
    const p = eas.build[name];
    assert.ok(p, `falta el perfil ${name}`);
    return { ...eas.build[p.extends ?? ""], ...p, env: { ...(eas.build[p.extends ?? ""]?.env ?? {}), ...(p.env ?? {}) } };
  };
  for (const name of ["testflight", "android-apk"]) {
    const p = profile(name);
    assert.equal(p.env.EXPO_PUBLIC_HEDERA_NETWORK, "testnet", `${name}: testnet`);
    assert.equal(p.env.EXPO_PUBLIC_GUARDIAN_URL, "https://guardian.h10xindex.xyz", `${name}: guardián público`);
    assert.match(p.env.EXPO_PUBLIC_WC_PROJECT_ID, /^[0-9a-f]{32}$/);
    assert.equal(p.env.EXPO_PUBLIC_FEE_COLLECTOR, undefined, `${name}: las comisiones siguen apagadas`);
    assert.equal(p.autoIncrement, true);
  }
  assert.equal(profile("testflight").distribution, "store");
  assert.equal(profile("android-apk").android.buildType, "apk");
  assert.equal(profile("android-play").android.buildType, "app-bundle");
  assert.equal(eas.submit["android-play"].android.track, "internal");
  // Los de mainnet (android-apk-mainnet, testflight-mainnet y android-play, la de la tienda) en test/mainnet.test.mjs.
  assert.equal(profile("android-play").extends, "base-mainnet");
});
