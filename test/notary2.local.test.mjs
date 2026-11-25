// Pruebas locales del notario v2 (dos carriles, bloqueo y congelación).
// No prueban Hedera: el Schedule Service es un doble. Lo que depende de la red se prueba con `npm run ataques`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HSS, LocalChain, mockAbi, notary2Abi, notary2Artifact, rogueAbi, rogueArtifact } from "./helpers/evm.mjs";

const DEPLOYER = "0x00000000000000000000000000000000000000d1";
const DEVICE = "0x00000000000000000000000000000000000004d2";
const RESCUE = "0x00000000000000000000000000000000000011d7";
const GUARDIAN = "0x00000000000000000000000000000000000011d8";
const OUTSIDER = "0x000000000000000000000000000000000000beef";
const ZERO = "0x0000000000000000000000000000000000000000";
const W = 172_800n; // retirada: 48 h
const R = 604_800n; // recuperación: 7 días
const sched = (n) => "0x" + (0x5000 + n).toString(16).padStart(40, "0");

const Lane = { None: 0n, Withdraw: 1n, Recovery: 2n };
const Status = { None: 0n, Requested: 1n, Vetoed: 2n, Approved: 3n };
const SUCCESS = 22n;

async function setup({ rc = SUCCESS, guardian = GUARDIAN } = {}) {
  const chain = await LocalChain.create();
  assert.ok((await chain.send(mockAbi, HSS, DEPLOYER, "setRc", [rc])).ok);
  const dep = await chain.deploy(notary2Artifact, notary2Abi, [DEVICE, RESCUE, guardian, W, R], DEPLOYER);
  assert.ok(dep.ok, "el despliegue debe funcionar");
  const notary = dep.createdAddress;
  const send = (from, fn, args) => chain.send(notary2Abi, notary, from, fn, args);
  const read = async (fn, args = []) => (await chain.read(notary2Abi, notary, fn, args))[0];
  const status = (s) => read("statusOf", [s]);
  const hssCalls = async () => (await chain.read(mockAbi, HSS, "calls"))[0];
  const hssCaller = async () => (await chain.read(mockAbi, HSS, "lastCaller"))[0].toLowerCase();
  return { chain, notary, send, read, status, hssCalls, hssCaller, deployGas: dep.gasUsed };
}

const fails = (res, name) => {
  assert.equal(res.ok, false, `debe fallar con ${name}`);
  assert.equal(res.error?.name, name);
};

test("despliegue: guarda móvil, kit, guardián y los dos retardos", async () => {
  const { read, deployGas } = await setup();
  assert.equal((await read("device")).toLowerCase(), DEVICE);
  assert.equal((await read("rescue")).toLowerCase(), RESCUE);
  assert.equal((await read("guardian")).toLowerCase(), GUARDIAN);
  assert.equal(await read("withdrawDelay"), W);
  assert.equal(await read("recoveryDelay"), R);
  assert.ok(deployGas < 1_200_000n, `gas de despliegue ${deployGas}`);
});

test("despliegue: rechaza parámetros inválidos", async () => {
  const chain = await LocalChain.create();
  const cases = [
    [[ZERO, RESCUE, GUARDIAN, W, R], "ZeroAddress"],
    [[DEVICE, ZERO, GUARDIAN, W, R], "ZeroAddress"],
    [[DEVICE, DEVICE, GUARDIAN, W, R], "SameAddress"],
    [[DEVICE, RESCUE, DEVICE, W, R], "SameAddress"],
    [[DEVICE, RESCUE, RESCUE, W, R], "SameAddress"],
    [[DEVICE, RESCUE, GUARDIAN, 0n, R], "InvalidDelay"],
    [[DEVICE, RESCUE, GUARDIAN, W, W - 1n], "InvalidDelay"],
    [[DEVICE, RESCUE, GUARDIAN, W, 61n * 86_400n], "InvalidDelay"],
  ];
  for (const [args, expected] of cases) {
    const dep = await chain.deploy(notary2Artifact, notary2Abi, args, DEPLOYER);
    assert.equal(dep.ok, false, `debe fallar: ${expected}`);
    assert.equal(notary2Abi.parseError(dep.returnData).name, expected);
  }
  // Sin guardián (dirección cero) sí se puede.
  assert.ok((await chain.deploy(notary2Artifact, notary2Abi, [DEVICE, RESCUE, ZERO, W, W], DEPLOYER)).ok);
});

