// H10X Wallet · DeRec, paso 3 (TESTNET): nuestro motor (core/src/derec) con el SDK publicado (@derec-alliance/nodejs)
// y buzones HCS de verdad. Corre DENTRO de la caja de DeRec (sin /home, sin llaves de Hvault): solo recibe por la
// tubería la llave de una Cartera de testnet de usar y tirar, que paga los mensajes y es lo que se protege.
//
// Parte A (en memoria, segundos): las dos formas de emparejar y un reinicio de la app a mitad.
//   A · el DUEÑO enseña el código y el amigo lo escanea     B · el AMIGO enseña el código y el dueño lo escanea
// Parte B (HCS testnet): la forma que haya funcionado, con 5 buzones reales (dueño, 3 amigos y un móvil nuevo):
//   emparejar → (reinicio) → repartir → comprobar → móvil nuevo: códigos de recuperación de 2 amigos, que CONFIRMAN
//   a mano → recupera Cartera y perfil exactos → se queda como dueño y vuelve a repartir (versión nueva).
// Lee por stdin {secretHex, config, accountId}; deja por stdout una línea {h10xDerec: 1, …}. Lo demás va a stderr.
import { readFileSync } from "node:fs";
import * as sdk from "@derec-alliance/nodejs";
import { AccountId, Client, PrivateKey } from "@hiero-ledger/sdk";
import { DerecDevice } from "./derec/device.js";
import { memoryKV } from "./derec/stores.js";
import { createInbox, hcsInbox, hcsTransport, inboxUri } from "./derec/hcs.js";

