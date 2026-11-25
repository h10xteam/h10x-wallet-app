// Aviso de emergencia y topes de la beta, SIN red: el núcleo (limpieza), el script del aviso y el guardián real
// (proceso aparte, con nodo y mirror simulados) publicándolos en /notice e /info.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AccountCreateTransaction, AccountId, Hbar, PrivateKey } from "@hiero-ledger/sdk";
import { HBAR, NOTICE_MAX_TEXT, cleanLimits, cleanNotice, cleanNoticeText, createClient, readNoticeFile, submit, vaultRoom } from "@boveda/core";
import { startFakeNetwork } from "./sim/fake-network.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GUARDIAN_PORT = 18791;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Limpieza del aviso ---------------------------------------------------------------------------

test("el aviso solo lleva texto: sin enlaces, cuentas, direcciones ni caracteres de control", () => {
  const es = cleanNoticeText("Evacúa ya a la cuenta 0.0.12345 o entra en https://h10x-rescate.com‮ ¡rápido!", "es");
  assert.doesNotMatch(es, /0\.0\.12345|https?:|h10x-rescate\.com|‮/);
  assert.match(es, /\[cuenta oculta\]/);
  const en = cleanNoticeText("Send to 0x1234567890abcdef1234567890abcdef12345678 now", "en");
  assert.match(en, /\[address hidden\]/);
  assert.doesNotMatch(en, /0x1234/);
  const spaced = cleanNoticeText("cuenta 0. 0. 98765 y web h10x . com", "es");
  assert.doesNotMatch(spaced, /98765/);
  assert.doesNotMatch(spaced, /h10x \. com/);
  assert.equal(cleanNoticeText("x".repeat(1000), "es").length, NOTICE_MAX_TEXT);
  assert.equal(cleanNoticeText(42, "es"), "");
});

test("un aviso que no vale se descarta", () => {
  const ok = { id: "evacuar-202611190800", level: "evacuar", es: "Hemos encontrado un fallo.", en: "We found a bug.", at: 1795000000 };
  assert.deepEqual(cleanNotice(ok), ok);
  assert.equal(cleanNotice({ ...ok, level: "panico" }), null);
  assert.equal(cleanNotice({ ...ok, id: "../../etc" }), null);
  assert.equal(cleanNotice({ ...ok, id: "abc" }), null);
  assert.equal(cleanNotice({ ...ok, es: "", en: "" }), null);
  assert.equal(cleanNotice(null), null);
  assert.equal(cleanNotice("evacuar"), null);
  // Con un solo idioma, el otro usa el mismo texto.
  assert.equal(cleanNotice({ ...ok, en: "" })?.en, ok.es);
  assert.equal(cleanNotice({ ...ok, at: "ayer" })?.at, 0);
  assert.equal(readNoticeFile(() => "{no es json", "x"), null);
  assert.equal(
    readNoticeFile(() => {
      throw new Error("ENOENT");
    }, "x"),
    null,
  );
});

test("topes de la beta", () => {
  assert.deepEqual(cleanLimits({ maxVaultHbar: "1000", maxVaults: 50.7 }), { maxVaultHbar: 1000, maxVaults: 50 });
  assert.deepEqual(cleanLimits({ maxVaultHbar: -5, maxVaults: "muchas" }), { maxVaultHbar: 0, maxVaults: 0 });
  assert.deepEqual(cleanLimits(undefined), { maxVaultHbar: 0, maxVaults: 0 });
  assert.equal(vaultRoom(5n * HBAR, 0), null, "0 = sin tope");
  assert.equal(vaultRoom(null, 1000), 1000n * HBAR);
  assert.equal(vaultRoom(400n * HBAR, 1000), 600n * HBAR);
  assert.equal(vaultRoom(1200n * HBAR, 1000), 0n, "pasado del tope, no cabe nada (nunca negativo)");
});

test("la app no deja guardar por encima del tope (Guardar y Crear la bóveda)", () => {
  const actions = readFileSync(join(ROOT, "app/src/screens/Actions.tsx"), "utf8");
  assert.match(actions, /const room = isHbar \? vaultRoom\(balances\.vault, limits\.maxVaultHbar\) : null;/);
  assert.match(actions, /const ok = enough && !tokensBlocked && !overCap;/);
  const onboarding = readFileSync(join(ROOT, "app/src/screens/Onboarding.tsx"), "utf8");
  assert.match(onboarding, /const overCap = room != null && deposit > room;/);
  assert.match(onboarding, /const valid = deposit >= 0n && !overCap/);
  const home = readFileSync(join(ROOT, "app/src/screens/Home.tsx"), "utf8");
  assert.match(home, /<GuardianNoticeCard go=\{go\} \/>/);
  assert.match(home, /onPress=\{\(\) => go\("evacuate"\)\}/, "el aviso solo lleva a la pantalla de Evacuar de la app");
  const status = readFileSync(join(ROOT, "app/src/guardianStatus.tsx"), "utf8");
  assert.match(status, /cleanNotice\(body\?\.notice\)/, "la app vuelve a limpiar lo que manda el servidor");
  assert.match(status, /notice\.level === "evacuar" \|\| !dismissed\.includes/, "el de evacuar no se puede cerrar");
});

// ---- Script del aviso (scripts/aviso.mjs) -----------------------------------------------------------