test("cada llave solo abre SU carril", async () => {
  const { send, status } = await setup();
  for (const who of [RESCUE, GUARDIAN, OUTSIDER, DEPLOYER]) fails(await send(who, "request", [sched(1)]), "NotDevice");
  for (const who of [DEVICE, GUARDIAN, OUTSIDER, DEPLOYER]) fails(await send(who, "requestRecovery", [sched(2)]), "NotRescue");
  assert.equal(await status(sched(1)), Status.None);
  assert.equal(await status(sched(2)), Status.None);

  const a = await send(DEVICE, "request", [sched(1)]);
  assert.ok(a.ok);
  assert.equal(a.events[0].name, "Requested");
  assert.equal(a.events[0].args.lane, Lane.Withdraw);
  assert.equal(a.events[0].args.executableAt - a.events[0].args.requestedAt, W);
  const b = await send(RESCUE, "requestRecovery", [sched(2)]);
  assert.ok(b.ok);
  assert.equal(b.events[0].args.lane, Lane.Recovery);
  assert.equal(b.events[0].args.executableAt - b.events[0].args.requestedAt, R);

  fails(await send(DEVICE, "request", [ZERO]), "ZeroAddress");
  fails(await send(DEVICE, "request", [sched(1)]), "BadStatus"); // repetida
  fails(await send(RESCUE, "requestRecovery", [sched(1)]), "BadStatus"); // ya está en el otro carril
  fails(await send(DEVICE, "request", [sched(2)]), "BadStatus");
});

test("approve: cada carril espera SU retardo; el kit espera más que el móvil", async () => {
  const { chain, notary, send, status, hssCalls, hssCaller } = await setup();
  assert.ok((await send(DEVICE, "request", [sched(1)])).ok);
  assert.ok((await send(RESCUE, "requestRecovery", [sched(2)])).ok);

  fails(await send(OUTSIDER, "approve", [sched(1)]), "TooEarly");
  fails(await send(RESCUE, "approve", [sched(2)]), "TooEarly");
  chain.advance(W - 1n);
  fails(await send(DEVICE, "approve", [sched(1)]), "TooEarly");
  chain.advance(1n);
  assert.equal(await hssCalls(), 0n);
  const ok1 = await send(OUTSIDER, "approve", [sched(1)]); // cualquiera puede completar
  assert.ok(ok1.ok);
  assert.equal(await status(sched(1)), Status.Approved);
  assert.equal(await hssCalls(), 1n);
  assert.equal(await hssCaller(), notary.toLowerCase());
  fails(await send(OUTSIDER, "approve", [sched(1)]), "BadStatus");

  // Pasadas las 48 h del móvil, la petición del kit SIGUE esperando.
  fails(await send(RESCUE, "approve", [sched(2)]), "TooEarly");
  chain.advance(R - W - 1n);
  fails(await send(RESCUE, "approve", [sched(2)]), "TooEarly");
  chain.advance(1n);
  assert.ok((await send(OUTSIDER, "approve", [sched(2)])).ok);
  assert.equal(await hssCalls(), 2n);
  fails(await send(OUTSIDER, "approve", [sched(3)]), "BadStatus"); // nunca anunciada
});

test("veto: quién puede bloquear en cada carril", async () => {
  const { chain, send, status, hssCalls } = await setup();
  // Carril de retirada: móvil, kit y guardián.
  for (const [i, who] of [DEVICE, RESCUE, GUARDIAN].entries()) {
    assert.ok((await send(DEVICE, "request", [sched(10 + i)])).ok);
    fails(await send(OUTSIDER, "veto", [sched(10 + i)]), "NotAllowed");
    const v = await send(who, "veto", [sched(10 + i)]);
    assert.ok(v.ok, `debe poder bloquear: ${who}`);
    assert.equal(v.events[0].name, "Vetoed");
    assert.equal(await status(sched(10 + i)), Status.Vetoed);
    fails(await send(who, "veto", [sched(10 + i)]), "BadStatus");
  }
  // Carril de recuperación: kit y móvil. El guardián NO.
  for (const [i, who] of [RESCUE, DEVICE].entries()) {
    assert.ok((await send(RESCUE, "requestRecovery", [sched(20 + i)])).ok);
    fails(await send(GUARDIAN, "veto", [sched(20 + i)]), "NotAllowed");
    fails(await send(OUTSIDER, "veto", [sched(20 + i)]), "NotAllowed");
    assert.ok((await send(who, "veto", [sched(20 + i)])).ok, `debe poder bloquear: ${who}`);
  }
  // No se puede bloquear algo que no se ha anunciado, y lo bloqueado no sale nunca.
  fails(await send(DEVICE, "veto", [sched(99)]), "BadStatus");
  chain.advance(R + 1n);
  for (const n of [10, 11, 12, 20, 21]) fails(await send(OUTSIDER, "approve", [sched(n)]), "BadStatus");
  assert.equal(await hssCalls(), 0n);
});

