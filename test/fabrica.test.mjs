// Fábrica de notarios: en una EVM local se comprueba que el notario que crea es byte a byte el de la app con los mismos
// datos, que no tiene dueño ni estado ni forma de cambiar, y que la app solo acepta la fábrica buena y el notario exacto
// (protecciones 1 y 2 de core/src/factory.js). Lo que solo se puede ver en Hedera (clave de administrador, Schedule
// Service, coste real) va en test/testnet-fabrica.mjs.
import test from "node:test";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { Interface, getCreateAddress, keccak256 } from "ethers";
import { ContractId } from "@hiero-ledger/sdk";
import { NOTARY3_ARTIFACT } from "../core/src/artifact3.js";
import { FACTORY3_ARTIFACT, FACTORY3_RUNTIME_KECCAK, checkNotaryFactory, expectedNotary3Runtime, hasNoAdmin, notary3ParamsProblem, notaryFromFactoryCall, verifyNotary3, vaultSetupReserve, minPocketForVault } from "../core/src/index.js";
import { LocalChain } from "./helpers/evm.mjs";
import { compileFactory } from "./helpers/fabrica.mjs";

const require = createRequire(import.meta.url);
const c = compileFactory();
const factoryAbi = new Interface(c.factory.abi);
const notaryAbi = new Interface(NOTARY3_ARTIFACT.abi);
const A = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const params = [A(0xd1), A(0xe5), A(0x6a), A(0x7b), 86_400n, 604_800n];
const deployer = A(0x1001);

test("la fábrica crea exactamente el notario de la app (mismo código y mismos datos)", async () => {
  assert.equal(c.notary3.bytecode, NOTARY3_ARTIFACT.bytecode, "el v3 compilado junto a la fábrica es el de la app");
  const chain = await LocalChain.create();
  const f = await chain.deploy(c.factory, factoryAbi, [], deployer);
  assert.ok(f.ok && f.createdAddress);
  const made = await chain.send(factoryAbi, f.createdAddress, A(0x2002), "create", params);
  assert.ok(made.ok, JSON.stringify(made.error));
  const ev = made.events.find((e) => e.name === "NotaryCreated");
  const child = String(ev.args.notary).toLowerCase();
  assert.equal(child, getCreateAddress({ from: f.createdAddress, nonce: 1 }).toLowerCase(), "CREATE normal (no CREATE2): nadie puede adelantarse a la dirección");
  const direct = await chain.deploy({ bytecode: NOTARY3_ARTIFACT.bytecode }, notaryAbi, params, deployer);
  assert.ok(direct.ok);
  const code = async (a) => (await chain.vm.stateManager.getCode((await import("@ethereumjs/util")).createAddressFromString(a))).length;
  assert.equal(await code(child), await code(direct.createdAddress));
  const runtime = async (a) => Buffer.from(await chain.vm.stateManager.getCode((await import("@ethereumjs/util")).createAddressFromString(a))).toString("hex");
  assert.equal(await runtime(child), await runtime(direct.createdAddress), "mismo código en ejecución, datos incluidos");
  for (const [fn, want] of [["device", params[0]], ["rescue", params[1]], ["guardian", params[2]], ["tiebreaker", params[3]], ["withdrawDelay", params[4]], ["recoveryDelay", params[5]]]) {
    assert.equal(String((await chain.read(notaryAbi, child, fn))[0]).toLowerCase(), String(want).toLowerCase(), fn);
  }
  console.log(`      gas: fábrica.create ${made.gasUsed} · notario directo ${direct.gasUsed}`);
});

