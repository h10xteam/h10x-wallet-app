// @ts-check
// Operaciones de la cartera. Las usan la app (React Native) y el guardián (Node) con el mismo código.
import {
  AccountCreateTransaction,
  AccountId,
  Client,
  ContractCreateTransaction,
  ContractExecuteTransaction,
  ContractId,
  Hbar,
  Key,
  NftId,
  PrecheckStatusError,
  PrivateKey,
  PublicKey,
  ReceiptStatusError,
  ScheduleCreateTransaction,
  ScheduleId,
  Timestamp,
  Transaction,
  TransactionId,
  TransactionReceipt,
  TransactionRecordQuery,
  TransactionResponse,
  TokenAssociateTransaction,
  TokenId,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import { getBytes, hexlify, toUtf8Bytes } from "ethers";
import { GAS, HBAR, MAX_FEE_HBAR, MAX_SERVICE_FEE_TINYBARS, SCHEDULE_GRACE_SECONDS, SCHEDULE_MAX_LIFETIME_SECONDS } from "./config.js";
import { buildVaultKey } from "./keys.js";
import { Mirror } from "./mirror.js";
import { encodeNotaryCall, notaryInitcode, RequestStatus, revertName, scheduleIdOfAddress } from "./notary.js";
import { nowSeconds } from "./format.js";
import { tr } from "./i18n.js";


/**
 * Cliente de Hedera para la red indicada. En React Native el SDK usa gRPC-web automáticamente.
 * @param {import("./config.js").NetworkName} network
 * @param {{ accountId: AccountId | string, key: PrivateKey } | null} [operator]
 */
export function createClient(network, operator = null) {
  const client = network === "local" ? Client.forNetwork({ "127.0.0.1:50211": new AccountId(3) }) : Client.forName(network);
  if (operator) client.setOperator(operator.accountId, operator.key);
  client.setDefaultMaxTransactionFee(new Hbar(MAX_FEE_HBAR.default));
  return client;
}

/**
 * "0.0.123" o "0x…" → AccountId.
 * @param {string} text
 */
export function parseAccount(text) {
  const t = text.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(t)) return AccountId.fromEvmAddress(0, 0, t);
  return AccountId.fromString(t);
}

/**
 * @typedef {{ ok: boolean, status: string, txId: string, receipt: TransactionReceipt | null, response: TransactionResponse | null }} SubmitResult
 */

/**
 * Congela, firma, envía y espera el recibo. No lanza si Hedera rechaza la transacción.
 * @param {Client} client @param {Transaction} tx @param {PrivateKey[]} [signers]
 * @returns {Promise<SubmitResult>}
 */
export async function submit(client, tx, signers = []) {
  if (!tx.isFrozen()) tx.freezeWith(client);
  for (const key of signers) await tx.sign(key);
  /** @type {TransactionResponse} */
  let response;
  try {
    response = await tx.execute(client);
  } catch (e) {
    if (e instanceof PrecheckStatusError) {
      return { ok: false, status: e.status.toString(), txId: e.transactionId.toString(), receipt: null, response: null };
    }
    throw e;
  }
  const txId = response.transactionId.toString();
  try {
    const receipt = await response.getReceipt(client);
    return { ok: true, status: receipt.status.toString(), txId, receipt, response };
  } catch (e) {
    if (e instanceof ReceiptStatusError) {
      return { ok: false, status: e.status.toString(), txId, receipt: e.transactionReceipt, response };
    }
    throw e;
  }
}

/** Error de una operación con un texto pensado para mostrarlo al usuario. */
export class WalletError extends Error {
  /** @param {string} message @param {string} [status] @param {string} [txId] */
  constructor(message, status = "", txId = "") {
    super(message);
    this.status = status;
    this.txId = txId;
  }
}

/**
 * @param {string} what @param {Client} client @param {Transaction} tx @param {PrivateKey[]} [signers]
 */
async function mustSubmit(what, client, tx, signers = []) {
  const out = await submit(client, tx, signers);
  if (!out.ok || !out.receipt) throw new WalletError(`${what}: ${out.status}`, out.status, out.txId);
  return /** @type {SubmitResult & { receipt: TransactionReceipt }} */ (out);
}

