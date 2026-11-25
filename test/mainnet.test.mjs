// Beta en mainnet (h10x8): red, datos del móvil separados por red, topes, dApp de H10X, perfiles de EAS, guardián con
// topes obligatorios y los scripts del VPS. Sin red: el guardián habla con un mirror de mainnet simulado (HTTP local).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@hiero-ledger/sdk";
import { MAINNET_BETA, NETWORKS, createClient, dappForUrl, dappsFor, effectiveCap, storageKeys, vaultRoom, HBAR } from "@boveda/core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("mainnet está en la configuración, sin faucet, y el cliente es de mainnet", () => {
  assert.equal(NETWORKS.mainnet.mirror, "https://mainnet-public.mirrornode.hedera.com");
  assert.equal(NETWORKS.mainnet.hashscan, "https://hashscan.io/mainnet");
  assert.equal(NETWORKS.mainnet.faucet, null);
  const c = createClient("mainnet");
  assert.ok(c.ledgerId?.isMainnet(), "Client.forName('mainnet')");
  c.close();
});

test("los datos del móvil van por red: testnet con los nombres de siempre, mainnet aparte", () => {
  assert.deepEqual(storageKeys("testnet"), { profile: "boveda.profile.v1", pocketKey: "boveda.pocketKey.v1", wcSessions: "hvault.wc.sessions.v1" });
  const m = storageKeys("mainnet");
  assert.deepEqual(m, { profile: "boveda.mainnet.profile.v1", pocketKey: "boveda.mainnet.pocketKey.v1", wcSessions: "hvault.mainnet.wc.sessions.v1" });
  for (const k of Object.keys(m)) assert.notEqual(m[k], storageKeys("testnet")[k]);
  // SecureStore solo admite letras, números, «.», «-» y «_».
  for (const v of Object.values(m)) assert.match(v, /^[\w.-]+$/);
});

test("la app lee el perfil solo si es de su red y guarda con las claves de su red", () => {
  const src = readFileSync(join(ROOT, "app/src/storage.ts"), "utf8");
  assert.match(src, /storageKeys\(NETWORK\)/);
  assert.match(src, /p\?\.network === NETWORK \? p : null/);
  assert.doesNotMatch(src, /"boveda\.profile\.v1"/, "sin nombres fijos");
  assert.match(readFileSync(join(ROOT, "app/src/walletconnect.tsx"), "utf8"), /storageKeys\(NETWORK\)\.wcSessions/);
  // WalletConnect en mainnet pide hedera:mainnet (antes caía en testnet).
  assert.match(readFileSync(join(ROOT, "app/src/env.ts"), "utf8"), /NETWORK === "mainnet" \? "hedera:mainnet"/);
});

test("tope de la beta: manda el más bajo entre la compilación y el guardián", () => {
  assert.equal(effectiveCap(1000, 0), 1000, "guardián sin tope o caído");
  assert.equal(effectiveCap(1000, 500), 500);
  assert.equal(effectiveCap(1000, 5000), 1000, "el guardián no puede subir el de la app");
  assert.equal(effectiveCap(0, 200), 200, "testnet: solo el del guardián");
  assert.equal(effectiveCap(0, 0), 0);
  assert.equal(effectiveCap(Number.NaN, -3), 0);
  assert.equal(vaultRoom(900n * HBAR, effectiveCap(MAINNET_BETA.maxVaultHbar, 0)), 100n * HBAR);
});

test("la web de H10X es una dApp de la lista solo en mainnet", () => {
  assert.ok(!dappsFor("testnet").some((d) => d.id === "h10x"));
  assert.ok(dappsFor("mainnet").some((d) => d.id === "h10x"));
  assert.equal(dappsFor("testnet").length + 1, dappsFor("mainnet").length);
  assert.equal(dappForUrl("https://h10xindex.xyz/#dao")?.id, "h10x");
  assert.equal(dappForUrl("https://h10xindex.xyz.evil.com/"), null);
});

