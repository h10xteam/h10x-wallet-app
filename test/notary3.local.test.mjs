// Pruebas locales del notario v3: la recuperación PRIORITARIA con kit + contraseña de desempate.
// (Lo común con el v2 lo prueban notary2.local y el fuzzing.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrivateKey } from "@hiero-ledger/sdk";
import { HSS, LocalChain, mockAbi, notary3Abi, notary3Artifact } from "./helpers/evm.mjs";
import { CHAIN_IDS, normalizePassword, passwordStrength, priorityDigest, signPriority, suggestPassphrase, tiebreakerAddress, tiebreakerKey } from "@boveda/core";

const DEPLOYER = "0x00000000000000000000000000000000000000d1";
const DEVICE = "0x00000000000000000000000000000000000004d2";
const RESCUE = "0x00000000000000000000000000000000000011d7";
const GUARDIAN = "0x00000000000000000000000000000000000011d8";
const OUTSIDER = "0x000000000000000000000000000000000000beef";
const ZERO = "0x0000000000000000000000000000000000000000";
const W = 86_400n;
const R = 604_800n;
const sched = (n) => "0x" + (0x6000 + n).toString(16).padStart(40, "0");
const Lane = { Withdraw: 1n, Recovery: 2n };
const Status = { None: 0n, Requested: 1n, Vetoed: 2n, Approved: 3n };
const CHAIN = CHAIN_IDS.local; // la EVM local de las pruebas es la de Ethereum (chainid 1)

const kitKey = PrivateKey.generateED25519();
const password = "ábaco tormenta vela níquel cometa";
const tbKey = await tiebreakerKey(password, kitKey.publicKey);
const TIEBREAKER = tiebreakerAddress(tbKey);

async function setup() {
  const chain = await LocalChain.create();
  assert.ok((await chain.send(mockAbi, HSS, DEPLOYER, "setRc", [22n])).ok);
  const dep = await chain.deploy(notary3Artifact, notary3Abi, [DEVICE, RESCUE, GUARDIAN, TIEBREAKER, W, R], DEPLOYER);
  assert.ok(dep.ok, "despliegue");
  const notary = dep.createdAddress;
  const send = (from, fn, args) => chain.send(notary3Abi, notary, from, fn, args);
  const read = async (fn, args = []) => (await chain.read(notary3Abi, notary, fn, args))[0];
  const priority = (from, s, key = tbKey, opts = {}) => {
    const sig = signPriority({ key, chainId: opts.chainId ?? CHAIN, notaryAddress: opts.notary ?? notary, schedule: opts.signFor ?? s });
    return send(from, "requestPriority", [s, sig.v, sig.r, sig.s]);
  };
  return { chain, notary, send, read, priority, status: (s) => read("statusOf", [s]), calls: async () => (await chain.read(mockAbi, HSS, "calls"))[0] };
}
const fails = (res, name) => {
  assert.equal(res.ok, false, `debe fallar con ${name}`);
  assert.equal(res.error?.name, name);
};

test("la contraseña: normalizada, fuerte y propuesta al azar", async () => {
  assert.equal(normalizePassword("  Ábaco   NIÑO  "), "abaco nino");
  assert.equal(tiebreakerAddress(await tiebreakerKey("abaco tormenta vela niquel cometa", kitKey.publicKey)), TIEBREAKER, "con o sin tildes, la misma llave");
  assert.notEqual(tiebreakerAddress(await tiebreakerKey(password, PrivateKey.generateED25519().publicKey)), TIEBREAKER, "otro kit, otra llave");
  assert.equal(passwordStrength("1234").ok, false);
  assert.equal(passwordStrength("perro gato casa").ok, false);
  // Desde boveda-h10x3 hacen falta 5 palabras distintas (4 corrientes se prueban en horas con mil núcleos).
  assert.equal(passwordStrength("perro gato casa mesa").ok, false);
  assert.equal(passwordStrength("perro gato casa mesa silla").ok, true);
  const a = suggestPassphrase("es");
  assert.equal(a.split(" ").length, 5);
  assert.notEqual(a, suggestPassphrase("es"));
  assert.equal(passwordStrength(suggestPassphrase("en")).ok, true);
});

test("despliegue: la llave de desempate es obligatoria y distinta de las demás", async () => {
  const chain = await LocalChain.create();
  for (const [args, err] of [
    [[DEVICE, RESCUE, GUARDIAN, ZERO, W, R], "ZeroAddress"],
    [[DEVICE, RESCUE, GUARDIAN, DEVICE, W, R], "SameAddress"],
    [[DEVICE, RESCUE, GUARDIAN, RESCUE, W, R], "SameAddress"],
    [[DEVICE, RESCUE, GUARDIAN, GUARDIAN, W, R], "SameAddress"],
  ]) {
    const d = await chain.deploy(notary3Artifact, notary3Abi, args, DEPLOYER);
    assert.equal(d.ok, false, err);
  }
  const { read } = await setup();
  assert.equal((await read("tiebreaker")).toLowerCase(), TIEBREAKER);
});