/**
 * Motivo de la reversión de una llamada a contrato que falló (consulta de pago, muy barata).
 * @param {Client} client @param {SubmitResult} out
 */
async function revertReason(client, out) {
  if (!out.response) return "";
  try {
    const record = await new TransactionRecordQuery()
      .setTransactionId(out.response.transactionId)
      .setValidateReceiptStatus(false)
      .execute(client);
    return revertName(record.contractFunctionResult?.errorMessage);
  } catch {
    return "";
  }
}

/**
 * Despliega el notario de una bóveda. Antes lo simula gratis en el mirror node: desplegar cuesta
 * alrededor de 1 $ aunque falle.
 * @param {{ client: Client, mirror: Mirror, from: string, quorum: string, vetoers: string[], delaySeconds: number }} p
 */
export async function deployNotary({ client, mirror, from, quorum, vetoers, delaySeconds }) {
  const initcode = notaryInitcode({ quorum, vetoers, delaySeconds });
  try {
    const sim = await mirror.simulate({ from, data: initcode, gas: GAS.deploy });
    if (!sim.ok && sim.error.includes("CONTRACT_REVERT_EXECUTED")) {
      throw new WalletError(tr(`el notario no se puede desplegar (simulación): ${sim.error}`, `the notary cannot be deployed (simulation): ${sim.error}`));
    }
  } catch (e) {
    if (e instanceof WalletError) throw e;
    // Sin mirror node no hay simulación: se sigue.
  }
  const tx = new ContractCreateTransaction()
    .setBytecode(initcode)
    .setGas(GAS.deploy)
    .setContractMemo("Bóveda · notario")
    .setMaxTransactionFee(new Hbar(MAX_FEE_HBAR.deploy));
  const out = await mustSubmit(tr("desplegar el notario", "deploy the notary"), client, tx);
  if (!out.receipt.contractId) throw new WalletError(tr("el despliegue no devolvió el ID del contrato", "the deployment returned no contract ID"));
  return out.receipt.contractId;
}

/**
 * Crea la cuenta bóveda con su clave compuesta.
 * @param {{ client: Client, devices: Key[], notaryId: ContractId, rescue: Key[], initialTinybars?: bigint }} p
 */
export async function createVaultAccount({ client, devices, notaryId, rescue, initialTinybars = 0n }) {
  const key = buildVaultKey({ devices, notaryId, rescue });
  const tx = new AccountCreateTransaction()
    .setKeyWithoutAlias(key)
    .setInitialBalance(Hbar.fromTinybars(initialTinybars.toString()))
    .setAccountMemo("Bóveda");
  const out = await mustSubmit(tr("crear la bóveda", "create the vault"), client, tx);
  if (!out.receipt.accountId) throw new WalletError(tr("la creación no devolvió el ID de la cuenta", "the creation returned no account ID"));
  return { vaultId: out.receipt.accountId, key };
}

/**
 * Crea notario + bóveda para una cartera. `pocket` es la cuenta del móvil: paga, es el quórum que
 * anuncia retiradas y uno de los vetadores. El guardián, si lo hay, también puede vetar (solo bloquear).
 * @param {{ client: Client, mirror: Mirror, pocket: { evmAddress: string, publicKey: PublicKey },
 *   rescuePublicKey: PublicKey, guardianEvm?: string | null, delaySeconds: number, initialTinybars?: bigint,
 *   onStep?: (step: "notary" | "vault") => void }} p
 */
export async function setupVault({ client, mirror, pocket, rescuePublicKey, guardianEvm, delaySeconds, initialTinybars = 0n, onStep }) {
  const vetoers = [...new Set([pocket.evmAddress, guardianEvm].filter((v) => !!v).map((v) => String(v).toLowerCase()))];
  onStep?.("notary");
  const notaryId = await deployNotary({ client, mirror, from: pocket.evmAddress, quorum: pocket.evmAddress, vetoers, delaySeconds });
  onStep?.("vault");
  const { vaultId } = await createVaultAccount({
    client,
    devices: [pocket.publicKey],
    notaryId,
    rescue: [rescuePublicKey],
    initialTinybars,
  });
  return { notaryId, vaultId, vetoers };
}

