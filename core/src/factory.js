// @ts-check
// Fábrica de notarios v3: crea el notario de una bóveda con una llamada normal a un contrato (≈ 0,09 $) en vez de
// desplegarlo (≈ 1,14 $, casi todo la tarifa fija de crear un contrato). Medido en testnet (nov. 2026).
//
// Tres protecciones (ninguna depende de fiarse de quien anuncia la fábrica):
//   1. La fábrica solo se usa si su código en la red es EXACTAMENTE el compilado: la app lleva fijada su huella
//      (keccak-256) y comprueba también que nadie puede borrarla ni cambiarla (sin clave de administrador).
//   2. El notario que crea se compara byte a byte con el código que debe tener un notario con esos datos (el mismo del
//      despliegue directo) antes de atar la bóveda a él. Si sobra o falta un solo byte, no se usa.
//   3. Si algo falla, el notario se crea directamente, como siempre (lo hace deployNotary2).
import { ContractCreateTransaction, ContractExecuteTransaction, ContractId, FileAppendTransaction, FileCreateTransaction, FileDeleteTransaction, Hbar } from "@hiero-ledger/sdk";
import { Interface, ZeroAddress, getAddress, getBytes, hexlify, keccak256, toBeHex, zeroPadValue } from "ethers";
import { FACTORY3_ARTIFACT } from "./artifact-factory3.js";
import { NOTARY3_ARTIFACT } from "./artifact3.js";
import { tr } from "./i18n.js";
import { WalletError, submit } from "./wallet.js";

export const factory3Abi = new Interface(FACTORY3_ARTIFACT.abi);
/** Huella del código en ejecución de la fábrica buena (la de contracts/NotaryFactory3.sol compilada). */
export const FACTORY3_RUNTIME_KECCAK = FACTORY3_ARTIFACT.runtimeKeccak;
/**
 * Gas de create(): en testnet gastó 1.001.364 (y es lo que cobró). Lo que gasta no depende de los datos: mismo código,
 * mismos eventos, nada de almacenamiento. El límite deja un 25 % de margen.
 */
export const FACTORY_CREATE_GAS = 1_250_000;
/** Tope de comisión de la llamada (se cobra lo que cueste: 1,7 HBAR en testnet con el HBAR a 0,05 $). */
export const FACTORY_CREATE_MAX_FEE_HBAR = 30;
/** Cuánto se espera a que el mirror enseñe el notario creado. */
const MIRROR_WAIT_MS = 90_000;

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const ID_RE = /^0\.0\.\d+$/;

/**
 * @typedef {{ device: string, rescue: string, guardian?: string | null, tiebreaker: string, withdrawDelay: number, recoveryDelay: number }} Notary3Params
 *   direcciones EVM tal como las ve msg.sender
 * @typedef {{ id: string, evmAddress: string }} NotaryFactory
 * @typedef {{ contractInfo: (idOrEvm: string) => Promise<{ id: string, evmAddress: string, runtimeBytecode: string, deleted: boolean, adminKey: any, adminKeyRaw: any } | null>,
 *   contractResult: (txId: string) => Promise<{ result: string, error: string | null, createdContractIds: string[], contractId: string | null } | null>,
 *   simulate: (p: { to?: string, from?: string, data: Uint8Array | string, gas?: number }) => Promise<{ ok: boolean, result: string, error: string }> }} FactoryMirror
 */

/** Palabra de 32 bytes con la que el compilador guarda un dato fijo (immutable) en el código. */
const word = (/** @type {string | bigint | number} */ v) =>
  getBytes(typeof v === "string" ? zeroPadValue(getAddress(v), 32) : zeroPadValue(toBeHex(BigInt(v)), 32));

/**
 * Código en ejecución EXACTO que tiene un notario v3 con estos datos (el del despliegue directo y el de la fábrica son el
 * mismo): el compilado con cada dato fijo escrito en su sitio.
 * @param {Notary3Params} p
 * @returns {string} hex en minúsculas
 */
