// @ts-check
// Bóveda v2: "ninguna llave sola mueve dinero rápido".
//
//   clave de la bóveda = 1 de 3
//     ├─ TODAS [ móvil , notario ]   retirada: cuenta atrás corta, la bloquean el kit o el guardián
//     ├─ TODAS [ kit   , notario ]   recuperación: cuenta atrás larga, la bloquea el móvil
//     └─ TODAS [ móvil , kit ]       las dos llaves juntas: inmediato (evacuar o cambiar llaves)
//
// El kit de rescate es una cuenta propia (con un poco de HBAR para comisiones) porque, para
// abrir su carril, tiene que llamar al notario como msg.sender.
import {
  AccountCreateTransaction,
  AccountId,
  AccountUpdateTransaction,
  Mnemonic,
  Client,
  ContractCreateTransaction,
  ContractExecuteTransaction,
  FileAppendTransaction,
  FileCreateTransaction,
  FileDeleteTransaction,
  ContractId,
  Hbar,
  Key,
  KeyList,
  NftId,
  PrivateKey,
  PublicKey,
  ScheduleCreateTransaction,
  ScheduleId,
  Timestamp,
  TokenId,
  Transaction,
  TransactionRecordQuery,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { Interface, getAddress, getBytes, hexlify } from "ethers";
import { NOTARY2_ARTIFACT } from "./artifact2.js";
import { NOTARY3_ARTIFACT } from "./artifact3.js";
import { tokenRisks } from "./risks.js";
import { HBAR, MAX_FEE_HBAR, SCHEDULE_GRACE_SECONDS, SCHEDULE_MAX_LIFETIME_SECONDS, TOKENS_PER_TRANSFER } from "./config.js";
import { formatDateTime, nowSeconds } from "./format.js";
import { tr } from "./i18n.js";
import { Mirror } from "./mirror.js";
import { contractAddress, scheduleAddress, scheduleIdOfAddress, with0x } from "./notary.js";
import { WalletError, checkServiceFee, submit } from "./wallet.js";
import { signPriority } from "./tiebreaker.js";
import { createNotaryWithFactory } from "./factory.js";

export const notary2Abi = new Interface(NOTARY2_ARTIFACT.abi);
/** Notario v3 = v2 + contraseña de desempate (requestPriority). */
export const notary3Abi = new Interface(NOTARY3_ARTIFACT.abi);
/** Para leer eventos de los dos: los del v2 más los propios del v3. */
const notaryEventsAbi = new Interface([...NOTARY2_ARTIFACT.abi, ...NOTARY3_ARTIFACT.abi.filter((/** @type {any} */ f) => f.type === "event" && (f.name === "NotaryCreated3" || f.name === "PriorityRequested"))]);

/** Carriles del notario v2 (enum Lane del contrato). */
export const Lane = /** @type {const} */ ({ None: 0, Withdraw: 1, Recovery: 2 });

/** Límites de gas del notario v2 (medidos en local: request ≈ 51k, freeze ≈ 64k, approve ≈ 76k). */
export const GAS2 = { deploy: 1_500_000, request: 90_000, veto: 60_000, freeze: 110_000, approve: 250_000, deploy3: 1_500_000, priority: 160_000 };

/** Retardos de la v2 (segundos): cuenta atrás de retirada (móvil) y de recuperación (kit). */
export const DELAYS2 = {
  test: { withdraw: 120, recovery: 300 }, // 2 min y 5 min: solo para probar
  standard: { withdraw: 24 * 3600, recovery: 7 * 24 * 3600 },
};

const DAY = 24 * 3600;
/** Plazos que se pueden elegir: retirada de 24 h a 7 días; recuperación con el kit de 7 a 14 días. */
export const DELAY_CHOICES = {
  withdraw: [DAY, 2 * DAY, 3 * DAY, 7 * DAY],
  recovery: [7 * DAY, 14 * DAY],
};

/**
 * Comprueba unos plazos antes de desplegar un notario (el contrato exige recuperación ≥ retirada).
 * @param {number} withdrawDelay @param {number} recoveryDelay @param {{ allowTest?: boolean }} [opts]
 */
export function checkDelays(withdrawDelay, recoveryDelay, { allowTest = false } = {}) {
  // Modo prueba (red de pruebas y tests): plazos de minutos.
  if (allowTest && withdrawDelay > 0 && withdrawDelay <= 600 && recoveryDelay >= withdrawDelay && recoveryDelay <= 1800) return;
  if (!DELAY_CHOICES.withdraw.includes(withdrawDelay)) throw new WalletError(tr("Ese plazo de retirada no se puede elegir.", "That withdrawal delay can't be chosen."));
  if (!DELAY_CHOICES.recovery.includes(recoveryDelay)) throw new WalletError(tr("Ese plazo de recuperación no se puede elegir.", "That recovery delay can't be chosen."));
  if (recoveryDelay < withdrawDelay) throw new WalletError(tr("La recuperación no puede ser más corta que la retirada.", "The recovery can't be shorter than the withdrawal."));
}

/** HBAR con los que nace la cuenta del kit: pagan sus comisiones si un día hay que recuperar. */
export const RESCUE_ACCOUNT_TINYBARS = 3n * HBAR;
/**
 * Comisiones de crear la bóveda en dólares (Hedera cobra en dólares, pagados en HBAR al cambio del momento). Medido en
 * mainnet (nov. 2026, notario v3): kit 0,99 + notario 22,59 + bóveda 1,59 = 25,17 HBAR con el HBAR a 0,0497 $ ≈ 1,25 $.
 * Casi todo es la tarifa fija de crear un contrato (1 $) más su gas.
 */
export const VAULT_V2_SETUP_FEES_USD = 1.26;
/**
 * Lo mismo con la fábrica de notarios: el notario sale de una llamada normal en vez de un despliegue. Medido en testnet
 * (nov. 2026, HBAR a 0,0502 $): kit 1,00 + notario 1,69 + bóveda 1,59 = 4,28 HBAR ≈ 0,21 $. Se cuenta con 0,30 $.
 */
export const VAULT_V2_SETUP_FEES_USD_FACTORY = 0.3;
/** Desplegar solo el notario (sin fábrica), en dólares: lo que hace falta si la fábrica falla a mitad. */
export const NOTARY_DIRECT_DEPLOY_USD = 1.2;
/** Margen sobre esas comisiones (el cambio se actualiza cada hora y el precio de la app no es exactamente el de la red). */
const SETUP_MARGIN = 1.1;
/** Sin precio del HBAR: lo que se reserva para crear la bóveda (comisiones medidas + los 3 HBAR del kit, con margen). */
export const VAULT_V2_SETUP_RESERVE = 29n * HBAR;
/** Lo mismo con la fábrica. */
export const VAULT_V2_SETUP_RESERVE_FACTORY = 10n * HBAR;
/** Ya no se suma aparte: la reserva se calcula con el notario v3, el más caro. Se deja por compatibilidad. */
export const NOTARY3_EXTRA_RESERVE = 0n;
/** Sin precio del HBAR: saldo mínimo de la cartera para crear la bóveda. */
export const MIN_POCKET_FOR_VAULT_V2 = 30n * HBAR;

/**
 * Lo que cuesta crear la bóveda al cambio de hoy: comisiones (con margen) + los 3 HBAR del kit. Sin precio, la cifra fija.
 * @param {number | null | undefined} hbarUsd
 * @param {{ factory?: boolean }} [opts] con la fábrica de notarios (comprobada) disponible
 * @returns {bigint} tinybars
 */
export function vaultSetupReserve(hbarUsd, { factory = false } = {}) {
  if (typeof hbarUsd !== "number" || !Number.isFinite(hbarUsd) || hbarUsd <= 0) return factory ? VAULT_V2_SETUP_RESERVE_FACTORY : VAULT_V2_SETUP_RESERVE;
  const usd = factory ? VAULT_V2_SETUP_FEES_USD_FACTORY : VAULT_V2_SETUP_FEES_USD;
  const fees = BigInt(Math.ceil(((usd * SETUP_MARGIN) / hbarUsd) * 1e8));
  return fees + RESCUE_ACCOUNT_TINYBARS;
}

/**
 * Saldo mínimo de la Cartera para crear la bóveda al cambio de hoy (la reserva redondeada al HBAR de arriba).
 * @param {number | null | undefined} hbarUsd
 * @param {{ factory?: boolean }} [opts]
 * @returns {bigint} tinybars
 */
export function minPocketForVault(hbarUsd, opts = {}) {
  if (typeof hbarUsd !== "number" || !Number.isFinite(hbarUsd) || hbarUsd <= 0) return opts.factory ? VAULT_V2_SETUP_RESERVE_FACTORY + HBAR : MIN_POCKET_FOR_VAULT_V2;
  const r = vaultSetupReserve(hbarUsd, opts);
  return ((r + HBAR - 1n) / HBAR) * HBAR;
}

/**
 * Initcode del notario v2 (bytecode + argumentos; con bytecode en línea el nodo ignora constructorParameters).
 * @param {{ device: string, rescue: string, guardian?: string | null, withdrawDelay: number, recoveryDelay: number }} p
 *   direcciones EVM tal como las ve msg.sender
 */
export function notary2Initcode({ device, rescue, guardian, withdrawDelay, recoveryDelay }) {
  const args = notary2Abi.encodeDeploy([
    getAddress(device),
    getAddress(rescue),
    guardian ? getAddress(guardian) : "0x0000000000000000000000000000000000000000",
    BigInt(withdrawDelay),
    BigInt(recoveryDelay),
  ]);
  return getBytes(NOTARY2_ARTIFACT.bytecode + args.slice(2));
}

/**
 * @param {"request" | "requestRecovery" | "veto" | "approve" | "statusOf"} fn @param {ScheduleId} schedule
 */
/**
 * Código de despliegue del notario v3 (con la dirección de la llave de desempate).
 * @param {{ device: string, rescue: string, guardian?: string | null, tiebreaker: string, withdrawDelay: number, recoveryDelay: number }} p
 */
export function notary3Initcode({ device, rescue, guardian, tiebreaker, withdrawDelay, recoveryDelay }) {
  const args = notary3Abi.encodeDeploy([getAddress(device), getAddress(rescue), getAddress(guardian ?? "0x0000000000000000000000000000000000000000"), getAddress(tiebreaker), withdrawDelay, recoveryDelay]);
  return getBytes(NOTARY3_ARTIFACT.bytecode + args.slice(2));
}

/** @param {string} fn @param {import("@hiero-ledger/sdk").ScheduleId} schedule */
export const encodeNotary2 = (fn, schedule) => getBytes(notary2Abi.encodeFunctionData(fn, [scheduleAddress(schedule)]));

/** @param {number} lane */
export const encodeFreeze = (lane) => getBytes(notary2Abi.encodeFunctionData("freeze", [lane]));

/**
 * Nombre legible del error del notario v2.
 * @param {string | null | undefined} data
 */
export function revertName2(data) {
  if (!data || data === "0x") return "(sin datos)";
  try {
    const parsed = notary2Abi.parseError(with0x(data));
    if (parsed) return `${parsed.name}(${parsed.args.map((x) => String(x)).join(", ")})`;
  } catch {
    // no es un error del notario
  }
  return data.length > 74 ? `${data.slice(0, 74)}…` : data;
}

/**
 * Clave de la bóveda v2.
 * @param {{ deviceKey: Key, rescueKey: Key, notaryId: ContractId }} p
 */
export function buildVaultKeyV2({ deviceKey, rescueKey, notaryId }) {
  return new KeyList(
    [new KeyList([deviceKey, notaryId]), new KeyList([rescueKey, notaryId]), new KeyList([deviceKey, rescueKey])],
    1,
  );
}

/**
 * ¿Tiene la clave exactamente la forma de una bóveda v2 con este notario?
 * @param {Key | null | undefined} key @param {ContractId} notaryId
 */
export function isVaultKeyV2For(key, notaryId) {
  if (!(key instanceof KeyList) || key.threshold !== 1) return false;
  const routes = key.toArray();
  if (routes.length !== 3 || !routes.every((r) => r instanceof KeyList && r.threshold == null && r.toArray().length === 2)) return false;
  const [w, r, both] = routes.map((x) => /** @type {KeyList} */ (x).toArray());
  const isNotary = (/** @type {Key} */ k) => k instanceof ContractId && k.toString() === notaryId.toString();
  const same = (/** @type {Key} */ a, /** @type {Key} */ b) => a instanceof PublicKey && b instanceof PublicKey && a.toStringRaw() === b.toStringRaw();
  return isNotary(w[1]) && isNotary(r[1]) && same(w[0], both[0]) && same(r[0], both[1]) && !same(w[0], r[0]);
}

/**
 * Motivo de la reversión de una llamada a contrato (consulta de pago, muy barata).
 * @param {Client} client @param {import("./wallet.js").SubmitResult} out @param {(data: string) => string} [decode]
 */
export async function revertReasonOf(client, out, decode = revertName2) {
  if (!out.response) return "";
  try {
    const record = await new TransactionRecordQuery()
      .setTransactionId(out.response.transactionId)
      .setValidateReceiptStatus(false)
      .execute(client);
    return decode(record.contractFunctionResult?.errorMessage ?? "");
  } catch {
    return "";
  }
}

/**
 * @param {string} what @param {Client} client @param {Transaction} tx @param {PrivateKey[]} [signers]
 */
async function mustSubmit(what, client, tx, signers = []) {
  const out = await submit(client, tx, signers);
  if (!out.ok || !out.receipt) throw new WalletError(`${what}: ${out.status}`, out.status, out.txId);
  return /** @type {import("./wallet.js").SubmitResult & { receipt: import("@hiero-ledger/sdk").TransactionReceipt }} */ (out);
}

/**
 * Hedera rechaza transacciones de más de 6 KB (TRANSACTION_OVERSIZE). Hasta este tamaño, el código va en
 * la propia transacción (el v3, 5.685 bytes con sus parámetros, queda en 5.873 bytes firmado). Si algún
 * día es mayor, se sube antes al servicio de archivos, que en testnet cuesta unos 21 HBAR más.
 */
export const INLINE_INITCODE_MAX = 5_800;
/** Trozo de archivo por transacción (con firmas y cabecera sigue por debajo de 6 KB). */
const FILE_CHUNK = 4_000;
/** Tope de comisión por cada transacción del archivo (se cobra lo que cueste de verdad, que es bastante menos). */
const FILE_MAX_FEE_HBAR = 10;

/**
 * Crea un contrato. Si el código no cabe en una transacción, lo sube como archivo (en hexadecimal, como
 * lo pide Hedera), crea el contrato desde ese archivo y después lo borra.
 * @param {{ client: Client, initcode: Uint8Array, gas: number, memo: string, what: string }} p
 */
async function createContract({ client, initcode, gas, memo, what }) {
  const tx = new ContractCreateTransaction().setGas(gas).setContractMemo(memo).setMaxTransactionFee(new Hbar(MAX_FEE_HBAR.deploy));
  /** @type {import("@hiero-ledger/sdk").FileId | null} */
  let fileId = null;
  if (initcode.length <= INLINE_INITCODE_MAX) {
    tx.setBytecode(initcode);
  } else {
    if (!client.operatorPublicKey) throw new WalletError(tr("falta la llave que paga", "the paying key is missing"));
    const text = new TextEncoder().encode(hexlify(initcode).slice(2));
    const created = await mustSubmit(
      what,
      client,
      new FileCreateTransaction().setKeys([client.operatorPublicKey]).setContents(text.slice(0, FILE_CHUNK)).setFileMemo("H10X Wallet · código del notario").setMaxTransactionFee(new Hbar(FILE_MAX_FEE_HBAR)),
    );
    fileId = created.receipt.fileId;
    if (!fileId) throw new WalletError(tr("la subida del código no devolvió el ID del archivo", "the code upload returned no file ID"));
    for (let i = FILE_CHUNK; i < text.length; i += FILE_CHUNK) {
      await mustSubmit(what, client, new FileAppendTransaction().setFileId(fileId).setContents(text.slice(i, i + FILE_CHUNK)).setMaxTransactionFee(new Hbar(FILE_MAX_FEE_HBAR)));
    }
    tx.setBytecodeFileId(fileId);
  }
  try {
    const out = await mustSubmit(what, client, tx);
    if (!out.receipt.contractId) throw new WalletError(tr("el despliegue no devolvió el ID del contrato", "the deployment returned no contract ID"));
    return out.receipt.contractId;
  } finally {
    // El archivo solo hacía falta para crear el contrato.
    if (fileId) await submit(client, new FileDeleteTransaction().setFileId(fileId).setMaxTransactionFee(new Hbar(MAX_FEE_HBAR.default))).catch(() => undefined);
  }
}

/**
 * Crea el notario de una bóveda: con la fábrica si la hay (y la bóveda lleva contraseña de desempate: la fábrica solo
 * crea el v3) y, si eso falla por lo que sea, desplegándolo directamente como siempre. Antes de desplegar lo simula
 * gratis en el mirror node (desplegar cuesta ≈ 1 $ aunque falle).
 * @param {{ client: Client, mirror: Mirror, from: string, device: string, rescue: string, guardian?: string | null,
 *   withdrawDelay: number, recoveryDelay: number, tiebreaker?: string | null, factory?: import("./factory.js").NotaryFactory | null }} p
 * @returns {Promise<{ notaryId: ContractId, viaFactory: boolean, factoryError: string | null }>}
 */
export async function createVaultNotary({ client, mirror, from, tiebreaker = null, factory = null, ...params }) {
  // Con contraseña de desempate, el notario v3; sin ella, el v2.
  const v3 = !!tiebreaker;
  /** @type {string | null} */
  let factoryError = null;
  if (v3 && factory) {
    try {
      const made = await createNotaryWithFactory({ client, mirror, factory, from, params: { ...params, tiebreaker: /** @type {string} */ (tiebreaker) } });
      return { notaryId: made.notaryId, viaFactory: true, factoryError: null };
    } catch (e) {
      // Sin saldo para la llamada tampoco lo habrá para desplegarlo: mejor decirlo ya.
      if (e instanceof WalletError && (e.status === "INSUFFICIENT_PAYER_BALANCE" || e.status === "BAD_PARAMS")) throw e;
      factoryError = e instanceof Error ? e.message : String(e);
    }
    // Desplegarlo aparte cuesta bastante más: si no hay saldo, se dice sin gastar nada (Hedera cobraría el intento).
    const usd = await mirror.usdPerHbar().catch(() => null);
    const payer = client.operatorAccountId ? await mirror.account(client.operatorAccountId.toString()).catch(() => null) : null;
    if (usd && payer) {
      const need = BigInt(Math.ceil(((NOTARY_DIRECT_DEPLOY_USD * 1.1) / usd) * 1e8));
      if (payer.balance < need) {
        throw new WalletError(
          tr(
            `No se pudo usar la fábrica (${factoryError}) y crear el notario aparte cuesta unos ${Math.ceil(Number(need) / 1e8)} HBAR: tu cartera tiene ${Math.floor(Number(payer.balance) / 1e6) / 100}. Inténtalo de nuevo en un minuto o añade HBAR.`,
            `The factory couldn't be used (${factoryError}) and creating the notary separately costs about ${Math.ceil(Number(need) / 1e8)} HBAR: your wallet has ${Math.floor(Number(payer.balance) / 1e6) / 100}. Try again in a minute or add HBAR.`,
          ),
          "FACTORY_FAILED",
        );
      }
    }
  }
  const initcode = v3 ? notary3Initcode({ ...params, tiebreaker: /** @type {string} */ (tiebreaker) }) : notary2Initcode(params);
  const gas = v3 ? GAS2.deploy3 : GAS2.deploy;
  try {
    const sim = await mirror.simulate({ from, data: initcode, gas });
    if (!sim.ok && sim.error.includes("CONTRACT_REVERT_EXECUTED")) {
      throw new WalletError(tr(`el notario v2 no se puede desplegar (simulación): ${sim.error}`, `the v2 notary cannot be deployed (simulation): ${sim.error}`));
    }
  } catch (e) {
    if (e instanceof WalletError) throw e;
  }
  const notaryId = await createContract({
    client,
    initcode,
    gas,
    // Sin nota: con «H10X Wallet · …» cualquiera podía listar en un indexador todas las bóvedas y sus kits.
    memo: "",
    what: v3 ? tr("desplegar el notario v3", "deploy the v3 notary") : tr("desplegar el notario v2", "deploy the v2 notary"),
  });
  return { notaryId, viaFactory: false, factoryError };
}

/**
 * Despliega el notario (como createVaultNotary) y devuelve solo su ID.
 * @param {Parameters<typeof createVaultNotary>[0]} p
 */
export async function deployNotary2(p) {
  return (await createVaultNotary(p)).notaryId;
}

/**
 * Crea la cuenta bóveda v2. Con `stakedNodeId`, nace ya haciendo staking en ese nodo (rendimiento).
 * @param {{ client: Client, deviceKey: Key, rescueKey: Key, notaryId: ContractId, initialTinybars?: bigint, stakedNodeId?: number | null }} p
 */
export async function createVaultV2({ client, deviceKey, rescueKey, notaryId, initialTinybars = 0n, stakedNodeId = null }) {
  const key = buildVaultKeyV2({ deviceKey, rescueKey, notaryId });
  const tx = new AccountCreateTransaction()
    .setKeyWithoutAlias(key)
    .setInitialBalance(Hbar.fromTinybars(initialTinybars.toString()))
    // Acepta cualquier token de Hedera sin asociarlo antes (HIP-904).
    .setMaxAutomaticTokenAssociations(-1);
  // Sin nota en la cuenta (antes «H10X Wallet · bóveda v2»): así no se puede buscar la lista de bóvedas por su nota.
  if (stakedNodeId != null) {
    if (!Number.isSafeInteger(stakedNodeId) || stakedNodeId < 0) throw new WalletError(tr("Nodo de staking no válido.", "Invalid staking node."));
    tx.setStakedNodeId(stakedNodeId);
  }
  const out = await mustSubmit(tr("crear la bóveda v2", "create the v2 vault"), client, tx);
  if (!out.receipt.accountId) throw new WalletError(tr("la creación no devolvió el ID de la cuenta", "the creation returned no account ID"));
  return { vaultId: out.receipt.accountId, key };
}

/**
 * @typedef {{ tokenId: string, amount: bigint, decimals?: number | null }} TokenAmount
 * @typedef {{ collector: AccountId, tinybars: bigint }} ServiceFee
 */

/** Comprueba una comisión del servicio (null si está apagada). */
export const checkFee = checkServiceFee;

/**
 * Transferencia desde la bóveda: HBAR, tokens y/o NFT a `to` y, si la hay, la comisión del servicio en
 * la MISMA transacción (solo se cobra si la retirada llega a ejecutarse).
 * @param {{ vaultId: AccountId, to: AccountId, tinybars?: bigint, tokens?: TokenAmount[], nfts?: import("./mirror.js").NftRef[], fee?: ServiceFee | null }} p
 */
export function buildVaultTransfer({ vaultId, to, tinybars = 0n, tokens = [], nfts = [], fee = null }) {
  const f = checkFee(fee);
  if (tinybars < 0n || tokens.some((t) => t.amount <= 0n)) throw new WalletError(tr("Importe no válido.", "Invalid amount."));
  if (nfts.some((n) => !Number.isSafeInteger(n.serial) || n.serial <= 0)) throw new WalletError(tr("NFT no válido.", "Invalid NFT."));
  // Límites de Hedera por transferencia: 10 movimientos de tokens (5 tokens) y 10 NFT.
  if (tokens.length > TOKENS_PER_TRANSFER || nfts.length > 2 * TOKENS_PER_TRANSFER) throw new WalletError(tr("Demasiados tokens en una sola operación.", "Too many tokens in one operation."));
  if (tinybars === 0n && tokens.length === 0 && nfts.length === 0) throw new WalletError(tr("No hay nada que mover.", "Nothing to move."));
  const tx = new TransferTransaction();
  const debit = tinybars + (f?.tinybars ?? 0n);
  if (debit > 0n) tx.addHbarTransfer(vaultId, Hbar.fromTinybars((-debit).toString()));
  if (tinybars > 0n) tx.addHbarTransfer(to, Hbar.fromTinybars(tinybars.toString()));
  if (f) tx.addHbarTransfer(f.collector, Hbar.fromTinybars(f.tinybars.toString()));
  for (const t of tokens) {
    const id = TokenId.fromString(t.tokenId);
    if (t.decimals != null) {
      tx.addTokenTransferWithDecimals(id, vaultId, -t.amount, t.decimals);
      tx.addTokenTransferWithDecimals(id, to, t.amount, t.decimals);
    } else {
      tx.addTokenTransfer(id, vaultId, -t.amount);
      tx.addTokenTransfer(id, to, t.amount);
    }
  }
  for (const n of nfts) tx.addNftTransfer(new NftId(TokenId.fromString(n.tokenId), n.serial), vaultId, to);
  return tx;
}

/**
 * Programa una transacción de la bóveda. Firma (y paga) quien firma con el cliente; esa firma
 * cuenta para la transacción programada.
 * @param {{ client: Client, inner: Transaction, lifetimeSeconds: number, memo?: string }} p
 */
export async function scheduleForVault({ client, inner, lifetimeSeconds, memo }) {
  const lifetime = Math.min(lifetimeSeconds + SCHEDULE_GRACE_SECONDS, SCHEDULE_MAX_LIFETIME_SECONDS);
  const schedule = new ScheduleCreateTransaction()
    .setScheduledTransaction(inner)
    .setScheduleMemo(memo ?? `h10x-wallet-v2 ${Date.now().toString(36)}`)
    .setExpirationTime(Timestamp.fromDate(new Date((nowSeconds() + lifetime) * 1000)))
    .setWaitForExpiry(false);
  const out = await submit(client, schedule);
  return { ...out, scheduleId: out.receipt?.scheduleId ?? null };
}

/**
 * Programa una transferencia desde la bóveda (HBAR, tokens, NFT y comisión opcional).
 * @param {{ client: Client, vaultId: AccountId, to: AccountId, tinybars?: bigint, tokens?: TokenAmount[], nfts?: import("./mirror.js").NftRef[], fee?: ServiceFee | null,
 *   lifetimeSeconds: number, memo?: string }} p
 */
export const scheduleVaultTransfer = ({ client, vaultId, to, tinybars, tokens, nfts, fee, lifetimeSeconds, memo }) =>
  scheduleForVault({ client, inner: buildVaultTransfer({ vaultId, to, tinybars, tokens, nfts, fee }), lifetimeSeconds, memo });

/**
 * Llama al notario v2 y, si revierte, devuelve el motivo.
 * @param {{ client: Client, notaryId: ContractId, call: "request" | "requestRecovery" | "veto" | "approve" | "freeze",
 *   schedule?: ScheduleId, lane?: number }} p
 */
export async function callNotary2({ client, notaryId, call, schedule, lane }) {
  const data = call === "freeze" ? encodeFreeze(lane ?? 0) : encodeNotary2(call, /** @type {ScheduleId} */ (schedule));
  const gas = call === "freeze" ? GAS2.freeze : call === "approve" ? GAS2.approve : call === "veto" ? GAS2.veto : GAS2.request;
  const tx = new ContractExecuteTransaction()
    .setContractId(notaryId)
    .setGas(gas)
    .setFunctionParameters(data)
    .setMaxTransactionFee(new Hbar(MAX_FEE_HBAR.contractCall));
  const out = await submit(client, tx);
  const reason = out.ok ? "" : await revertReasonOf(client, out);
  return { ...out, reason };
}

// ---------------------------------------------------------------------------------------------
// Operaciones de alto nivel (app y guardián)
// ---------------------------------------------------------------------------------------------

/**
 * Llave del kit a partir de las 24 palabras (derivación estándar ED25519 de Hedera, índice 0).
 * @param {string} words
 */
export async function rescueKeyFromWords(words) {
  const clean = words.trim().toLowerCase().split(/\s+/).join(" ");
  const mnemonic = await Mnemonic.fromString(clean);
  return mnemonic.toStandardEd25519PrivateKey("", 0);
}

/** Dirección con la que el notario ve a una cuenta sin alias (long-zero). @param {AccountId} id */
export const longZeroAddress = (id) => `0x${id.toEvmAddress()}`.toLowerCase();

/**
 * Crea la cuenta del kit, el notario v2 y la bóveda. Paga la cartera (`client`).
 * @param {{ client: Client, mirror: Mirror, pocket: { evmAddress: string, publicKey: PublicKey }, rescuePublicKey: PublicKey,
 *   guardianEvm?: string | null, withdrawDelay: number, recoveryDelay: number, initialTinybars?: bigint, rescueTinybars?: bigint,
 *   stakedNodeId?: number | null, tiebreaker?: string | null, factory?: import("./factory.js").NotaryFactory | null,
 *   onStep?: (step: "kit" | "notary" | "vault") => void }} p
 *   tiebreaker: dirección de la llave de desempate (de la contraseña). Con ella se despliega el notario v3.
 *   factory: fábrica de notarios ya comprobada (checkNotaryFactory). Si falla, el notario se despliega directamente.
 */
export async function setupVaultV2({ client, mirror, pocket, rescuePublicKey, guardianEvm, withdrawDelay, recoveryDelay, initialTinybars = 0n, rescueTinybars = RESCUE_ACCOUNT_TINYBARS, stakedNodeId = null, tiebreaker = null, factory = null, onStep }) {
  onStep?.("kit");
  // Sin nota (antes «H10X Wallet · kit de rescate»): que nadie pueda saber qué cuentas son kits.
  const kitTx = new AccountCreateTransaction().setKeyWithoutAlias(rescuePublicKey).setInitialBalance(Hbar.fromTinybars(rescueTinybars.toString()));
  const kit = await mustSubmit(tr("crear la cuenta del kit", "create the kit account"), client, kitTx);
  const rescueAccountId = kit.receipt.accountId;
  if (!rescueAccountId) throw new WalletError(tr("la cuenta del kit no devolvió su ID", "the kit account returned no ID"));
  onStep?.("notary");
  const { notaryId, viaFactory, factoryError } = await createVaultNotary({
    client,
    mirror,
    from: pocket.evmAddress,
    device: pocket.evmAddress,
    rescue: longZeroAddress(rescueAccountId),
    guardian: guardianEvm ?? null,
    withdrawDelay,
    recoveryDelay,
    tiebreaker,
    factory,
  });
  onStep?.("vault");
  const { vaultId } = await createVaultV2({ client, deviceKey: pocket.publicKey, rescueKey: rescuePublicKey, notaryId, initialTinybars, stakedNodeId });
  return { notaryId, vaultId, rescueAccountId, viaFactory, factoryError };
}

/**
 * Traduce los errores del notario v2 a algo que entienda cualquiera.
 * @param {"request" | "requestRecovery" | "veto" | "approve" | "freeze"} call @param {string} reason
 */
export function friendlyNotary2Error(call, reason) {
  const m = /^(\w+)(?:\((.*)\))?$/.exec(reason.trim());
  const name = m?.[1] ?? reason;
  const arg = m?.[2] ?? "";
  if (name === "BadStatus") {
    if (arg === "2") return call === "veto" ? tr("Ya estaba bloqueada.", "It was already blocked.") : tr("Está bloqueada: no saldrá.", "It is blocked: it will not go out.");
    if (arg === "3") return call === "veto" ? tr("Ya no se puede bloquear: ya se ha completado.", "It can no longer be blocked: it has already completed.") : tr("Ya se ha completado.", "It has already completed.");
    if (arg === "0") return tr("El notario no conoce esta operación.", "The notary does not know this operation.");
    return tr("La operación no está en un estado que lo permita.", "The operation is not in a state that allows this.");
  }
  if (name === "Superseded") return tr("Se anuló al congelar su carril: no saldrá.", "It was cancelled when its lane was frozen: it will not go out.");
  if (name === "TooEarly") return tr("Todavía no ha terminado la cuenta atrás.", "The countdown has not finished yet.");
  if (name === "LaneLocked") {
    const until = Number(arg.split(",")[1] ?? 0);
    const when = until ? formatDateTime(until) : tr("dentro de un rato", "a while from now");
    return tr(`Ese carril está congelado hasta ${when}.`, `That lane is frozen until ${when}.`);
  }
  if (name === "NotDevice") return tr("Solo el móvil de la bóveda puede pedir retiradas.", "Only the vault's phone can request withdrawals.");
  if (name === "NotRescue") return tr("Solo el kit de rescate de la bóveda puede pedir una recuperación.", "Only the vault's rescue kit can request a recovery.");
  if (name === "NotAllowed") return tr("Esta cuenta no puede hacer eso en esta bóveda.", "This account cannot do that on this vault.");
  return tr(`El notario lo rechazó (${reason || "sin motivo"}).`, `The notary rejected it (${reason || "no reason"}).`);
}

/**
 * Programa una operación de la bóveda y la anuncia al notario, que empieza la cuenta atrás.
 * @param {"request" | "requestRecovery"} call
 * @param {{ client: Client, notaryId: ContractId, inner: Transaction, delaySeconds: number, memo?: string }} p
 */
async function announce(call, { client, notaryId, inner, delaySeconds, memo }) {
  const s = await scheduleForVault({ client, inner, lifetimeSeconds: delaySeconds, memo });
  if (!s.ok || !s.scheduleId) throw new WalletError(tr(`no se pudo programar la operación: ${s.status}`, `the operation could not be scheduled: ${s.status}`), s.status, s.txId);
  const out = await callNotary2({ client, notaryId, call, schedule: s.scheduleId });
  if (!out.ok) throw new WalletError(friendlyNotary2Error(call, out.reason || out.status), out.status, out.txId);
  return { scheduleId: s.scheduleId, txId: out.txId };
}

/**
 * Retirada por el carril del móvil (paga y firma la cartera). La comisión del servicio, si se
 * configura, solo se añade aquí: nunca a recuperaciones, evacuaciones ni ajustes.
 * @param {{ client: Client, vaultId: AccountId, notaryId: ContractId, to: AccountId, tinybars?: bigint, tokens?: TokenAmount[], nfts?: import("./mirror.js").NftRef[],
 *   fee?: ServiceFee | null, withdrawDelay: number, memo?: string }} p
 */
export const requestWithdrawalV2 = ({ client, vaultId, notaryId, to, tinybars, tokens, nfts, fee, withdrawDelay, memo }) =>
  announce("request", { client, notaryId, inner: buildVaultTransfer({ vaultId, to, tinybars, tokens, nfts, fee }), delaySeconds: withdrawDelay, memo });

/**
 * Recuperación por el carril del kit (paga y firma la cuenta del kit). Sin comisión.
 * @param {{ client: Client, vaultId: AccountId, notaryId: ContractId, to: AccountId, tinybars?: bigint, tokens?: TokenAmount[], nfts?: import("./mirror.js").NftRef[],
 *   recoveryDelay: number, memo?: string }} p
 */
export const requestRecoveryV2 = ({ client, vaultId, notaryId, to, tinybars, tokens, nfts, recoveryDelay, memo }) =>
  announce("requestRecovery", { client, notaryId, inner: buildVaultTransfer({ vaultId, to, tinybars, tokens, nfts }), delaySeconds: recoveryDelay, memo });

/**
 * Dirección EVM real de un notario (la que usa como address(this)): la del mirror; la «larga de ceros» de su ID solo si
 * el mirror no le da otra. Lanza si el mirror no responde (firmar con la dirección equivocada haría fallar la operación).
 * @param {{ mirror: Mirror, notaryId: ContractId | string }} p
 */
export async function notaryEvmAddress({ mirror, notaryId }) {
  const id = notaryId.toString();
  const info = await mirror.contractInfo(id);
  if (!info) throw new WalletError(tr("no encuentro el notario en la red", "I can't find the notary on the network"));
  return info.evmAddress || contractAddress(ContractId.fromString(id));
}

/**
 * Recuperación PRIORITARIA (notario v3): la pide el kit y la firma también la llave de la contraseña
 * de desempate. El móvil no la puede bloquear ni congelar; vale aunque las recuperaciones estén
 * congeladas; y cierra el carril de retirada hasta que se ejecute. Sin comisión.
 * @param {{ client: Client, vaultId: AccountId, notaryId: ContractId, to: AccountId, tinybars?: bigint, tokens?: TokenAmount[],
 *   nfts?: import("./mirror.js").NftRef[], recoveryDelay: number, tiebreakerKey: PrivateKey, chainId: number, memo?: string,
 *   mirror?: Mirror }} p
 */
export async function requestPriorityRecoveryV3({ client, vaultId, notaryId, to, tinybars, tokens, nfts, recoveryDelay, tiebreakerKey, chainId, memo, mirror }) {
  // El notario comprueba la firma con SU dirección (address(this)). La de uno creado por la fábrica no es la «larga de
  // ceros» de su ID: se lee de la red antes de programar nada.
  const notaryAddress = mirror ? await notaryEvmAddress({ mirror, notaryId }) : contractAddress(notaryId);
  const s = await scheduleForVault({ client, inner: buildVaultTransfer({ vaultId, to, tinybars, tokens, nfts }), lifetimeSeconds: recoveryDelay, memo });
  if (!s.ok || !s.scheduleId) throw new WalletError(tr(`no se pudo programar la operación: ${s.status}`, `the operation could not be scheduled: ${s.status}`), s.status, s.txId);
  const { v, r, s: sig } = signPriority({ key: tiebreakerKey, chainId, notaryAddress, schedule: s.scheduleId });
  const tx = new ContractExecuteTransaction()
    .setContractId(notaryId)
    .setGas(GAS2.priority)
    .setFunctionParameters(getBytes(notary3Abi.encodeFunctionData("requestPriority", [scheduleAddress(s.scheduleId), v, r, sig])))
    .setMaxTransactionFee(new Hbar(MAX_FEE_HBAR.contractCall));
  const out = await submit(client, tx);
  if (!out.ok) {
    const reason = await revertReasonOf(client, out, (d) => {
      try {
        return notary3Abi.parseError(d)?.name ?? "";
      } catch {
        return "";
      }
    });
    const why = reason === "BadTiebreaker" ? tr("la contraseña de desempate no es la de esta bóveda", "the tiebreaker password isn't this vault's") : friendlyNotary2Error("requestRecovery", reason || out.status);
    throw new WalletError(why, out.status, out.txId);
  }
  return { scheduleId: s.scheduleId, txId: out.txId };
}

/**
 * Activa los tokens en una bóveda creada sin ellos: cambia su ajuste de asociación automática a
 * "sin límite" por el carril de retirada (con su cuenta atrás, visible y bloqueable). Sin comisión.
 * @param {{ client: Client, vaultId: AccountId, notaryId: ContractId, withdrawDelay: number }} p
 */
export const requestEnableTokensV2 = ({ client, vaultId, notaryId, withdrawDelay }) =>
  announce("request", {
    client,
    notaryId,
    inner: new AccountUpdateTransaction().setAccountId(vaultId).setMaxAutomaticTokenAssociations(-1),
    delaySeconds: withdrawDelay,
    memo: `h10x-wallet-v2 tokens ${Date.now().toString(36)}`,
  });

/**
 * Rendimiento: cambia el nodo de staking de la bóveda (o lo quita con `nodeId: null`) por el carril de
 * retirada, con su cuenta atrás, visible y bloqueable. La transacción SOLO toca el nodo de staking:
 * así la reconocen la app y el guardián (cualquier otra cosa la bloquea el guardián). Sin comisión.
 * @param {{ client: Client, vaultId: AccountId, notaryId: ContractId, nodeId: number | null, withdrawDelay: number }} p
 */
export function requestStakingV2({ client, vaultId, notaryId, nodeId, withdrawDelay }) {
  if (nodeId != null && (!Number.isSafeInteger(nodeId) || nodeId < 0)) throw new WalletError(tr("Nodo de staking no válido.", "Invalid staking node."));
  const inner = new AccountUpdateTransaction().setAccountId(vaultId);
  if (nodeId == null) inner.clearStakedNodeId();
  else inner.setStakedNodeId(nodeId);
  return announce("request", { client, notaryId, inner, delaySeconds: withdrawDelay, memo: `h10x-wallet-v2 staking ${Date.now().toString(36)}` });
}

/**
 * Reparte tokens en grupos que caben en una transferencia.
 * @template T @param {T[]} list @param {number} [size]
 * @returns {T[][]}
 */
export function chunk(list, size = TOKENS_PER_TRANSFER) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Evacuación inmediata con las dos llaves: paga y firma la cartera (móvil) y firma también el kit.
 * Mueve PRIMERO todo el HBAR, después los tokens y NFT (en grupos), vuelve a barrer los HBAR y deja para el
 * FINAL, de uno en uno, los tokens cuyo emisor puede cambiar las comisiones: si se las pone justo entonces,
 * en la bóveda ya no queda nada con que pagarlas y ese token, simplemente, no sale.
 * Los tokens con comisión fija (la pagaría la bóveda) se dejan, avisados en `skippedTokens`/`skippedNfts`;
 * uno que el destino no pueda recibir se queda y se informa en `failedTokens`.
 * @param {{ client: Client, mirror: Mirror, vaultId: AccountId, to: AccountId, rescueKey: PrivateKey }} p
 */
export async function evacuateVault({ client, mirror, vaultId, to, rescueKey }) {
  const badKit = (/** @type {any} */ out) => new WalletError(tr("las 24 palabras no son las del kit de esta bóveda", "those 24 words are not this vault's rescue kit"), out.status, out.txId);
  /**
   * Manda todos los HBAR de la bóveda. `strict`: si falla, error; si no, se deja estar (barrido final).
   * @param {boolean} strict @returns {Promise<{ txId: string, tinybars: bigint } | null>}
   */
  const sweepHbar = async (strict) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const account = await mirror.account(vaultId.toString());
      if (!account) throw new WalletError(tr("no encuentro la bóveda en la red", "I can't find the vault on the network"));
      if (account.balance <= 0n) return null;
      const tx = new TransferTransaction()
        .addHbarTransfer(vaultId, Hbar.fromTinybars((-account.balance).toString()))
        .addHbarTransfer(to, Hbar.fromTinybars(account.balance.toString()))
        .setTransactionMemo("H10X Wallet · evacuación");
      const out = await submit(client, tx, [rescueKey]);
      if (out.ok) return { txId: out.txId, tinybars: account.balance };
      if (out.status === "INVALID_SIGNATURE") throw badKit(out);
      // El mirror node puede ir unos segundos por detrás del saldo real: se vuelve a leer.
      if (out.status !== "INSUFFICIENT_ACCOUNT_BALANCE" || attempt === 2) {
        if (!strict) return null;
        throw new WalletError(tr(`evacuar la bóveda: ${out.status}`, `evacuate the vault: ${out.status}`), out.status, out.txId);
      }
      await new Promise((r) => setTimeout(r, 4000));
    }
    return null;
  };

  // 1. Los HBAR, LO PRIMERO: así un token trampa (con comisión fija) no puede cobrársela de ellos.
  const first = await sweepHbar(true);

  // 2. Tokens y NFT. Los que cobran comisión a quien envía se dejan en la bóveda, avisados.
  const nftHoldings = await mirror.accountNfts(vaultId.toString());
  const nftTokens = new Set(nftHoldings.map((n) => n.tokenId));
  const holdings = (await mirror.accountTokens(vaultId.toString())).filter((t) => t.balance > 0n && !nftTokens.has(t.tokenId));
  /** @type {Map<string, ReturnType<typeof tokenRisks>>} */
  const risks = new Map();
  for (const id of new Set([...holdings.map((h) => h.tokenId), ...nftTokens])) risks.set(id, tokenRisks(await mirror.tokenInfo(id, { fresh: true }).catch(() => null)));
  const charges = (/** @type {string} */ id) => risks.get(id)?.chargesOnMove === true;
  /** @type {{ tokenId: string, amount: bigint }[]} */
  const movedTokens = [];
  /** @type {{ tokenId: string, status: string }[]} */
  const failedTokens = [];
  /** @type {{ tokenId: string, amount: bigint, fixedHbar: bigint }[]} */
  const skippedTokens = holdings.filter((h) => charges(h.tokenId)).map((h) => ({ tokenId: h.tokenId, amount: h.balance, fixedHbar: risks.get(h.tokenId)?.fixedHbar ?? 0n }));
  /** @type {import("./mirror.js").NftRef[]} */
  const movedNfts = [];
  /** @type {(import("./mirror.js").NftRef & { status: string })[]} */
  const failedNfts = [];
  /** @type {import("./mirror.js").NftRef[]} */
  const skippedNfts = nftHoldings.filter((n) => charges(n.tokenId)).map((n) => ({ tokenId: n.tokenId, serial: n.serial }));
  /** @typedef {{ kind: "token", tokenId: string, amount: bigint } | { kind: "nft", tokenId: string, serial: number }} Item */
  /** @type {Item[]} */
  const items = [
    ...holdings.filter((t) => !charges(t.tokenId)).map((t) => /** @type {Item} */ ({ kind: "token", tokenId: t.tokenId, amount: t.balance })),
    ...nftHoldings.filter((n) => !charges(n.tokenId)).map((n) => /** @type {Item} */ ({ kind: "nft", tokenId: n.tokenId, serial: n.serial })),
  ];
  const tryItems = async (/** @type {Item[]} */ group) => {
    const tokens = [];
    const nfts = [];
    for (const i of group) {
      if (i.kind === "token") tokens.push({ tokenId: i.tokenId, amount: i.amount });
      else nfts.push({ tokenId: i.tokenId, serial: i.serial });
    }
    const tx = buildVaultTransfer({ vaultId, to, tokens, nfts }).setTransactionMemo("H10X Wallet · evacuación");
    const out = await submit(client, tx, [rescueKey]);
    if (out.status === "INVALID_SIGNATURE") throw badKit(out);
    return out;
  };
  const record = (/** @type {Item} */ i, /** @type {string | null} */ failStatus) => {
    if (i.kind === "token") {
      if (failStatus) failedTokens.push({ tokenId: i.tokenId, status: failStatus });
      else movedTokens.push({ tokenId: i.tokenId, amount: i.amount });
    } else if (failStatus) failedNfts.push({ tokenId: i.tokenId, serial: i.serial, status: failStatus });
    else movedNfts.push({ tokenId: i.tokenId, serial: i.serial });
  };
  // Los de emisor con llave de comisiones, al final y de uno en uno.
  const keyed = (/** @type {Item} */ i) => risks.get(i.tokenId)?.canChangeFees === true;
  const lastOnes = items.filter(keyed);
  for (const group of chunk(items.filter((i) => !keyed(i)))) {
    const out = await tryItems(group);
    if (out.ok) {
      for (const i of group) record(i, null);
      continue;
    }
    // Si falla el grupo, se prueba uno a uno para salvar los que sí se puedan mover.
    for (const i of group) {
      const one = group.length > 1 ? await tryItems([i]) : out;
      record(i, one.ok ? null : one.status);
    }
  }

  // 3. Barrido de HBAR (lo que haya llegado mientras tanto, p. ej. recompensas de staking que se cobran
  // con el primer movimiento) ANTES de los tokens cuya comisión puede cambiar. Si el mirror aún no ve el
  // primero, se reintenta; si no, se deja.
  if (first) await new Promise((r) => setTimeout(r, 1500));
  const middle = lastOnes.length ? await sweepHbar(false) : null;
  // 4. Los tokens cuyo emisor puede cambiar las comisiones, de uno en uno.
  for (const i of lastOnes) {
    const one = await tryItems([i]);
    record(i, one.ok ? null : one.status);
  }
  // 5. Barrido final.
  if (lastOnes.length) await new Promise((r) => setTimeout(r, 1500));
  const last = await sweepHbar(false);
  const tinybars = (first?.tinybars ?? 0n) + (middle?.tinybars ?? 0n) + (last?.tinybars ?? 0n);
  if (!first && !middle && !last && !movedTokens.length && !movedNfts.length && !failedTokens.length && !failedNfts.length && !skippedTokens.length && !skippedNfts.length) {
    throw new WalletError(tr("la bóveda está vacía", "the vault is empty"));
  }
  return { txId: first?.txId ?? middle?.txId ?? last?.txId ?? "", tinybars, tokens: movedTokens, failedTokens, skippedTokens, nfts: movedNfts, failedNfts, skippedNfts };
}