test("hvault-vps aviso: poner, ver y quitar", () => {
  const box = mkdtempSync(join(tmpdir(), "aviso-"));
  try {
    // Copia del script con el núcleo real al lado y un guardian/.env que solo dice DATA_DIR.
    mkdirSync(join(box, "scripts"));
    mkdirSync(join(box, "guardian"));
    copyFileSync(join(ROOT, "scripts/aviso.mjs"), join(box, "scripts/aviso.mjs"));
    symlinkSync(join(ROOT, "core"), join(box, "core"));
    const data = join(box, "datos");
    writeFileSync(join(box, "guardian/.env"), `OPERATOR_KEY=no-se-lee\nDATA_DIR=${data}\n`);
    const run = (...args) => spawnSync(process.execPath, [join(box, "scripts/aviso.mjs"), ...args], { encoding: "utf8" });

    assert.match(run("ver").stdout, /Sin aviso puesto/);
    const put = run("poner", "evacuar", "Fallo encontrado: evacúa a 0.0.666 en https://falso.com", "Bug found: evacuate");
    assert.equal(put.status, 0, put.stderr);
    assert.doesNotMatch(put.stdout, /no-se-lee/, "no enseña nada más del .env");
    const file = join(data, "aviso.json");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(saved.level, "evacuar");
    assert.match(saved.id, /^evacuar-\d{12}$/);
    assert.doesNotMatch(saved.es, /0\.0\.666|falso\.com/);
    assert.match(run("ver").stdout, /nivel evacuar/);

    assert.notEqual(run("poner", "panico", "x", "y").status, 0);
    assert.notEqual(run("poner", "info", "", "").status, 0);
    assert.equal(run("quitar").status, 0);
    assert.match(run("ver").stdout, /Sin aviso puesto/);
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
});

// ---- Guardián real ---------------------------------------------------------------------------------

let net;
let guardian;
let guardianLog = "";
let dataDir;

before(async () => {
  const operatorKey = PrivateKey.generateED25519();
  const guardianKey = PrivateKey.generateED25519();
  net = await startFakeNetwork({ operatorNum: 1001, operatorKey: operatorKey.publicKey });
  const op = createClient("local", { accountId: new AccountId(1001), key: operatorKey });
  const created = await submit(op, new AccountCreateTransaction().setKeyWithoutAlias(guardianKey.publicKey).setInitialBalance(new Hbar(50)));
  op.close();
  dataDir = mkdtempSync(join(tmpdir(), "guardian-aviso-"));
  guardian = spawn(process.execPath, ["guardian/src/index.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      HEDERA_NETWORK: "local",
      MIRROR_URL: "http://127.0.0.1:5551",
      OPERATOR_KEY: guardianKey.toStringDer(),
      OPERATOR_ID: created.receipt.accountId.toString(),
      PORT: String(GUARDIAN_PORT),
      DATA_DIR: dataDir,
      POLL_SECONDS: "2",
      MAX_VAULT_HBAR: "1000",
      MAX_VAULTS: "50",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  guardian.stdout.on("data", (d) => (guardianLog += d));
  guardian.stderr.on("data", (d) => (guardianLog += d));
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${GUARDIAN_PORT}/health`)).ok) break;
    } catch {
      // aún arrancando
    }
    if (i > 60) throw new Error(`el guardián no arranca\n${guardianLog}`);
    await sleep(500);
  }
});

after(async () => {
  // Se espera a que el guardián termine: si no, puede seguir escribiendo su estado mientras se borra la carpeta
  // (fallaba de vez en cuando con ENOTEMPTY).
  if (guardian && guardian.exitCode == null) {
    const gone = new Promise((r) => guardian.once("exit", r));
    guardian.kill("SIGTERM");
    await Promise.race([gone, sleep(5000)]);
  }
  net?.stop();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const get = async (p) => (await fetch(`http://127.0.0.1:${GUARDIAN_PORT}${p}`)).json();
async function until(what, fn) {
  for (let i = 0; i < 40; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  throw new Error(`tiempo agotado: ${what}\n${guardianLog}`);
}

test("el guardián publica los topes y el aviso, limpio, y lo quita al borrarlo", async () => {
  const info = await get("/info");
  assert.deepEqual(info.limits, { maxVaultHbar: 1000, maxVaults: 50 });
  assert.equal(info.notice, null);
  assert.deepEqual(await get("/notice"), { notice: null, limits: { maxVaultHbar: 1000, maxVaults: 50 } });

  // Aunque alguien escriba el fichero a mano con un enlace y una cuenta, sale limpio.
  writeFileSync(
    join(dataDir, "aviso.json"),
    JSON.stringify({ id: "evacuar-202611190900", level: "evacuar", es: "Evacúa a 0.0.4242 desde https://falso.example", en: "Evacuate now", at: 1795000000 }),
  );
  const { notice } = await until("aviso publicado", async () => ((await get("/notice")).notice ? get("/notice") : null));
  assert.equal(notice.id, "evacuar-202611190900");
  assert.equal(notice.level, "evacuar");
  assert.doesNotMatch(notice.es, /0\.0\.4242|falso\.example/);
  assert.match(guardianLog, /aviso de emergencia «evacuar-202611190900» \(evacuar\) → 0 bóvedas/);
  const state = JSON.parse(readFileSync(join(dataDir, "state.json"), "utf8"));
  assert.equal(state.noticeSent, "evacuar-202611190900", "se manda una sola vez");

  // Un fichero roto no tumba al guardián: simplemente no hay aviso.
  writeFileSync(join(dataDir, "aviso.json"), "{roto");
  await until("aviso roto ignorado", async () => (await get("/notice")).notice === null);
  rmSync(join(dataDir, "aviso.json"));
  await until("aviso quitado", async () => (await get("/info")).notice === null);
  assert.ok((await fetch(`http://127.0.0.1:${GUARDIAN_PORT}/health`)).ok);
});