export function expectedNotary3Runtime({ device, rescue, guardian, tiebreaker, withdrawDelay, recoveryDelay }) {
  const code = getBytes(NOTARY3_ARTIFACT.deployedBytecode).slice();
  /** @type {Record<string, Uint8Array>} */
  const values = {
    device: word(device),
    rescue: word(rescue),
    guardian: word(guardian || ZeroAddress),
    tiebreaker: word(tiebreaker),
    withdrawDelay: word(BigInt(withdrawDelay)),
    recoveryDelay: word(BigInt(recoveryDelay)),
  };
  const refs = /** @type {Record<string, { start: number, length: number }[]>} */ (NOTARY3_ARTIFACT.immutables);
  for (const [name, list] of Object.entries(refs)) {
    const v = values[name];
    if (!v) throw new Error(`dato fijo desconocido en el notario: ${name}`);
    for (const r of list) {
      if (r.length !== 32 || r.start < 0 || r.start + 32 > code.length) throw new Error("referencia de dato fijo fuera del código");
      code.set(v, r.start);
    }
  }
  return hexlify(code).toLowerCase();
}

/** Plazo máximo del notario (MAX_DELAY del contrato: 60 días). */
const MAX_DELAY = 60 * 24 * 3600;

/**
 * Las mismas comprobaciones que hace el constructor del notario v3, sin gastar nada. Devuelve el problema o null.
 * @param {Notary3Params} p
 */
export function notary3ParamsProblem(p) {
  /** @param {string | null | undefined} a */
  const norm = (a) => {
    try {
      return getAddress(a || ZeroAddress).toLowerCase();
    } catch {
      return null;
    }
  };
  const device = norm(p.device);
  const rescue = norm(p.rescue);
  const guardian = norm(p.guardian);
  const tiebreaker = norm(p.tiebreaker);
  const zero = ZeroAddress.toLowerCase();
  if (!device || !rescue || !guardian || !tiebreaker) return "dirección mal formada";
  if (device === zero || rescue === zero || tiebreaker === zero) return "falta una dirección";
  if (device === rescue || guardian === device || guardian === rescue) return "dos llaves iguales";
  if (tiebreaker === device || tiebreaker === rescue || tiebreaker === guardian) return "dos llaves iguales";
  const w = Number(p.withdrawDelay);
  const r = Number(p.recoveryDelay);
  if (!Number.isSafeInteger(w) || !Number.isSafeInteger(r) || w <= 0 || r < w || r > MAX_DELAY) return "plazos no válidos";
  return null;
}

/**
 * ¿Nadie puede borrar ni cambiar el contrato? En Hedera, un contrato sin clave de administrador aparece con su propio ID
 * como clave (o sin clave). Cualquier otra clave (una llave, una lista…) es que alguien lo controla.
 * @param {{ id: string, adminKey: any, adminKeyRaw: any }} info
 */
export function hasNoAdmin(info) {
  if (info.adminKeyRaw == null) return true;
  const k = info.adminKey;
  return k instanceof ContractId && k.shard.toString() === "0" && k.realm.toString() === "0" && `0.0.${k.num.toString()}` === info.id && !k.evmAddress;
}

/**
 * Comprueba una fábrica anunciada (por el guardián o fijada en la app). Devuelve null si no es la buena.
 * @param {{ mirror: FactoryMirror, factoryId: string | null | undefined }} p
 * @returns {Promise<NotaryFactory | null>}
 */
export async function checkNotaryFactory({ mirror, factoryId }) {
  if (!factoryId || !ID_RE.test(factoryId)) return null;
  const info = await mirror.contractInfo(factoryId).catch(() => null);
  if (!info || info.id !== factoryId || info.deleted || !hasNoAdmin(info)) return null;
  if (info.runtimeBytecode.length < 4 || keccak256(info.runtimeBytecode) !== FACTORY3_RUNTIME_KECCAK) return null;
  return { id: info.id, evmAddress: info.evmAddress || `0x${ContractId.fromString(info.id).toEvmAddress()}` };
}

/**
 * La primera fábrica buena de una lista (las fijadas en la app y la que anuncia el guardián).
 * @param {{ mirror: FactoryMirror, candidates: (string | null | undefined)[] }} p
 */
export async function resolveNotaryFactory({ mirror, candidates }) {
  const seen = new Set();
  for (const id of candidates) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const f = await checkNotaryFactory({ mirror, factoryId: id });
    if (f) return f;
  }
  return null;
}