test("freeze: solo la otra parte puede congelar cada carril", async () => {
  const { chain, notary, send } = await setup();
  for (const who of [DEVICE, OUTSIDER, DEPLOYER]) fails(await send(who, "freeze", [Lane.Withdraw]), "NotAllowed");
  for (const who of [RESCUE, GUARDIAN, OUTSIDER, DEPLOYER]) fails(await send(who, "freeze", [Lane.Recovery]), "NotAllowed");
  fails(await send(DEVICE, "freeze", [Lane.None]), "InvalidLane");
  // Un valor de carril que no existe revierte al decodificar.
  const bad = await chain.raw({ from: DEVICE, to: notary, data: notary2Abi.getFunction("freeze").selector + "3".padStart(64, "0") });
  assert.equal(bad.ok, false);
  for (const who of [RESCUE, GUARDIAN]) {
    const f = await send(who, "freeze", [Lane.Withdraw]);
    assert.ok(f.ok);
    assert.equal(f.events[0].name, "Frozen");
    assert.equal(f.events[0].args.lane, Lane.Withdraw);
  }
  assert.ok((await send(DEVICE, "freeze", [Lane.Recovery])).ok);
});

test("freeze: anula todo lo pendiente del carril, lo cierra un periodo y no toca el otro", async () => {
  const { chain, send, read, status, hssCalls } = await setup();
  // El ladrón con el kit abre tres recuperaciones; el móvil tiene una retirada en curso.
  for (const n of [1, 2, 3]) assert.ok((await send(RESCUE, "requestRecovery", [sched(n)])).ok);
  assert.ok((await send(DEVICE, "request", [sched(50)])).ok);

  const f = await send(DEVICE, "freeze", [Lane.Recovery]); // un solo toque del dueño
  assert.ok(f.ok);
  for (const n of [1, 2, 3]) assert.equal(await status(sched(n)), Status.Vetoed);
  assert.equal(await status(sched(50)), Status.Requested);
  assert.equal(await read("epochOf", [Lane.Recovery]), 1n);
  assert.equal(await read("epochOf", [Lane.Withdraw]), 0n);

  // El kit no puede abrir otra hasta que pase el periodo.
  fails(await send(RESCUE, "requestRecovery", [sched(4)]), "LaneLocked");
  chain.advance(W);
  assert.ok((await send(OUTSIDER, "approve", [sched(50)])).ok, "la retirada del móvil sigue su curso");
  fails(await send(RESCUE, "requestRecovery", [sched(4)]), "LaneLocked");
  chain.advance(R - W);
  // Las anuladas no salen aunque haya pasado todo el plazo.
  for (const n of [1, 2, 3]) fails(await send(OUTSIDER, "approve", [sched(n)]), "Superseded");
  assert.equal(await hssCalls(), 1n);

  // Pasado el cierre, el carril vuelve a funcionar con normalidad.
  assert.ok((await send(RESCUE, "requestRecovery", [sched(4)])).ok);
  chain.advance(R);
  assert.ok((await send(OUTSIDER, "approve", [sched(4)])).ok);
  assert.equal(await hssCalls(), 2n);
});

test("freeze del carril de retirada: el kit o el guardián paran al ladrón que tiene el móvil", async () => {
  const { chain, send, status } = await setup();
  assert.ok((await send(DEVICE, "request", [sched(1)])).ok);
  assert.ok((await send(GUARDIAN, "freeze", [Lane.Withdraw])).ok);
  assert.equal(await status(sched(1)), Status.Vetoed);
  fails(await send(DEVICE, "request", [sched(2)]), "LaneLocked");
  chain.advance(W - 1n);
  assert.ok((await send(RESCUE, "freeze", [Lane.Withdraw])).ok); // se puede renovar
  chain.advance(W - 1n);
  fails(await send(DEVICE, "request", [sched(2)]), "LaneLocked");
  fails(await send(OUTSIDER, "approve", [sched(1)]), "Superseded");
});

