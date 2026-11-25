// La hoja de firma de las dApps no se deja engañar: se firma lo que se ve, o no se firma.
// Es la última defensa de la Cartera si una de las dApps de la lista aparece un día con la web secuestrada.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AccountAllowanceApproveTransaction,
  AccountId,
  AccountUpdateTransaction,
  ContractExecuteTransaction,
  ContractId,
  Hbar,
  NftId,
  ScheduleCreateTransaction,
  TokenAssociateTransaction,
  TokenDissociateTransaction,
  TokenId,
  TransactionId,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import * as HieroProto from "@hiero-ledger/proto";
import { encodeBase64, getBytes, id } from "ethers";
import { dataFieldsOf, describeDappTransaction, evmCallOf, parseDappRequest, readBody, tokenIdsOfBodies } from "@boveda/core";

const { proto } = HieroProto;
const CHAIN = "hedera:testnet";
const ME = "0.0.5005";
const VAULT = "0.0.6006";
const THIEF = "0.0.666";
const nodes = [new AccountId(3), new AccountId(4)];
const me = { shardNum: 0, realmNum: 0, accountNum: 5005 };
const thief = { shardNum: 0, realmNum: 0, accountNum: 666 };
const meta = (tokenId) =>
  tokenId === "0.0.42" ? { tokenId, name: "Salsa", symbol: "SAUCE", decimals: 2, fungible: true } : tokenId === "0.0.88" ? { tokenId, name: "Gatos", symbol: "GATO", decimals: 0, fungible: false } : undefined;
const opts = { account: ME, vaultId: VAULT, lang: "es", meta };

