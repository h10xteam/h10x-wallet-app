// Rendimiento (staking nativo): elección de nodo, lectura de la operación programada y qué puede ir por
// el carril de retirada.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountId, AccountUpdateTransaction, PrivateKey, TransactionId } from "@hiero-ledger/sdk";
import * as HieroProto from "@hiero-ledger/proto";
import { encodeBase64 } from "ethers";
import { allowedInWithdrawLane, describeDappTransaction, describeScheduledBody, nodeAprPercent, nodeIsFull, nodeLabel, pickStakingNode, summarizeAction } from "@boveda/core";

const { proto } = HieroProto;
const VAULT = "0.0.7777";
const node = (nodeId, rewardRateStart, stakeRewarded, maxStake, description = "") => ({ nodeId, accountId: `0.0.${nodeId + 3}`, description, stake: stakeRewarded, stakeRewarded, maxStake, rewardRateStart });

/** Cuerpo de una transacción congelada (toBytes da una TransactionList). */
const bodyOf = (tx, payer = "0.0.2") => {
  tx.setTransactionId(TransactionId.generate(payer)).setNodeAccountIds([new AccountId(3)]).freeze();
  const first = proto.TransactionList.decode(tx.toBytes()).transactionList[0];
  return proto.TransactionBody.decode(proto.SignedTransaction.decode(first.signedTransactionBytes).bodyBytes);
};
/** Cuerpo programable (base64) de una actualización de cuenta, como lo guarda el mirror. */
function scheduled(tx) {
  const body = bodyOf(tx);
  return encodeBase64(proto.SchedulableTransactionBody.encode({ cryptoUpdateAccount: body.cryptoUpdateAccount, transactionFee: body.transactionFee }).finish());
}
const upd = () => new AccountUpdateTransaction().setAccountId(VAULT);

test("nodo por defecto: el que más paga sin estar lleno; si todos lo están, el que más paga", () => {
  const nodes = [node(3, 5000, 50, 100), node(4, 9000, 100, 100), node(5, 5000, 10, 100), node(6, 4000, 0, 100)];
  assert.equal(nodeIsFull(nodes[1]), true);
  assert.equal(pickStakingNode(nodes), 5, "el 4 está lleno; 3 y 5 pagan igual y el 5 está más vacío");
  assert.equal(pickStakingNode([node(4, 9000, 100, 100), node(7, 100, 200, 100)]), 4);
  assert.equal(pickStakingNode([]), null);
  assert.equal(nodeAprPercent(node(3, 5068, 0, 1)).toFixed(2), "1.85", "5068 tinybars/HBAR/día ≈ 1,85 % al año");
  assert.equal(nodeAprPercent(node(3, 0, 0, 1)), 0);
  assert.equal(nodeLabel(node(3, 0, 0, 1, "Hosted by LG | Seoul, South Korea"), "es"), "Nodo 3 · LG | Seoul, South Korea");
  assert.equal(nodeLabel(node(9, 0, 0, 1), "en"), "Node 9");
});

test("la operación de staking se reconoce solo si no toca nada más", () => {
  assert.deepEqual(describeScheduledBody(scheduled(upd().setStakedNodeId(3))), { kind: "staking", account: VAULT, nodeId: 3, declineReward: null });
  assert.deepEqual(describeScheduledBody(scheduled(upd().clearStakedNodeId())), { kind: "staking", account: VAULT, nodeId: null, declineReward: null });
  assert.equal(describeScheduledBody(scheduled(upd().setStakedNodeId(0))).nodeId, 0, "el nodo 0 existe");
  assert.deepEqual(describeScheduledBody(scheduled(upd().setStakedNodeId(3).setDeclineStakingReward(true))).declineReward, true);
  // Mezclas y trucos: ya no es «staking».
  assert.deepEqual(describeScheduledBody(scheduled(upd().setStakedNodeId(3).setReceiverSignatureRequired(true))), { kind: "settings", account: VAULT, autoAssociations: null });
  assert.deepEqual(describeScheduledBody(scheduled(upd().setStakedAccountId("0.0.666"))), { kind: "settings", account: VAULT, autoAssociations: null });
  assert.deepEqual(describeScheduledBody(scheduled(upd().setMaxAutomaticTokenAssociations(-1).setReceiverSignatureRequired(true))), { kind: "settings", account: VAULT, autoAssociations: null }, "activar tokens + otra cosa ya no pasa por «activar tokens»");
  assert.deepEqual(describeScheduledBody(scheduled(upd().setMaxAutomaticTokenAssociations(-1))), { kind: "settings", account: VAULT, autoAssociations: -1 });
  assert.equal(describeScheduledBody(scheduled(upd().setStakedNodeId(3).setKey(PrivateKey.generateED25519().publicKey))).kind, "keyChange");
});

test("carril de retirada: solo transferencias, activar tokens y el staking de la propia bóveda", () => {
  const transfer = { kind: "transfer", from: VAULT, to: "0.0.9", tinybars: 1n, tokens: [], nfts: [], fee: null, extra: [] };
  assert.equal(allowedInWithdrawLane(transfer, VAULT), true);
  assert.equal(allowedInWithdrawLane({ kind: "settings", account: VAULT, autoAssociations: -1 }, VAULT), true);
  assert.equal(allowedInWithdrawLane({ kind: "staking", account: VAULT, nodeId: 3, declineReward: null }, VAULT), true);
  assert.equal(allowedInWithdrawLane({ kind: "staking", account: VAULT, nodeId: null, declineReward: null }, VAULT), true);
  assert.equal(allowedInWithdrawLane({ kind: "staking", account: "0.0.1", nodeId: 3, declineReward: null }, VAULT), false, "otra cuenta");
  assert.equal(allowedInWithdrawLane({ kind: "staking", account: VAULT, nodeId: 3, declineReward: true }, VAULT), false, "rechazar recompensas");
  assert.equal(allowedInWithdrawLane({ kind: "settings", account: VAULT, autoAssociations: null }, VAULT), false);
  assert.equal(allowedInWithdrawLane({ kind: "keyChange", account: VAULT }, VAULT), false);
  assert.equal(allowedInWithdrawLane({ kind: "other" }, VAULT), false);
  const s = summarizeAction({ kind: "staking", account: VAULT, nodeId: 3, declineReward: null }, { lang: "es" });
  assert.match(s.title, /nodo 3/);
  assert.equal(s.unusual, false);
  assert.match(summarizeAction({ kind: "staking", account: VAULT, nodeId: null, declineReward: null }, { lang: "es" }).title, /Desactivar/);
});

test("una dApp no puede mandar las recompensas de la Cartera a otra cuenta", () => {
  const me = "0.0.5005";
  const body = bodyOf(new AccountUpdateTransaction().setAccountId(me).setStakedAccountId("0.0.666"), me);
  assert.match(describeDappTransaction(body, { account: me, lang: "es" }).blocked, /recompensas/);
  const okBody = bodyOf(new AccountUpdateTransaction().setAccountId(me).setStakedNodeId(3), me);
  assert.equal(describeDappTransaction(okBody, { account: me, lang: "es" }).blocked, null);
});
