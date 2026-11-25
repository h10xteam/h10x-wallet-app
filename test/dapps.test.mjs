// Política de dApps (WalletConnect): lista cerrada, decodificación de transacciones y firmas HIP-820.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AccountAllowanceApproveTransaction,
  AccountDeleteTransaction,
  AccountId,
  AccountUpdateTransaction,
  ContractExecuteTransaction,
  ContractId,
  Hbar,
  NftId,
  PrivateKey,
  TokenAssociateTransaction,
  TokenId,
  TransactionId,
  TransferTransaction,
} from "@hiero-ledger/sdk";
import * as HieroProto from "@hiero-ledger/proto";
import { decodeBase64, encodeBase64, toUtf8Bytes } from "ethers";
import {
  DAPPS,
  approvedNamespaces,
  bodiesOfTransactionList,
  dappForUrl,
  describeDappTransaction,
  hostOf,
  parseDappRequest,
  prefixedMessage,
  signatureMapBase64,
  tokenIdsOfBodies,
  vetProposal,
  vetRequestOrigin,
} from "@boveda/core";

const { proto } = HieroProto;
const CHAIN = "hedera:testnet";
const ME = "0.0.5005";
const nodes = [new AccountId(3), new AccountId(4)];
const listOf = (tx) => encodeBase64(tx.setTransactionId(TransactionId.generate(ME)).setNodeAccountIds(nodes).freeze().toBytes());
const describe = (b64, extra = {}) => {
  const req = parseDappRequest({ method: "hedera_signAndExecuteTransaction", params: { signerAccountId: `${CHAIN}:${ME}`, transactionList: b64 }, chainId: CHAIN, accountId: ME });
  return describeDappTransaction(req.bodies[0], { account: ME, lang: "es", ...extra });
};

test("dominios: solo las dApps de la lista, con subdominios y por https", () => {
  assert.deepEqual(DAPPS.map((d) => d.id), ["saucerswap", "sentx", "hsuite", "hashpack", "kabila", "h10x"]);
  assert.equal(dappForUrl("https://www.saucerswap.finance/swap")?.id, "saucerswap");
  assert.equal(dappForUrl("https://saucerswap.finance")?.id, "saucerswap");
  assert.equal(dappForUrl("https://sentx.io/nft-marketplace")?.id, "sentx");
  assert.equal(dappForUrl("https://market.kabila.app")?.id, "kabila");
  assert.equal(dappForUrl("https://wallet.hashpack.app")?.id, "hashpack");
  assert.equal(dappForUrl("http://saucerswap.finance"), null, "sin https no");
  assert.equal(dappForUrl("https://saucerswap.finance.evil.com"), null);
  assert.equal(dappForUrl("https://evilsaucerswap.finance"), null);
  assert.equal(dappForUrl("https://saucerswap.finance@evil.com"), null);
  assert.equal(dappForUrl("https://xn--saucerswp-8ya.finance"), null);
  assert.equal(hostOf("https://SaucerSwap.Finance./x"), "saucerswap.finance");
});

test("propuestas: se fía del origen verificado, no del nombre que dice la web", () => {
  const ns = { hedera: { chains: [CHAIN], methods: ["hedera_signAndExecuteTransaction"], events: [] } };
  const base = { metadataUrl: "https://www.saucerswap.finance", requiredNamespaces: ns, chainId: CHAIN, lang: "es" };
  const ok = vetProposal({ ...base, verifyContext: { verified: { origin: "https://www.saucerswap.finance", validation: "VALID" } } });
  assert.equal(ok.ok, true);
  assert.equal(ok.verified, true);
  // Una web falsa que se presenta como SaucerSwap: Verify certifica su origen real.
  const fake = vetProposal({ ...base, verifyContext: { verified: { origin: "https://saucer-swap.app", validation: "VALID" } } });
  assert.equal(fake.ok, false);
  assert.equal(fake.code, "mismatch");
  assert.equal(vetProposal({ ...base, verifyContext: { verified: { origin: "https://www.saucerswap.finance", validation: "INVALID" } } }).code, "mismatch");
  assert.equal(vetProposal({ ...base, verifyContext: { verified: { origin: "https://www.saucerswap.finance", validation: "VALID", isScam: true } } }).code, "scam");
  // Sin verificar: se permite con aviso (o se rechaza si se exige verificación).
  const unknown = vetProposal({ ...base, verifyContext: { verified: { origin: "", validation: "UNKNOWN" } } });
  assert.equal(unknown.ok, true);
  assert.match(unknown.warning, /no ha podido certificar/);
  assert.equal(vetProposal({ ...base, requireVerified: true, verifyContext: { verified: { validation: "UNKNOWN" } } }).code, "unverified");
  // Redes: solo Hedera y solo la red de la app.
  assert.equal(vetProposal({ ...base, requiredNamespaces: { eip155: { chains: ["eip155:1"] } }, verifyContext: { verified: { origin: "https://www.saucerswap.finance", validation: "VALID" } } }).code, "unsupported");
  assert.equal(vetProposal({ ...base, requiredNamespaces: { hedera: { chains: ["hedera:mainnet"] } }, verifyContext: { verified: { origin: "https://www.saucerswap.finance", validation: "VALID" } } }).code, "wrong_network");
  assert.equal(vetProposal({ ...base, requiredNamespaces: {}, optionalNamespaces: { hedera: { chains: ["hedera:mainnet", CHAIN] } }, verifyContext: { verified: { origin: "https://www.saucerswap.finance", validation: "VALID" } } }).ok, true);
  assert.equal(vetProposal({ ...base, requiredNamespaces: { [CHAIN]: { methods: [] } }, verifyContext: { verified: { origin: "https://www.saucerswap.finance", validation: "VALID" } } }).ok, true);
  // Las peticiones posteriores no pueden venir de otra web.
  assert.equal(vetRequestOrigin({ dappId: "saucerswap", verifyContext: { verified: { origin: "https://www.saucerswap.finance", validation: "VALID" } } }), true);
  assert.equal(vetRequestOrigin({ dappId: "saucerswap", verifyContext: { verified: { origin: "https://sentx.io", validation: "VALID" } } }), false);
  assert.equal(vetRequestOrigin({ dappId: "saucerswap", verifyContext: { verified: { validation: "INVALID" } } }), false);
  assert.deepEqual(approvedNamespaces({ chainId: CHAIN, accountId: ME }).hedera.accounts, [`${CHAIN}:${ME}`]);
});

