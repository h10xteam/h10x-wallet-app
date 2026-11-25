// h10x13: el kit recién creado no se pierde si la app se bloquea o se cierra mientras se apunta, y el refresco
// periódico no enseña la rueda de carga. Comprobaciones sobre el código de la app (no hay móvil en las pruebas).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

test("el bloqueo con Face ID va encima de la app sin desmontarla (no se pierde lo que hay en pantalla)", () => {
  const lock = read("app/src/LockGate.tsx");
  // Ya no hay un return temprano que sustituya a la app por la pantalla de bloqueo.
  assert.doesNotMatch(lock, /if \(enabled && locked\) \{\s*return/);
  assert.match(lock, /const showLock = enabled && locked;/);
  assert.match(lock, /pointerEvents=\{showLock \? "none" : "auto"\}/);
  assert.match(lock, /importantForAccessibility=\{showLock \? "no-hide-descendants" : "auto"\}/);
  // Los avisos de dApps (ventanas modales) solo con la app desbloqueada.
  assert.match(lock, /\{unlockedOnly\}/);
  assert.match(read("app/App.tsx"), /<LockGate enabled=\{!!profile && prefs\.appLock\} unlockedOnly=\{<DappPrompt \/>\}>/);
});

test("el kit queda guardado (solo este móvil y detrás de Face ID) hasta comprobarlo, y entonces se borra", () => {
  const st = read("app/src/storage.ts");
  assert.match(st, /const KIT_KEY = POCKET_KEY\.replace\("pocketKey", "kitPending"\);/);
  // 0.10: cada wallet guarda lo suyo (walletStorage); las funciones son las mismas, dentro.
  const store = st.slice(st.indexOf("async function storePendingKit"), st.indexOf("async function readPendingKit"));
  assert.ok(store.length > 0);
  assert.match(store, /WHEN_UNLOCKED_THIS_DEVICE_ONLY/);
  assert.match(store, /requireAuthentication: biometric/);
  // Al borrar la wallet o empezar de cero, el kit guardado también se va.
  assert.match(st.slice(st.indexOf("async function wipeWallet"), st.indexOf("async function clearStaleKey")), /await clearPendingKit\(\);/);
  assert.match(st.slice(st.indexOf("async function clearStaleKey")), /await clearPendingKit\(\);/);
  const w = read("app/src/wallet.tsx");
  // Se guarda al pasar a la v2 y al crear la bóveda con un kit sin comprobar (desde la 0.9.4 se comprueba antes de
  // crearla, y entonces no se guarda)…
  assert.equal(w.match(/const kitPending = await keepPendingKit\(/g)?.length, 1);
  assert.match(w, /const kitPending = checked \? false : await keepPendingKit\(/);
  // …y se borra al comprobarlo.
  const confirm = w.slice(w.indexOf("const confirmRecovery = useCallback"), w.indexOf("const openPendingKit = useCallback"));
  assert.match(confirm, /await store\.clearPendingKit\(\);/);
  assert.match(confirm, /recoveryConfirmed: true, kitPending: false/);
  // Solo se enseña el kit de la bóveda actual.
  assert.match(w, /kit && kit\.vaultId === p\.vault\.accountId \? kit : null/);
});

test("crear la bóveda de nuevo solo con el kit perdido y la bóveda vacía; la Cartera no se toca", () => {
  const w = read("app/src/wallet.tsx");
  const r = w.slice(w.indexOf("const restartVault = useCallback"), w.indexOf("/** Envío desde la cartera"));
  assert.match(r, /if \(!lostKit && \(p\.recoveryConfirmed \|\| p\.kitPending\)\) throw/);
  assert.match(r, /if \(p\.pendingRecovery\) throw/);
  assert.match(r, /await store\.clearPendingKit\(\);/);
  assert.match(r, /vault\.balance > 5_000_000n \|\| tokens\.some\(\(x\) => x\.balance > 0n\) \|\| nfts\.length > 0/);
  assert.match(r, /legacyVaults: \[\.\.\.\(p\.legacyVaults \?\? \[\]\), id\]/);
  assert.doesNotMatch(r, /pocket:|wipeWallet|clearStaleKey/, "no toca la Cartera ni su llave");
  const home = read("app/src/screens/Home.tsx");
  assert.match(home, /profile\.kitPending \? \(/);
  assert.match(home, /await restartVault\(\);/);
});

test("el refresco de cada 10 s va en silencio: la rueda solo al deslizar", () => {
  const w = read("app/src/wallet.tsx");
  const once = w.slice(w.indexOf("const refreshOnce = useCallback"), w.indexOf("const refreshRun = useRef"));
  assert.doesNotMatch(once, /setRefreshing/);
  const pull = w.slice(w.indexOf("const pullRefresh = useCallback"), w.indexOf("const pullRefresh = useCallback") + 300);
  assert.match(pull, /setRefreshing\(true\)/);
  for (const f of ["Home", "Nfts", "Swap", "Onboarding", "Account", "H10x"]) {
    const src = read(`app/src/screens/${f}.tsx`);
    assert.doesNotMatch(src, /onRefresh=\{\(\) => void refresh\(\)\}/, `${f}: deslizar usa pullRefresh`);
    assert.match(src, /pullRefresh\(\)/, f);
  }
});

test("«Hacer un kit nuevo»: sacar todo con la cuenta atrás y crear otra bóveda; nunca un cambio de llaves solo con el móvil", async () => {
  const nk = read("app/src/screens/NewKit.tsx");
  assert.match(nk, /disabled=\{!empty\}/, "solo con la bóveda vacía");
  assert.match(nk, /await restartVault\(\{ lostKit: true \}\);/);
  assert.doesNotMatch(nk, /AccountUpdateTransaction|setKey|keyChange/);
  const settings = read("app/src/screens/Actions.tsx");
  assert.match(settings, /title=\{t\("Hacer un kit nuevo", "Make a new kit"\)\}/);
  assert.match(read("app/App.tsx"), /case "newKit":/);
  // El guardián sigue bloqueando los cambios de llaves pedidos por el carril del móvil.
  const { allowedInWithdrawLane } = await import("../core/src/index.js");
  assert.equal(allowedInWithdrawLane({ kind: "keyChange", account: "0.0.5" }, "0.0.5"), false);
});