/**
 * Comprueba una comisión del servicio: null si está apagada; error si supera el tope de seguridad.
 * @param {{ collector: AccountId, tinybars: bigint } | null | undefined} fee
 */
export function checkServiceFee(fee) {
  if (!fee || fee.tinybars <= 0n) return null;
  if (fee.tinybars > MAX_SERVICE_FEE_TINYBARS) throw new WalletError(tr("La comisión configurada es demasiado alta.", "The configured fee is too high."));
  return fee;
}

/**
 * Transferencia normal desde la cuenta del operador del cliente. Con `fee`, la comisión del servicio
 * va en la misma transferencia (se cobra solo si el envío sale).
 * @param {{ client: Client, from: AccountId, to: AccountId, tinybars: bigint, memo?: string, fee?: { collector: AccountId, tinybars: bigint } | null }} p
 */
export async function sendHbar({ client, from, to, tinybars, memo = "", fee = null }) {
  const f = checkServiceFee(fee);
  const tx = new TransferTransaction()
    .addHbarTransfer(from, Hbar.fromTinybars((-(tinybars + (f?.tinybars ?? 0n))).toString()))
    .addHbarTransfer(to, Hbar.fromTinybars(tinybars.toString()))
    .setTransactionMemo(memo);
  if (f) tx.addHbarTransfer(f.collector, Hbar.fromTinybars(f.tinybars.toString()));
  const out = await mustSubmit(tr("enviar", "send"), client, tx);
  return out.txId;
}

/**
 * Paga solo la comisión del servicio (p. ej. el depósito inicial al crear la bóveda).
 * @param {{ client: Client, from: AccountId, fee: { collector: AccountId, tinybars: bigint }, memo?: string }} p
 */
export async function payServiceFee({ client, from, fee, memo = "H10X Wallet · comisión" }) {
  checkServiceFee(fee);
  const tx = new TransferTransaction()
    .addHbarTransfer(from, Hbar.fromTinybars((-fee.tinybars).toString()))
    .addHbarTransfer(fee.collector, Hbar.fromTinybars(fee.tinybars.toString()))
    .setTransactionMemo(memo);
  const out = await mustSubmit(tr("pagar la comisión", "pay the fee"), client, tx);
  return out.txId;
}

/**
 * Envía un token de Hedera desde la cuenta del operador del cliente (con comisión opcional en HBAR,
 * en la misma transferencia).
 * @param {{ client: Client, from: AccountId, to: AccountId, tokenId: string, amount: bigint, decimals?: number | null, memo?: string,
 *   fee?: { collector: AccountId, tinybars: bigint } | null }} p
 */
export async function sendToken({ client, from, to, tokenId, amount, decimals = null, memo = "", fee = null }) {
  const id = TokenId.fromString(tokenId);
  const tx = new TransferTransaction().setTransactionMemo(memo);
  if (decimals != null) tx.addTokenTransferWithDecimals(id, from, -amount, decimals).addTokenTransferWithDecimals(id, to, amount, decimals);
  else tx.addTokenTransfer(id, from, -amount).addTokenTransfer(id, to, amount);
  const f = checkServiceFee(fee);
  if (f) tx.addHbarTransfer(from, Hbar.fromTinybars((-f.tinybars).toString())).addHbarTransfer(f.collector, Hbar.fromTinybars(f.tinybars.toString()));
  const out = await mustSubmit(tr("enviar el token", "send the token"), client, tx);
  return out.txId;
}

/**
 * Envía NFT desde la cuenta del operador del cliente (hasta 10 por transferencia), con comisión opcional.
 * @param {{ client: Client, from: AccountId, to: AccountId, nfts: { tokenId: string, serial: number }[], memo?: string,
 *   fee?: { collector: AccountId, tinybars: bigint } | null }} p
 */