/**
 * ¿Es este contrato un notario v3 genuino con exactamente estos datos? Lee su código de la red y lo compara byte a byte.
 * @param {{ mirror: FactoryMirror, notaryId: string, params: Notary3Params }} p
 * @returns {Promise<{ ok: true, evmAddress: string } | { ok: false, why: string }>}
 */
export async function verifyNotary3({ mirror, notaryId, params }) {
  const info = await mirror.contractInfo(notaryId).catch(() => null);
  if (!info || info.id !== notaryId) return { ok: false, why: "no existe" };
  if (info.deleted) return { ok: false, why: "borrado" };
  if (!hasNoAdmin(info)) return { ok: false, why: "tiene clave de administrador" };
  if (info.runtimeBytecode !== expectedNotary3Runtime(params)) return { ok: false, why: "su código no es el esperado" };
  return { ok: true, evmAddress: info.evmAddress || `0x${ContractId.fromString(notaryId).toEvmAddress()}` };
}

/** @param {() => Promise<any>} fn @param {number} ms */
async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(2500);
  }
}

/**
 * Crea un notario v3 con la fábrica y lo verifica byte a byte. Paga `client` (la cartera). Lanza si algo no cuadra: quien
 * llama (deployNotary2) crea entonces el notario directamente.
 * @param {{ client: import("@hiero-ledger/sdk").Client, mirror: FactoryMirror, factory: NotaryFactory, from: string, params: Notary3Params }} p
 * @returns {Promise<{ notaryId: ContractId, evmAddress: string, txId: string }>}
 */
export async function createNotaryWithFactory({ client, mirror, factory, from, params }) {
  const why = notary3ParamsProblem(params);
  if (why) throw new WalletError(tr(`datos del notario no válidos: ${why}`, `invalid notary data: ${why}`), "BAD_PARAMS");
  const args = [
    getAddress(params.device),
    getAddress(params.rescue),
    getAddress(params.guardian || ZeroAddress),
    getAddress(params.tiebreaker),
    BigInt(params.withdrawDelay),
    BigInt(params.recoveryDelay),
  ];
  const data = factory3Abi.encodeFunctionData("create", args);
  // Sin simulación previa en el mirror: justo después de que la fábrica cree otro notario, el mirror puede ir unos
  // segundos por detrás (todavía no ha visto la última creación) y dar por fallida una creación que en la red sale
  // bien (se vio en testnet). Las comprobaciones del constructor se hacen aquí arriba, y si aun así revirtiera, solo
  // se paga el gas gastado y el notario se crea directamente.
  void from;
  const tx = new ContractExecuteTransaction()
    .setContractId(ContractId.fromString(factory.id))
    .setGas(FACTORY_CREATE_GAS)
    .setFunctionParameters(getBytes(data))
    .setMaxTransactionFee(new Hbar(FACTORY_CREATE_MAX_FEE_HBAR));
  const out = await submit(client, tx);
  if (!out.ok) throw new WalletError(tr(`la fábrica no creó el notario: ${out.status}`, `the factory didn't create the notary: ${out.status}`), out.status, out.txId);
  return notaryFromFactoryCall({ mirror, factory, txId: out.txId, params });
}

/**
 * Tras la llamada a create(): busca en el mirror el notario creado y lo verifica byte a byte. Lanza si no cuadra.
 * @param {{ mirror: FactoryMirror, factory: NotaryFactory, txId: string, params: Notary3Params, waitMs?: number }} p
 * @returns {Promise<{ notaryId: ContractId, evmAddress: string, txId: string }>}
 */