test("perfiles de EAS: los de mainnet apuntan a mainnet, su guardián y su tope; los de testnet no cambian", () => {
  const eas = JSON.parse(readFileSync(join(ROOT, "app/eas.json"), "utf8"));
  const envOf = (name) => {
    const p = eas.build[name];
    return { ...(p.extends ? envOf(p.extends) : {}), ...(p.env ?? {}) };
  };
  for (const name of ["android-apk-mainnet", "testflight-mainnet", "android-play"]) {
    const env = envOf(name);
    assert.equal(env.EXPO_PUBLIC_HEDERA_NETWORK, "mainnet", name);
    assert.equal(env.EXPO_PUBLIC_GUARDIAN_URL, "https://guardian.h10xindex.xyz/mainnet", name);
    assert.ok(Number(env.EXPO_PUBLIC_MAX_VAULT_HBAR) > 0, name);
    assert.ok(!env.EXPO_PUBLIC_FEE_COLLECTOR, "comisiones apagadas");
  }
  assert.equal(eas.build["android-apk-mainnet"].android.buildType, "apk");
  for (const name of ["android-apk", "testflight"]) {
    assert.equal(envOf(name).EXPO_PUBLIC_HEDERA_NETWORK, "testnet", name);
    assert.equal(envOf(name).EXPO_PUBLIC_GUARDIAN_URL, "https://guardian.h10xindex.xyz", name);
  }
});