const err = (...a) => void process.stderr.write(a.map(String).join(" ") + "\n");
console.log = (...a) => err(...a);
console.info = console.log;
console.warn = console.log;
const MIRROR = "https://testnet.mirrornode.hedera.com";
const hex = (b) => Buffer.from(b).toString("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let n = 0;
const check = (name, pass, detail = "") => {
  n++;
  results.push({ n, name, pass, detail });
  err(`${pass ? "✅" : "⛔"} ${n}  ${name}${detail ? `\n      ${detail}` : ""}`);
  return pass;
};
const types = (evs) => [...new Set(evs.map((e) => String(e?.type)))].join(", ");
const msg = (e) => String(e?.message ?? e).slice(0, 240) + (e?.code ? ` [${e.code}]` : "");

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
const secretHex = String(input.secretHex ?? "").toLowerCase();
if (!/^[0-9a-f]{64}$/.test(secretHex)) throw new Error("falta la llave de testnet (secretHex)");
const cartera = Uint8Array.from(Buffer.from(secretHex, "hex"));
const perfil = new TextEncoder().encode(JSON.stringify(input.config ?? {}));
const accountId = String(input.accountId ?? "");

/** Red en memoria: cada buzón es una cola. */
function memoryNet() {
  const queues = new Map();
  let seq = 0;
  return {
    port(uri) {
      if (!queues.has(uri)) queues.set(uri, []);
      return {
        transport: {
          async send(endpoints, message) {
            const ep = endpoints.find((e) => queues.has(e.uri));
            if (!ep) throw new Error(`sin buzón para ${endpoints.map((e) => e.uri).join(",")}`);
            queues.get(ep.uri).push({ seq: ++seq, at: "", from: "", bytes: Uint8Array.from(message) });
          },
        },
        inbox: { poll: async () => queues.get(uri).splice(0) },
      };
    },
  };
}

/**
 * Un escenario completo. `ports(name)` da {transport, inbox, uri} de cada móvil.
 * @returns {Promise<{ ok: boolean, recoveredHex: string, firstFail: string }>}
 */
async function scenario({ label, direction, ports, delayMs, maxWaitMs, restart }) {
  err(`\n── ${label}`);
  const kvs = new Map();
  const mk = (name, robot = false) => {
    if (!kvs.has(name)) kvs.set(name, memoryKV());
    const p = ports(name);
    return new DerecDevice({ sdk, kv: kvs.get(name), transport: p.transport, inbox: p.inbox, ownUri: p.uri, network: "testnet", name, robot, log: (s) => err(`      [${name}] ${s}`) });
  };
  let owner = mk("Dueño");
  let helpers = ["Ana", "Bea", "Carlos"].map((x) => mk(x));
  const all = () => [owner, ...helpers];
  /** Bombea los buzones hasta que `done(eventosPorMóvil)` o se acabe el tiempo. */
  const lastErr = new Map();
  const pumpUntil = async (devices, done, what) => {
    const seen = new Map(devices.map((d) => [d, []]));
    const t0 = Date.now();
    while (Date.now() - t0 < maxWaitMs) {
      for (const d of devices) {
        try {
          seen.get(d).push(...(await d.pump()));
          lastErr.delete(d.name);
        } catch (e) {
          // Un error que se repite se enseña una sola vez.
          if (lastErr.get(d.name) !== msg(e)) err(`      [${d.name}] pump: ${msg(e)}`);
          lastErr.set(d.name, msg(e));
        }
      }
      if (await done(seen)) return { seen, ok: true, secs: Math.round((Date.now() - t0) / 1000) };
      if (delayMs) await sleep(delayMs);
    }
    err(`      (tiempo agotado esperando: ${what})`);
    return { seen, ok: false, secs: Math.round((Date.now() - t0) / 1000) };
  };
  const evOf = (seen, d) => seen.get(d) ?? [];
  let firstFail = "";
  const step = (name, pass, detail) => {
    const okk = check(`${label} · ${name}`, pass, detail);
    if (!okk && !firstFail) firstFail = name;
    return okk;
  };

  // 1. Emparejar 3 amigos.
  try {
    const sizes = [];
    for (const h of helpers) {
      if (direction === "A") {
        const code = await owner.ownerCode();
        sizes.push(code.length);
        await h.helperScan(code);
      } else {
        const code = await h.helperCode();
        sizes.push(code.length);
        await owner.ownerScan(code);
      }
    }
    const r = await pumpUntil(all(), async () => (await owner.friends()).length === 3 && (await Promise.all(helpers.map((h) => h.helping()))).every((l) => l.length === 1), "emparejar");
    const ownerEv = evOf(r.seen, owner);
    step("emparejar 3 amigos", r.ok, `${r.secs} s · código de ${Math.min(...sizes)}–${Math.max(...sizes)} caracteres · dueño: ${types(ownerEv) || "—"} · amigos: ${helpers.map((h) => types(evOf(r.seen, h)) || "—").join(" | ")}`);
  } catch (e) {
    step("emparejar 3 amigos", false, msg(e));
  }
  if (firstFail) return { ok: false, recoveredHex: "", firstFail };

  // 2. Reinicio de la app (todo sale de los almacenes).
  if (restart) {
    for (const d of all()) d.close();
    owner = mk("Dueño");
    helpers = ["Ana", "Bea", "Carlos"].map((x) => mk(x));
    step("reinicio: se vuelve a abrir todo desde los almacenes", true, "instancias nuevas sobre los mismos datos");
  }

  // 3. Repartir (umbral 2 de 3).
  let version = 0;
  try {
    const st = await owner.protect({ cartera, perfil, threshold: 2, description: "H10X Wallet · prueba HCS" });
    let done = null;
    const r = await pumpUntil(all(), async (seen) => (done = [...st, ...evOf(seen, owner)].find((e) => e?.type === "SharingComplete")) != null, "repartir");
    version = Number(done?.version ?? 0);
    const held = helpers.filter((h) => evOf(r.seen, h).some((e) => e?.type === "AutoAccepted" || e?.type === "ShareStored" || e?.type === "ActionRequired")).length;
    step("repartir: los 3 guardan su parte (umbral 2)", !!done?.threshold_met && Number(done?.confirmed_count) === 3, `${r.secs} s · versión ${version} · confirmadas ${done?.confirmed_count ?? "?"} · fallidas ${done?.failed_count ?? "?"} · amigos que recibieron: ${held}/3 · dueño: ${types([...st, ...evOf(r.seen, owner)])}`);
  } catch (e) {
    step("repartir: los 3 guardan su parte (umbral 2)", false, msg(e));
  }
  if (firstFail) return { ok: false, recoveredHex: "", firstFail };

  // 4. Comprobar.
  try {
    const st = await owner.verify(version);
    const r = await pumpUntil(all(), async (seen) => [...st, ...evOf(seen, owner)].filter((e) => e?.type === "ShareVerified").length >= 3, "comprobar");
    const ok3 = [...st, ...evOf(r.seen, owner)].filter((e) => e?.type === "ShareVerified").length;
    step("comprobar: las 3 partes están bien", ok3 >= 3, `${r.secs} s · ShareVerified ${ok3}/3`);
  } catch (e) {
    step("comprobar: las 3 partes están bien", false, msg(e));
  }

  // 5. Móvil nuevo: Bea y Carlos le enseñan su código de recuperación (eligen antes al amigo).
  const nuevo = mk("MóvilNuevo");
  let secretId = "";
  try {
    for (const h of helpers.slice(1)) {
      const [friend] = await h.helping();
      const code = await h.helperCode({ forOwnerChannel: friend.channelId, version });
      const { code: c } = await nuevo.ownerScan(code);
      secretId = String(c.secretId ?? "");
    }
    const r = await pumpUntil([nuevo, ...helpers], async () => (await nuevo.friends()).length === 2, "emparejar el móvil nuevo");
    step("móvil nuevo: se empareja con Bea y Carlos (códigos de recuperación)", r.ok, `${r.secs} s · secreto ${secretId.slice(0, 6)}… · nuevo: ${types(evOf(r.seen, nuevo)) || "—"}`);
  } catch (e) {
    step("móvil nuevo: se empareja con Bea y Carlos (códigos de recuperación)", false, msg(e));
  }
  if (firstFail) return { ok: false, recoveredHex: "", firstFail };

  // 6. Pedir las partes: cada amigo CONFIRMA a mano (con el código corto) antes de darla.
  let recovered = null;
  try {
    const st = await nuevo.recover(secretId, version);
    let asked = 0;
    const fps = [];
    const r = await pumpUntil(
      [nuevo, ...helpers],
      async (seen) => {
        for (const h of helpers) {
          for (const a of await h.pendingApprovals()) {
            asked++;
            fps.push(`${h.name}: ${a.kind} de «${a.name}» código ${a.fingerprint || "?"}`);
            for (const e of await h.answer(a.id, true)) seen.get(h)?.push(e);
          }
        }
        recovered = [...st, ...evOf(seen, nuevo)].find((e) => e?.type === "SecretRecovered") ?? null;
        return recovered != null || [...st, ...evOf(seen, nuevo)].some((e) => /RecoveryIncomplete|RecoverSecretFailed|RecoveryDisputed|RecoveryConflict/.test(String(e?.type)));
      },
      "recuperar",
    );
    const sec = recovered?.secret?.secrets ?? [];
    const key = sec.find((x) => x?.name === "cartera")?.data;
    const cfg = sec.find((x) => x?.name === "perfil")?.data;
    const keyOk = !!key && hex(key) === secretHex;
    const cfgOk = !!cfg && hex(cfg) === hex(perfil);
    step("recuperar: los amigos confirman y vuelven la Cartera y el perfil exactos", keyOk && cfgOk && asked >= 2, `${r.secs} s · confirmaciones ${asked} (${fps.join(" · ") || "ninguna"}) · eventos: ${types([...st, ...evOf(r.seen, nuevo)])} · llave ${keyOk ? "idéntica" : "NO"} · perfil ${cfgOk ? "idéntico" : "NO"}`);
    if (keyOk) recovered.h10xHex = hex(key);
  } catch (e) {
    step("recuperar: los amigos confirman y vuelven la Cartera y el perfil exactos", false, msg(e));
  }

  // 7. El móvil nuevo se queda como dueño y vuelve a repartir (versión nueva).
  try {
    if (!recovered) throw new Error("no hubo recuperación");
    const rs = await nuevo.adopt(recovered.secret, secretId, version);
    await pumpUntil([nuevo, owner, ...helpers], async () => true, "restaurar");
    const st = await nuevo.protect({ cartera, perfil, threshold: 2, description: "H10X Wallet · tras recuperar" });
    let done = null;
    const r = await pumpUntil([nuevo, ...helpers], async (seen) => (done = [...st, ...evOf(seen, nuevo)].find((e) => e?.type === "SharingComplete")) != null, "volver a repartir");
    step("el móvil nuevo vuelve a repartir (versión nueva)", !!done?.threshold_met && Number(done?.version) > version, `${r.secs} s · versión ${done?.version ?? "?"} · confirmadas ${done?.confirmed_count ?? "?"} · restaurar: ${types(rs)} · repartir: ${types([...st, ...evOf(r.seen, nuevo)])}`);
  } catch (e) {
    step("el móvil nuevo vuelve a repartir (versión nueva)", false, msg(e));
  }
  for (const d of [...all(), nuevo]) d.close();
  return { ok: !firstFail && results.filter((x) => x.name.startsWith(label)).every((x) => x.pass), recoveredHex: recovered?.h10xHex ?? "", firstFail };
}

const t0 = Date.now();
// ---- Parte A: en memoria -----------------------------------------------------------------------------------------
const outA = {};
for (const direction of ["A", "B"]) {
  const net = memoryNet();
  let k = 0;
  const uris = new Map();
  const ports = (name) => {
    if (!uris.has(name)) uris.set(name, inboxUri("testnet", `0.0.${9_000_000 + ++k}`));
    return { ...net.port(uris.get(name)), uri: uris.get(name) };
  };
  try {
    outA[direction] = await scenario({ label: `memoria ${direction === "A" ? "(el dueño enseña el código)" : "(el amigo enseña el código)"}`, direction, ports, delayMs: 0, maxWaitMs: 20_000, restart: true });
  } catch (e) {
    outA[direction] = { ok: false, recoveredHex: "", firstFail: msg(e) };
    check(`memoria ${direction}`, false, msg(e));
  }
}

// ---- Parte B: HCS testnet ------------------------------------------------------------------------------------------
let recoveredHex = outA.A?.recoveredHex || outA.B?.recoveredHex || "";
const direction = outA.A?.ok ? "A" : outA.B?.ok ? "B" : null;
let hcsOk = false;
if (!direction) {
  check("HCS testnet", false, "ninguna forma funcionó en memoria: no se prueba en la red");
} else {
  const client = Client.forTestnet().setOperator(AccountId.fromString(accountId), PrivateKey.fromStringECDSA(secretHex));
  const sent = { msgs: 0, chunks: 0, bytes: 0 };
  try {
    const names = ["Dueño", "Ana", "Bea", "Carlos", "MóvilNuevo"];
    const topics = {};
    for (const nm of names) topics[nm] = await createInbox({ client, memo: `H10X DeRec prueba · ${nm}` });
    check("HCS: 5 buzones creados en testnet", true, names.map((x) => `${x} ${topics[x]}`).join(" · "));
    await sleep(6000); // que el mirror los conozca
    const inboxKV = new Map(names.map((x) => [x, memoryKV()]));
    const ports = (name) => ({
      uri: inboxUri("testnet", topics[name]),
      transport: hcsTransport({ client, network: "testnet", onSend: (i) => ((sent.msgs += 1), (sent.chunks += i.chunks), (sent.bytes += i.bytes)) }),
      inbox: hcsInbox({ mirrorBase: MIRROR, topicId: topics[name], kv: inboxKV.get(name) }),
    });
    const r = await scenario({ label: `HCS testnet (forma ${direction})`, direction, ports, delayMs: 2500, maxWaitMs: 240_000, restart: true });
    hcsOk = r.ok;
    if (r.recoveredHex) recoveredHex = r.recoveredHex;
    err(`\n      HCS: ${sent.msgs} mensajes · ${sent.chunks} trozos · ${sent.bytes} bytes`);
  } catch (e) {
    check("HCS testnet", false, msg(e));
  } finally {
    client.close();
  }
}

const ok = results.every((r) => r.pass);
err(`\n${results.filter((r) => r.pass).length}/${results.length} en la caja · ${Math.round((Date.now() - t0) / 1000)} s · forma elegida: ${direction ?? "ninguna"}`);
process.stdout.write(JSON.stringify({ h10xDerec: 1, ok, hcsOk, direction, results, recoveredHex, accountId }) + "\n");
