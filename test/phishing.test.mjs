// Phishing y regalos trampa: webs escondidas en nombres de tokens y NFT, tokens que se hacen pasar por HBAR,
// y los permisos de gasto de la Cartera (verlos y quitarlos).
import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountId, Hbar, NftId, TokenId, TransactionId, TransferTransaction } from "@hiero-ledger/sdk";
import * as HieroProto from "@hiero-ledger/proto";
import { encodeBase64 } from "ethers";
import { allowancesFromMirror, describeDappTransaction, fakesHbar, hasLink, hideLinks, parseDappRequest, revokeTransaction } from "@boveda/core";

const { proto } = HieroProto;
const ME = "0.0.5005";

test("webs en nombres y descripciones: se ven también disimuladas, y lo normal no salta", () => {
  for (const s of [
    "https://hbar-claim.com",
    "Visit hbarclaim.xyz to claim",
    "claim at hbar-rewards[.]com",
    "hbar dot io",
    "www.example.org",
    "t.me/hbarsupport",
    "HBAR-AIRDROP.COM",
    "sаucerswap.finance", // con «а» cirílica
    "hxxps://evil.site/x",
    "premios hbar punto com",
    "reclama en hbar-premio . com",
    "Airdrop! 🎁 hedera-gift.app/claim?id=7",
    "support@hbar-help.com",
  ]) {
    assert.equal(hasLink(s), true, s);
  }
  for (const s of ["SAUCE", "Hedera Name Service", "v1.5", "No. 5", "Mr. Smith", "Gatos #7", "St. Louis", "1.000.000 HBAR", "WHBAR", "USDC.e", "Thanks. App launch soon", "Punto de venta", "El punto es este", "", undefined, null]) {
    assert.equal(hasLink(s), false, String(s));
  }
  assert.equal(hideLinks("Reclama en https://hbar-claim.com ya", "es"), "Reclama en [enlace oculto] ya");
  assert.equal(hideLinks("Visita hbarclaim[.]xyz", "es"), "Visita [enlace oculto]");
  assert.equal(hideLinks("a.com y b.io", "en"), "[link hidden] y [link hidden]");
  assert.equal(hideLinks("Gatos #7", "es"), "Gatos #7");
  // Un texto enorme y retorcido no cuelga la app.
  const t0 = Date.now();
  hideLinks("a.".repeat(3000) + "a dot ".repeat(1000), "es");
  assert.ok(Date.now() - t0 < 1000);
});

test("tokens que se hacen llamar HBAR", () => {
  for (const s of ["HBAR", "hbar", "H.B.A.R", "ℏ", "ＨＢＡＲ", "НВАR", "Hedera"]) assert.equal(fakesHbar(s), true, s);
  for (const s of ["WHBAR", "HBARX", "SAUCE", "xHBAR", "Hedera Name Service", "", null]) assert.equal(fakesHbar(s), false, String(s));
});

test("la hoja de firma no enseña la web de un token y avisa en rojo", () => {
  const tx = new TransferTransaction()
    .addHbarTransfer(ME, new Hbar(-5))
    .addHbarTransfer("0.0.777", new Hbar(5))
    .addTokenTransfer("0.0.42", "0.0.777", -1000)
    .addTokenTransfer("0.0.42", ME, 1000)
    .addTokenTransfer("0.0.43", "0.0.777", -1)
    .addTokenTransfer("0.0.43", ME, 1)
    .setTransactionMemo("Reclama tu premio en hbar-claim.com")
    .setTransactionId(TransactionId.generate(ME))
    .setNodeAccountIds([new AccountId(3)])
    .freeze();
  const req = parseDappRequest({ method: "hedera_signAndExecuteTransaction", params: { signerAccountId: ME, transactionList: encodeBase64(tx.toBytes()) }, chainId: "hedera:testnet", accountId: ME });
  const meta = (id) =>
    id === "0.0.42" ? { tokenId: id, name: "Premio: visita hbar-claim.com", symbol: "GIFT hbar-claim.com", decimals: 0, fungible: true } : id === "0.0.43" ? { tokenId: id, name: "Hbar", symbol: "HBAR", decimals: 0, fungible: true } : undefined;
  const d = describeDappTransaction(req.bodies[0], { account: ME, lang: "es", meta });
  assert.equal(d.blocked, null);
  assert.equal(d.danger, true);
  const all = [...d.lines, ...d.warnings, d.title].join("\n");
  assert.doesNotMatch(all, /hbar-claim\.com/, "la web no se enseña en ningún sitio");
  assert.ok(d.warnings.some((w) => /0\.0\.42 trae una web/.test(w)), d.warnings.join("|"));
  assert.ok(d.warnings.some((w) => /0\.0\.43 se hace llamar HBAR/.test(w)), d.warnings.join("|"));
  assert.ok(d.warnings.some((w) => /La nota trae una web/.test(w)), d.warnings.join("|"));
  assert.ok(d.lines.some((l) => /\[enlace oculto\]/.test(l)), d.lines.join("|"));
});

