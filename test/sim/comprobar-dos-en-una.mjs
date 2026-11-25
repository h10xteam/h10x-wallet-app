// Comprobación suelta (no forma parte de `npm test`): ¿se podía engañar a la hoja de firma ANTERIOR (hasta
// boveda-h10x3) metiendo dos operaciones en un mismo cuerpo? Depende de cómo lee los bytes la librería de
// protobuf de verdad, y por eso se mira aquí, en el servidor. No firma ni envía nada, y no toca la red.
//   npm run dos-en-una
import { AccountId, Hbar, TransactionId, TransferTransaction } from "@hiero-ledger/sdk";
import * as HieroProto from "@hiero-ledger/proto";
import { encodeBase64 } from "ethers";
import { dataFieldsOf, describeDappTransaction, parseDappRequest } from "@boveda/core";

const { proto } = HieroProto;
const ME = "0.0.5005";
const me = { shardNum: 0, realmNum: 0, accountNum: 5005 };
const thief = { shardNum: 0, realmNum: 0, accountNum: 666 };
const opts = { account: ME, vaultId: "0.0.6006", lang: /** @type {"es"} */ ("es") };
const why = (/** @type {unknown} */ e) => (e instanceof Error ? e.message : String(e));

// Lo que se ve: una transferencia de 1 tinybar. Así la prepara cualquier dApp con el SDK.
const shown = new TransferTransaction().addHbarTransfer(ME, Hbar.fromTinybars(-1)).addHbarTransfer("0.0.98", Hbar.fromTinybars(1)).setTransactionId(TransactionId.generate(ME)).setNodeAccountIds([new AccountId(3)]).freeze();
const shownBytes = proto.SignedTransaction.decode(/** @type {Uint8Array} */ (proto.TransactionList.decode(shown.toBytes()).transactionList[0].signedTransactionBytes)).bodyBytes;

// Lo que no se ve: otra operación pegada detrás (un cuerpo es una lista de campos; se le añade uno más).
const hidden = /** @type {Record<string, any>} */ ({
  "cambiar la llave de la Cartera": { cryptoUpdateAccount: { accountIDToUpdate: me, key: { ed25519: new Uint8Array(32).fill(7) } } },
  "dar un permiso de gasto": { cryptoApproveAllowance: { cryptoAllowances: [{ owner: me, spender: thief, amount: 500_000_000 }] } },
  "borrar la cuenta": { cryptoDelete: { deleteAccountID: me, transferAccountID: thief } },
  "llamar a un contrato con 5 HBAR": { contractCall: { contractID: { shardNum: 0, realmNum: 0, contractNum: 9999 }, gas: 100_000, amount: 500_000_000 } },
});

console.log("Una transferencia de 1 tinybar con otra operación pegada detrás, en el mismo cuerpo.");
console.log("En protobuf, cuando un cuerpo trae dos operaciones vale la última.\n");
let confirmed = 0;
let stillOpen = 0;
for (const [name, op] of Object.entries(hidden)) {
  const bytes = new Uint8Array(Buffer.concat([Buffer.from(shownBytes), Buffer.from(proto.TransactionBody.encode(op).finish())]));
  console.log(`· ${name}`);
  // Antes: se leía el cuerpo tal cual y se enseñaba la primera operación que la hoja reconocía.
  const decoded = proto.TransactionBody.decode(bytes);
  const fields = dataFieldsOf(decoded);
  if (fields.length > 1) {
    const onlyShown = { ...decoded };
    for (const k of fields) if (k !== "cryptoTransfer") delete onlyShown[k];
    const before = describeDappTransaction(onlyShown, opts);
    if (before.blocked) console.log(`    antes: se leían las dos (${fields.join(" + ")}) y la hoja lo bloqueaba`);
    else {
      confirmed++;
      console.log(`    antes: se leían las dos (${fields.join(" + ")}) y la hoja enseñaba solo «${before.title}», ${before.warnings.length ? "con avisos" : "sin avisos"} → se podía firmar sin ver la otra`);
    }
  } else {
    console.log(`    antes: al leerlo quedaba solo ${fields.join()} (la misma que vale para la red) → no engañaba`);
  }
  // Ahora.
  let now = null;
  try {
    const req = parseDappRequest({ method: "hedera_signTransaction", params: { signerAccountId: ME, transactionBody: encodeBase64(bytes) }, chainId: "hedera:testnet", accountId: ME });
    now = describeDappTransaction(req.bodies[0], opts).blocked;
  } catch (e) {
    now = why(e);
  }
  if (now) console.log(`    ahora: NO SE FIRMA («${now}»)`);
  else {
    stillOpen++;
    console.log("    ahora: SE PODRÍA FIRMAR  ← sigue abierto");
  }
}
const total = Object.keys(hidden).length;
console.log(
  confirmed > 0
    ? `\nRESULTADO: CONFIRMADO en ${confirmed} de ${total}: la hoja anterior enseñaba solo la transferencia. Para aprovecharlo hacía falta que una dApp de la lista pidiera esa firma (su web secuestrada, por ejemplo), y solo alcanzaba a la Cartera, no a la bóveda.`
    : "\nRESULTADO: no confirmado: la librería de verdad ya se quedaba con una sola operación.",
);
console.log(stillOpen === 0 ? `Con esta versión, las ${total} se rechazan.` : `OJO: ${stillOpen} de ${total} siguen pasando con esta versión.`);
process.exit(stillOpen === 0 ? 0 : 1);
