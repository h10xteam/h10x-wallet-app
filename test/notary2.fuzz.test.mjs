// Fuzzing del notario v2: miles de operaciones al azar (actores, horas y orden aleatorios) contra un
// modelo de referencia de cómo DEBE comportarse. Si el contrato y el modelo discrepan en algo (qué se
// acepta, qué estado queda, cuántas veces firma el notario), la prueba falla con la secuencia exacta.
//
// Reglas que se comprueban en cada paso:
//   - solo el móvil abre retiradas y solo el kit abre recuperaciones; nadie más;
//   - nada se aprueba antes de su hora ni después de que congelen su carril;
//   - el notario firma (authorizeSchedule) una vez por aprobación, y nunca en otro caso;
//   - quien vigila un carril puede congelarlo; nadie más;
//   - un bloqueo o una aprobación son definitivos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrivateKey } from "@hiero-ledger/sdk";
import { HSS, LocalChain, mockAbi, notary2Abi, notary2Artifact, notary3Abi, notary3Artifact } from "./helpers/evm.mjs";
import { signPriority, tiebreakerAddress } from "@boveda/core";

const DEVICE = "0x00000000000000000000000000000000000004d2";
const RESCUE = "0x00000000000000000000000000000000000011d7";
const GUARDIAN = "0x00000000000000000000000000000000000011d8";
const OUTSIDER = "0x000000000000000000000000000000000000beef";
const ACTORS = [DEVICE, RESCUE, GUARDIAN, OUTSIDER];
const W = 3_600n;
const R = 7_200n;
const Lane = { None: 0, Withdraw: 1, Recovery: 2 };
const St = { None: 0, Requested: 1, Vetoed: 2, Approved: 3 };

/** Generador pseudoaleatorio con semilla (para poder repetir un fallo). */
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

/** Modelo de referencia del notario (v2; con `v3`, también la recuperación prioritaria). */
class Model {
  constructor(now, v3 = false) {
    this.v3 = v3;
    this.now = now;
    this.req = new Map(); // schedule → { lane, status, epoch, executableAt }
    this.epoch = { 1: 0, 2: 0 };
    this.locked = { 1: 0n, 2: 0n };
    this.approvals = 0;
  }
  delay(lane) {
    return lane === Lane.Withdraw ? W : R;
  }
  opens(lane, who) {
    return lane === Lane.Withdraw ? who === DEVICE : who === RESCUE;
  }
  watches(lane, who) {
    return lane === Lane.Withdraw ? who === RESCUE || who === GUARDIAN : who === DEVICE;
  }
  open(who, s, lane) {
    if (!this.opens(lane, who)) return false;
    if (this.now < this.locked[lane]) return false;
    if ((this.req.get(s)?.status ?? St.None) !== St.None) return false;
    this.req.set(s, { lane, status: St.Requested, epoch: this.epoch[lane], executableAt: this.now + this.delay(lane), priority: false });
    return true;
  }
  /** Kit + contraseña: ignora el cierre de recuperaciones, cierra el carril de retirada. */
  priority(who, s, goodSig) {
    if (!this.v3 || who !== RESCUE || !goodSig) return false;
    if ((this.req.get(s)?.status ?? St.None) !== St.None) return false;
    const at = this.now + R;
    this.req.set(s, { lane: Lane.Recovery, status: St.Requested, epoch: this.epoch[Lane.Recovery], executableAt: at, priority: true });
    this.epoch[Lane.Withdraw] += 1;
    if (this.locked[Lane.Withdraw] < at) this.locked[Lane.Withdraw] = at;
    return true;
  }
  veto(who, s) {
    const r = this.req.get(s);
    if (!r || r.status !== St.Requested) return false;
    if (r.priority ? who !== RESCUE : !this.opens(r.lane, who) && !this.watches(r.lane, who)) return false;
    r.status = St.Vetoed;
    return true;
  }
  freeze(who, lane) {
    if (!this.watches(lane, who)) return false;
    this.epoch[lane] += 1;
    const until = this.now + this.delay(lane);
    // El v3 nunca acorta un cierre más largo; el v2 lo sustituye.
    this.locked[lane] = this.v3 && this.locked[lane] > until ? this.locked[lane] : until;
    return true;
  }
  approve(s) {
    const r = this.req.get(s);
    if (!r || r.status !== St.Requested) return false;
    if (!r.priority && r.epoch !== this.epoch[r.lane]) return false;
    if (this.now < r.executableAt) return false;
    r.status = St.Approved;
    this.approvals += 1;
    return true;
  }
  statusOf(s) {
    const r = this.req.get(s);
    if (!r) return St.None;
    if (r.status === St.Requested && !r.priority && r.epoch !== this.epoch[r.lane]) return St.Vetoed;
    return r.status;
  }
}

