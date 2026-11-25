// DeRec: almacenes, códigos de amigo, buzones HCS, reglas de la wallet y la app.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEREC_CODE_TTL_MS,
  DEREC_TIMEOUTS,
  DerecDevice,
  decodeFriendCode,
  derecStores,
  derecThreshold,
  encodeFriendCode,
  hcsInbox,
  heldShares,
  inboxUri,
  memoryKV,
  newSecretId,
  parseInboxUri,
  secretIdsWithChannel,
  shortFingerprint,
} from "@boveda/core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(ROOT, f), "utf8");

// ---- Paso 3: nuestro motor (core/src/derec), sin el SDK ------------------------------------------------------------

const te = new TextEncoder();
const td = new TextDecoder();

test("almacenes de DeRec sobre un KV: canales empalmados sin tocar los ids, enlaces, partes, estado y secretos", async () => {
  const kv = memoryKV();
  const st = derecStores(kv);
  const S = "18446744073709551557"; // u64 grande: no puede pasar por un número de JS
  const rec = (id) => te.encode(`{"Helper":{"schema_version":1,"channel_id":${id},"transports":[],"weight":1}}`);
  await st.channelStore.save(S, "18446744073709551001", "0", rec("18446744073709551001"));
  await st.channelStore.save(S, "7", "0", rec("7"));
  await st.channelStore.save(S, "9", "5", te.encode('{"Replica":{"replica_id":5}}'));
  const all = td.decode(await st.channelStore.listHelpers(S, { ids: [], status: [], role: null, exclude: [] }));
  assert.ok(all.startsWith("[") && all.includes('"channel_id":18446744073709551001') && all.includes('"channel_id":7'), "los ids grandes salen tal cual");
  assert.ok(!all.includes("Replica"), "las réplicas van aparte");
  assert.equal(td.decode(await st.channelStore.listHelpers(S, { ids: [], status: [], role: null, exclude: ["7"] })).includes('"channel_id":7,'), false, "exclude");
  assert.ok(td.decode(await st.channelStore.listReplicas(S, { ids: [], status: [], role: null, exclude: [] })).includes('"replica_id":5'));
  assert.ok(await st.channelStore.load(S, "anything", "5"), "un miembro se busca por su replicaId");
  await st.channelStore.linkChannel(S, "7", "8");
  await st.channelStore.linkChannel(S, "8", "11");
  assert.deepEqual((await st.channelStore.linkedChannels(S, "7")).sort(), ["11", "7", "8"], "cierre transitivo");
  await assert.rejects(st.channelStore.load(S, "1e3", "0"), /no decimal/, "solo ids decimales");
  // Partes por versión.
  await st.shareStore.save(S, "7", { secretId: S, version: 1, bytes: Uint8Array.from([1, 2]), subshares: null, threshold: 2 });
  await st.shareStore.save(S, "7", { secretId: S, version: 2, bytes: Uint8Array.from([3]), subshares: 4, threshold: 2 });
  assert.deepEqual((await st.shareStore.load(S, "7", [])).map((x) => x.version), [1, 2]);
  assert.deepEqual((await st.shareStore.load(S, "7", [2]))[0].bytes, Uint8Array.from([3]));
  assert.equal((await st.shareStore.loadMany(S, ["7", "8"], [1])).length, 1);
  assert.equal(await st.shareStore.keepVersion(S, 5), 4, "se guarda también la versión anterior");
  assert.equal(await st.shareStore.latestVersion(S), null, "como las pruebas oficiales");
  await st.shareStore.recordVerification(S, "7", 2);
  const held = await heldShares(kv);
  assert.equal(held.length, 1);
  assert.deepEqual(held[0].versions, [1, 2]);
  assert.ok(held[0].verifiedAt);
  await st.shareStore.removeVersions(S, "7", [1]);
  assert.deepEqual((await st.shareStore.load(S, "7", [])).map((x) => x.version), [2]);
  // Demasiado grande: se niega con el error del SDK.
  const big = derecStores(memoryKV(), { refusal: (r) => Object.assign(new Error(r), { refusal: r }), maxShareBytes: 4 });
  await assert.rejects(big.shareStore.save(S, "7", { secretId: S, version: 1, bytes: new Uint8Array(5) }), (e) => e.refusal === "size_limit_exceeded");
  // Llaves por canal y tipo.
  await st.secretStore.save(S, "7", 1, Uint8Array.from([9]));
  assert.deepEqual(await st.secretStore.loadMany(S, ["7", "8"], 1), [Uint8Array.from([9]), null]);
  // Lo último protegido.
  await st.userSecretStore.saveLatest(S, { version: 3, secrets: [{ id: Uint8Array.from([1]), name: "cartera", data: Uint8Array.from([7, 7]) }], threshold: 2 });
  const us = await st.userSecretStore.loadLatest(S);
  assert.equal(us.version, 3);
  assert.deepEqual(us.secrets[0].data, Uint8Array.from([7, 7]));
  // Flujos a medias: clave compuesta y lista por tipo.
  const item = (o) => te.encode(JSON.stringify(o));
  await st.stateStore.save(S, item({ kind: 2, channel_id: "7", version: 1, extra: "a" }));
  await st.stateStore.save(S, item({ kind: 2, channel_id: "8", version: 1 }));
  await st.stateStore.save(S, item({ kind: 3, secret_id: "5", version: 1 }));
  assert.equal((await st.stateStore.loadAll(S, 2)).length, 2);
  assert.ok(td.decode(await st.stateStore.load(S, item({ kind: 2, channel_id: "7", version: 1 }))).includes('"extra":"a"'));
  assert.equal(await st.stateStore.remove(S, item({ kind: 3, secret_id: "5", version: 1 })), true);
  assert.deepEqual(await secretIdsWithChannel(kv, "7"), [S]);
});

