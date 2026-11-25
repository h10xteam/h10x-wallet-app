// Reglas del guardián que no necesitan red: direcciones de los avisos del notario, presupuesto diario
// por bóveda y qué hacer con una petición que no se ha podido leer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEDULE_MAX_LIFETIME_SECONDS, budgetDay, scheduleIdOfAddress, takeBudget, uncheckedVerdict } from "@boveda/core";

test("avisos del notario: solo la dirección de una programada da un ID; lo demás es null y nunca lanza", () => {
  const zeros = "0".repeat(24);
  // La dirección de una programada: 12 bytes a cero y el número en los 8 últimos.
  assert.equal(scheduleIdOfAddress(`0x${zeros}0000000000ae5f1f`), "0.0.11427615");
  assert.equal(scheduleIdOfAddress(`0x${zeros}0000000000AE5F1F`), "0.0.11427615", "da igual mayúsculas");
  assert.equal(scheduleIdOfAddress(`${zeros}0000000000009000`), "0.0.36864", "y con o sin 0x");
  // Cualquier otra cosa que el notario acepta en request(): no es una programada.
  for (const bogus of [
    "0x00000000ffffffffffffffff0000000000000001", // «realm» distinto de cero
    "0xdeadbeef00000000000000000000000000000001", // «shard» distinto de cero
    `0x${zeros}ffffffffffffffff`, // número imposible
    `0x${zeros}0000000000000000`, // la cuenta cero
    "0x1234",
    "",
    "0.0.1234",
    null,
    undefined,
    42,
    {},
  ]) {
    assert.equal(scheduleIdOfAddress(bogus), null, `no es una programada: ${String(bogus)}`);
  }
});

test("presupuesto diario por bóveda: gasta hasta el tope, cada tipo por separado, y vuelve a cero al día siguiente", () => {
  const limits = { approve: 2, veto: 1, freeze: 1 };
  /** @type {{ spend?: { day: number, approve: number, veto: number, freeze: number } }} */
  const v = {};
  const t0 = 20_000 * 86400 + 100; // un día cualquiera
  assert.equal(takeBudget(v, "approve", limits, t0), true);
  assert.equal(takeBudget(v, "approve", limits, t0 + 1), true);
  assert.equal(takeBudget(v, "approve", limits, t0 + 2), false, "al tope ya no gasta");
  assert.equal(v.spend?.approve, 2, "y no cuenta la que no hizo");
  // Bloquear tiene su propio tope: agotar las aprobaciones no deja a la bóveda sin bloqueos.
  assert.equal(takeBudget(v, "veto", limits, t0 + 3), true);
  assert.equal(takeBudget(v, "veto", limits, t0 + 4), false);
  assert.equal(takeBudget(v, "freeze", limits, t0 + 5), true);
  assert.equal(takeBudget(v, "freeze", limits, t0 + 6), false);
  // Al día siguiente (UTC) empieza de nuevo.
  assert.equal(budgetDay(t0 + 86400), budgetDay(t0) + 1);
  assert.equal(takeBudget(v, "approve", limits, t0 + 86400), true);
  assert.deepEqual(v.spend, { day: budgetDay(t0) + 1, approve: 1, veto: 0, freeze: 0 });
});

test("petición sin leer: espera, se bloquea a media cuenta atrás y se olvida cuando ya no puede ejecutarse", () => {
  const p = { requestedAt: 1_000_000, executableAt: 1_000_000 + 86400 };
  const life = SCHEDULE_MAX_LIFETIME_SECONDS;
  assert.equal(uncheckedVerdict(p, p.requestedAt + 60, life), "wait");
  assert.equal(uncheckedVerdict(p, p.requestedAt + 43199, life), "wait");
  assert.equal(uncheckedVerdict(p, p.requestedAt + 43200, life), "block", "a media cuenta atrás");
  assert.equal(uncheckedVerdict(p, p.executableAt + 10, life), "block", "y después, mientras pueda ejecutarse");
  assert.equal(uncheckedVerdict(p, p.executableAt + life + 1, life), "expired");
  // Entradas guardadas por un guardián anterior (sin la hora de la petición): margen de dos minutos.
  assert.equal(uncheckedVerdict({ executableAt: 5000 }, 5000 - 100, life), "wait");
  assert.equal(uncheckedVerdict({ executableAt: 5000 }, 5000 - 60, life), "block");
  // Un aviso con fechas de hace años (basura): caducado, no se gasta nada en él.
  assert.equal(uncheckedVerdict({ requestedAt: 1000, executableAt: 2000 }, 1_800_000_000, life), "expired");
});

// ---- boveda-h10x3: correo, alias, contraseña, NFT y tokens con llave de comisiones ----------------------
import { accountName, fetchNftMetadata, isPrivateUrl, isValidEmail, maskEmail, nftMetadataSource, normalizeEmail, passwordStrength, suggestPassphrase, tokenRisks } from "@boveda/core";

test("correo de avisos: se normaliza, se valida y nunca se enseña entero", () => {
  assert.equal(normalizeEmail("  Ana.Perez@Gmail.COM "), "ana.perez@gmail.com");
  for (const ok of ["ana@gmail.com", "a.b+avisos@correo.es", "x@sub.dominio.co"]) assert.equal(isValidEmail(ok), true, ok);
  for (const bad of ["", "ana", "ana@", "@gmail.com", "ana@gmail", "ana @gmail.com", "ana@@gmail.com", ".ana@gmail.com", "ana..b@gmail.com", "ana@-x.com", "ana@x.c", null, 42]) {
    assert.equal(isValidEmail(bad), false, String(bad));
  }
  assert.equal(maskEmail("ana.perez@gmail.com"), "a•••@gmail.com");
  assert.equal(maskEmail("raro"), "•••");
});