test("la fábrica no tiene dueño, ni estado, ni nada que cambiar", async () => {
  const fns = c.factory.abi.filter((x) => x.type === "function").map((x) => x.name);
  assert.deepEqual(fns, ["create"], "solo una función");
  assert.ok(!c.factory.abi.some((x) => x.type === "receive" || x.type === "fallback"), "no acepta HBAR ni llamadas sueltas");
  assert.ok(!c.factory.abi.some((x) => x.type === "function" && x.stateMutability === "payable"));
  const chain = await LocalChain.create();
  const f = await chain.deploy(c.factory, factoryAbi, [], deployer);
  await chain.send(factoryAbi, f.createdAddress, A(0x2002), "create", params);
  const { createAddressFromString } = await import("@ethereumjs/util");
  const storage = await chain.vm.stateManager.dumpStorage(createAddressFromString(f.createdAddress));
  assert.deepEqual(Object.keys(storage), [], "no guarda nada");
  // El código fuente: sin delegatecall, selfdestruct, owner ni ensamblador.
  const src = (await import("node:fs")).readFileSync(new URL("../contracts/NotaryFactory3.sol", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(src, /delegatecall|selfdestruct|assembly|owner|onlyOwner|upgrade|\.call\{|\.call\(/i);
});

test("la fábrica hereda las comprobaciones del notario: datos absurdos no crean nada", async () => {
  const chain = await LocalChain.create();
  const f = await chain.deploy(c.factory, factoryAbi, [], deployer);
  const bad = [
    [A(0), A(0xe5), A(0x6a), A(0x7b), 86_400n, 604_800n],
    [A(0xd1), A(0xd1), A(0x6a), A(0x7b), 86_400n, 604_800n],
    [A(0xd1), A(0xe5), A(0x6a), A(0x7b), 0n, 604_800n],
    [A(0xd1), A(0xe5), A(0x6a), A(0x7b), 604_800n, 86_400n],
  ];
  for (const p of bad) {
    const r = await chain.send(factoryAbi, f.createdAddress, A(0x2002), "create", p);
    assert.equal(r.ok, false, JSON.stringify(p.map(String)));
  }
});

// ---- lo que comprueba la app ---------------------------------------------------------------------------------------

const runtimeAt = async (chain, a) => `0x${Buffer.from(await chain.vm.stateManager.getCode((await import("@ethereumjs/util")).createAddressFromString(a))).toString("hex")}`;
const named = { device: params[0], rescue: params[1], guardian: params[2], tiebreaker: params[3], withdrawDelay: Number(params[4]), recoveryDelay: Number(params[5]) };

/** Mirror de mentira sobre la EVM local: cada contrato tiene un ID 0.0.N y la app lo lee como lo leería del real. */
function fakeMirror(chain) {
  const byId = new Map();
  const results = new Map();
  return {
    byId,
    results,
    add(id, address, extra = {}) {
      byId.set(id, { address, adminKeyRaw: null, adminKey: null, deleted: false, ...extra });
    },
    async contractInfo(id) {
      const c = byId.get(id);
      if (!c) return null;
      return { id, evmAddress: c.address, runtimeBytecode: c.runtime ?? (await runtimeAt(chain, c.address)), deleted: c.deleted, adminKey: c.adminKey, adminKeyRaw: c.adminKeyRaw };
    },
    async contractResult(txId) {
      return results.get(txId) ?? null;
    },
    async simulate() {
      return { ok: true, result: "0x", error: "" };
    },
  };
}

test("la huella de la fábrica que lleva la app es la del código fuente actual", () => {
  assert.equal(keccak256(c.factory.deployedBytecode), FACTORY3_RUNTIME_KECCAK, "si cambia NotaryFactory3.sol hay que recompilar (npm run compile) y desplegar otra fábrica");
  assert.equal(c.factory.bytecode, JSON.parse((require("node:fs")).readFileSync(new URL("../scripts/build/NotaryFactory3.json", import.meta.url), "utf8")).bytecode, "el código que despliega el VPS es el mismo");
  assert.deepEqual(FACTORY3_ARTIFACT.abi, c.factory.abi);
});

test("la app sabe el código exacto que debe tener un notario con unos datos (y cualquier dato distinto lo cambia)", async () => {
  const chain = await LocalChain.create();
  const f = await chain.deploy(c.factory, factoryAbi, [], deployer);
  await chain.send(factoryAbi, f.createdAddress, A(0x2002), "create", params);
  const child = getCreateAddress({ from: f.createdAddress, nonce: 1 }).toLowerCase();
  const direct = await chain.deploy({ bytecode: NOTARY3_ARTIFACT.bytecode }, notaryAbi, params, deployer);
  const want = expectedNotary3Runtime(named);
  assert.equal(await runtimeAt(chain, child), want, "el de la fábrica");
  assert.equal(await runtimeAt(chain, direct.createdAddress), want, "el directo");
  for (const [k, v] of [["device", A(0xd2)], ["rescue", A(0xe6)], ["guardian", A(0)], ["tiebreaker", A(0x7c)], ["withdrawDelay", 86_401], ["recoveryDelay", 1_209_600]]) {
    assert.notEqual(expectedNotary3Runtime({ ...named, [k]: v }), want, k);
  }
  // Sin guardián: dirección cero.
  const noG = await chain.deploy({ bytecode: NOTARY3_ARTIFACT.bytecode }, notaryAbi, [params[0], params[1], A(0), params[3], params[4], params[5]], deployer);
  assert.equal(await runtimeAt(chain, noG.createdAddress), expectedNotary3Runtime({ ...named, guardian: null }));
});

test("solo vale la fábrica buena: otro código, con dueño o borrada, no se usa", async () => {
  const chain = await LocalChain.create();
  const good = await chain.deploy(c.factory, factoryAbi, [], deployer);
  const m = fakeMirror(chain);
  m.add("0.0.500", good.createdAddress);
  assert.deepEqual(await checkNotaryFactory({ mirror: m, factoryId: "0.0.500" }), { id: "0.0.500", evmAddress: good.createdAddress.toLowerCase() });
  // Otro contrato cualquiera (aquí, un notario) anunciado como fábrica.
  const other = await chain.deploy({ bytecode: NOTARY3_ARTIFACT.bytecode }, notaryAbi, params, deployer);
  m.add("0.0.501", other.createdAddress);
  assert.equal(await checkNotaryFactory({ mirror: m, factoryId: "0.0.501" }), null);
  // El mismo código con un byte cambiado.
  const code = await runtimeAt(chain, good.createdAddress);
  m.add("0.0.502", good.createdAddress, { runtime: code.slice(0, -2) + (code.endsWith("00") ? "01" : "00") });
  assert.equal(await checkNotaryFactory({ mirror: m, factoryId: "0.0.502" }), null);
  // El código bueno, pero desplegado CON clave de administrador (alguien podría borrarla).
  const { PrivateKey } = await import("@hiero-ledger/sdk");
  const k = PrivateKey.generateED25519().publicKey;
  m.add("0.0.503", good.createdAddress, { adminKeyRaw: { _type: "ED25519", key: k.toStringRaw() }, adminKey: k });
  assert.equal(await checkNotaryFactory({ mirror: m, factoryId: "0.0.503" }), null);
  // Con su propio ID como clave (así enseña Hedera un contrato sin clave): vale.
  m.add("0.0.504", good.createdAddress, { adminKeyRaw: { _type: "ProtobufEncoded", key: "x" }, adminKey: ContractId.fromString("0.0.504") });
  assert.ok(await checkNotaryFactory({ mirror: m, factoryId: "0.0.504" }));
  // Con el ID de OTRO contrato como clave: ese otro la controlaría.
  m.add("0.0.505", good.createdAddress, { adminKeyRaw: { _type: "ProtobufEncoded", key: "x" }, adminKey: ContractId.fromString("0.0.999") });
  assert.equal(await checkNotaryFactory({ mirror: m, factoryId: "0.0.505" }), null);
  m.add("0.0.506", good.createdAddress, { deleted: true });
  assert.equal(await checkNotaryFactory({ mirror: m, factoryId: "0.0.506" }), null);
  for (const bad of [null, "", "0.0.", "1.2.3", "0.0.500/../x", "0x" + "1".repeat(40)]) assert.equal(await checkNotaryFactory({ mirror: m, factoryId: bad }), null, String(bad));
  assert.equal(hasNoAdmin({ id: "0.0.7", adminKeyRaw: null, adminKey: null }), true);
});

test("el notario creado se acepta solo si es exactamente el pedido", async () => {
  const chain = await LocalChain.create();
  const f = await chain.deploy(c.factory, factoryAbi, [], deployer);
  const m = fakeMirror(chain);
  m.add("0.0.600", f.createdAddress);
  const factory = { id: "0.0.600", evmAddress: f.createdAddress.toLowerCase() };
  const call = async (txId, args) => {
    const made = await chain.send(factoryAbi, f.createdAddress, A(0x2002), "create", args);
    assert.ok(made.ok);
    return String(made.events.find((e) => e.name === "NotaryCreated").args.notary).toLowerCase();
  };
  const ret = (a) => factoryAbi.encodeFunctionResult("create", [a]);

  // Bien: el notario con tus datos.
  const mine = await call("tx1", params);
  m.add("0.0.601", mine);
  m.results.set("tx1", { result: ret(mine), error: null, createdContractIds: ["0.0.601"], contractId: "0.0.600" });
  const ok = await notaryFromFactoryCall({ mirror: m, factory, txId: "tx1", params: named, waitMs: 0 });
  assert.equal(ok.notaryId.toString(), "0.0.601");
  assert.equal(ok.evmAddress, mine);
  assert.deepEqual(await verifyNotary3({ mirror: m, notaryId: "0.0.601", params: named }), { ok: true, evmAddress: mine });

  // Una fábrica trampa (o un mirror mentiroso) que devuelve un notario con el kit de OTRO: se rechaza.
  const theirs = await call("tx2", [params[0], A(0xbad), params[2], params[3], params[4], params[5]]);
  m.add("0.0.602", theirs);
  m.results.set("tx2", { result: ret(theirs), error: null, createdContractIds: ["0.0.602"], contractId: "0.0.600" });
  await assert.rejects(notaryFromFactoryCall({ mirror: m, factory, txId: "tx2", params: named, waitMs: 0 }), /no es el esperado/);
  // Plazo más corto, sin contraseña de desempate propia o sin guardián: igual.
  for (const [i, args] of [
    [3, [params[0], params[1], params[2], params[3], 120n, 300n]],
    [4, [params[0], params[1], params[2], A(0x666), params[4], params[5]]],
    [5, [params[0], params[1], A(0), params[3], params[4], params[5]]],
  ]) {
    const a = await call(`tx${i}`, args);
    m.add(`0.0.60${i}`, a);
    m.results.set(`tx${i}`, { result: ret(a), error: null, createdContractIds: [`0.0.60${i}`], contractId: "0.0.600" });
    await assert.rejects(notaryFromFactoryCall({ mirror: m, factory, txId: `tx${i}`, params: named, waitMs: 0 }), /no es el esperado/, String(i));
  }
  // Un contrato cualquiera haciéndose pasar por el notario.
  m.add("0.0.607", f.createdAddress);
  m.results.set("tx7", { result: ret(f.createdAddress), error: null, createdContractIds: ["0.0.607"], contractId: "0.0.600" });
  await assert.rejects(notaryFromFactoryCall({ mirror: m, factory, txId: "tx7", params: named, waitMs: 0 }), /no es el esperado/);
  // El notario bueno pero con clave de administrador ajena.
  const { PrivateKey } = await import("@hiero-ledger/sdk");
  const k = PrivateKey.generateED25519().publicKey;
  m.add("0.0.608", mine, { adminKeyRaw: { _type: "ED25519", key: k.toStringRaw() }, adminKey: k });
  m.results.set("tx8", { result: ret(mine), error: null, createdContractIds: ["0.0.608"], contractId: "0.0.600" });
  await assert.rejects(notaryFromFactoryCall({ mirror: m, factory, txId: "tx8", params: named, waitMs: 0 }), /clave de administrador/);
  // Más de un contrato creado, el resultado de otro contrato, una dirección devuelta que no cuadra o nada en el mirror.
  m.results.set("tx9", { result: ret(mine), error: null, createdContractIds: ["0.0.601", "0.0.602"], contractId: "0.0.600" });
  await assert.rejects(notaryFromFactoryCall({ mirror: m, factory, txId: "tx9", params: named, waitMs: 0 }), /más de un contrato/);
  m.results.set("tx10", { result: ret(mine), error: null, createdContractIds: ["0.0.601"], contractId: "0.0.666" });
  await assert.rejects(notaryFromFactoryCall({ mirror: m, factory, txId: "tx10", params: named, waitMs: 0 }), /no es de la fábrica/);
  m.results.set("tx11", { result: ret(theirs), error: null, createdContractIds: ["0.0.601"], contractId: "0.0.600" });
  await assert.rejects(notaryFromFactoryCall({ mirror: m, factory, txId: "tx11", params: named, waitMs: 0 }), /no cuadra/);
  await assert.rejects(notaryFromFactoryCall({ mirror: m, factory, txId: "tx-nada", params: named, waitMs: 0 }), /todavía/);
});

test("crear la bóveda con la fábrica pide bastante menos saldo", () => {
  const price = 0.0497;
  const direct = minPocketForVault(price);
  const withFactory = minPocketForVault(price, { factory: true });
  assert.equal(direct, 31n * 100_000_000n);
  assert.equal(withFactory, 10n * 100_000_000n);
  assert.ok(vaultSetupReserve(price, { factory: true }) < vaultSetupReserve(price));
  assert.ok(minPocketForVault(null, { factory: true }) < minPocketForVault(null));
});

test("antes de llamar a la fábrica, la app hace las mismas comprobaciones que el constructor (sin depender del mirror)", async () => {
  assert.equal(notary3ParamsProblem(named), null);
  assert.equal(notary3ParamsProblem({ ...named, guardian: null }), null, "sin guardián vale");
  for (const bad of [
    { device: A(0) },
    { tiebreaker: A(0) },
    { rescue: named.device },
    { guardian: named.rescue },
    { tiebreaker: named.guardian },
    { withdrawDelay: 0 },
    { recoveryDelay: 3600, withdrawDelay: 7200 },
    { recoveryDelay: 61 * 86_400 },
    { device: "0x123" },
  ]) {
    const p = { ...named, ...bad };
    assert.ok(notary3ParamsProblem(p), JSON.stringify(bad));
    // Y lo que la app rechaza, el contrato también lo rechaza (no se rechaza nada que el contrato aceptaría).
    if (bad.device !== "0x123") {
      const chain = await LocalChain.create();
      const f = await chain.deploy(c.factory, factoryAbi, [], deployer);
      const r = await chain.send(factoryAbi, f.createdAddress, A(0x2002), "create", [p.device, p.rescue, p.guardian ?? A(0), p.tiebreaker, BigInt(p.withdrawDelay), BigInt(p.recoveryDelay)]);
      assert.equal(r.ok, false, `el contrato también lo rechaza: ${JSON.stringify(bad)}`);
    }
  }
});