test("código de amigo: ida y vuelta con bigint y bytes; lo raro se rechaza; código corto para leer por teléfono", () => {
  const contact = { channel_id: 18446744073709551557n, contact_mode: 1, nonce: 42n, contact_binding_hash: Uint8Array.from([1, 2, 3]), supported_transports: [{ uri: inboxUri("testnet", "0.0.123"), protocol: 0 }] };
  const code = encodeFriendCode({ purpose: "recover", name: "Ana", network: "testnet", contact, secretId: "9007199254740993", version: 2 });
  assert.match(code, /^H10XDEREC1\.[A-Za-z0-9_-]+$/, "apto para QR y enlaces");
  const back = decodeFriendCode(`mira esto: ${code} gracias`);
  assert.equal(back.contact.channel_id, contact.channel_id);
  assert.deepEqual(back.contact.contact_binding_hash, contact.contact_binding_hash);
  assert.equal(back.secretId, "9007199254740993", "el secreto en texto, sin perder precisión");
  assert.equal(back.version, 2);
  assert.equal(back.purpose, "recover");
  assert.throws(() => decodeFriendCode("hola"), /no es un código/);
  assert.throws(() => decodeFriendCode("H10XDEREC1.AAAAAAAAAAAAAAAA"), /no válido/);
  assert.throws(() => encodeFriendCode({ purpose: "pair", name: "x", network: "devnet", contact }), /red/);
  assert.match(shortFingerprint("a1b2c3d4e5f60718293a4b5c"), /^\d{3} \d{3}$/);
});

