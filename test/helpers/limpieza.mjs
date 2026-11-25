// Limpieza de los programas de testnet: devuelve a la cuenta que paga lo que quede en las cuentas de prueba.
//
// Primero borra la cuenta mandando TODO su saldo a la que paga (AccountDelete): no hace falta leer el
// saldo, así que da igual que el mirror vaya unos segundos por detrás. Antes se leía el saldo del mirror y
// se transfería; con el saldo desfasado la transferencia fallaba y los HBAR se quedaban atrapados.
// Si no se puede borrar (p. ej. aún tiene tokens), transfiere el HBAR releyendo el saldo en cada intento.
import { AccountDeleteTransaction, Hbar, TransferTransaction } from "@hiero-ledger/sdk";
import { submit } from "@boveda/core";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{ clientFor: (id: any, key: any) => import("@hiero-ledger/sdk").Client, mirror: import("@boveda/core").Mirror,
 *   accounts: { id: import("@hiero-ledger/sdk").AccountId, key: import("@hiero-ledger/sdk").PrivateKey }[],
 *   to: import("@hiero-ledger/sdk").AccountId, log?: (t: string) => void }} p
 * @returns {Promise<number>} cuentas vaciadas
 */
export async function sweepAccounts({ clientFor, mirror, accounts, to, log = () => {} }) {
  let emptied = 0;
  const seen = new Set();
  for (const { id, key } of accounts) {
    if (seen.has(id.toString())) continue;
    seen.add(id.toString());
    const client = clientFor(id, key);
    const del = await submit(client, new AccountDeleteTransaction().setAccountId(id).setTransferAccountId(to)).catch((e) => ({ ok: false, status: String(e?.message ?? e) }));
    if (del.ok) {
      emptied++;
      continue;
    }
    if (del.status === "ACCOUNT_DELETED") continue;
    let why = del.status;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const balance = (await mirror.account(id.toString()))?.balance ?? 0n;
        const amount = balance - 5_000_000n; // deja 0,05 HBAR para la comisión
        if (amount <= 0n) {
          why = "";
          break;
        }
        const out = await submit(client, new TransferTransaction().addHbarTransfer(id, Hbar.fromTinybars((-amount).toString())).addHbarTransfer(to, Hbar.fromTinybars(amount.toString())));
        if (out.ok) {
          emptied++;
          why = "";
          break;
        }
        why = out.status;
      } catch (e) {
        why = e instanceof Error ? e.message : String(e);
      }
      await sleep(5000); // el mirror se pone al día
    }
    if (why) log(`⚠️  no he podido vaciar ${id}: ${why}`);
  }
  return emptied;
}

/**
 * Cuentas creadas con una llave (p. ej. la del kit, si la preparación se paró antes de devolver su ID).
 * @param {{ mirror: import("@boveda/core").Mirror, publicKey: import("@hiero-ledger/sdk").PublicKey }} p
 */
export async function accountsOfKey({ mirror, publicKey }) {
  for (let i = 0; i < 4; i++) {
    const list = await mirror.accountsByPublicKey(publicKey.toStringRaw()).catch(() => []);
    if (list.length) return list.map((a) => a.id);
    await sleep(3000);
  }
  return [];
}
