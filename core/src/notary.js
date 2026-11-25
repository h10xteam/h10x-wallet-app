// @ts-check
// Codificación de llamadas y eventos del contrato notario.
import { ContractId, ScheduleId } from "@hiero-ledger/sdk";
import { Interface, getAddress, getBytes } from "ethers";
import { NOTARY_ARTIFACT } from "./artifact.js";

export const notaryAbi = new Interface(NOTARY_ARTIFACT.abi);

/** Estados de una petición en el notario (enum Status del contrato). */
export const RequestStatus = /** @type {const} */ ({ None: 0, Requested: 1, Vetoed: 2, Approved: 3 });

/** @param {string} hex */
export const with0x = (hex) => (hex.startsWith("0x") ? hex : `0x${hex}`);

/** @param {ScheduleId} id */
export const scheduleAddress = (id) => with0x(id.toSolidityAddress()).toLowerCase();

/** @param {string} address dirección "long-zero" de una transacción programada */
export const scheduleIdFromAddress = (address) => ScheduleId.fromSolidityAddress(address.toLowerCase().replace(/^0x/, ""));

/** @param {ContractId} id */
export const contractAddress = (id) => with0x(id.toEvmAddress()).toLowerCase();

/**
 * Initcode del notario: bytecode + argumentos del constructor.
 * Los argumentos van pegados porque, con el bytecode en línea, el nodo ignora constructorParameters.
 * @param {{ quorum: string, vetoers: string[], delaySeconds: number }} p direcciones EVM tal como las ve msg.sender
 */
export function notaryInitcode({ quorum, vetoers, delaySeconds }) {
  const args = notaryAbi.encodeDeploy([getAddress(quorum), vetoers.map((v) => getAddress(v)), BigInt(delaySeconds)]);
  return getBytes(NOTARY_ARTIFACT.bytecode + args.slice(2));
}

/**
 * @param {"request" | "veto" | "approve"} fn @param {ScheduleId} schedule
 */
export const encodeNotaryCall = (fn, schedule) => getBytes(notaryAbi.encodeFunctionData(fn, [scheduleAddress(schedule)]));

/**
 * @typedef {{ kind: "requested", schedule: string, requestedAt: number, executableAt: number }
 *   | { kind: "vetoed", schedule: string, by: string }
 *   | { kind: "approved", schedule: string, approvedAt: number }
 *   | { kind: "created", quorum: string, delay: number, vetoers: string[] }} NotaryEvent
 */

/**
 * Traduce un log del mirror node a un evento del notario.
 * @param {{ topics: string[], data: string }} log
 * @returns {NotaryEvent | null}
 */
export function decodeNotaryLog(log) {
  let parsed;
  try {
    parsed = notaryAbi.parseLog({ topics: log.topics, data: log.data });
  } catch {
    return null;
  }
  if (!parsed) return null;
  const a = parsed.args;
  switch (parsed.name) {
    case "Requested":
      return { kind: "requested", schedule: String(a[0]).toLowerCase(), requestedAt: Number(a[1]), executableAt: Number(a[2]) };
    case "Vetoed":
      return { kind: "vetoed", schedule: String(a[0]).toLowerCase(), by: String(a[1]).toLowerCase() };
    case "Approved":
      return { kind: "approved", schedule: String(a[0]).toLowerCase(), approvedAt: Number(a[1]) };
    case "NotaryCreated":
      return { kind: "created", quorum: String(a[0]).toLowerCase(), delay: Number(a[1]), vetoers: [...a[2]].map((v) => String(v).toLowerCase()) };
    default:
      return null;
  }
}

/**
 * ID «0.0.N» de la transacción programada de un aviso del notario, o null si la dirección no es la de una
 * programada de esta red. El notario acepta CUALQUIER dirección en request(): quien tenga la llave de un
 * carril puede anunciar una que no sea nada. Esa dirección no puede ejecutarse nunca (el servicio de
 * programadas no la conoce), pero no debe atascar a quien lee los avisos. Esta función nunca lanza.
 * @param {unknown} address
 * @returns {string | null}
 */
export function scheduleIdOfAddress(address) {
  if (typeof address !== "string") return null;
  // 20 bytes: 4 de shard y 8 de realm (a cero en Hedera) y 8 con el número de la entidad.
  const m = /^(?:0x)?0{24}([0-9a-f]{16})$/i.exec(address.trim());
  if (!m) return null;
  const num = BigInt(`0x${m[1]}`);
  if (num <= 0n || num > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return `0.0.${num.toString()}`;
}

/**
 * Nombre legible del error del contrato a partir de los datos de la reversión.
 * @param {string | null | undefined} data
 */
export function revertName(data) {
  if (!data || data === "0x") return "(sin datos)";
  try {
    const parsed = notaryAbi.parseError(with0x(data));
    if (parsed) return `${parsed.name}(${parsed.args.map((x) => String(x)).join(", ")})`;
  } catch {
    // no es un error del notario
  }
  return data.length > 74 ? `${data.slice(0, 74)}…` : data;
}
