// @ts-check
// La clave de la bóveda y utilidades para describirla y compararla.
import { ContractId, Key, KeyList, PrivateKey, PublicKey } from "@hiero-ledger/sdk";

/**
 * Agrupa claves: una sola clave tal cual; varias, como umbral N de M.
 * @param {Key[]} keys @param {number} threshold
 * @returns {Key}
 */
function group(keys, threshold) {
  if (keys.length === 0) throw new Error("hace falta al menos una clave");
  if (threshold < 1 || threshold > keys.length) throw new Error(`umbral ${threshold} no válido para ${keys.length} claves`);
  return keys.length === 1 ? keys[0] : new KeyList(keys, threshold);
}

/**
 * Clave de la bóveda:
 *
 *   1 de 2
 *   ├─ ruta normal : TODAS [ dispositivos (umbral) , ContractID(notario) ]
 *   └─ ruta rescate: llaves de rescate (umbral)
 *
 * Una transacción directa nunca activa un ContractID, así que por la ruta normal solo salen
 * transacciones programadas que el notario autoriza tras el retardo.
 *
 * @param {{ devices: Key[], deviceThreshold?: number, notaryId: ContractId, rescue: Key[], rescueThreshold?: number }} p
 */
export function buildVaultKey({ devices, deviceThreshold = devices.length, notaryId, rescue, rescueThreshold = rescue.length }) {
  const normalRoute = new KeyList([group(devices, deviceThreshold), notaryId]);
  return new KeyList([normalRoute, group(rescue, rescueThreshold)], 1);
}

/**
 * Huella canónica de una clave, para comparar la que guarda la red con la esperada.
 * @param {Key | null | undefined} key
 * @returns {string}
 */
export function keyFingerprint(key) {
  if (key instanceof KeyList) {
    const inner = key.toArray().map(keyFingerprint).join(",");
    return `${key.threshold == null ? "all" : key.threshold}[${inner}]`;
  }
  if (key instanceof ContractId) return `contract:${key.toString()}`;
  if (key instanceof PublicKey) return `${key.type}:${key.toStringRaw()}`;
  return `?:${String(key)}`;
}

/**
 * Comprueba que una clave tiene exactamente la forma de una bóveda con este notario.
 * @param {Key | null | undefined} key @param {ContractId} notaryId
 */
export function isVaultKeyFor(key, notaryId) {
  if (!(key instanceof KeyList) || key.threshold !== 1 || key.toArray().length !== 2) return false;
  const [normal, rescue] = key.toArray();
  if (!(normal instanceof KeyList) || normal.threshold != null || rescue == null) return false;
  const parts = normal.toArray();
  return parts.length === 2 && parts[1] instanceof ContractId && parts[1].toString() === notaryId.toString();
}

/**
 * Clave privada desde texto: DER (portal de Hedera) o hexadecimal crudo (se toma como ECDSA,
 * que es lo que corresponde a una dirección EVM del faucet, salvo que se indique ed25519).
 * @param {string} text @param {string} [typeHint]
 */
export function parsePrivateKey(text, typeHint) {
  const s = text.trim().replace(/^0x/i, "");
  if (PrivateKey.isDerKey(s)) return PrivateKey.fromStringDer(s);
  if ((typeHint ?? "").toLowerCase() === "ed25519") return PrivateKey.fromStringED25519(s);
  return PrivateKey.fromStringECDSA(s);
}

/**
 * La clave de dispositivos de una bóveda (ruta normal sin el notario), o null si no tiene esa forma.
 * @param {Key | null | undefined} key
 */
export function vaultDeviceKey(key) {
  if (!(key instanceof KeyList)) return null;
  const normal = key.toArray()[0];
  return normal instanceof KeyList ? normal.toArray()[0] ?? null : null;
}

/**
 * Árbol legible de una clave.
 * @param {Key | null | undefined} key @param {string} [indent]
 * @returns {string[]}
 */
export function describeKey(key, indent = "") {
  if (key instanceof KeyList) {
    const items = key.toArray();
    const head = key.threshold == null ? `TODAS (${items.length})` : `${key.threshold} de ${items.length}`;
    return [`${indent}${head}`, ...items.flatMap((k) => describeKey(k, `${indent}  `))];
  }
  if (key instanceof ContractId) return [`${indent}contrato ${key.toString()}`];
  if (key instanceof PublicKey) return [`${indent}${key.type} ${key.toStringRaw().slice(0, 16)}…`];
  return [`${indent}${key == null ? "(sin clave)" : String(key)}`];
}
