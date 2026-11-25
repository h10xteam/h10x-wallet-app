// Pruebas locales del contrato notario (lógica de retardo, veto y control de acceso).
// No prueban Hedera: el Schedule Service es un doble. Lo que depende de la red se prueba con scripts/poc.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HSS, LocalChain, mockAbi, notaryAbi, notaryArtifact } from "./helpers/evm.mjs";

const DEPLOYER = "0x00000000000000000000000000000000000000d1";
const QUORUM = "0x00000000000000000000000000000000000004d2";
const VETO_1 = "0x00000000000000000000000000000000000011d7";
const VETO_2 = "0x00000000000000000000000000000000000011d8";
const OUTSIDER = "0x000000000000000000000000000000000000beef";
const DELAY = 172_800n; // 48 h
const sched = (n) => "0x" + (0x5000 + n).toString(16).padStart(40, "0");

const Status = { None: 0n, Requested: 1n, Vetoed: 2n, Approved: 3n };
const SUCCESS = 22n;

async function setup({ rc = SUCCESS } = {}) {
  const chain = await LocalChain.create();
  const set = await chain.send(mockAbi, HSS, DEPLOYER, "setRc", [rc]);
  assert.ok(set.ok);
  const dep = await chain.deploy(notaryArtifact, notaryAbi, [QUORUM, [VETO_1, VETO_2], DELAY], DEPLOYER);
  assert.ok(dep.ok, "el despliegue debe funcionar");
  const notary = dep.createdAddress;
  const send = (from, fn, args) => chain.send(notaryAbi, notary, from, fn, args);
  const status = async (s) => (await chain.read(notaryAbi, notary, "requests", [s]))[0];
  const hssCalls = async () => (await chain.read(mockAbi, HSS, "calls"))[0];
  return { chain, notary, send, status, hssCalls, deployGas: dep.gasUsed };
}

test("despliegue: guarda quórum, retardo y vetadores", async () => {
  const { chain, notary } = await setup();
  assert.equal((await chain.read(notaryAbi, notary, "quorum"))[0].toLowerCase(), QUORUM);
  assert.equal((await chain.read(notaryAbi, notary, "delay"))[0], DELAY);
  assert.equal((await chain.read(notaryAbi, notary, "isVetoer", [VETO_1]))[0], true);
  assert.equal((await chain.read(notaryAbi, notary, "isVetoer", [VETO_2]))[0], true);
  assert.equal((await chain.read(notaryAbi, notary, "isVetoer", [QUORUM]))[0], false);
});

test("despliegue: rechaza parámetros inválidos", async () => {
  const chain = await LocalChain.create();
  const zero = "0x0000000000000000000000000000000000000000";
  const cases = [
    [[zero, [VETO_1], DELAY], "ZeroAddress"],
    [[QUORUM, [VETO_1], 0n], "InvalidDelay"],
    [[QUORUM, [VETO_1], 61n * 86_400n], "InvalidDelay"],
    [[QUORUM, [], DELAY], "NoVetoers"],
    [[QUORUM, [VETO_1, zero], DELAY], "ZeroAddress"],
  ];
  for (const [args, expected] of cases) {
    const dep = await chain.deploy(notaryArtifact, notaryAbi, args, DEPLOYER);
    assert.equal(dep.ok, false, `debe fallar: ${expected}`);
    assert.equal(notaryAbi.parseError(dep.returnData).name, expected);
  }
});

test("request: solo el quórum puede abrir una petición", async () => {
  const { send, status } = await setup();
  for (const who of [OUTSIDER, VETO_1, DEPLOYER]) {
    const r = await send(who, "request", [sched(1)]);
    assert.equal(r.ok, false);
    assert.equal(r.error.name, "NotQuorum");
  }
  assert.equal(await status(sched(1)), Status.None);
});

test("request: registra la hora y no se puede repetir", async () => {
  const { chain, notary, send } = await setup();
  const r = await send(QUORUM, "request", [sched(1)]);
  assert.ok(r.ok);
  assert.equal(r.events[0].name, "Requested");
  const [st, requestedAt, executableAt] = await chain.read(notaryAbi, notary, "requests", [sched(1)]);
  assert.equal(st, Status.Requested);
  assert.equal(requestedAt, chain.now);
  assert.equal(executableAt, chain.now + DELAY);
  const again = await send(QUORUM, "request", [sched(1)]);
  assert.equal(again.ok, false);
  assert.equal(again.error.name, "BadStatus");
});

test("approve: sin petición previa no hay firma del notario", async () => {
  const { send, hssCalls } = await setup();
  const r = await send(OUTSIDER, "approve", [sched(1)]);
  assert.equal(r.ok, false);
  assert.equal(r.error.name, "BadStatus");
  assert.equal(await hssCalls(), 0n);
});

test("approve: antes del retardo revierte y no toca el Schedule Service", async () => {
  const { chain, send, hssCalls, status } = await setup();
  await send(QUORUM, "request", [sched(1)]);
  const start = chain.now;
  for (const elapsed of [0n, 1n, DELAY - 1n]) {
    chain.now = start + elapsed;
    const r = await send(OUTSIDER, "approve", [sched(1)]);
    assert.equal(r.ok, false, `a los ${elapsed} s debe fallar`);
    assert.equal(r.error.name, "TooEarly");
  }
  assert.equal(await hssCalls(), 0n);
  assert.equal(await status(sched(1)), Status.Requested);
});