test("buzón HCS: junta trozos desordenados, no pasa el cursor de un mensaje a medias, descarta lo ajeno y no repite", async () => {
  const kv = memoryKV();
  const MAGIC = [0x48, 0x58, 0x44, 0x01];
  const b64 = (arr) => Buffer.from(arr).toString("base64");
  const chunk = (seq, number, total, bytes, start = "100.1") => ({ sequence_number: seq, consensus_timestamp: `${seq}.0`, payer_account_id: "0.0.7", message: b64(bytes), chunk_info: { initial_transaction_id: { account_id: "0.0.7", transaction_valid_start: start, nonce: 0 }, number, total } });
  const single = (seq, bytes) => ({ sequence_number: seq, consensus_timestamp: `${seq}.0`, payer_account_id: "0.0.8", message: b64(bytes), chunk_info: null });
  let pages = [[single(1, [...MAGIC, 1, 2]), chunk(2, 2, 2, [6]), single(3, [9, 9, 9]), chunk(4, 1, 3, [...MAGIC, 5], "200.1")]];
  const urls = [];
  const fetch = async (u) => (urls.push(u), { status: 200, ok: true, json: async () => ({ messages: pages.shift() ?? [], links: { next: null } }) });
  const inbox = hcsInbox({ mirrorBase: "https://m", topicId: "0.0.55", kv, fetch });
  const got1 = await inbox.poll();
  assert.deepEqual(got1.map((m) => [...m.bytes]), [[1, 2]], "el suelto con marca; el de 2 trozos aún incompleto (falta el 1); lo sin marca, fuera");
  assert.match(urls[0], /sequencenumber=gte:1&limit=100&order=asc/, "el mirror rechaza gt:0");
  // Llegan el trozo 1 del primero (seq 5) y el resto del segundo (seq 6 y 7).
  pages = [[chunk(2, 2, 2, [6]), single(3, [9, 9, 9]), chunk(4, 1, 3, [...MAGIC, 5], "200.1"), chunk(5, 1, 2, [...MAGIC, 4]), chunk(6, 2, 3, [6], "200.1"), chunk(7, 3, 3, [7], "200.1")]];
  const got2 = await inbox.poll();
  assert.deepEqual(got2.map((m) => [...m.bytes]).sort(), [[4, 6], [5, 6, 7]], "trozos juntados en orden");
  assert.match(urls[1], /sequencenumber=gte:2&/, "el cursor no pasó de un mensaje a medias");
  pages = [[chunk(6, 2, 3, [6], "200.1"), chunk(7, 3, 3, [7], "200.1")]];
  assert.deepEqual(await inbox.poll(), [], "no se repite nada");
  assert.equal(parseInboxUri(inboxUri("mainnet", "0.0.42"))?.topicId, "0.0.42");
  assert.equal(parseInboxUri("https://evil.example/hcs/mainnet/0.0.42"), null, "solo nuestros buzones");
});

test("motor: reglas de la wallet (emparejar solo con un código propio y reciente; dar una parte, solo si la persona confirma)", async () => {
  let t = 1_000_000;
  const kv = memoryKV();
  const fakeSdk = { shareStoreRefusal: (r) => new Error(r) };
  const d = new DerecDevice({ sdk: fakeSdk, kv, transport: { send: async () => {} }, inbox: { poll: async () => [] }, ownUri: inboxUri("testnet", "0.0.1"), network: "testnet", name: "Yo", now: () => t });
  assert.equal((await d.decide("1", { action_kind: "Pairing", channel_id: "77" })).kind, "reject", "código desconocido");
  await kv.set("pc/77", te.encode(JSON.stringify({ role: "owner", secretId: "1", createdAt: t })));
  assert.equal((await d.decide("1", { action_kind: "Pairing", channel_id: "77" })).kind, "accept");
  t += DEREC_CODE_TTL_MS + 1;
  assert.equal((await d.decide("1", { action_kind: "Pairing", channel_id: "77" })).kind, "reject", "código caducado");
  for (const k of ["StoreShare", "VerifyShare", "Discovery", "Unpair", "UpdateChannelInfo"]) assert.equal((await d.decide("1", { action_kind: k, channel_id: "5" })).kind, "accept", k);
  assert.equal((await d.decide("1", { action_kind: "GetShare", channel_id: "5" })).kind, "ask", "dar una parte siempre lo confirma la persona");
  assert.equal((await d.decide("1", { action_kind: "PrePair", channel_id: "5" })).kind, "reject", "PrePair de un código que no es nuestro");
  await kv.set("pc/88", te.encode(JSON.stringify({ role: "helper", secretId: "1", createdAt: t })));
  assert.equal((await d.decide("1", { action_kind: "PrePair", channel_id: "88" })).kind, "accept", "PrePair de nuestro código reciente (códigos «hashed»)");
  const robot = new DerecDevice({ sdk: fakeSdk, kv: memoryKV(), transport: { send: async () => {} }, inbox: { poll: async () => [] }, ownUri: inboxUri("testnet", "0.0.2"), network: "testnet", name: "Robot", robot: true });
  assert.equal((await robot.decide("1", { action_kind: "GetShare", channel_id: "5" })).kind, "reject", "robot: solo a canales enlazados para recuperar");
  await robot.kv.set("lk/5", te.encode(JSON.stringify({ old: "4" })));
  assert.equal((await robot.decide("1", { action_kind: "GetShare", channel_id: "5" })).kind, "accept");
  // Al guardar una parte, el ayudante apunta de qué secreto es.
  await kv.set("ow/9", te.encode(JSON.stringify({ name: "Ana", secretId: "1" })));
  await d.decide("1", { action_kind: "StoreShare", channel_id: "9", share_secret_id: "555", version: 1 });
  assert.equal(JSON.parse(td.decode(await kv.get("ow/9"))).ownerSecretId, "555");
  assert.deepEqual([derecThreshold(2), derecThreshold(3), derecThreshold(4), derecThreshold(5)], [2, 2, 3, 3], "mayoría, mínimo 2");
  assert.ok(DEREC_TIMEOUTS.pairing_secs >= 600 && DEREC_TIMEOUTS.inbound_message_secs >= 7 * 86400, "plazos para HCS y móviles que se abren de vez en cuando");
  assert.match(newSecretId(() => Uint8Array.from([255, 255, 255, 255, 255, 255, 255, 255])), /^\d{1,19}$/);
});