export async function notaryFromFactoryCall({ mirror, factory, txId, params, waitMs = MIRROR_WAIT_MS }) {
  // El ID del notario nuevo: el mirror lo da en el resultado de la llamada.
  const res = await waitFor(async () => {
    const r = await mirror.contractResult(txId);
    return r && r.createdContractIds.length ? r : null;
  }, waitMs);
  if (!res) throw new WalletError(tr("la red no enseña todavía el notario creado", "the network doesn't show the new notary yet"), "MIRROR_TIMEOUT", txId);
  if (res.contractId && res.contractId !== factory.id) throw new WalletError(tr("el resultado no es de la fábrica", "the result isn't the factory's"), "BAD_RESULT", txId);
  if (res.createdContractIds.length !== 1) throw new WalletError(tr("la fábrica creó más de un contrato", "the factory created more than one contract"), "BAD_RESULT", txId);
  const notaryId = res.createdContractIds[0];
  // Lo que devolvió create() debe ser la dirección de ese contrato.
  let returned = "";
  try {
    returned = String(factory3Abi.decodeFunctionResult("create", res.result)[0]).toLowerCase();
  } catch {
    returned = "";
  }
  const check = await waitFor(async () => {
    const v = await verifyNotary3({ mirror, notaryId, params });
    // «No existe» puede ser que el mirror aún no lo tenga: se espera. Lo demás es definitivo.
    if (!v.ok && v.why === "no existe") return null;
    return v;
  }, waitMs);
  if (!check) throw new WalletError(tr("la red no enseña todavía el notario creado", "the network doesn't show the new notary yet"), "MIRROR_TIMEOUT", txId);
  if (!check.ok) throw new WalletError(tr(`el notario creado no es el esperado (${check.why})`, `the new notary isn't the expected one (${check.why})`), "BAD_NOTARY", txId);
  if (returned && returned !== check.evmAddress) throw new WalletError(tr("la dirección del notario no cuadra", "the notary address doesn't match"), "BAD_NOTARY", txId);
  return { notaryId: ContractId.fromString(notaryId), evmAddress: check.evmAddress, txId };
}

/**
 * Despliega la fábrica (una sola vez por red, desde el VPS). Sube el código como archivo (no cabe en una transacción),
 * crea el contrato SIN clave de administrador, borra el archivo y comprueba en el mirror que su código es el bueno.
 * @param {{ client: import("@hiero-ledger/sdk").Client, mirror: FactoryMirror, initcode: string, gas?: number, maxFeeHbar?: number }} p
 * @returns {Promise<{ factoryId: string, evmAddress: string, txId: string }>}
 */
export async function deployNotaryFactory({ client, mirror, initcode, gas = 1_600_000, maxFeeHbar = 40 }) {
  if (!client.operatorPublicKey) throw new WalletError("falta la llave que paga");
  const text = new TextEncoder().encode(initcode.replace(/^0x/, ""));
  const CHUNK = 4_000;
  const fileTx = (/** @type {import("@hiero-ledger/sdk").Transaction} */ t) => t.setMaxTransactionFee(new Hbar(15));
  const created = await submit(client, fileTx(new FileCreateTransaction().setKeys([client.operatorPublicKey]).setContents(text.slice(0, CHUNK)).setFileMemo("H10X Wallet · fábrica de notarios v3")));
  const fileId = created.receipt?.fileId;
  if (!created.ok || !fileId) throw new WalletError(`subir el código: ${created.status}`, created.status, created.txId);
  try {
    for (let i = CHUNK; i < text.length; i += CHUNK) {
      const r = await submit(client, fileTx(new FileAppendTransaction().setFileId(fileId).setContents(text.slice(i, i + CHUNK))));
      if (!r.ok) throw new WalletError(`subir el código: ${r.status}`, r.status, r.txId);
    }
    // Sin setAdminKey: nadie podrá cambiarla ni borrarla.
    const tx = new ContractCreateTransaction().setBytecodeFileId(fileId).setGas(gas).setContractMemo("H10X Wallet · fábrica de notarios v3").setMaxTransactionFee(new Hbar(maxFeeHbar));
    const out = await submit(client, tx);
    const id = out.receipt?.contractId?.toString();
    if (!out.ok || !id) throw new WalletError(`crear la fábrica: ${out.status}`, out.status, out.txId);
    const f = await waitFor(() => checkNotaryFactory({ mirror, factoryId: id }), MIRROR_WAIT_MS);
    if (!f) throw new WalletError(`la fábrica ${id} no pasa la comprobación (código o clave de administrador)`, "BAD_FACTORY", out.txId);
    return { factoryId: id, evmAddress: f.evmAddress, txId: out.txId };
  } finally {
    await submit(client, new FileDeleteTransaction().setFileId(fileId).setMaxTransactionFee(new Hbar(5))).catch(() => undefined);
  }
}