export async function sendNfts({ client, from, to, nfts, memo = "", fee = null }) {
  if (nfts.length === 0 || nfts.length > 10) throw new WalletError(tr("Elige entre 1 y 10 NFT.", "Choose between 1 and 10 NFTs."));
  const tx = new TransferTransaction().setTransactionMemo(memo);
  for (const n of nfts) tx.addNftTransfer(new NftId(TokenId.fromString(n.tokenId), n.serial), from, to);
  const f = checkServiceFee(fee);
  if (f) tx.addHbarTransfer(from, Hbar.fromTinybars((-f.tinybars).toString())).addHbarTransfer(f.collector, Hbar.fromTinybars(f.tinybars.toString()));
  const out = await mustSubmit(tr("enviar el NFT", "send the NFT"), client, tx);
  return out.txId;
}

/**
 * Asocia tokens a una cuenta (la del operador del cliente) para poder recibirlos.
 * @param {{ client: Client, accountId: AccountId, tokenIds: string[] }} p
 */
export async function associateTokens({ client, accountId, tokenIds }) {
  const tx = new TokenAssociateTransaction().setAccountId(accountId).setTokenIds(tokenIds.map((t) => TokenId.fromString(t)));
  const out = await submit(client, tx);
  if (!out.ok && out.status !== "TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT") throw new WalletError(tr(`no se pudo añadir el token: ${out.status}`, `the token could not be added: ${out.status}`), out.status, out.txId);
  return out.txId;
}

/**
 * Pide sacar dinero de la bóveda: crea la transacción programada (firmada por el móvil al pagarla)
 * y la anuncia al notario, que empieza a contar el retardo.
 * @param {{ client: Client, vaultId: AccountId, notaryId: ContractId, to: AccountId, tinybars: bigint, delaySeconds: number, memo?: string }} p
 */
export async function requestWithdrawal({ client, vaultId, notaryId, to, tinybars, delaySeconds, memo }) {
  const lifetime = Math.min(delaySeconds + SCHEDULE_GRACE_SECONDS, SCHEDULE_MAX_LIFETIME_SECONDS);
  const inner = new TransferTransaction()
    .addHbarTransfer(vaultId, Hbar.fromTinybars((-tinybars).toString()))
    .addHbarTransfer(to, Hbar.fromTinybars(tinybars.toString()));
  const schedule = new ScheduleCreateTransaction()
    .setScheduledTransaction(inner)
    .setScheduleMemo(memo ?? `retirada ${Date.now().toString(36)}`)
    .setExpirationTime(Timestamp.fromDate(new Date((nowSeconds() + lifetime) * 1000)))
    .setWaitForExpiry(false);
  const created = await mustSubmit(tr("programar la retirada", "schedule the withdrawal"), client, schedule);
  const scheduleId = created.receipt.scheduleId;
  if (!scheduleId) throw new WalletError(tr("la retirada programada no devolvió su ID", "the scheduled withdrawal returned no ID"));

  const call = new ContractExecuteTransaction()
    .setContractId(notaryId)
    .setGas(GAS.request)
    .setFunctionParameters(encodeNotaryCall("request", scheduleId))
    .setMaxTransactionFee(new Hbar(MAX_FEE_HBAR.contractCall));
  const out = await submit(client, call);
  if (!out.ok) {
    const why = await revertReason(client, out);
    throw new WalletError(tr(`el notario no aceptó la retirada: ${out.status} ${why}`, `the notary did not accept the withdrawal: ${out.status} ${why}`).trim(), out.status, out.txId);
  }
  return { scheduleId, txId: out.txId };
}

/**
 * Llamada simple al notario (veto o approve). Devuelve el resultado y, si revierte, el motivo.
 * @param {{ client: Client, notaryId: ContractId, scheduleId: ScheduleId, fn: "veto" | "approve" }} p
 */
export async function callNotary({ client, notaryId, scheduleId, fn }) {
  const call = new ContractExecuteTransaction()
    .setContractId(notaryId)
    .setGas(fn === "approve" ? GAS.approve : GAS.veto)
    .setFunctionParameters(encodeNotaryCall(fn, scheduleId))
    .setMaxTransactionFee(new Hbar(MAX_FEE_HBAR.contractCall));
  const out = await submit(client, call);
  const reason = out.ok ? "" : await revertReason(client, out);
  return { ...out, reason };
}