test("permisos de la Cartera: se leen del mirror (solo los vigentes)", () => {
  const list = allowancesFromMirror({
    crypto: [
      { owner: ME, spender: "0.0.666", amount: 500_000_000, amount_granted: 500_000_000 },
      { owner: ME, spender: "0.0.667", amount: 0, amount_granted: 100 }, // gastado o quitado
    ],
    tokens: [
      { owner: ME, spender: "0.0.1460200", token_id: "0.0.42", amount: 9223372036854775807n.toString() },
      { owner: ME, spender: "0.0.1460200", token_id: "0.0.43", amount: 0 },
    ],
    nfts: [
      { owner: ME, spender: "0.0.666", token_id: "0.0.88", approved_for_all: true },
      { owner: ME, spender: "0.0.666", token_id: "0.0.89", approved_for_all: false },
    ],
    held: [
      { tokenId: "0.0.88", serial: 3, metadata: "", spender: "0.0.668" },
      { tokenId: "0.0.88", serial: 4, metadata: "", spender: null },
    ],
  });
  assert.deepEqual(list, [
    { kind: "hbar", spender: "0.0.666", amount: 500_000_000n },
    { kind: "token", tokenId: "0.0.42", spender: "0.0.1460200", amount: 9223372036854775807n },
    { kind: "nftAll", tokenId: "0.0.88", spender: "0.0.666" },
    { kind: "nft", tokenId: "0.0.88", serial: 3, spender: "0.0.668" },
  ]);
  assert.deepEqual(allowancesFromMirror({}), []);
});

test("quitar un permiso: la transacción correcta para cada tipo, firmada por la Cartera", () => {
  const bodyOf = (tx) => {
    tx.setTransactionId(TransactionId.generate(ME)).setNodeAccountIds([new AccountId(3)]).freeze();
    const first = proto.TransactionList.decode(tx.toBytes()).transactionList[0];
    return proto.TransactionBody.decode(proto.SignedTransaction.decode(first.signedTransactionBytes).bodyBytes);
  };
  const n = (x) => Number(x ?? 0);
  const hbar = bodyOf(revokeTransaction(ME, { kind: "hbar", spender: "0.0.666", amount: 5n })).cryptoApproveAllowance.cryptoAllowances[0];
  assert.equal(n(hbar.owner.accountNum), 5005);
  assert.equal(n(hbar.spender.accountNum), 666);
  assert.equal(n(hbar.amount), 0);
  const token = bodyOf(revokeTransaction(ME, { kind: "token", tokenId: "0.0.42", spender: "0.0.1460200", amount: 5n })).cryptoApproveAllowance.tokenAllowances[0];
  assert.equal(n(token.tokenId.tokenNum), 42);
  assert.equal(n(token.spender.accountNum), 1460200);
  assert.equal(n(token.amount), 0);
  const all = bodyOf(revokeTransaction(ME, { kind: "nftAll", tokenId: "0.0.88", spender: "0.0.666" })).cryptoApproveAllowance.nftAllowances[0];
  assert.equal(n(all.tokenId.tokenNum), 88);
  assert.equal(n(all.spender.accountNum), 666);
  assert.equal(all.approvedForAll?.value ?? false, false);
  const one = bodyOf(revokeTransaction(ME, { kind: "nft", tokenId: "0.0.88", serial: 3, spender: "0.0.668" })).cryptoDeleteAllowance.nftAllowances[0];
  assert.equal(n(one.tokenId.tokenNum), 88);
  assert.equal(n(one.owner.accountNum), 5005);
  assert.deepEqual(one.serialNumbers.map(n), [3]);
  assert.throws(() => revokeTransaction(ME, /** @type {any} */ ({ kind: "otro" })), /desconocido|Unknown/);
  // Ninguna de estas toca nada más: una sola operación y la paga la Cartera.
  assert.equal(new NftId(TokenId.fromString("0.0.88"), 3).toString(), "0.0.88/3");
});