const tbKey = PrivateKey.generateECDSA();
const badKey = PrivateKey.generateECDSA();

async function run(seed, steps, v3 = false) {
  const rand = rng(seed);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const chain = await LocalChain.create();
  assert.ok((await chain.send(mockAbi, HSS, DEVICE, "setRc", [22n])).ok);
  const abi = v3 ? notary3Abi : notary2Abi;
  const dep = v3
    ? await chain.deploy(notary3Artifact, notary3Abi, [DEVICE, RESCUE, GUARDIAN, tiebreakerAddress(tbKey), W, R], DEVICE)
    : await chain.deploy(notary2Artifact, notary2Abi, [DEVICE, RESCUE, GUARDIAN, W, R], DEVICE);
  assert.ok(dep.ok);
  const notary = dep.createdAddress;
  const model = new Model(chain.now, v3);
  const schedules = Array.from({ length: 8 }, (_, i) => `0x${(0x7000 + i).toString(16).padStart(40, "0")}`);
  const trace = [];
  for (let i = 0; i < steps; i++) {
    const kind = pick(v3 ? ["request", "requestRecovery", "priority", "veto", "freeze", "approve", "approve", "warp", "warp"] : ["request", "requestRecovery", "veto", "freeze", "approve", "approve", "warp", "warp"]);
    const who = pick(ACTORS);
    const s = pick(schedules);
    let expected;
    let got;
    if (kind === "warp") {
      const dt = BigInt(Math.floor(rand() * Number(R) * 1.2));
      chain.advance(dt);
      model.now = chain.now;
      trace.push(`warp +${dt}`);
      continue;
    }
    if (kind === "request" || kind === "requestRecovery") {
      expected = model.open(who, s, kind === "request" ? Lane.Withdraw : Lane.Recovery);
      got = (await chain.send(abi, notary, who, kind, [s])).ok;
    } else if (kind === "priority") {
      const good = rand() < 0.75; // a veces con la contraseña equivocada
      const sig = signPriority({ key: good ? tbKey : badKey, chainId: 1, notaryAddress: notary, schedule: s });
      expected = model.priority(who, s, good);
      got = (await chain.send(abi, notary, who, "requestPriority", [s, sig.v, sig.r, sig.s])).ok;
    } else if (kind === "veto") {
      expected = model.veto(who, s);
      got = (await chain.send(abi, notary, who, "veto", [s])).ok;
    } else if (kind === "freeze") {
      const lane = pick([Lane.Withdraw, Lane.Recovery]);
      expected = model.freeze(who, lane);
      got = (await chain.send(abi, notary, who, "freeze", [lane])).ok;
      trace.push(`${who.slice(-4)} freeze(${lane}) → ${got}`);
    } else {
      expected = model.approve(s);
      got = (await chain.send(abi, notary, who, "approve", [s])).ok;
    }
    if (kind !== "freeze") trace.push(`${who.slice(-4)} ${kind}(${s.slice(-4)}) → ${got}`);
    assert.equal(got, expected, `semilla ${seed}, paso ${i}: el contrato dice ${got} y el modelo ${expected}\n${trace.slice(-25).join("\n")}`);
    if (i % 10 === 0 || kind === "approve") {
      for (const x of schedules) {
        const onChain = Number((await chain.read(abi, notary, "statusOf", [x]))[0]);
        assert.equal(onChain, model.statusOf(x), `semilla ${seed}, paso ${i}: estado de ${x.slice(-4)}\n${trace.slice(-25).join("\n")}`);
      }
      const calls = Number((await chain.read(mockAbi, HSS, "calls"))[0]);
      assert.equal(calls, model.approvals, `semilla ${seed}, paso ${i}: firmas del notario`);
    }
  }
  return model.approvals;
}

test("fuzzing del notario v2: 40 secuencias de 150 operaciones al azar contra el modelo", async () => {
  const base = Number(process.env.FUZZ_SEED ?? 20261113);
  const runs = Number(process.env.FUZZ_RUNS ?? 40);
  let approvals = 0;
  for (let k = 0; k < runs; k++) approvals += await run(base + k, 150);
  // Que el fuzzing haya llegado de verdad a aprobar cosas (si no, no prueba gran cosa).
  assert.ok(approvals > runs, `aprobaciones totales: ${approvals}`);
});

test("fuzzing del notario v3 (con recuperaciones prioritarias): 40 secuencias de 150 operaciones", async () => {
  const base = Number(process.env.FUZZ_SEED ?? 20261114);
  const runs = Number(process.env.FUZZ_RUNS ?? 40);
  let approvals = 0;
  for (let k = 0; k < runs; k++) approvals += await run(base + k, 150, true);
  assert.ok(approvals > runs, `aprobaciones totales: ${approvals}`);
});