test("peticiones: solo la Cartera y solo métodos permitidos", () => {
  const p = { signerAccountId: `${CHAIN}:0.0.999`, message: "hola" };
  assert.throws(() => parseDappRequest({ method: "hedera_signMessage", params: p, chainId: CHAIN, accountId: ME }), /otra cuenta/);
  assert.throws(() => parseDappRequest({ method: "hedera_signAndExecuteQuery", params: {}, chainId: CHAIN, accountId: ME }), /no permite/);
  assert.throws(() => parseDappRequest({ method: "eth_sendTransaction", params: {}, chainId: CHAIN, accountId: ME }), /no permite/);
  assert.throws(() => parseDappRequest({ method: "hedera_signAndExecuteTransaction", params: { signerAccountId: ME, transactionList: "!!" }, chainId: CHAIN, accountId: ME }), /no es válido|no se puede leer|vacía/);
});

test("transferencias: se ve lo que sale, a quién y la comisión", () => {
  const tx = new TransferTransaction()
    .addHbarTransfer(ME, new Hbar(-5))
    .addHbarTransfer("0.0.777", new Hbar(5))
    .addTokenTransfer("0.0.42", ME, -150)
    .addTokenTransfer("0.0.42", "0.0.777", 150)
    .addNftTransfer(new NftId(TokenId.fromString("0.0.88"), 3), ME, "0.0.777")
    .setMaxTransactionFee(new Hbar(2));
  const req = parseDappRequest({ method: "hedera_signAndExecuteTransaction", params: { signerAccountId: ME, transactionList: listOf(tx) }, chainId: CHAIN, accountId: ME });
  assert.deepEqual(tokenIdsOfBodies(req.bodies).sort(), ["0.0.42", "0.0.88"]);
  const meta = (id) => (id === "0.0.42" ? { tokenId: id, name: "Salsa", symbol: "SAUCE", decimals: 2, fungible: true } : { tokenId: id, name: "Gatos", symbol: "GATO", decimals: 0, fungible: false });
  const d = describeDappTransaction(req.bodies[0], { account: ME, lang: "es", meta });
  assert.equal(d.title, "Transferencia");
  assert.equal(d.blocked, null);
  assert.equal(d.outgoingTinybars, 5n * 100_000_000n);
  assert.ok(d.lines.includes("Sale de tu Cartera: 5 HBAR"), d.lines.join("|"));
  assert.ok(d.lines.includes("5 HBAR → 0.0.777"));
  assert.ok(d.lines.includes("1,5 SAUCE → 0.0.777"), d.lines.join("|"));
  assert.ok(d.lines.includes(`NFT Gatos #3: ${ME} → 0.0.777`));
  assert.ok(d.lines.includes("Comisión máxima de red: 2 HBAR"));
});

