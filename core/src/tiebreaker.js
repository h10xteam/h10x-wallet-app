// @ts-check
// Contraseña de desempate (notario v3).
//
// Si el ladrón tiene el móvil y el dueño el kit, cada uno podría congelar el carril del otro sin fin.
// Con el notario v3, una recuperación pedida con el kit Y firmada con la llave que sale de esta
// contraseña es prioritaria: el móvil no la puede parar.
//
//   llave = scrypt(contraseña normalizada, sal = "hvault-desempate-v1:" + clave pública del kit)
//
// La dirección de esa llave queda en el contrato (es pública), así que quien robe el kit podría
// probar contraseñas en su ordenador: por eso scrypt (lento y con mucha memoria) y una contraseña
// FUERTE (varias palabras al azar). La sal con la clave del kit hace que cada bóveda sea distinta.
// La contraseña nunca se guarda: solo se usa al crear o cambiar el notario y al recuperar con el kit.
import { PrivateKey } from "@hiero-ledger/sdk";
import { AbiCoder, SigningKey, concat, getBytes, hashMessage, hexlify, keccak256, scrypt, toUtf8Bytes } from "ethers";
import { WORDS_EN, WORDS_ES } from "./words.js";
import { scheduleAddress } from "./notary.js";

/** Parámetros de scrypt: N = 2^15 (32 MB), r = 8, p = 1. Unos segundos en un móvil. */
export const TIEBREAKER_KDF = { N: 1 << 15, r: 8, p: 1 };
const SALT_PREFIX = "hvault-desempate-v1:";
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** Identificador de cadena EVM de cada red de Hedera (la red simulada usa el de su EVM local). */
export const CHAIN_IDS = /** @type {const} */ ({ mainnet: 295, testnet: 296, previewnet: 297, local: 1 });

/**
 * Misma contraseña escrita con mayúsculas, con o sin tildes (también la ñ) o con espacios de más =
 * misma llave. Así «Ábaco Niño» y «abaco nino» dan lo mismo.
 * @param {string} password
 */
export const normalizePassword = (password) =>
  password
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

/**
 * ¿Es lo bastante fuerte? Al menos 5 palabras DISTINTAS de 3 letras o más, con alguna letra y no un solo
 * carácter repetido. Ya no vale «16 caracteres cualesquiera»: «1234 1234 1234 1234» o «aaaaaaaaaaaaaaaa»
 * se prueban en segundos. Quien robe el kit puede probar contraseñas en su ordenador (scrypt, ~70 ms por
 * intento en un núcleo): 4 palabras corrientes caen en horas con mil núcleos; 5 al azar, no.
 * Solo se comprueba al ponerla: las contraseñas que ya existen siguen valiendo para recuperar.
 * @param {string} password
 * @returns {{ ok: boolean, words: number }}
 */
export function passwordStrength(password) {
  const p = normalizePassword(password);
  const counted = new Set(p.split(" ").filter((w) => w.length >= 3 && /\p{L}/u.test(w) && new Set(w).size >= 2));
  return { ok: counted.size >= 5, words: counted.size };
}

/**
 * Propuesta de contraseña: palabras al azar de la lista BIP-39 del idioma (5 = unos 55 bits).
 * @param {"es" | "en"} [lang] @param {number} [count]
 */
export function suggestPassphrase(lang = "es", count = 5) {
  const list = lang === "en" ? WORDS_EN : WORDS_ES;
  /** @type {string[]} */
  const words = [];
  const buf = new Uint32Array(1);
  // 2048 palabras: el resto de una división por 2048 de un número de 32 bits es uniforme. Sin repetir
  // ninguna (una repetida dejaría la propuesta por debajo del mínimo).
  while (words.length < count) {
    globalThis.crypto.getRandomValues(buf);
    const w = list[buf[0] % 2048];
    if (!words.includes(w)) words.push(w);
  }
  return words.join(" ");
}

/**
 * Llave de desempate a partir de la contraseña y la clave pública del kit.
 * @param {string} password @param {import("@hiero-ledger/sdk").PublicKey} kitPublicKey
 * @param {{ onProgress?: (fraction: number) => void }} [opts]
 * @returns {Promise<PrivateKey>}
 */
export async function tiebreakerKey(password, kitPublicKey, { onProgress } = {}) {
  const salt = concat([toUtf8Bytes(SALT_PREFIX), kitPublicKey.toBytesRaw()]);
  let bytes = getBytes(await scrypt(toUtf8Bytes(normalizePassword(password)), salt, TIEBREAKER_KDF.N, TIEBREAKER_KDF.r, TIEBREAKER_KDF.p, 32, onProgress));
  // Casi imposible, pero una llave secp256k1 tiene que estar en [1, n-1].
  for (let i = 0; i < 4; i++) {
    const k = BigInt(hexlify(bytes));
    if (k > 0n && k < SECP256K1_N) break;
    bytes = getBytes(keccak256(bytes));
  }
  return PrivateKey.fromBytesECDSA(bytes);
}

/** Dirección EVM de la llave de desempate (la que se guarda en el notario v3). @param {PrivateKey} key */
export const tiebreakerAddress = (key) => `0x${key.publicKey.toEvmAddress()}`.toLowerCase();

/**
 * Lo que firma la llave de desempate (igual que `priorityDigest` del contrato).
 * @param {{ chainId: number, notaryAddress: string, schedule: import("@hiero-ledger/sdk").ScheduleId | string }} p
 */
export function priorityDigest({ chainId, notaryAddress, schedule }) {
  const scheduleAddr = typeof schedule === "string" ? schedule : `0x${scheduleAddress(schedule).slice(-40)}`;
  const inner = keccak256(AbiCoder.defaultAbiCoder().encode(["string", "uint256", "address", "address"], ["hvault-desempate-v1", chainId, notaryAddress, scheduleAddr]));
  return hashMessage(getBytes(inner));
}

/**
 * Firma de la recuperación prioritaria: { v, r, s } para requestPriority().
 * @param {{ key: PrivateKey, chainId: number, notaryAddress: string, schedule: import("@hiero-ledger/sdk").ScheduleId | string }} p
 */
export function signPriority({ key, chainId, notaryAddress, schedule }) {
  const sig = new SigningKey(key.toBytesRaw()).sign(priorityDigest({ chainId, notaryAddress, schedule }));
  return { v: sig.v, r: sig.r, s: sig.s };
}