/**
 * Rescate: vacía la bóveda hacia `to` con la llave de rescate, sin notario ni retardo.
 * Paga la propia bóveda, así que sirve aunque se haya perdido el móvil.
 * Si `to` es una dirección EVM sin cuenta, la transferencia la crea: entonces hace falta más margen.
 * @param {{ client: Client, mirror: Mirror, vaultId: AccountId, rescueKey: PrivateKey, to: AccountId, marginTinybars?: bigint }} p
 */
export async function rescueVault({ client, mirror, vaultId, rescueKey, to, marginTinybars = HBAR / 10n }) {
  const account = await mirror.account(vaultId.toString());
  if (!account) throw new WalletError(tr("no encuentro la bóveda en la red", "I can't find the vault on the network"));
  const margin = marginTinybars; // para la comisión
  const amount = account.balance - margin;
  if (amount <= 0n) throw new WalletError(tr("la bóveda no tiene saldo suficiente para rescatar", "the vault does not have enough balance to rescue"), "NOTHING_TO_RESCUE");
  const tx = new TransferTransaction()
    .addHbarTransfer(vaultId, Hbar.fromTinybars((-amount).toString()))
    .addHbarTransfer(to, Hbar.fromTinybars(amount.toString()))
    .setTransactionId(TransactionId.generate(vaultId));
  const out = await mustSubmit(tr("rescatar la bóveda", "rescue the vault"), client, tx, [rescueKey]);
  return { txId: out.txId, tinybars: amount };
}

/**
 * @typedef {{
 *   scheduleId: string, status: "requested" | "vetoed" | "approved",
 *   requestedAt: number, executableAt: number, executed: boolean, expired: boolean,
 *   action: import("./mirror.js").ScheduleAction, memo: string
 * }} Withdrawal
 */

/**
 * Retiradas de una bóveda reconstruidas a partir de los eventos del notario (gratis, vía mirror node).
 * @param {{ mirror: Mirror, notaryId: string }} p
 * @returns {Promise<Withdrawal[]>}
 */
export async function loadWithdrawals({ mirror, notaryId }) {
  const { events } = await mirror.notaryEvents(notaryId);
  /** @type {Map<string, Withdrawal>} */
  const byAddress = new Map();
  for (const ev of events) {
    if (ev.kind === "requested") {
      // Una dirección que no es la de una programada no puede ejecutarse: no se enseña (ni atasca la lista).
      const scheduleId = scheduleIdOfAddress(ev.schedule);
      if (!scheduleId) continue;
      byAddress.set(ev.schedule, {
        scheduleId,
        status: "requested",
        requestedAt: ev.requestedAt,
        executableAt: ev.executableAt,
        executed: false,
        expired: false,
        action: { kind: "other" },
        memo: "",
      });
    } else if (ev.kind === "vetoed" || ev.kind === "approved") {
      const w = byAddress.get(ev.schedule);
      if (w) w.status = ev.kind;
    }
  }
  const list = [...byAddress.values()];
  await Promise.all(
    list.map(async (w) => {
      const s = await mirror.schedule(w.scheduleId).catch(() => null);
      if (!s) return;
      w.executed = s.executed;
      w.expired = !s.executed && s.expiresAt > 0 && s.expiresAt < nowSeconds();
      w.action = s.action;
      w.memo = s.memo;
    }),
  );
  return list.sort((a, b) => b.requestedAt - a.requestedAt);
}

export { RequestStatus };

// ---------------------------------------------------------------------------------------------
// Registro en el guardián: un mensaje firmado con la llave del móvil
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{ vaultId: string, notaryId: string, pocketId: string, pushToken: string | null, timestamp: number, lang?: "es" | "en", h10x?: string }} Registration
 *   h10x: avisos de H10X que quiere el dueño ("db" DAO y cesta, "d", "b" o "-" ninguno); ver h10xPrefsCode
 */