test("approve: justo al cumplirse el retardo, cualquiera puede lanzarlo y el notario firma una sola vez", async () => {
  const { chain, notary, send, hssCalls, status } = await setup();
  await send(QUORUM, "request", [sched(1)]);
  chain.advance(DELAY);
  const r = await send(OUTSIDER, "approve", [sched(1)]);
  assert.ok(r.ok);
  assert.equal(r.events.at(-1).name, "Approved");
  assert.equal(await hssCalls(), 1n);
  assert.equal((await chain.read(mockAbi, HSS, "lastSchedule"))[0].toLowerCase(), sched(1));
  // Quien llama al Schedule Service es el notario: en Hedera eso es lo que activa su ContractID.
  assert.equal((await chain.read(mockAbi, HSS, "lastCaller"))[0].toLowerCase(), notary.toLowerCase());
  assert.equal(await status(sched(1)), Status.Approved);
  const again = await send(OUTSIDER, "approve", [sched(1)]);
  assert.equal(again.ok, false);
  assert.equal(again.error.name, "BadStatus");
  assert.equal(await hssCalls(), 1n);
});

test("veto: solo los vetadores; uno basta y es definitivo", async () => {
  const { chain, send, hssCalls, status } = await setup();
  await send(QUORUM, "request", [sched(1)]);
  for (const who of [OUTSIDER, QUORUM]) {
    const r = await send(who, "veto", [sched(1)]);
    assert.equal(r.ok, false);
    assert.equal(r.error.name, "NotVetoer");
  }
  const v = await send(VETO_2, "veto", [sched(1)]);
  assert.ok(v.ok);
  assert.equal(v.events[0].name, "Vetoed");
  assert.equal(await status(sched(1)), Status.Vetoed);
  chain.advance(DELAY * 10n);
  const a = await send(OUTSIDER, "approve", [sched(1)]);
  assert.equal(a.ok, false);
  assert.equal(a.error.name, "BadStatus");
  const again = await send(QUORUM, "request", [sched(1)]);
  assert.equal(again.ok, false, "una transacción vetada no se puede volver a pedir");
  assert.equal(await hssCalls(), 0n);
});

test("veto preventivo: bloquea una transacción programada antes de que se anuncie", async () => {
  const { send, status } = await setup();
  assert.ok((await send(VETO_1, "veto", [sched(7)])).ok);
  assert.equal(await status(sched(7)), Status.Vetoed);
  const r = await send(QUORUM, "request", [sched(7)]);
  assert.equal(r.ok, false);
  assert.equal(r.error.name, "BadStatus");
});

test("veto: llega tarde si ya se aprobó", async () => {
  const { chain, send } = await setup();
  await send(QUORUM, "request", [sched(1)]);
  chain.advance(DELAY);
  assert.ok((await send(OUTSIDER, "approve", [sched(1)])).ok);
  const v = await send(VETO_1, "veto", [sched(1)]);
  assert.equal(v.ok, false);
  assert.equal(v.error.name, "BadStatus");
});

test("peticiones independientes: vetar una no afecta a otra", async () => {
  const { chain, send, status } = await setup();
  await send(QUORUM, "request", [sched(1)]);
  await send(QUORUM, "request", [sched(2)]);
  await send(VETO_1, "veto", [sched(1)]);
  chain.advance(DELAY);
  assert.ok((await send(OUTSIDER, "approve", [sched(2)])).ok);
  assert.equal(await status(sched(1)), Status.Vetoed);
  assert.equal(await status(sched(2)), Status.Approved);
});

test("approve: si Hedera rechaza la firma, se revierte y la petición sigue abierta", async () => {
  const { chain, send, status } = await setup({ rc: 201n }); // p. ej. un código de error cualquiera
  await send(QUORUM, "request", [sched(1)]);
  chain.advance(DELAY);
  const r = await send(OUTSIDER, "approve", [sched(1)]);
  assert.equal(r.ok, false);
  assert.equal(r.error.name, "AuthorizeFailed");
  assert.equal(r.error.args[0], 201n);
  assert.equal(await status(sched(1)), Status.Requested);
  // Cuando Hedera vuelve a aceptar, la misma petición se puede aprobar.
  await chain.send(mockAbi, HSS, DEPLOYER, "setRc", [SUCCESS]);
  assert.ok((await send(OUTSIDER, "approve", [sched(1)])).ok);
});

test("approve: si la llamada al Schedule Service revierte, se trata como fallo", async () => {
  const { chain, send, status } = await setup();
  await chain.send(mockAbi, HSS, DEPLOYER, "setShouldRevert", [true]);
  await send(QUORUM, "request", [sched(1)]);
  chain.advance(DELAY);
  const r = await send(OUTSIDER, "approve", [sched(1)]);
  assert.equal(r.ok, false);
  assert.equal(r.error.name, "AuthorizeFailed");
  assert.equal(r.error.args[0], 21n);
  assert.equal(await status(sched(1)), Status.Requested);
});

test("gas: consumo de referencia para fijar límites en Hedera", async () => {
  const { chain, send, deployGas } = await setup();
  const req = await send(QUORUM, "request", [sched(1)]);
  const veto = await send(VETO_1, "veto", [sched(2)]);
  chain.advance(DELAY);
  const app = await send(OUTSIDER, "approve", [sched(1)]);
  console.log(
    `    gas de ejecución: despliegue ${deployGas}, request ${req.gasUsed}, veto ${veto.gasUsed}, approve ${app.gasUsed} (con el doble)`,
  );
  assert.ok(deployGas < 1_500_000n && req.gasUsed < 120_000n && app.gasUsed < 200_000n);
});