/**
 * Cambia los plazos de una bóveda v2. El contrato notario no deja cambiarlos, así que se despliega uno
 * nuevo (mismo móvil, mismo kit y mismo guardián) y se cambia la llave de la bóveda al momento con las
 * DOS llaves: el móvil (paga, `client`) y el kit (`rescueKey`). Lo que estuviera pendiente en el notario
 * anterior ya no podrá ejecutarse nunca.
 *
 * También sirve para poner o cambiar la contraseña de desempate (`tiebreaker`, notario v3); si no se
 * pasa, se mantiene la que tuviera el notario anterior.
 * @param {{ client: Client, mirror: Mirror, vaultId: AccountId, rescueKey: PrivateKey, withdrawDelay: number, recoveryDelay: number,
 *   tiebreaker?: string | null, allowTest?: boolean, factory?: import("./factory.js").NotaryFactory | null,
 *   onStep?: (step: "check" | "notary" | "key") => void }} p
 */
export async function changeVaultDelaysV2({ client, mirror, vaultId, rescueKey, withdrawDelay, recoveryDelay, tiebreaker, allowTest = false, factory = null, onStep }) {
  onStep?.("check");
  checkDelays(withdrawDelay, recoveryDelay, { allowTest });
  const v = await inspectVaultV2({ mirror, vaultId: vaultId.toString() });
  if (!v) throw new WalletError(tr("no es una bóveda v2", "it is not a v2 vault"));
  if (v.rescueKey.toStringRaw() !== rescueKey.publicKey.toStringRaw()) {
    throw new WalletError(tr("las 24 palabras no son las del kit de esta bóveda", "those 24 words are not this vault's rescue kit"));
  }
  if (!client.operatorPublicKey || client.operatorPublicKey.toStringRaw() !== v.deviceKey.toStringRaw()) {
    throw new WalletError(tr("este móvil no es el de la bóveda", "this phone is not the vault's phone"));
  }
  const cfg = await notary2Config({ mirror, notaryId: v.notaryId });
  const newTiebreaker = tiebreaker === undefined ? cfg.tiebreaker : tiebreaker ? tiebreaker.toLowerCase() : null;
  if (cfg.withdrawDelay === withdrawDelay && cfg.recoveryDelay === recoveryDelay && newTiebreaker === cfg.tiebreaker) {
    throw new WalletError(tr("La bóveda ya tiene esos plazos.", "The vault already has those delays."));
  }
  const noGuardian = /^0x0{40}$/.test(cfg.guardian);
  onStep?.("notary");
  const { notaryId, viaFactory, factoryError } = await createVaultNotary({
    client,
    mirror,
    from: cfg.device,
    device: cfg.device,
    rescue: cfg.rescue,
    guardian: noGuardian ? null : cfg.guardian,
    withdrawDelay,
    recoveryDelay,
    tiebreaker: newTiebreaker,
    factory,
  });
  onStep?.("key");
  const key = buildVaultKeyV2({ deviceKey: v.deviceKey, rescueKey: v.rescueKey, notaryId });
  const tx = new AccountUpdateTransaction().setAccountId(v.vaultId).setKey(key).setTransactionMemo("H10X Wallet · nuevos plazos");
  const out = await submit(client, tx, [rescueKey]);
  if (!out.ok) {
    const why = out.status === "INVALID_SIGNATURE" ? tr("las 24 palabras no son las del kit de esta bóveda", "those 24 words are not this vault's rescue kit") : out.status;
    throw new WalletError(tr(`no se pudo cambiar la llave de la bóveda: ${why}`, `the vault key could not be changed: ${why}`), out.status, out.txId);
  }
  return { notaryId, oldNotaryId: v.notaryId, txId: out.txId, viaFactory, factoryError };
}

