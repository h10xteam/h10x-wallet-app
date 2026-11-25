// DeRec, paso 2 (testnet): la parte de confianza, como hvault. La caja aislada de DeRec no ve ninguna llave de Hvault.
//
//   preparar: crea una Cartera de TESTNET de usar y tirar (ECDSA, 2 HBAR que paga la cuenta de guardian/.env) y saca
//             por stdout {secretHex, config, accountId} hacia la caja. Guarda esa llave de prueba en data/ (600) por si la
//             caja falla: así nunca se quedan HBAR atrapados.
//   terminar: lee por stdin lo que devuelve la caja, enseña el resultado y, con la llave RECUPERADA por DeRec, cierra esa
//             Cartera en testnet (AccountDelete firmado con ella) y devuelve los HBAR a la cuenta que paga. Si la llave
//             recuperada no sirve, cierra con la guardada y lo da por fallido.
//
// La orquesta «hvault-vps prueba derec»: preparar | caja de DeRec | terminar.
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { AccountCreateTransaction, AccountDeleteTransaction, Hbar, PrivateKey } from "@hiero-ledger/sdk";
import { Mirror, NETWORKS, createClient, formatHbar, parsePrivateKey, submit } from "@boveda/core";

const mode = process.argv[2];
// «hcs»: paso 3 (buzones HCS y nuestro motor). Paga también los mensajes: lleva más HBAR.
const HCS = process.argv[3] === "hcs";
const ROOT = new URL("..", import.meta.url).pathname;
/** {accountId, keyDer} de la Cartera de prueba de testnet (permisos 600): para cerrarla aunque la caja falle. */
const KEY_FILE = `${ROOT}data/derec-prueba.json`;
const say = (s) => process.stderr.write(`${s}\n`);
const env = Object.fromEntries(
  (existsSync(`${ROOT}guardian/.env`) ? readFileSync(`${ROOT}guardian/.env`, "utf8") : "")
    .split("\n")
    .map((l) => l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const NETWORK = (env.HEDERA_NETWORK ?? "testnet").toLowerCase();
if (NETWORK !== "testnet") {
  say("⛔ Esta prueba es solo para testnet.");
  process.exit(1);
}
const keyText = env.OPERATOR_KEY;
if (!keyText) {
  say("⛔ Falta OPERATOR_KEY en guardian/.env");
  process.exit(1);
}
const mirror = new Mirror(NETWORKS.testnet.mirror);
const funderKey = parsePrivateKey(keyText, env.OPERATOR_KEY_TYPE);
const funderAcc = env.OPERATOR_ID ? await mirror.account(env.OPERATOR_ID) : await mirror.account(`0x${funderKey.publicKey.toEvmAddress()}`);
if (!funderAcc) {
  say("⛔ No encuentro la cuenta de guardian/.env en testnet");
  process.exit(1);
}
const funder = createClient("testnet", { accountId: funderAcc.id, key: funderKey });

if (mode === "preparar") {
  mkdirSync(`${ROOT}data`, { recursive: true });
  const key = PrivateKey.generateECDSA();
  const out = await submit(funder, new AccountCreateTransaction().setKey(key.publicKey).setInitialBalance(new Hbar(HCS ? 6 : 2)));
  if (!out.ok || !out.receipt?.accountId) {
    say(`⛔ No se pudo crear la Cartera de prueba: ${out.status}`);
    process.exit(1);
  }
  const accountId = out.receipt.accountId.toString();
  writeFileSync(KEY_FILE, JSON.stringify({ accountId, keyDer: key.toStringDer() }), { mode: 0o600 });
  chmodSync(KEY_FILE, 0o600);
  say(`Red testnet · paga ${funderAcc.id} · Cartera de prueba ${accountId} con ${HCS ? 6 : 2} HBAR (llave nueva, solo para esta prueba${HCS ? "; paga los mensajes HCS" : ""})\n`);
  const config = { red: "testnet", cartera: accountId, boveda: "0.0.123456", guardian: "https://guardian.ejemplo", lista: ["0.0.98", "0.0.800"], creada: new Date().toISOString() };
  process.stdout.write(JSON.stringify({ secretHex: key.toStringRaw(), config, accountId }) + "\n");
  funder.close();
  process.exit(0);
}

// Robots de testnet: una cuenta que paga sus mensajes (20 HBAR de la cuenta de guardian/.env). Su llave se guarda
// también aquí (data/, 600) para poder cerrarla y devolver lo que quede («robots-cerrar»).
const ROBOTS_FILE = `${ROOT}data/derec-robots.json`;
if (mode === "robots") {
  mkdirSync(`${ROOT}data`, { recursive: true });
  const key = PrivateKey.generateECDSA();
  const out = await submit(funder, new AccountCreateTransaction().setKey(key.publicKey).setInitialBalance(new Hbar(20)).setAccountMemo("H10X DeRec · robots de prueba"));
  if (!out.ok || !out.receipt?.accountId) {
    say(`⛔ No se pudo crear la cuenta de los robots: ${out.status}`);
    process.exit(1);
  }
  const accountId = out.receipt.accountId.toString();
  writeFileSync(ROBOTS_FILE, JSON.stringify({ accountId, keyDer: key.toStringDer() }), { mode: 0o600 });
  chmodSync(ROBOTS_FILE, 0o600);
  say(`Robots de DeRec · testnet · pagador ${accountId} con 20 HBAR (de ${funderAcc.id})`);
  process.stdout.write(JSON.stringify({ accountId, keyHex: key.toStringRaw() }) + "\n");
  funder.close();
  process.exit(0);
}
if (mode === "robots-cerrar") {
  /** @type {any} */
  let f = null;
  try {
    f = existsSync(ROBOTS_FILE) ? JSON.parse(readFileSync(ROBOTS_FILE, "utf8")) : null;
  } catch {
    f = null;
  }
  if (!f?.accountId || !f?.keyDer) {
    say("No hay cuenta de robots que cerrar.");
    process.exit(0);
  }
  const c = createClient("testnet", { accountId: f.accountId, key: PrivateKey.fromStringDer(f.keyDer) });
  const del = await submit(c, new AccountDeleteTransaction().setAccountId(f.accountId).setTransferAccountId(funderAcc.id));
  c.close();
  say(del.ok ? `Cuenta de los robots ${f.accountId} cerrada: lo que quedaba vuelve a ${funderAcc.id}.` : `⛔ No se pudo cerrar ${f.accountId}: ${del.status}`);
  if (del.ok) rmSync(ROBOTS_FILE);
  funder.close();
  process.exit(del.ok ? 0 : 1);
}

if (mode === "terminar") {
  const text = readFileSync(0, "utf8");
  const line = text
    .split("\n")
    .reverse()
    .find((l) => l.startsWith('{"h10xDerec"'));
  /** @type {any} */
  let res = null;
  try {
    res = line ? JSON.parse(line) : null;
  } catch {
    res = null;
  }
  if (!res) {
    say("⛔ La caja de DeRec no ha devuelto resultado. Lo que salió:");
    say(text.slice(-4000));
  }
  /** @type {any} */
  let file = null;
  try {
    file = existsSync(KEY_FILE) ? JSON.parse(readFileSync(KEY_FILE, "utf8")) : null;
  } catch {
    file = null;
  }
  const saved = file?.keyDer ? PrivateKey.fromStringDer(file.keyDer) : null;
  const accountId = file?.accountId || res?.accountId || null;
  let onChain = false;
  let detail = "";
  if (accountId && saved) {
    let recovered = null;
    try {
      recovered = res?.recoveredHex ? PrivateKey.fromStringECDSA(res.recoveredHex) : null;
    } catch {
      recovered = null;
    }
    const same = !!recovered && recovered.toStringRaw() === saved.toStringRaw();
    const useKey = same ? recovered : saved;
    const before = await mirror.account(accountId).catch(() => null);
    const c = createClient("testnet", { accountId, key: useKey });
    const del = await submit(c, new AccountDeleteTransaction().setAccountId(accountId).setTransferAccountId(funderAcc.id));
    c.close();
    onChain = same && del.ok;
    detail = `${same ? "firma la llave RECUPERADA por DeRec" : "la recuperada no sirve: se cierra con la guardada"} · cuenta ${accountId} cerrada: ${del.status} · ${before ? formatHbar(before.balance) : "?"} HBAR vuelven a ${funderAcc.id}${del.txId ? ` · ${del.txId}` : ""}`;
  } else detail = "no hay Cartera de prueba que cerrar";
  if (existsSync(KEY_FILE)) rmSync(KEY_FILE);
  const boxResults = res?.results ?? [];
  const last = HCS ? boxResults.length + 1 : 10;
  say(`\n${onChain ? "✅" : "⛔"} ${last}  La llave recuperada firma en testnet (cierra la Cartera de prueba)`);
  say(`      ${detail}`);
  const results = [...boxResults, { n: last, name: "La llave recuperada firma en testnet", pass: onChain, detail }];
  const pass = results.filter((r) => r.pass).length;
  const report = HCS ? "informe-derec-hcs.md" : "informe-derec.md";
  say(`\n${pass}/${results.length} correctas${HCS ? ` · forma elegida: ${res?.direction ?? "ninguna"}` : ""} · informe en ${report}`);
  const md = [`# DeRec en testnet (H10X Wallet)${HCS ? " · buzones HCS" : ""}`, "", `Fecha: ${new Date().toISOString()}`, "", ...results.map((r) => `- ${r.pass ? "✅" : "⛔"} ${r.n}. ${r.name}${r.detail ? ` — ${r.detail}` : ""}`), ""];
  writeFileSync(`${ROOT}${report}`, md.join("\n"));
  funder.close();
  const expected = HCS ? results.length >= 10 : results.length === 11;
  process.exit(pass === results.length && expected ? 0 : 1);
}

say("Uso: node test/derec-testnet.mjs preparar [hcs] | terminar [hcs] | robots | robots-cerrar");
process.exit(1);
