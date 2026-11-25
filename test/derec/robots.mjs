// H10X Wallet · DeRec: 3 amigos ROBOT en TESTNET para probar «Amigos de confianza» con el móvil sin tener que reunir a
// tres personas. Corre dentro de la caja de DeRec (servicio hvault-derec-robots: usuario temporal, sin /home ni llaves
// de Hvault). Cada robot es un móvil más: su buzón HCS, sus almacenes (un archivo) y las reglas de la wallet; en modo
// robot da su parte solo a un móvil nuevo que se emparejó con SU código de recuperación (canal enlazado).
//
// Órdenes (las deja root como archivos en cmd/; la respuesta sale en out/):
//   codes            cada robot crea un código para que el DUEÑO lo pegue en «Mis amigos → Tengo un código»
//   help <código>    el siguiente robot libre escanea el código que enseña el dueño («Añadir un amigo»)
//   recover          cada robot crea su código de RECUPERACIÓN para el móvil nuevo del amigo al que ayuda
//   state            a quién ayuda cada robot, partes guardadas y saldo del pagador
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import * as sdk from "@derec-alliance/nodejs";
import { AccountId, Client, PrivateKey } from "@hiero-ledger/sdk";
import { DerecDevice } from "./derec/device.js";
import { heldShares } from "./derec/stores.js";
import { createInbox, hcsInbox, hcsTransport, inboxUri } from "./derec/hcs.js";
import { decodeFriendCode } from "./derec/contact.js";

const DIR = process.env.ROBOTS_DIR ?? "/var/lib/hvault-derec/robots";
const MIRROR = "https://testnet.mirrornode.hedera.com";
const NAMES = ["Robot Ana", "Robot Bea", "Robot Carlos"];
const log = (s) => process.stdout.write(`${new Date().toISOString()} ${s}\n`);
for (const d of ["", "/kv", "/cmd", "/out"]) mkdirSync(`${DIR}${d}`, { recursive: true, mode: 0o700 });

/** KV en un archivo JSON por robot (escritura atómica). */
function fileKV(path) {
  const m = new Map();
  if (existsSync(path)) for (const [k, v] of Object.entries(JSON.parse(readFileSync(path, "utf8")))) m.set(k, Uint8Array.from(Buffer.from(String(v), "base64")));
  let dirty = false;
  const flush = () => {
    if (!dirty) return;
    const o = Object.fromEntries([...m].map(([k, v]) => [k, Buffer.from(v).toString("base64")]));
    writeFileSync(`${path}.tmp`, JSON.stringify(o), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    dirty = false;
  };
  return {
    async get(k) {
      return m.get(k) ?? null;
    },
    async set(k, v) {
      m.set(k, Uint8Array.from(v));
      dirty = true;
    },
    async del(k) {
      const had = m.delete(k);
      dirty ||= had;
      return had;
    },
    async keys(prefix) {
      return [...m.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
    flush,
  };
}

const payerFile = `${DIR}/payer.json`;
if (!existsSync(payerFile)) {
  log("⛔ Falta payer.json (hvault-vps derec robots preparar). Espero…");
  await new Promise((r) => setTimeout(r, 60_000));
  process.exit(1);
}
const payer = JSON.parse(readFileSync(payerFile, "utf8"));
const client = Client.forTestnet().setOperator(AccountId.fromString(payer.accountId), PrivateKey.fromStringECDSA(payer.keyHex));

const robots = [];
for (const [i, name] of NAMES.entries()) {
  const kv = fileKV(`${DIR}/kv/robot-${i}.json`);
  let topic = (await kv.get("me/inbox")) ? new TextDecoder().decode(await kv.get("me/inbox")) : "";
  if (!topic) {
    topic = await createInbox({ client, memo: `H10X DeRec · ${name}` });
    await kv.set("me/inbox", new TextEncoder().encode(topic));
    kv.flush();
    log(`${name}: buzón nuevo ${topic}`);
  }
  const device = new DerecDevice({
    sdk,
    kv,
    transport: hcsTransport({ client, network: "testnet" }),
    inbox: hcsInbox({ mirrorBase: MIRROR, topicId: topic, kv }),
    ownUri: inboxUri("testnet", topic),
    network: "testnet",
    name,
    robot: true,
    log: (s) => log(`${name}: ${s}`),
  });
  robots.push({ name, kv, topic, device });
}
log(`3 robots en marcha · pagador ${payer.accountId} · buzones ${robots.map((r) => r.topic).join(", ")}`);

async function handle(cmd) {
  if (cmd.cmd === "codes") {
    const out = [];
    for (const r of robots) out.push({ robot: r.name, code: await r.device.helperCode() });
    return { ok: true, codes: out };
  }
  if (cmd.cmd === "help") {
    const code = String(cmd.code ?? "");
    const c = decodeFriendCode(code);
    if (c.purpose !== "pair") return { ok: false, error: "ese código no es para emparejar (Añadir un amigo)" };
    // El siguiente robot que aún no ayude a esa wallet.
    for (const r of robots) {
      const helping = await r.device.helping();
      if (helping.some((h) => h.secretId === c.secretId || h.name === c.name)) continue;
      await r.device.helperScan(code);
      return { ok: true, robot: r.name, owner: c.name };
    }
    return { ok: false, error: "los 3 robots ya ayudan a esa wallet" };
  }
  if (cmd.cmd === "recover") {
    const out = [];
    for (const r of robots) {
      for (const h of await r.device.helping()) {
        const ow = JSON.parse(new TextDecoder().decode((await r.kv.get(`ow/${h.channelId}`)) ?? new Uint8Array()) || "{}");
        out.push({ robot: r.name, friend: h.name, code: await r.device.helperCode({ forOwnerChannel: h.channelId, version: ow.version ?? 1 }) });
      }
    }
    return { ok: true, codes: out };
  }
  if (cmd.cmd === "state") {
    const st = [];
    for (const r of robots) {
      const helping = await r.device.helping();
      const held = await heldShares(r.kv);
      st.push({ robot: r.name, inbox: r.topic, helping: helping.map((h) => h.name), shares: held.reduce((n, x) => n + x.versions.length, 0) });
    }
    const bal = await fetch(`${MIRROR}/api/v1/accounts/${payer.accountId}?transactions=false`).then((x) => x.json()).catch(() => null);
    return { ok: true, robots: st, payer: payer.accountId, hbar: bal?.balance?.balance != null ? Number(bal.balance.balance) / 1e8 : null };
  }
  return { ok: false, error: `orden desconocida: ${cmd.cmd}` };
}

for (;;) {
  for (const f of readdirSync(`${DIR}/cmd`).filter((x) => x.endsWith(".json"))) {
    let res;
    try {
      res = await handle(JSON.parse(readFileSync(`${DIR}/cmd/${f}`, "utf8")));
    } catch (e) {
      res = { ok: false, error: String(e?.message ?? e) };
    }
    rmSync(`${DIR}/cmd/${f}`, { force: true });
    writeFileSync(`${DIR}/out/${f}`, JSON.stringify(res), { mode: 0o644 });
    log(`orden ${f}: ${res.ok ? "ok" : res.error}`);
  }
  for (const r of robots) {
    try {
      const evs = await r.device.pump();
      for (const e of evs) if (!/MessageIgnored|H10xUndelivered/.test(String(e?.type))) log(`${r.name}: ${e.type}`);
    } catch (e) {
      log(`${r.name}: ${String(e?.message ?? e).slice(0, 160)}`);
    }
    r.kv.flush();
  }
  await new Promise((res) => setTimeout(res, 4000));
}