test("sin guardián: la dirección cero no vigila nada", async () => {
  const { chain, notary } = await setup({ guardian: ZERO });
  const r = await chain.send(notary2Abi, notary, ZERO, "freeze", [Lane.Withdraw]);
  fails(r, "NotAllowed");
});

test("si Hedera rechaza la firma, approve revierte y la petición sigue pendiente", async () => {
  const { chain, send, status, hssCalls } = await setup({ rc: 201n });
  assert.ok((await send(DEVICE, "request", [sched(1)])).ok);
  chain.advance(W);
  const r = await send(OUTSIDER, "approve", [sched(1)]);
  fails(r, "AuthorizeFailed");
  assert.equal(r.error.args[0], 201n);
  assert.equal(await status(sched(1)), Status.Requested);
  assert.equal(await hssCalls(), 0n);
  assert.ok((await chain.send(mockAbi, HSS, DEPLOYER, "setShouldRevert", [true])).ok);
  fails(await send(OUTSIDER, "approve", [sched(1)]), "AuthorizeFailed");
  assert.ok((await chain.send(mockAbi, HSS, DEPLOYER, "setShouldRevert", [false])).ok);
  assert.ok((await chain.send(mockAbi, HSS, DEPLOYER, "setRc", [SUCCESS])).ok);
  assert.ok((await send(OUTSIDER, "approve", [sched(1)])).ok);
  assert.equal(await status(sched(1)), Status.Approved);
});

test("contrato trampa: ni llamando él al Schedule Service ni con delegatecall consigue la firma del notario", async () => {
  const { chain, notary, send, status, hssCalls, hssCaller } = await setup();
  const dep = await chain.deploy(rogueArtifact, rogueAbi, [], OUTSIDER);
  assert.ok(dep.ok);
  const rogue = dep.createdAddress.toLowerCase();
  // El ladrón (con el kit) ha anunciado su transacción y no quiere esperar.
  assert.ok((await send(RESCUE, "requestRecovery", [sched(1)])).ok);

  const a = await chain.send(rogueAbi, rogue, OUTSIDER, "authorizeDirect", [sched(1)]);
  assert.ok(a.ok);
  assert.equal(await hssCalls(), 1n);
  assert.equal(await hssCaller(), rogue, "quien firma es el contrato trampa, no el notario");

  const b = await chain.send(rogueAbi, rogue, OUTSIDER, "forgeAndApprove", [notary, sched(1)]);
  assert.ok(b.ok);
  assert.equal(b.events.at(-1).args.ok, true, "con el estado falsificado, el código del notario 'aprueba'…");
  assert.equal(await hssCalls(), 2n);
  assert.equal(await hssCaller(), rogue, "…pero ante Hedera quien firma sigue siendo el contrato trampa");
  assert.notEqual(rogue, notary.toLowerCase());
  // El notario de verdad no se ha enterado: la petición sigue esperando su plazo.
  assert.equal(await status(sched(1)), Status.Requested);
  fails(await send(OUTSIDER, "approve", [sched(1)]), "TooEarly");
});

test("consumo de gas dentro de los límites que usará la app", async () => {
  const { chain, send, deployGas } = await setup();
  const req = await send(DEVICE, "request", [sched(1)]);
  const rec = await send(RESCUE, "requestRecovery", [sched(2)]);
  const veto = await send(RESCUE, "veto", [sched(1)]);
  const frz = await send(DEVICE, "freeze", [Lane.Recovery]);
  assert.ok((await send(DEVICE, "request", [sched(3)])).ok);
  chain.advance(W);
  const app = await send(OUTSIDER, "approve", [sched(3)]);
  console.log(`      gas (sin los 21.000 fijos): despliegue ${deployGas} · request ${req.gasUsed} · requestRecovery ${rec.gasUsed} · veto ${veto.gasUsed} · freeze ${frz.gasUsed} · approve ${app.gasUsed}`);
  for (const r of [req, rec, veto, frz]) assert.ok(r.gasUsed < 70_000n);
  assert.ok(app.gasUsed < 120_000n);
});