/** Lanza el guardián con un .env vacío (para no leer ninguno de la carpeta) y las variables dadas. */
function runGuardian(env, { wait = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "guardian-mainnet-"));
  const envFile = join(dir, "vacio.env");
  writeFileSync(envFile, "");
  const base = { PATH: process.env.PATH, HOME: process.env.HOME, DOTENV_CONFIG_PATH: envFile, DATA_DIR: join(dir, "data"), H10X_ALERTS: "0" };
  if (!wait) {
    const r = spawnSync(process.execPath, ["guardian/src/index.js"], { cwd: ROOT, env: { ...base, ...env }, encoding: "utf8", timeout: 20000 });
    rmSync(dir, { recursive: true, force: true });
    return r;
  }
  const child = spawn(process.execPath, ["guardian/src/index.js"], { cwd: ROOT, env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  return { child, dir };
}

test("el guardián de mainnet no arranca sin los topes de la beta", () => {
  const key = PrivateKey.generateECDSA().toStringDer();
  const sinNada = runGuardian({ HEDERA_NETWORK: "mainnet", OPERATOR_KEY: key });
  assert.equal(sinNada.status, 1);
  assert.match(sinNada.stderr, /MAX_VAULT_HBAR/);
  assert.match(sinNada.stderr, /MAX_VAULTS/);
  const sinBovedas = runGuardian({ HEDERA_NETWORK: "mainnet", OPERATOR_KEY: key, MAX_VAULT_HBAR: "1000" });
  assert.equal(sinBovedas.status, 1);
  assert.match(sinBovedas.stderr, /MAX_VAULTS/);
  assert.doesNotMatch(sinBovedas.stderr, /MAX_VAULT_HBAR \(/);
  const demasiado = runGuardian({ HEDERA_NETWORK: "mainnet", OPERATOR_KEY: key, MAX_VAULT_HBAR: String(MAINNET_BETA.guardianMaxVaultHbar + 1), MAX_VAULTS: "25" });
  assert.equal(demasiado.status, 1);
  assert.match(demasiado.stderr, /MAX_VAULT_HBAR/);
  const rara = runGuardian({ HEDERA_NETWORK: "otra", OPERATOR_KEY: key });
  assert.equal(rara.status, 1);
});

test("con los topes, el guardián de mainnet arranca y los publica (mirror de mainnet simulado)", async () => {
  const key = PrivateKey.generateECDSA();
  const evm = `0x${key.publicKey.toEvmAddress()}`;
  const account = { account: "0.0.900001", evm_address: evm, balance: { balance: 5_000_000_000, tokens: [] }, key: null, deleted: false };
  const mirror = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === `/api/v1/accounts/${evm}` || u.pathname === "/api/v1/accounts/0.0.900001") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(account));
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((r) => mirror.listen(18796, "127.0.0.1", r));
  const { child, dir } = runGuardian(
    { HEDERA_NETWORK: "mainnet", OPERATOR_KEY: key.toStringDer(), MIRROR_URL: "http://127.0.0.1:18796", PORT: "18795", MAX_VAULT_HBAR: "1000", MAX_VAULTS: "25", POLL_SECONDS: "3" },
    { wait: true },
  );
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  try {
    let info = null;
    for (let i = 0; i < 60 && !info; i++) {
      await sleep(250);
      try {
        const r = await fetch("http://127.0.0.1:18795/info");
        if (r.ok) info = await r.json();
      } catch {
        // arrancando
      }
    }
    assert.ok(info, `no arranca:\n${log}`);
    assert.equal(info.network, "mainnet");
    assert.equal(info.account, "0.0.900001");
    assert.deepEqual(info.limits, { maxVaultHbar: 1000, maxVaults: 25 });
    assert.match(log, /MAINNET \(beta\): tope 1000 HBAR por bóveda, 25 bóvedas como mucho; presupuesto diario por bóveda 10\/10\/4/);
    const notice = await (await fetch("http://127.0.0.1:18795/notice")).json();
    assert.deepEqual(notice.limits, { maxVaultHbar: 1000, maxVaults: 25 });
  } finally {
    child.kill("SIGTERM");
    mirror.close();
    await sleep(200);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preparar el guardián de mainnet: clave nueva, 600, topes y sin enseñar la clave", () => {
  const dir = mkdtempSync(join(tmpdir(), "gm-preparar-"));
  writeFileSync(join(dir, ".env"), "PORT=8797\nEMAIL_PROVIDER=archivo\nOPERATOR_KEY=clave-de-testnet-que-no-se-copia\nSAUCERSWAP_API_KEY=sk-secreta\n");
  const run = () => spawnSync(process.execPath, ["scripts/guardian-mainnet.mjs", "preparar"], { cwd: ROOT, env: { ...process.env, HVAULT_GUARDIAN_DIR: dir }, encoding: "utf8" });
  try {
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    const file = join(dir, ".env.mainnet");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const text = readFileSync(file, "utf8");
    const key = /^OPERATOR_KEY=(.+)$/m.exec(text)?.[1];
    assert.ok(key && key.length > 40);
    assert.ok(!r.stdout.includes(key) && !r.stderr.includes(key), "la clave no se imprime");
    assert.ok(!r.stdout.includes("sk-secreta"), "lo copiado tampoco");
    assert.match(text, /^HEDERA_NETWORK=mainnet$/m);
    assert.match(text, /^PORT=8798$/m);
    assert.match(text, /^DATA_DIR=data-mainnet$/m);
    assert.match(text, new RegExp(`^MAX_VAULT_HBAR=${MAINNET_BETA.maxVaultHbar}$`, "m"));
    assert.match(text, /^MAX_VAULTS=25$/m);
    assert.match(text, /^SAUCERSWAP_API_KEY=sk-secreta$/m);
    assert.doesNotMatch(text, /clave-de-testnet/);
    const evm = `0x${PrivateKey.fromStringDer(key).publicKey.toEvmAddress()}`;
    assert.ok(r.stdout.includes(evm), "dice a qué dirección mandar HBAR");
    // Una segunda vez no la cambia.
    const again = run();
    assert.equal(again.status, 0);
    assert.equal(readFileSync(file, "utf8"), text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("el aviso de emergencia se puede poner aparte para mainnet", () => {
  const dir = mkdtempSync(join(tmpdir(), "gm-aviso-"));
  const run = (...args) => spawnSync(process.execPath, ["scripts/aviso.mjs", ...args], { cwd: ROOT, env: { ...process.env, HVAULT_GUARDIAN_DIR: dir }, encoding: "utf8" });
  try {
    assert.equal(run("poner", "info", "Prueba de mainnet", "Mainnet test", "--mainnet").status, 0);
    assert.ok(existsSync(join(dir, "data-mainnet", "aviso.json")));
    assert.ok(!existsSync(join(dir, "data", "aviso.json")), "no toca el de testnet");
    assert.equal(run("poner", "info", "Prueba", "Test").status, 0);
    assert.ok(existsSync(join(dir, "data", "aviso.json")));
    assert.equal(run("quitar", "--mainnet").status, 0);
    assert.ok(!existsSync(join(dir, "data-mainnet", "aviso.json")));
    assert.ok(existsSync(join(dir, "data", "aviso.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("la app de mainnet: aviso de beta, sin plazos de prueba y bóveda solo con guardián", () => {
  const onb = readFileSync(join(ROOT, "app/src/screens/Onboarding.tsx"), "utf8");
  assert.match(onb, /MainnetBetaCard/);
  assert.match(onb, /disabled=\{!accepted\}/);
  assert.match(onb, /allowTestDelays \? \(/);
  const w = readFileSync(join(ROOT, "app/src/wallet.tsx"), "utf8");
  assert.match(w, /if \(isMainnet && !guardian\)/);
  assert.match(w, /allowTest: allowTestDelays/);
  assert.doesNotMatch(w, /allowTest: true/);
});
