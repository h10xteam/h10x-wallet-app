// Borra todo lo de DeRec de una wallet de este móvil: su zona del llavero y su buzón. Se usa al borrar la wallet y al
// crear una nueva en su hueco (el llavero de iOS conserva datos aunque se borre la app). Aparte del proveedor para que
// wallet.tsx lo use sin importarse en círculo.
import { NETWORK } from "../env";
import { secureKV } from "./kv";
import { deleteMailbox } from "./mailbox";

export async function wipeDerec(walletId: string): Promise<void> {
  try {
    const z = await secureKV(`derec_${NETWORK}_${walletId}`);
    await z.wipe();
  } catch {
    // nada que borrar
  }
  await deleteMailbox(walletId);
}