test("permisos (allowance): aviso en rojo, y más si son sin límite o de toda una colección", () => {
  const tx = new AccountAllowanceApproveTransaction()
    .approveTokenAllowance("0.0.42", ME, "0.0.1460200", "9223372036854775807")
    .approveTokenNftAllowanceAllSerials("0.0.88", ME, "0.0.1460200");
  const d = describe(listOf(tx));
  assert.equal(d.blocked, null);
  assert.equal(d.danger, true);
  assert.ok(d.warnings.some((w) => /sin límite/.test(w)));
  assert.ok(d.warnings.some((w) => /toda la colección/.test(w)));
  assert.ok(d.lines.some((l) => /TODOS tus NFT/.test(l)));
});

test("bloqueado siempre: cambiar la llave, borrar la cuenta, ajustes de seguridad", () => {
  const key = PrivateKey.generateED25519().publicKey;
  assert.match(describe(listOf(new AccountUpdateTransaction().setAccountId(ME).setKey(key))).blocked, /llave/);
  assert.match(describe(listOf(new AccountUpdateTransaction().setAccountId(ME).setReceiverSignatureRequired(true))).blocked, /seguridad/);
  assert.match(describe(listOf(new AccountDeleteTransaction().setAccountId(ME).setTransferAccountId("0.0.666"))).blocked, /Borraría/);
  // Cambiar el nodo de staking sí se deja (no da acceso a nada).
  assert.equal(describe(listOf(new AccountUpdateTransaction().setAccountId(ME).setStakedNodeId(3))).blocked, null);
});

test("contratos y asociaciones: se permiten con explicación", () => {
  const c = describe(listOf(new ContractExecuteTransaction().setContractId(ContractId.fromString("0.0.3045981")).setGas(300000).setPayableAmount(new Hbar(1)).setFunction("swap")));
  assert.equal(c.blocked, null);
  assert.ok(c.lines.includes("Contrato 0.0.3045981"));
  assert.ok(c.lines.some((l) => /^Función 0x[0-9a-f]{8}$/.test(l)));
  assert.equal(c.outgoingTinybars, 100_000_000n);
  const a = describe(listOf(new TokenAssociateTransaction().setAccountId(ME).setTokenIds([TokenId.fromString("0.0.731861")])));
  assert.equal(a.title, "Añadir tokens a tu Cartera");
  assert.equal(a.blocked, null);
});

test("una lista con cuerpos distintos por nodo se rechaza (enseñar una cosa y ejecutar otra)", () => {
  const good = new TransferTransaction().addHbarTransfer(ME, new Hbar(-1)).addHbarTransfer("0.0.777", new Hbar(1));
  const bytes = decodeBase64(listOf(good));
  const list = proto.TransactionList.decode(bytes);
  const signed = proto.SignedTransaction.decode(list.transactionList[1].signedTransactionBytes);
  const body = proto.TransactionBody.decode(signed.bodyBytes);
  body.cryptoTransfer.transfers.accountAmounts[1].accountID.accountNum = 666;
  body.cryptoTransfer.transfers.accountAmounts[1].amount = 100_000_000;
  signed.bodyBytes = proto.TransactionBody.encode(body).finish();
  list.transactionList[1].signedTransactionBytes = proto.SignedTransaction.encode(signed).finish();
  const evil = proto.TransactionList.encode(list).finish();
  assert.throws(() => bodiesOfTransactionList(evil), /versiones distintas/);
  assert.equal(bodiesOfTransactionList(bytes).length, 2);
});

test("firmas HIP-820: mensaje con prefijo y cuerpo de transacción", () => {
  for (const key of [PrivateKey.generateED25519(), PrivateKey.generateECDSA()]) {
    const msg = "Inicia sesión en SentX: 1234";
    const map = proto.SignatureMap.decode(decodeBase64(signatureMapBase64(key, prefixedMessage(msg))));
    const pair = map.sigPair[0];
    const sig = pair.ed25519?.length ? pair.ed25519 : pair.ECDSASecp256k1;
    assert.ok(key.publicKey.verify(toUtf8Bytes(`\x19Hedera Signed Message:\n${msg.length}${msg}`), sig));
    assert.ok(!key.publicKey.verify(toUtf8Bytes(msg), sig), "sin prefijo no vale");
    const tx = new TransferTransaction().addHbarTransfer(ME, new Hbar(-1)).addHbarTransfer("0.0.777", new Hbar(1)).setTransactionId(TransactionId.generate(ME)).setNodeAccountIds([nodes[0]]).freeze();
    const bodyBytes = proto.SignedTransaction.decode(proto.TransactionList.decode(tx.toBytes()).transactionList[0].signedTransactionBytes).bodyBytes;
    const req = parseDappRequest({ method: "hedera_signTransaction", params: { signerAccountId: ME, transactionBody: encodeBase64(bodyBytes) }, chainId: CHAIN, accountId: ME });
    const tmap = proto.SignatureMap.decode(decodeBase64(signatureMapBase64(key, req.bodyBytes)));
    const tsig = tmap.sigPair[0].ed25519?.length ? tmap.sigPair[0].ed25519 : tmap.sigPair[0].ECDSASecp256k1;
    assert.ok(key.publicKey.verify(bodyBytes, tsig));
    assert.deepEqual(Buffer.from(tmap.sigPair[0].pubKeyPrefix), Buffer.from(key.publicKey.toBytesRaw()));
  }
});