/**
 * Mensaje que firma el móvil. Con idioma, formato v2 (el idioma de los avisos también va firmado); con preferencias de
 * avisos de H10X, v3 (también firmadas: nadie puede apagarle los avisos a otro).
 * @param {Registration} r
 */
export const registrationMessage = (r) =>
  r.h10x
    ? `boveda-registro:v3|${r.vaultId}|${r.notaryId}|${r.pocketId}|${r.pushToken ?? ""}|${r.timestamp}|${r.lang ?? ""}|${r.h10x}`
    : r.lang
      ? `boveda-registro:v2|${r.vaultId}|${r.notaryId}|${r.pocketId}|${r.pushToken ?? ""}|${r.timestamp}|${r.lang}`
      : `boveda-registro:v1|${r.vaultId}|${r.notaryId}|${r.pocketId}|${r.pushToken ?? ""}|${r.timestamp}`;

/**
 * @param {PrivateKey} key llave del móvil (la de la cuenta cartera) @param {Registration} r
 */
export const signRegistration = (key, r) => ({ ...r, signature: hexlify(key.sign(toUtf8Bytes(registrationMessage(r)))) });

/**
 * @param {PublicKey} publicKey @param {Registration & { signature: string }} signed
 */
export function verifyRegistration(publicKey, signed) {
  try {
    return publicKey.verify(toUtf8Bytes(registrationMessage(signed)), getBytes(signed.signature));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Modo robo: un mensaje firmado con la llave del KIT (las 24 palabras) le pide al guardián que
// bloquee todas las retiradas de la bóveda mientras se recupera. El guardián comprueba en la red
// que esa llave es la del kit de esa bóveda. No da ningún poder nuevo: con el kit ya se pueden
// bloquear y congelar retiradas; esto solo lo mantiene aunque nadie tenga la app abierta.
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{ action: "on" | "off", vaultId: string, notaryId: string, timestamp: number, lang?: "es" | "en" }} TheftNotice
 */

/** @param {TheftNotice} n */
export const theftMessage = (n) => `hvault-robo:v1|${n.action}|${n.vaultId}|${n.notaryId}|${n.timestamp}|${n.lang ?? ""}`;

/** @param {PrivateKey} kitKey llave del kit de rescate @param {TheftNotice} n */
export const signTheftNotice = (kitKey, n) => ({ ...n, signature: hexlify(kitKey.sign(toUtf8Bytes(theftMessage(n)))) });

/** @param {PublicKey} kitPublicKey @param {TheftNotice & { signature: string }} signed */
export function verifyTheftNotice(kitPublicKey, signed) {
  try {
    return kitPublicKey.verify(toUtf8Bytes(theftMessage(signed)), getBytes(signed.signature));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Avisos por correo: el correo que recibe los avisos graves solo se pone, se cambia o se quita con un
// mensaje firmado con la llave del KIT. Quien tenga el móvil (y su llave) no puede quitarlo ni desviarlo.
//   start:   pide un código para ese correo (el guardián lo manda allí);
//   confirm: lo confirma con el código recibido;
//   remove:  deja de mandar avisos por correo (`email` vacío).
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{ action: "start" | "confirm" | "remove", vaultId: string, notaryId: string, email: string, code?: string,
 *   timestamp: number, lang?: "es" | "en" }} EmailNotice
 */

/** @param {EmailNotice} n */
export const emailMessage = (n) => `h10x-correo:v1|${n.action}|${n.vaultId}|${n.notaryId}|${n.email}|${n.code ?? ""}|${n.timestamp}|${n.lang ?? ""}`;

/** @param {PrivateKey} kitKey llave del kit de rescate @param {EmailNotice} n */
export const signEmailNotice = (kitKey, n) => ({ ...n, signature: hexlify(kitKey.sign(toUtf8Bytes(emailMessage(n)))) });

/** @param {PublicKey} kitPublicKey @param {EmailNotice & { signature: string }} signed */
export function verifyEmailNotice(kitPublicKey, signed) {
  try {
    return kitPublicKey.verify(toUtf8Bytes(emailMessage(signed)), getBytes(signed.signature));
  } catch {
    return false;
  }
}