test("avisos con destino por alias: cada dirección EVM se nombra entera (antes todas eran «0.0.?»)", () => {
  const evm = Buffer.from("abcdef1234567890abcdef1234567890abcdef12", "hex");
  assert.equal(accountName({ accountNum: 777 }), "0.0.777");
  assert.equal(accountName({ alias: evm }), "0xabcdef1234567890abcdef1234567890abcdef12");
  assert.equal(accountName({ alias: evm.toString("base64") }), "0xabcdef1234567890abcdef1234567890abcdef12", "también si llega en base64");
  // La dirección «larga de ceros» es la de una cuenta numerada: se enseña su número.
  assert.equal(accountName({ alias: Buffer.from(`${"0".repeat(24)}0000000000001771`, "hex") }), "0.0.6001");
  // Dos alias distintos nunca dan el mismo nombre.
  assert.notEqual(accountName({ alias: Buffer.alloc(20, 1) }), accountName({ alias: Buffer.alloc(20, 2) }));
  assert.match(accountName({ alias: Buffer.alloc(34, 7) }), /^alias:07/);
  assert.equal(accountName(null), "0.0.?");
});

test("contraseña de desempate: 5 palabras distintas; las débiles que antes valían, ya no", () => {
  for (const weak of ["1234 1234 1234 1234", "aaaaaaaaaaaaaaaa", "1234567890123456", "hola hola hola hola hola", "mi perro se llama toby", "Real Madrid campeón 2026", "perro gato casa mesa", "aaa bbb ccc ddd eee"]) {
    assert.equal(passwordStrength(weak).ok, false, weak);
  }
  for (const strong of ["perro gato casa mesa silla", "faro  Tortuga  CANELA  nube  río", "lápiz órbita trigo ancla cometa"]) assert.equal(passwordStrength(strong).ok, true, strong);
  // La propuesta de la app siempre cumple (antes, con una palabra repetida, podía no cumplir).
  for (let i = 0; i < 300; i++) assert.equal(passwordStrength(suggestPassphrase(i % 2 ? "en" : "es")).ok, true);
});

test("NFT: nada se pide a servidores de terceros sin permiso, y la metadata tiene tope aunque no diga su tamaño", async () => {
  const b64 = (s) => Buffer.from(s).toString("base64");
  assert.equal(isPrivateUrl("https://ipfs.io/ipfs/Qm"), true);
  assert.equal(isPrivateUrl("https://arweave.net/x"), true);
  assert.equal(isPrivateUrl("https://ipfs.io.evil.com/ipfs/Qm"), false);
  assert.deepEqual(nftMetadataSource(b64("https://regalo.example/m.json")), { uri: "https://regalo.example/m.json", url: "https://regalo.example/m.json", external: true, host: "regalo.example" });
  assert.equal(nftMetadataSource(b64("ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"))?.external, false);
  let asked = 0;
  const json = (obj, headers = {}) => async () => ((asked += 1), new Response(JSON.stringify(obj), { status: 200, headers }));
  // Metadata en un servidor de terceros: sin permiso, ni se pide.
  assert.equal(await fetchNftMetadata(b64("https://regalo.example/m.json"), { fetchImpl: /** @type {any} */ (json({ name: "x" })) }), null);
  assert.equal(asked, 0);
  const allowed = await fetchNftMetadata(b64("https://regalo.example/m.json"), { allowExternal: true, fetchImpl: /** @type {any} */ (json({ name: "x", image: "https://regalo.example/p.png" })) });
  assert.equal(allowed?.name, "x");
  assert.equal(allowed?.imageExternal, true, "la imagen está en un servidor de terceros");
  // En IPFS sí se pide; una imagen también en IPFS no es externa.
  const ipfs = await fetchNftMetadata(b64("ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"), { fetchImpl: /** @type {any} */ (json({ name: "y", image: "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/1.png" })) });
  assert.equal(ipfs?.imageExternal, false);
  // 5 MB sin declarar el tamaño: se corta al pasar de 200 kB, sin leerlo entero.
  let pulled = 0;
  const huge = async () =>
    new Response(
      new ReadableStream({
        pull(c) {
          pulled += 64_000;
          if (pulled > 5_000_000) c.close();
          else c.enqueue(new Uint8Array(64_000).fill(32));
        },
      }),
      { status: 200 },
    );
  assert.equal(await fetchNftMetadata(b64("ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"), { fetchImpl: /** @type {any} */ (huge) }), null);
  assert.ok(pulled < 1_000_000, `leyó ${pulled} bytes`);
});

test("tokens: se marca el que su emisor puede cambiar de comisiones", () => {
  assert.equal(tokenRisks({ issuerKeys: ["feeSchedule"], fees: { fixedHbar: 0n, fixedTokens: [] } }).canChangeFees, true);
  assert.equal(tokenRisks({ issuerKeys: ["freeze", "supply"], fees: { fixedHbar: 0n, fixedTokens: [] } }).canChangeFees, false);
  assert.equal(tokenRisks(null).canChangeFees, false);
});