// ---- Fase 2: robots de testnet y la app ---------------------------------------------------------------------------

test("app: DeRec se carga solo en la app instalada (nunca en Expo Go), y dar una parte siempre lo confirma la persona", () => {
  const sdkTs = read("app/src/derec/sdk.ts");
  assert.match(sdkTs, /if \(isExpoGo\) \{\n\s+cached = null;/, "en Expo Go ni se intenta");
  assert.match(sdkTs, /require\("@derec-alliance\/react-native"\)/);
  // Ningún import fijo del módulo nativo en toda la app.
  const files = ["app/App.tsx", "app/src/wallet.tsx", "app/src/derec/DerecProvider.tsx", "app/src/derec/kv.ts", "app/src/derec/mailbox.ts", "app/src/derec/wipe.ts", "app/src/screens/Friends.tsx", "app/src/screens/Home.tsx"];
  for (const f of files) assert.doesNotMatch(read(f), /from "@derec-alliance\/react-native"/, f);
  const prov = read("app/src/derec/DerecProvider.tsx");
  assert.doesNotMatch(prov, /robot:\s*true/, "la app nunca es robot");
  const pkg = JSON.parse(read("app/package.json"));
  assert.equal(pkg.dependencies["@derec-alliance/react-native"], "0.1.0", "versión exacta");
  const lock = JSON.parse(read("package-lock.json"));
  assert.equal(lock.packages["node_modules/@derec-alliance/react-native"]?.integrity, "sha512-L/D6fbTQWqbHUXP5iRdZihbpk3qvSXXtpR4KFhwLVKGCZomb+4+DWdYtdIvA6MUyvzyd5tVK8gDpZUI4uXVhOQ==");
  assert.equal(lock.packages.app.dependencies["@derec-alliance/react-native"], "0.1.0");
  // El buzón: llavero solo de este móvil, sin Face ID (es solo para pagar mensajes, nunca la Cartera).
  const mb = read("app/src/derec/mailbox.ts");
  assert.match(mb, /keychainAccessible: SecureStore\.WHEN_UNLOCKED_THIS_DEVICE_ONLY/);
  assert.doesNotMatch(mb, /requireAuthentication: true/);
  const kv = read("app/src/derec/kv.ts");
  assert.match(kv, /WHEN_UNLOCKED_THIS_DEVICE_ONLY/);
  // Instalar lo recuperado: antes se comprueba en la red que la llave sigue mandando.
  const w = read("app/src/wallet.tsx");
  const inst = w.slice(w.indexOf("const installFromFriends"), w.indexOf("const installFromFriends") + 4000);
  assert.ok(inst.indexOf("keyStillControls") > 0 && inst.indexOf("keyStillControls") < inst.indexOf("storePocketKey"), "comprueba antes de guardar la llave");
  assert.match(inst, /p\.network !== NETWORK/, "nunca una wallet de otra red");
  assert.match(w, /await store\.clearStaleKey\(\);\n\s+await wipeDerec\(walletId\);/, "una wallet nueva no hereda DeRec de otra");
  assert.match(w, /await store\.wipeWallet\(\);\n\s+await wipeDerec\(walletId\);/, "borrar la wallet borra su DeRec");
  // La pantalla: confirmar con el código de 6 cifras; recuperar solo con códigos de recuperación.
  const scr = read("app/src/screens/Friends.tsx");
  assert.match(scr, /Es él: dar mi parte/);
  assert.match(scr, /decodeFriendCode\(text\)\.purpose !== "recover"/);
  assert.doesNotMatch(scr, /auditad|\bETF\b/i);
});