test("dApps fuera de la lista (h10x14): con dominio certificado y aviso; nunca imitaciones", async () => {
  const { dappById, looksLikeListed, unlistedDapp } = await import("../core/src/index.js");
  const ns = { hedera: { chains: [CHAIN], methods: [], events: [] } };
  const vet = (origin, validation, metadataUrl, metadataName = "", requireVerified = true) =>
    vetProposal({ verifyContext: { verified: { origin, validation } }, metadataUrl, metadataName, requiredNamespaces: ns, chainId: CHAIN, requireVerified, lang: "es" });
  // Certificada por WalletConnect: se acepta con aviso, nombrada por su dominio (no por el nombre que dice).
  const ok = vet("https://app.bonzo.finance", "VALID", "https://app.bonzo.finance", "Bonzo Finance");
  assert.equal(ok.ok, true);
  assert.equal(ok.dapp.id, "web:app.bonzo.finance");
  assert.equal(ok.dapp.name, "app.bonzo.finance");
  assert.equal(ok.dapp.unlisted, true);
  assert.match(ok.warning, /no está en la lista/);
  // Se hace pasar por una de la lista (por dirección o por nombre): fuera.
  assert.equal(vet("https://swap.evil.io", "VALID", "https://www.saucerswap.finance").code, "mismatch");
  assert.equal(vet("https://swap.evil.io", "VALID", "https://swap.evil.io", "HashPack").code, "mismatch");
  // Imitaciones: lleva la marca de una de la lista, o letras de otros alfabetos.
  for (const h of ["saucerswap-airdrop.xyz", "hashpack.support", "kabila-nft.io", "h10x-claim.com", "xn--sacerswap-9za.finance"]) {
    assert.equal(looksLikeListed(h), true, h);
    assert.equal(vet(`https://${h}`, "VALID", `https://${h}`).code, "lookalike", h);
  }
  assert.equal(looksLikeListed("app.bonzo.finance"), false);
  assert.equal(looksLikeListed("www.saucerswap.finance"), false, "la oficial no es imitación");
  // Sin certificar: en mainnet se rechaza; en testnet, con aviso fuerte.
  assert.equal(vet("", "UNKNOWN", "https://app.bonzo.finance").code, "unverified");
  const weak = vet("", "UNKNOWN", "https://app.bonzo.finance", "", false);
  assert.equal(weak.ok, true);
  assert.equal(weak.verified, false);
  assert.match(weak.warning, /Ni H10X Wallet ni WalletConnect/);
  // Estafa, origen falso y redes que no son Hedera: fuera, como siempre.
  assert.equal(vetProposal({ verifyContext: { verified: { origin: "https://app.bonzo.finance", validation: "VALID", isScam: true } }, metadataUrl: "https://app.bonzo.finance", requiredNamespaces: ns, chainId: CHAIN }).code, "scam");
  assert.equal(vetProposal({ verifyContext: { verified: { origin: "https://app.bonzo.finance", validation: "INVALID" } }, metadataUrl: "https://app.bonzo.finance", requiredNamespaces: ns, chainId: CHAIN }).code, "mismatch");
  assert.equal(vetProposal({ verifyContext: { verified: { origin: "https://app.bonzo.finance", validation: "VALID" } }, metadataUrl: "https://app.bonzo.finance", requiredNamespaces: { eip155: { chains: ["eip155:1"] } }, chainId: CHAIN }).code, "unsupported");
  // Sus peticiones solo desde su mismo dominio certificado.
  assert.equal(vetRequestOrigin({ dappId: "web:app.bonzo.finance", verifyContext: { verified: { origin: "https://app.bonzo.finance", validation: "VALID" } } }), true);
  assert.equal(vetRequestOrigin({ dappId: "web:app.bonzo.finance", verifyContext: { verified: { origin: "https://evil.io", validation: "VALID" } } }), false);
  assert.equal(vetRequestOrigin({ dappId: "web:app.bonzo.finance", verifyContext: { verified: { origin: "https://www.saucerswap.finance", validation: "VALID" } } }), false);
  // Ids: «web:dominio» o uno de la lista; nada raro.
  assert.equal(dappById("web:app.bonzo.finance")?.name, "app.bonzo.finance");
  assert.equal(dappById("saucerswap")?.name, "SaucerSwap");
  assert.equal(dappById("web:bad host"), null);
  assert.equal(unlistedDapp("localhost"), null);
});
