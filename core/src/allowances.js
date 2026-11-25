// @ts-check
// Quitar un permiso de gasto que dio la Cartera. Un permiso deja a otra cuenta mover tus fondos sin volver a
// preguntarte, y es lo que buscan las webs que roban: si alguna vez diste uno de más, aquí se quita. Lo firma
// la Cartera, que es quien lo dio. La bóveda no da permisos (las dApps no pueden tocarla).
import { AccountAllowanceApproveTransaction, AccountAllowanceDeleteTransaction, AccountId, Client, Hbar, NftId, TokenId } from "@hiero-ledger/sdk";
import { tr } from "./i18n.js";
import { submit, WalletError } from "./wallet.js";

/**
 * La transacción que quita un permiso: para HBAR y tokens, dejarlo a 0; para una colección entera, retirar el
 * «todos los NFT»; para un NFT suelto, borrar su permiso.
 * @param {AccountId | string} owner
 * @param {import("./mirror.js").Allowance} a
 */
export function revokeTransaction(owner, a) {
  switch (a.kind) {
    case "hbar":
      return new AccountAllowanceApproveTransaction().approveHbarAllowance(owner, a.spender, Hbar.fromTinybars(0));
    case "token":
      return new AccountAllowanceApproveTransaction().approveTokenAllowance(a.tokenId, owner, a.spender, 0);
    case "nftAll":
      return new AccountAllowanceApproveTransaction().deleteTokenNftAllowanceAllSerials(a.tokenId, owner, a.spender);
    case "nft":
      return new AccountAllowanceDeleteTransaction().deleteAllTokenNftAllowances(new NftId(TokenId.fromString(a.tokenId), a.serial), owner);
    default:
      throw new WalletError(tr("Permiso desconocido.", "Unknown allowance."));
  }
}

/**
 * Quita un permiso de la Cartera (`client` firma con la llave de la Cartera).
 * @param {{ client: Client, accountId: AccountId | string, allowance: import("./mirror.js").Allowance }} p
 */
export async function revokeAllowance({ client, accountId, allowance }) {
  const out = await submit(client, revokeTransaction(accountId, allowance));
  if (!out.ok) throw new WalletError(tr(`no se pudo quitar el permiso: ${out.status}`, `the allowance could not be removed: ${out.status}`));
  return out.txId;
}