/**
 * Lee de la red una bóveda v2: notario, llaves y saldo. Devuelve null si no existe o no es v2.
 * @param {{ mirror: Mirror, vaultId: string }} p
 */
export async function inspectVaultV2({ mirror, vaultId }) {
  const acc = await mirror.account(vaultId);
  if (!acc || !(acc.key instanceof KeyList) || acc.key.threshold !== 1) return null;
  const routes = acc.key.toArray();
  const first = routes[0] instanceof KeyList ? routes[0].toArray() : [];
  const second = routes[1] instanceof KeyList ? routes[1].toArray() : [];
  const notaryId = first[1];
  if (!(notaryId instanceof ContractId) || !isVaultKeyV2For(acc.key, notaryId)) return null;
  return {
    vaultId: acc.id,
    balance: acc.balance,
    notaryId,
    deviceKey: /** @type {PublicKey} */ (first[0]),
    rescueKey: /** @type {PublicKey} */ (second[0]),
  };
}

/**
 * Configuración del notario v2 (lecturas gratuitas vía mirror node).
 * @param {{ mirror: Mirror, notaryId: ContractId | string }} p
 */
export async function notary2Config({ mirror, notaryId }) {
  const to = contractAddress(typeof notaryId === "string" ? ContractId.fromString(notaryId) : notaryId);
  const read = async (/** @type {string} */ fn) => {
    const r = await mirror.simulate({ to, data: notary2Abi.encodeFunctionData(fn, []), gas: 50_000 });
    if (!r.ok) throw new WalletError(tr(`no se pudo leer el notario (${fn})`, `the notary could not be read (${fn})`));
    return notary2Abi.decodeFunctionResult(fn, r.result)[0];
  };
  const [device, rescue, guardian, withdrawDelay, recoveryDelay] = await Promise.all(["device", "rescue", "guardian", "withdrawDelay", "recoveryDelay"].map(read));
  // Solo el v3 tiene llave de desempate.
  const tb = await mirror.simulate({ to, data: notary3Abi.encodeFunctionData("tiebreaker", []), gas: 50_000 }).catch(() => null);
  const tiebreaker = tb?.ok && tb.result.length >= 66 ? String(notary3Abi.decodeFunctionResult("tiebreaker", tb.result)[0]).toLowerCase() : null;
  return {
    device: String(device).toLowerCase(),
    rescue: String(rescue).toLowerCase(),
    guardian: String(guardian).toLowerCase(),
    withdrawDelay: Number(withdrawDelay),
    recoveryDelay: Number(recoveryDelay),
    tiebreaker: tiebreaker && !/^0x0{40}$/.test(tiebreaker) ? tiebreaker : null,
    version: tiebreaker ? 3 : 2,
  };
}

