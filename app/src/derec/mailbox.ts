// El buzón de DeRec de esta wallet: una cuenta pequeña de Hedera (solo para pagar los mensajes) y su topic HCS, donde
// los amigos escriben. Va aparte de la Cartera a propósito: así los mensajes no piden Face ID cada vez y la llave del
// buzón, si alguien la sacara, solo da acceso a unos pocos HBAR para mensajes (nunca a la Cartera ni a la bóveda).
import * as SecureStore from "expo-secure-store";
import { AccountCreateTransaction, AccountId, Hbar, PrivateKey, TransferTransaction } from "@hiero-ledger/sdk";
import { createClient, createInbox, submit, type Mirror } from "@boveda/core";
import { NETWORK } from "../env";
import { t } from "../i18n";

export type MailboxInfo = { keyHex: string; accountId: string | null; topicId: string | null };
/** HBAR con los que se activa el buzón desde la Cartera (dan para cientos de mensajes). */
export const MAILBOX_HBAR = 2;

const OPTS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const itemName = (walletId: string) => `derecMailbox_${NETWORK}_${walletId}`.replace(/[^A-Za-z0-9._-]/g, "_");

export async function loadMailbox(walletId: string): Promise<MailboxInfo | null> {
  const raw = await SecureStore.getItemAsync(itemName(walletId), OPTS).catch(() => null);
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Partial<MailboxInfo>;
    if (typeof j.keyHex !== "string" || !/^[0-9a-f]{64}$/.test(j.keyHex)) return null;
    return { keyHex: j.keyHex, accountId: typeof j.accountId === "string" ? j.accountId : null, topicId: typeof j.topicId === "string" ? j.topicId : null };
  } catch {
    return null;
  }
}

export async function saveMailbox(walletId: string, m: MailboxInfo): Promise<void> {
  await SecureStore.setItemAsync(itemName(walletId), JSON.stringify(m), OPTS);
}

export async function deleteMailbox(walletId: string): Promise<void> {
  await SecureStore.deleteItemAsync(itemName(walletId), OPTS).catch(() => undefined);
}

/** El buzón de la wallet; la primera vez crea su llave (todavía sin cuenta en la red). */
export async function mailboxOrNew(walletId: string): Promise<MailboxInfo> {
  const cur = await loadMailbox(walletId);
  if (cur) return cur;
  const m: MailboxInfo = { keyHex: PrivateKey.generateECDSA().toStringRaw(), accountId: null, topicId: null };
  await saveMailbox(walletId, m);
  return m;
}

export const mailboxKey = (m: MailboxInfo) => PrivateKey.fromStringECDSA(m.keyHex);
export const mailboxEvm = (m: MailboxInfo) => `0x${mailboxKey(m).publicKey.toEvmAddress()}`.toLowerCase();

export function mailboxClient(m: MailboxInfo) {
  if (!m.accountId) throw new Error(t("El buzón aún no tiene cuenta.", "The mailbox doesn't have an account yet."));
  return createClient(NETWORK, { accountId: AccountId.fromString(m.accountId), key: mailboxKey(m) });
}

/** La Cartera crea la cuenta del buzón con unos HBAR (una sola firma de la Cartera). */
export async function fundMailboxFromPocket(walletId: string, pocketClient: ReturnType<typeof createClient>, hbar = MAILBOX_HBAR): Promise<MailboxInfo> {
  const m = await mailboxOrNew(walletId);
  if (m.accountId) return m;
  const out = await submit(pocketClient, new AccountCreateTransaction().setKey(mailboxKey(m).publicKey).setInitialBalance(new Hbar(hbar)).setAccountMemo("H10X Wallet · DeRec"));
  const id = out.receipt?.accountId?.toString();
  if (!out.ok || !id) throw new Error(t(`No se pudo crear el buzón (${out.status}).`, `Couldn't create the mailbox (${out.status}).`));
  const next = { ...m, accountId: id };
  await saveMailbox(walletId, next);
  return next;
}

/** Recarga el buzón desde la Cartera. */
export async function topUpMailbox(m: MailboxInfo, pocketClient: ReturnType<typeof createClient>, pocketId: AccountId, hbar = MAILBOX_HBAR): Promise<void> {
  if (!m.accountId) throw new Error(t("El buzón aún no tiene cuenta.", "The mailbox doesn't have an account yet."));
  const out = await submit(pocketClient, new TransferTransaction().addHbarTransfer(pocketId, new Hbar(-hbar)).addHbarTransfer(AccountId.fromString(m.accountId), new Hbar(hbar)));
  if (!out.ok) throw new Error(t(`No se pudo recargar el buzón (${out.status}).`, `Couldn't top up the mailbox (${out.status}).`));
}

/** Móvil nuevo: alguien ha mandado HBAR a la dirección del buzón (faucet o un amigo). ¿Ya tiene cuenta? */
export async function findFundedMailbox(walletId: string, mirror: Mirror): Promise<MailboxInfo | null> {
  const m = await mailboxOrNew(walletId);
  if (m.accountId) return m;
  const acc = await mirror.account(mailboxEvm(m)).catch(() => null);
  if (!acc || acc.balance <= 0n) return null;
  const next = { ...m, accountId: acc.id.toString() };
  await saveMailbox(walletId, next);
  return next;
}

/** Crea el topic del buzón (lo paga la cuenta del buzón). */
export async function ensureInboxTopic(walletId: string, m: MailboxInfo): Promise<MailboxInfo> {
  if (m.topicId) return m;
  const client = mailboxClient(m);
  try {
    const topicId = await createInbox({ client, memo: "H10X Wallet · DeRec" });
    const next = { ...m, topicId };
    await saveMailbox(walletId, next);
    return next;
  } finally {
    client.close();
  }
}
