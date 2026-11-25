// Repaso de seguridad (21-nov-2026): huecos nuevos de Hedera y del cambio de móvil que no cubrían las pruebas de antes.
import test from "node:test";
import assert from "node:assert/strict";
import * as HieroProto from "@hiero-ledger/proto";
import { PrivateKey } from "@hiero-ledger/sdk";
import { allowedInWithdrawLane, checkMoveSchedule, describeScheduledBody, summarizeAction } from "../core/src/index.js";

const b64 = (body) => Buffer.from(HieroProto.proto.SchedulableTransactionBody.encode(body).finish()).toString("base64");
const VAULT = "0.0.5005";
const acct = (n) => ({ shardNum: 0, realmNum: 0, accountNum: n });

test("«ganchos» (HIP-1195) en la bóveda: por el carril del móvil se ven como raros y el guardián los bloquea", () => {
  // Un programa EVM pegado a la cuenta podría autorizar transferencias sin la firma de la bóveda: nunca por el carril
  // del móvil (el que tiene la cuenta atrás corta).
  const body = b64({ cryptoUpdateAccount: { accountIDToUpdate: acct(5005), hookCreationDetails: [{ hookId: 1, extensionPoint: 0 }] } });
  const action = describeScheduledBody(body);
  assert.equal(action.kind, "settings");
  assert.equal(allowedInWithdrawLane(action, VAULT), false, "el guardián lo veta");
  assert.equal(summarizeAction(action, { lane: "withdraw" }).unusual, true, "la app lo marca como raro");
  const del = describeScheduledBody(b64({ cryptoUpdateAccount: { accountIDToUpdate: acct(5005), hookIdsToDelete: [1] } }));
  assert.equal(allowedInWithdrawLane(del, VAULT), false);
});

test("cambio de llaves o ajustes raros por el carril del móvil: el guardián los bloquea", () => {
  const k = PrivateKey.generateECDSA().publicKey;
  for (const op of [
    { accountIDToUpdate: acct(5005), key: k._toProtobufKey() },
    { accountIDToUpdate: acct(5005), receiverSigRequiredWrapper: { value: true } },
    { accountIDToUpdate: acct(5005), maxAutomaticTokenAssociations: { value: 0 } },
    { accountIDToUpdate: acct(5005), stakedAccountId: acct(666) },
    { accountIDToUpdate: acct(5005), stakedNodeId: 3, declineReward: { value: true } },
  ]) {
    const a = describeScheduledBody(b64({ cryptoUpdateAccount: op }));
    assert.equal(allowedInWithdrawLane(a, VAULT), false, JSON.stringify(Object.keys(op)));
  }
  // Lo que sí pide la app: activar tokens y elegir nodo de staking.
  assert.equal(allowedInWithdrawLane(describeScheduledBody(b64({ cryptoUpdateAccount: { accountIDToUpdate: acct(5005), maxAutomaticTokenAssociations: { value: -1 } } })), VAULT), true);
  assert.equal(allowedInWithdrawLane(describeScheduledBody(b64({ cryptoUpdateAccount: { accountIDToUpdate: acct(5005), stakedNodeId: 3 } })), VAULT), true);
});

test("cambio de móvil: una petición con ganchos, comisiones personalizadas o memo interno no se ofrece nunca", () => {
  const k1 = PrivateKey.generateECDSA().publicKey;
  const k2 = PrivateKey.generateECDSA().publicKey;
  const rescue = PrivateKey.generateED25519().publicKey;
  const w = { vaultId: VAULT, notaryId: "0.0.5004", carteraId: "0.0.5001", carteraEvm: "0x", kitAccountId: "0.0.5002", carteraKey: k1, vaultDeviceKey: k1, rescueKey: rescue, withdrawDelay: 1, recoveryDelay: 1, tiebreaker: false, guardianEvm: "0x", kitBalance: 0n };
  const base = { id: "0.0.9", executed: false, deleted: false, expiresAt: Math.floor(Date.now() / 1000) + 600, payer: w.kitAccountId, creator: w.kitAccountId, memo: "", signers: [k2.toStringRaw(), rescue.toStringRaw()] };
  const update = { accountIDToUpdate: acct(5001), key: k2._toProtobufKey() };
  const good = checkMoveSchedule({ ...base, body: b64({ cryptoUpdateAccount: update }) }, w, Math.floor(Date.now() / 1000));
  assert.equal(good.ok, true);
  for (const [name, body] of [
    ["ganchos", { cryptoUpdateAccount: { ...update, hookCreationDetails: [{ hookId: 7, extensionPoint: 0 }] } }],
    ["comisiones personalizadas", { cryptoUpdateAccount: update, maxCustomFees: [{ accountId: acct(5002) }] }],
    ["memo interno", { cryptoUpdateAccount: update, memo: "x" }],
    ["comisión enorme", { cryptoUpdateAccount: update, transactionFee: 50_000_000_000 }],
  ]) {
    const r = checkMoveSchedule({ ...base, body: b64(body) }, w, Math.floor(Date.now() / 1000));
    assert.equal(r?.ok, false, name);
  }
  // Un cuerpo que no se puede leer, o que no es un cambio de llave, tampoco (se descarta o se ignora).
  for (const body of ["!!!", "", "AAAA", b64({ cryptoTransfer: {} })]) assert.notEqual(checkMoveSchedule({ ...base, body }, w, 0)?.ok, true, JSON.stringify(body));
});

test("cambio de móvil: una petición sin caducidad explícita (el mirror real la da como null) sí se ve; a los 30 min, no", async () => {
  const { expiryOf } = await import("../core/src/index.js");
  const now = Math.floor(Date.now() / 1000);
  assert.equal(expiryOf({ expiresAt: 0, createdAt: now - 60 }), now - 60 + 1800);
  assert.equal(expiryOf({ expiresAt: now + 3600, createdAt: now }), now + 3600);
  assert.ok(expiryOf({ expiresAt: 0 }) > now, "sin ninguna fecha, no se da por caducada");
  const k1 = PrivateKey.generateECDSA().publicKey;
  const k2 = PrivateKey.generateECDSA().publicKey;
  const rescue = PrivateKey.generateED25519().publicKey;
  const w = { vaultId: VAULT, notaryId: "0.0.5004", carteraId: "0.0.5001", carteraEvm: "0x", kitAccountId: "0.0.5002", carteraKey: k1, vaultDeviceKey: k1, rescueKey: rescue, withdrawDelay: 1, recoveryDelay: 1, tiebreaker: false, guardianEvm: "0x", kitBalance: 0n };
  const body = b64({ cryptoUpdateAccount: { accountIDToUpdate: acct(5001), key: k2._toProtobufKey() } });
  const s = { id: "0.0.9", executed: false, deleted: false, expiresAt: 0, payer: w.kitAccountId, creator: w.kitAccountId, memo: "", signers: [k2.toStringRaw(), rescue.toStringRaw()], body };
  assert.equal(checkMoveSchedule({ ...s, createdAt: now - 60 }, w, now)?.ok, true);
  assert.equal(checkMoveSchedule({ ...s, createdAt: now - 1900 }, w, now), null, "pasados 30 minutos ya no existe");
});