/**
 * Cuenta del kit a partir de su llave pública (la que el notario tiene como `rescue`).
 * @param {{ mirror: Mirror, rescuePublicKey: PublicKey, rescueAddress: string }} p
 */
export async function findRescueAccount({ mirror, rescuePublicKey, rescueAddress }) {
  const list = await mirror.accountsByPublicKey(rescuePublicKey.toStringRaw());
  return list.find((a) => longZeroAddress(a.id) === rescueAddress.toLowerCase() || a.evmAddress === rescueAddress.toLowerCase()) ?? null;
}

/**
 * @typedef {{ kind: "requested", schedule: string, lane: number, requestedAt: number, executableAt: number }
 *   | { kind: "vetoed", schedule: string, by: string }
 *   | { kind: "approved", schedule: string, approvedAt: number }
 *   | { kind: "frozen", lane: number, by: string, until: number }
 *   | { kind: "priority", schedule: string, executableAt: number }
 *   | { kind: "created" }} Notary2Event
 */

/**
 * @param {{ topics: string[], data: string }} log
 * @returns {Notary2Event | null}
 */
export function decodeNotary2Log(log) {
  let parsed;
  try {
    parsed = notaryEventsAbi.parseLog({ topics: log.topics, data: log.data });
  } catch {
    return null;
  }
  if (!parsed) return null;
  const a = parsed.args;
  switch (parsed.name) {
    case "Requested":
      return { kind: "requested", schedule: String(a[0]).toLowerCase(), lane: Number(a[1]), requestedAt: Number(a[2]), executableAt: Number(a[3]) };
    case "Vetoed":
      return { kind: "vetoed", schedule: String(a[0]).toLowerCase(), by: String(a[1]).toLowerCase() };
    case "Approved":
      return { kind: "approved", schedule: String(a[0]).toLowerCase(), approvedAt: Number(a[1]) };
    case "Frozen":
      return { kind: "frozen", lane: Number(a[0]), by: String(a[1]).toLowerCase(), until: Number(a[2]) };
    case "NotaryCreated":
    case "NotaryCreated3":
      return { kind: "created" };
    case "PriorityRequested":
      return { kind: "priority", schedule: String(a[0]).toLowerCase(), executableAt: Number(a[1]) };
    default:
      return null;
  }
}