const frozen = (tx) => tx.setTransactionId(TransactionId.generate(ME)).setNodeAccountIds(nodes).freeze();
/** Lo que manda una dApp para «firmar y ejecutar»: la lista entera, en base64. */
const listB64 = (tx) => encodeBase64(frozen(tx).toBytes());
/** Los bytes del cuerpo (el del primer nodo) de una transacción del SDK. */
const bodyBytesOf = (tx) => proto.SignedTransaction.decode(proto.TransactionList.decode(frozen(tx).toBytes()).transactionList[0].signedTransactionBytes).bodyBytes;
const join = (...parts) => new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p))));
/** La misma lista con el cuerpo de cada nodo cambiado por `change(cuerpo)`. */
const tamperedList = (tx, change) => {
  const list = proto.TransactionList.decode(frozen(tx).toBytes());
  for (const t of list.transactionList) {
    const signed = proto.SignedTransaction.decode(t.signedTransactionBytes);
    signed.bodyBytes = change(signed.bodyBytes);
    t.signedTransactionBytes = proto.SignedTransaction.encode(signed).finish();
  }
  return encodeBase64(proto.TransactionList.encode(list).finish());
};
const signOnly = (bodyBytes) => parseDappRequest({ method: "hedera_signTransaction", params: { signerAccountId: ME, transactionBody: encodeBase64(bodyBytes) }, chainId: CHAIN, accountId: ME });
const signAndRun = (b64) => parseDappRequest({ method: "hedera_signAndExecuteTransaction", params: { signerAccountId: `${CHAIN}:${ME}`, transactionList: b64 }, chainId: CHAIN, accountId: ME });
const describe = (tx, extra = {}) => describeDappTransaction(signAndRun(listB64(tx)).bodies[0], { ...opts, ...extra });
/** Por qué H10X Wallet no deja firmar (lo rechaza al leerlo o lo bloquea en la hoja), o null si deja. */
const refusal = (make) => {
  try {
    return describeDappTransaction(make().bodies[0], opts).blocked;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};
const small = () => new TransferTransaction().addHbarTransfer(ME, Hbar.fromTinybars(-1)).addHbarTransfer("0.0.98", Hbar.fromTinybars(1));

// --- llamadas EVM ---
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const addr = (accountId) => word(BigInt(accountId.split(".")[2]));
const MAX = (1n << 256n) - 1n;
const data = (signature, ...words) => getBytes(id(signature).slice(0, 10) + words.join(""));
const call = (contract, params) => new ContractExecuteTransaction().setContractId(ContractId.fromString(contract)).setGas(100_000).setFunctionParameters(params);

test("dos operaciones metidas en un mismo cuerpo: no se firma (la red se quedaría con la que no se ve)", () => {
  const hidden = {
    "cambiar la llave de la Cartera": { cryptoUpdateAccount: { accountIDToUpdate: me, key: { ed25519: new Uint8Array(32).fill(7) } } },
    "dar un permiso de gasto": { cryptoApproveAllowance: { cryptoAllowances: [{ owner: me, spender: thief, amount: 500_000_000 }] } },
    "borrar la cuenta": { cryptoDelete: { deleteAccountID: me, transferAccountID: thief } },
    "llamar a un contrato": { contractCall: { contractID: { shardNum: 0, realmNum: 0, contractNum: 9999 }, gas: 100_000, amount: 500_000_000 } },
  };
  for (const [name, op] of Object.entries(hidden)) {
    // Un cuerpo es una lista de campos: pegar otro cuerpo detrás es añadirle una segunda operación.
    const extra = proto.TransactionBody.encode(op).finish();
    assert.ok(refusal(() => signOnly(join(bodyBytesOf(small()), extra))), `firma suelta: una transferencia de nada + ${name}`);
    assert.ok(refusal(() => signAndRun(tamperedList(small(), (b) => join(b, extra)))), `firmar y ejecutar: una transferencia de nada + ${name}`);
  }
  // Ya decodificado (así llega lo de dentro de una programada o de un lote): también se bloquea.
  const two = { transactionID: { accountID: me }, transactionFee: 100_000_000, cryptoTransfer: { transfers: { accountAmounts: [] } }, cryptoDelete: { deleteAccountID: me, transferAccountID: thief } };
  assert.deepEqual(dataFieldsOf(two), ["cryptoTransfer", "cryptoDelete"]);
  assert.match(describeDappTransaction(two, opts).blocked, /varias operaciones/);
  assert.match(describeDappTransaction({ transactionID: { accountID: me }, transactionFee: 1, scheduleCreate: { scheduledTransactionBody: { cryptoTransfer: { transfers: { accountAmounts: [] } }, cryptoDelete: {} } } }, opts).blocked, /varias operaciones/);
  // Una sola operación sigue pasando.
  assert.equal(refusal(() => signOnly(bodyBytesOf(small()))), null);
  assert.equal(refusal(() => signAndRun(listB64(small()))), null);
});

test("datos que esta versión no sabe leer, relleno u orden raro: no se firma lo que no se ve", () => {
  const unknown = Uint8Array.from([0xf8, 0xf0, 0x04, 0x01]); // el campo 9999 (no existe) con el valor 1
  const lateMemo = proto.TransactionBody.encode({ memo: "x" }).finish(); // la nota, repetida al final
  for (const [name, tail] of [["un campo desconocido", unknown], ["un campo repetido fuera de sitio", lateMemo]]) {
    assert.throws(() => signOnly(join(bodyBytesOf(small()), tail)), /no sabe leer/, `firma suelta con ${name}`);
    assert.throws(() => signAndRun(tamperedList(small(), (b) => join(b, tail))), /no sabe leer/, `firmar y ejecutar con ${name}`);
    assert.throws(() => readBody(join(bodyBytesOf(small()), tail)), /no sabe leer/);
  }
  assert.throws(() => readBody(Uint8Array.from([0xff, 0xff, 0xff])), /no se puede leer|no sabe leer/);
  // Dentro de un lote, igual: cada operación del lote se lee con la misma regla.
  const inner = proto.SignedTransaction.encode({ bodyBytes: join(bodyBytesOf(small()), unknown), sigMap: {} }).finish();
  assert.throws(() => describeDappTransaction({ transactionID: { accountID: me }, transactionFee: 1, atomicBatch: { transactions: [inner] } }, opts), /no sabe leer/);
});

test("firma suelta (hedera_signTransaction): solo un cuerpo completo, que empiece diciendo quién paga", () => {
  const transfers = { transfers: { accountAmounts: [{ accountID: me, amount: -1 }, { accountID: thief, amount: 1 }] } };
  // Así empieza siempre una transacción de Hedera preparada; ninguna transacción EVM empieza por ese byte.
  assert.equal(bodyBytesOf(small())[0], 0x0a);
  assert.throws(() => signOnly(proto.TransactionBody.encode({ transactionFee: 100_000_000, cryptoTransfer: transfers }).finish()), /quién la paga/);
  assert.throws(() => signOnly(proto.TransactionBody.encode({ transactionID: { transactionValidStart: { seconds: 1_700_000_000 } }, transactionFee: 100_000_000, cryptoTransfer: transfers }).finish()), /quién la paga/);
  assert.equal(signOnly(bodyBytesOf(small())).bodies.length, 1);
});

test("lo normal pasa sin tocar: lo que escribe el SDK se lee y se vuelve a escribir byte a byte igual", () => {
  const normal = {
    "transferencia de HBAR, un token y un NFT": () =>
      new TransferTransaction()
        .addHbarTransfer(ME, new Hbar(-5))
        .addHbarTransfer("0.0.777", new Hbar(5))
        .addTokenTransfer("0.0.42", ME, -150)
        .addTokenTransfer("0.0.42", "0.0.777", 150)
        .addNftTransfer(new NftId(TokenId.fromString("0.0.88"), 3), ME, "0.0.777")
        .setTransactionMemo("año nuevo, ¡enhorabuena!")
        .setMaxTransactionFee(new Hbar(2)),
    "permisos de HBAR, de un token sin límite y de una colección": () =>
      new AccountAllowanceApproveTransaction().approveHbarAllowance(ME, "0.0.1460200", new Hbar(10)).approveTokenAllowance("0.0.42", ME, "0.0.1460200", "9223372036854775807").approveTokenNftAllowanceAllSerials("0.0.88", ME, "0.0.1460200"),
    "llamada a un contrato con HBAR": () => new ContractExecuteTransaction().setContractId(ContractId.fromString("0.0.3045981")).setGas(300_000).setPayableAmount(new Hbar(1)).setFunction("swap"),
    "asociar un token": () => new TokenAssociateTransaction().setAccountId(ME).setTokenIds([TokenId.fromString("0.0.731861")]),
    "quitar un token": () => new TokenDissociateTransaction().setAccountId(ME).setTokenIds([TokenId.fromString("0.0.731861")]),
    "cambiar el nodo de staking": () => new AccountUpdateTransaction().setAccountId(ME).setStakedNodeId(3),
    "programar una transferencia": () => new ScheduleCreateTransaction().setScheduledTransaction(new TransferTransaction().addHbarTransfer(ME, new Hbar(-1)).addHbarTransfer("0.0.777", new Hbar(1))),
  };
  for (const [name, make] of Object.entries(normal)) {
    const bytes = bodyBytesOf(make());
    assert.deepEqual(Buffer.from(proto.TransactionBody.encode(readBody(bytes)).finish()), Buffer.from(bytes), `${name}: mismos bytes`);
    assert.equal(dataFieldsOf(readBody(bytes)).length, 1, `${name}: una sola operación`);
    assert.equal(refusal(() => signOnly(bytes)), null, `${name}: firma suelta`);
    assert.equal(refusal(() => signAndRun(listB64(make()))), null, `${name}: firmar y ejecutar`);
  }
  // Sin congelar (HIP-745), como las manda la librería de WalletConnect para Hedera.
  const loose = new TransferTransaction().addHbarTransfer(ME, new Hbar(-3)).addHbarTransfer("0.0.777", new Hbar(3));
  assert.equal(signAndRun(encodeBase64(loose.toBytes())).bodies.length >= 1, true);
});

test("permisos «por la puerta EVM»: se ven y se avisan en rojo, igual que por la vía normal", () => {
  // approve en la dirección del token: lo que hace un «drainer» en las redes EVM.
  const erc20 = describe(call("0.0.42", data("approve(address,uint256)", addr(THIEF), word(MAX))));
  assert.equal(erc20.blocked, null);
  assert.equal(erc20.danger, true);
  assert.equal(erc20.title, "Dar permiso para gastar");
  assert.ok(erc20.lines.includes("0.0.666 podrá gastar sin límite de SAUCE"), erc20.lines.join("|"));
  assert.ok(erc20.warnings.some((w) => /sin límite sobre SAUCE/.test(w)));
  assert.ok(erc20.lines.includes("Contrato 0.0.42"), "se sigue viendo a qué contrato se llama");
  // La app pide al mirror el nombre y los decimales de ese token.
  assert.deepEqual(tokenIdsOfBodies(signAndRun(listB64(call("0.0.42", data("approve(address,uint256)", addr(THIEF), word(1))))).bodies), ["0.0.42"]);
  const some = describe(call("0.0.42", data("approve(address,uint256)", addr(THIEF), word(150))));
  assert.ok(some.lines.includes("0.0.666 podrá gastar 1,5 SAUCE"), some.lines.join("|"));
  assert.equal(some.danger, true);
  const all = describe(call("0.0.88", data("setApprovalForAll(address,bool)", addr(THIEF), word(1))));
  assert.equal(all.danger, true);
  assert.ok(all.lines.some((l) => /TODOS tus NFT de Gatos/.test(l)), all.lines.join("|"));
  const oneNft = describe(call("0.0.88", data("approve(address,uint256)", addr(THIEF), word(7))));
  assert.ok(oneNft.lines.includes("0.0.666 podrá mover tu NFT Gatos #7"), oneNft.lines.join("|"));
  // El servicio de tokens (0x167) y el de cuentas (0x16a), llamados directamente con la llave de la Cartera.
  const hts = describe(call("0.0.359", data("approve(address,address,uint256)", addr("0.0.42"), addr(THIEF), word(MAX))));
  assert.equal(hts.danger, true);
  assert.ok(hts.lines.includes("0.0.666 podrá gastar sin límite de SAUCE"), hts.lines.join("|"));
  const opaque = describe(call("0.0.359", data("cryptoTransfer((int64)[],(address)[])", word(64))));
  assert.equal(opaque.danger, true);
  assert.ok(opaque.warnings.some((w) => /contrato del sistema de Hedera/.test(w)));
  const hbar = describe(call("0.0.362", data("hbarApprove(address,address,int256)", addr(ME), addr(THIEF), word(500n * 100_000_000n))));
  assert.equal(hbar.danger, true);
  assert.ok(hbar.lines.includes("0.0.666 podrá gastar 500 HBAR"), hbar.lines.join("|"));
  // La bóveda, ni nombrada como dueña ni llamada como si fuera un contrato.
  assert.match(describe(call("0.0.362", data("hbarApprove(address,address,int256)", addr(VAULT), addr(THIEF), word(1)))).blocked, /bóveda/);
  assert.match(describe(call(VAULT, data("hbarApprove(address,int256)", addr(THIEF), word(1)))).blocked, /bóveda/);
  // Quitar un permiso no asusta, y un contrato cualquiera sigue como estaba.
  const revoke = describe(call("0.0.42", data("approve(address,uint256)", addr(THIEF), word(0))));
  assert.equal(revoke.danger, false);
  assert.ok(revoke.lines.includes("Quita un permiso sobre Salsa"));
  const sent = describe(call("0.0.42", data("transfer(address,uint256)", addr(THIEF), word(150))));
  assert.ok(sent.lines.includes("1,5 SAUCE → 0.0.666"), sent.lines.join("|"));
  const swap = describe(new ContractExecuteTransaction().setContractId(ContractId.fromString("0.0.3045981")).setGas(300_000).setPayableAmount(new Hbar(1)).setFunction("swap"));
  assert.equal(swap.danger, false);
  assert.equal(swap.title, "Interactuar con un contrato");
  assert.equal(evmCallOf({ contractID: { shardNum: 0, realmNum: 0, contractNum: 3045981 }, functionParameters: getBytes("0x12345678") }), null);
});

test("una transacción EVM (firmada por dentro con otra llave) se bloquea", () => {
  const bytes = proto.TransactionBody.encode({
    transactionID: { transactionValidStart: { seconds: 1_700_000_000, nanos: 0 }, accountID: me },
    transactionFee: 100_000_000,
    ethereumTransaction: { ethereumData: new Uint8Array(40).fill(1) },
  }).finish();
  assert.match(refusal(() => signOnly(bytes)), /EVM/);
});

test("vaciar la Cartera de una firma (HBAR + tokens + NFT a cambio de nada): aviso en rojo", () => {
  const drain = describe(
    new TransferTransaction()
      .addHbarTransfer(ME, new Hbar(-900))
      .addHbarTransfer(THIEF, new Hbar(900))
      .addTokenTransfer("0.0.42", ME, -5000)
      .addTokenTransfer("0.0.42", THIEF, 5000)
      .addNftTransfer(new NftId(TokenId.fromString("0.0.88"), 3), ME, THIEF),
  );
  assert.equal(drain.blocked, null);
  assert.equal(drain.danger, true);
  assert.ok(drain.warnings.some((w) => /Salen 3 activos distintos/.test(w)), drain.warnings.join("|"));
  // Una compra (pagas con HBAR y dos tokens, recibes un NFT) o un envío normal no llevan ese aviso.
  const buy = describe(
    new TransferTransaction()
      .addHbarTransfer(ME, new Hbar(-5))
      .addHbarTransfer(THIEF, new Hbar(5))
      .addTokenTransfer("0.0.42", ME, -10)
      .addTokenTransfer("0.0.42", THIEF, 10)
      .addTokenTransfer("0.0.43", ME, -10)
      .addTokenTransfer("0.0.43", THIEF, 10)
      .addNftTransfer(new NftId(TokenId.fromString("0.0.88"), 9), THIEF, ME),
  );
  assert.equal(buy.danger, false);
  const send = describe(new TransferTransaction().addHbarTransfer(ME, new Hbar(-5)).addHbarTransfer("0.0.777", new Hbar(5)));
  assert.deepEqual(send.warnings, []);
  assert.equal(send.danger, false);
});