test("prioritaria: solo el kit, solo con la firma buena, y nadie más que el kit la para", async () => {
  const { priority, send, status, chain, read } = await setup();
  fails(await priority(DEVICE, sched(1)), "NotRescue");
  fails(await priority(OUTSIDER, sched(1)), "NotRescue");
  fails(await priority(RESCUE, sched(1), PrivateKey.generateECDSA()), "BadTiebreaker");
  fails(await priority(RESCUE, sched(1), tbKey, { signFor: sched(2) }), "BadTiebreaker"); // firma de otra programada
  fails(await priority(RESCUE, sched(1), tbKey, { chainId: CHAIN_IDS.testnet }), "BadTiebreaker"); // firma de otra red
  fails(await priority(RESCUE, sched(1), tbKey, { notary: OUTSIDER }), "BadTiebreaker"); // firma para otro notario
  const ok = await priority(RESCUE, sched(1));
  assert.ok(ok.ok, ok.error?.name);
  assert.deepEqual(ok.events.map((e) => e.name), ["Requested", "PriorityRequested", "Frozen"]);
  assert.equal(await status(sched(1)), Status.Requested);
  fails(await priority(RESCUE, sched(1)), "BadStatus"); // no se repite
  // El móvil (ni el guardián) no la pueden bloquear; congelar las recuperaciones no la anula.
  fails(await send(DEVICE, "veto", [sched(1)]), "NotAllowed");
  fails(await send(GUARDIAN, "veto", [sched(1)]), "NotAllowed");
  assert.ok((await send(DEVICE, "freeze", [Lane.Recovery])).ok);
  assert.equal(await status(sched(1)), Status.Requested);
  // Antes de tiempo, no; después, cualquiera la completa.
  fails(await send(OUTSIDER, "approve", [sched(1)]), "TooEarly");
  chain.advance(R);
  const ap = await send(OUTSIDER, "approve", [sched(1)]);
  assert.ok(ap.ok, ap.error?.name);
  assert.equal(await status(sched(1)), Status.Approved);
  void read;
});

test("prioritaria: vale aunque el móvil haya congelado las recuperaciones, y la normal no", async () => {
  const { priority, send, status } = await setup();
  assert.ok((await send(DEVICE, "freeze", [Lane.Recovery])).ok);
  fails(await send(RESCUE, "requestRecovery", [sched(3)]), "LaneLocked");
  assert.ok((await priority(RESCUE, sched(4))).ok);
  assert.equal(await status(sched(4)), Status.Requested);
});

test("prioritaria: anula las retiradas pendientes y cierra el carril del móvil hasta que se ejecuta", async () => {
  const { priority, send, status, read, chain } = await setup();
  assert.ok((await send(DEVICE, "request", [sched(5)])).ok);
  assert.ok((await priority(RESCUE, sched(6))).ok);
  assert.equal(await status(sched(5)), Status.Vetoed, "la retirada del ladrón queda anulada");
  const lockedAt = await read("lockedUntil", [Lane.Withdraw]);
  fails(await send(DEVICE, "request", [sched(7)]), "LaneLocked");
  // El guardián congela retiradas (24 h): no acorta el cierre de 7 días.
  assert.ok((await send(GUARDIAN, "freeze", [Lane.Withdraw])).ok);
  assert.equal(await read("lockedUntil", [Lane.Withdraw]), lockedAt);
  chain.advance(W + 10n);
  fails(await send(DEVICE, "request", [sched(8)]), "LaneLocked");
  chain.advance(R);
  assert.ok((await send(DEVICE, "request", [sched(9)])).ok, "pasada la recuperación, el carril se reabre");
});

test("prioritaria: el kit puede retirarla; una firma con s alta (maleable) no vale", async () => {
  const { priority, send, status, notary } = await setup();
  assert.ok((await priority(RESCUE, sched(10))).ok);
  assert.ok((await send(RESCUE, "veto", [sched(10)])).ok);
  assert.equal(await status(sched(10)), Status.Vetoed);
  // Misma firma con s → n - s (y v cambiado): matemáticamente válida, pero el contrato la rechaza.
  const sig = signPriority({ key: tbKey, chainId: CHAIN, notaryAddress: notary, schedule: sched(11) });
  const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const highS = "0x" + (n - BigInt(sig.s)).toString(16).padStart(64, "0");
  fails(await send(RESCUE, "requestPriority", [sched(11), sig.v === 27 ? 28 : 27, sig.r, highS]), "BadTiebreaker");
  assert.equal(priorityDigest({ chainId: CHAIN, notaryAddress: notary, schedule: sched(11) }).length, 66);
});