/**
 * Movimiento de la bóveda (v1 o v2) tal como lo muestra la app.
 * @typedef {{
 *   scheduleId: string, lane: "withdraw" | "recovery",
 *   status: "requested" | "vetoed" | "approved" | "superseded",
 *   requestedAt: number, executableAt: number, executed: boolean, expired: boolean,
 *   action: import("./mirror.js").ScheduleAction, memo: string, priority?: boolean
 * }} Movement
 * priority: recuperación con kit + contraseña de desempate (notario v3): el móvil no la puede parar.
 */

/**
 * Movimientos y carriles congelados de una bóveda v2, a partir de los eventos del notario.
 * @param {{ mirror: Mirror, notaryId: string }} p
 * @returns {Promise<{ items: Movement[], locks: { withdraw: number, recovery: number }, unreadable: string[] }>}
 *   unreadable: direcciones anunciadas al notario que no son las de una transacción programada (no pueden
 *   ejecutarse; solo las anuncia quien tiene una llave)
 */
export async function loadVaultActivity({ mirror, notaryId }) {
  // Los más recientes: una avalancha de avisos viejos no puede tapar la última petición.
  const { logs } = await mirror.contractLogs(notaryId, undefined, { newest: true });
  /** @type {Map<string, Movement>} */
  const byAddress = new Map();
  const locks = { withdraw: 0, recovery: 0 };
  /** @type {string[]} */
  const unreadable = [];
  for (const log of logs) {
    const ev = decodeNotary2Log(log);
    if (!ev) continue;
    if (ev.kind === "requested") {
      // El notario acepta cualquier dirección: la que no es la de una programada no puede ejecutarse nunca
      // y no se enseña como operación (antes, una sola bastaba para que no cargase ningún movimiento).
      const scheduleId = scheduleIdOfAddress(ev.schedule);
      if (!scheduleId) {
        if (!unreadable.includes(ev.schedule)) unreadable.push(ev.schedule);
        continue;
      }
      byAddress.set(ev.schedule, {
        scheduleId,
        lane: ev.lane === Lane.Recovery ? "recovery" : "withdraw",
        status: "requested",
        requestedAt: ev.requestedAt,
        executableAt: ev.executableAt,
        executed: false,
        expired: false,
        action: { kind: "other" },
        memo: "",
      });
    } else if (ev.kind === "vetoed" || ev.kind === "approved") {
      const m = byAddress.get(ev.schedule);
      if (m) m.status = ev.kind;
    } else if (ev.kind === "priority") {
      const m = byAddress.get(ev.schedule);
      if (m) m.priority = true;
    } else if (ev.kind === "frozen") {
      const lane = ev.lane === Lane.Recovery ? "recovery" : "withdraw";
      // Congelar anula todo lo pendiente de ese carril (el contrato avanza su época), salvo lo prioritario.
      for (const m of byAddress.values()) if (m.lane === lane && m.status === "requested" && !m.priority) m.status = "superseded";
      locks[lane] = Math.max(locks[lane], ev.until);
    }
  }
  const items = [...byAddress.values()];
  await Promise.all(
    items.map(async (m) => {
      // Si el mirror falla con una, esa se queda como «operación desconocida» (en rojo) y el resto se ve.
      const s = await mirror.schedule(m.scheduleId).catch(() => null);
      if (!s) return;
      m.executed = s.executed;
      m.expired = !s.executed && s.expiresAt > 0 && s.expiresAt < nowSeconds();
      m.action = s.action;
      m.memo = s.memo;
    }),
  );
  return { items: items.sort((a, b) => b.requestedAt - a.requestedAt), locks, unreadable };
}

/**
 * Retiradas de una bóveda v1 en el mismo formato que los movimientos v2.
 * @param {import("./wallet.js").Withdrawal[]} list
 * @returns {Movement[]}
 */
export const withdrawalsAsMovements = (list) => list.map((w) => ({ ...w, lane: /** @type {const} */ ("withdraw") }));
