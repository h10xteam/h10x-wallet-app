// Red de Hedera SIMULADA para pruebas sin conexión: un nodo (gRPC) y un mirror node (REST).
//
// Aplica las reglas de firma tal como están en el código del nodo de consenso (v0.78.2):
//   - una transacción directa nunca activa una clave ContractID;
//   - en una transacción programada, un ContractID se activa si ese contrato llamó a authorizeSchedule;
//   - con el bytecode en línea, constructorParameters se ignora;
//   - una transferencia a una dirección EVM sin cuenta crea una cuenta "hueca", que se completa cuando
//     paga su primera transacción firmada con la clave ECDSA de esa dirección (lo que hace el faucet);
//   - un contrato ve como msg.sender la dirección EVM de la cuenta (su alias si lo tiene).
//
// Sirve para comprobar que núcleo, guardián y contrato encajan. No demuestra nada sobre la red real.
import { createServer } from "node:http";
import * as grpc from "@grpc/grpc-js";
import * as HieroProto from "@hiero-ledger/proto";
import { PublicKey } from "@hiero-ledger/sdk";
import { HSS, LocalChain, mockAbi } from "../helpers/evm.mjs";

const { proto } = HieroProto;
const RC = proto.ResponseCodeEnum;
const COST_ANSWER = proto.ResponseType.COST_ANSWER;

const hex = (bytes) => Buffer.from(bytes ?? []).toString("hex");
const n = (v) => (v == null ? 0 : Number(v.toString()));
const longZero = (num) => `0x${num.toString(16).padStart(40, "0")}`;
const accountIdProto = (num) => ({ shardNum: 0, realmNum: 0, accountNum: num });
const txKey = (id) => `${n(id.accountID.accountNum)}@${n(id.transactionValidStart.seconds)}.${n(id.transactionValidStart.nanos)}`;
const QUERIES = new Set(["contractCallLocalMethod", "cryptoGetBalance", "contractGetBytecode", "getBySolidityID"]);
const isQuery = (method) => method.startsWith("get") || QUERIES.has(method);

/** Marcas de tiempo de consenso crecientes, "segundos.nanos". */
let lastNs = 0n;
function consensusTs() {
  let ns = BigInt(Date.now()) * 1_000_000n;
  if (ns <= lastNs) ns = lastNs + 1n;
  lastNs = ns;
  const s = ns / 1_000_000_000n;
  return { text: `${s}.${(ns % 1_000_000_000n).toString().padStart(9, "0")}`, seconds: Number(s), nanos: Number(ns % 1_000_000_000n) };
}

/**
 * @param {{ operatorNum: number, operatorKey: import("@hiero-ledger/sdk").PublicKey, grpcPort?: number, mirrorPort?: number }} opts
 */
export async function startFakeNetwork({ operatorNum, operatorKey, grpcPort = 50211, mirrorPort = 5551 }) {
  const chain = await LocalChain.create();
  const simChain = await LocalChain.create(); // para simular despliegues sin dejar rastro
  await chain.send(mockAbi, HSS, longZero(1), "setRc", [22n]);

  /** @type {Map<number, { key: any, balance: bigint, alias: string | null, memo: string, maxAuto?: number, autoUsed?: number, tokens?: Map<number, bigint> }>} */
  const accounts = new Map();
  /** @type {Map<number, { name: string, symbol: string, decimals: number, treasury: number, nft?: boolean, nextSerial?: number }>} */
  const tokens = new Map();
  /** @type {Map<string, { owner: number, metadata: string }>} "token:serie" → dueño y metadata (base64) */
  const nfts = new Map();
  const tokensOf = (num) => {
    const a = accounts.get(num);
    if (!a.tokens) a.tokens = new Map();
    return a.tokens;
  };
  /** @type {Map<string, number>} alias EVM (sin 0x) → cuenta */
  const byAlias = new Map();
  const contracts = new Map(); // num -> dirección EVM
  /** @type {Map<number, { contents: Buffer, deleted: boolean }>} archivos (servicio de archivos) */
  const files = new Map();
  const contractByAddress = new Map();
  const schedules = new Map();
  const results = new Map();
  /** @type {{ owner: number | null, spender: number | null, amount: bigint }[]} */
  const allowances = [];
  /** @type {{ contractNum: number, address: string, topics: string[], data: string, timestamp: string, index: number }[]} */
  const logs = [];
  let next = 9000;
  accounts.set(operatorNum, { key: operatorKey._toProtobufKey(), balance: 10_000n * 100_000_000n, alias: null, memo: "" });

  /** Programada tal como la devuelve el mirror (sola o en la lista). */
  const scheduleJson = (s) => ({
          schedule_id: `0.0.${s.id}`,
          consensus_timestamp: s.createdTs,
          creator_account_id: `0.0.${s.creator}`,
          payer_account_id: `0.0.${s.payer}`,
          executed_timestamp: s.executed ? s.executed.text : null,
          deleted: false,
          expiration_time: s.explicitExpiry ? tsOf(s.expirationTime) : null,
          transaction_body: s.bodyBase64,
          memo: s.memo,
          wait_for_expiry: false,
          signatures: [
            ...[...s.crypto].map((k) => ({ consensus_timestamp: s.createdTs, public_key_prefix: Buffer.from(k, "hex").toString("base64"), signature: "", type: k.length === 66 ? "ECDSA_SECP256K1" : "ED25519" })),
            ...[...s.contracts].map(() => ({ consensus_timestamp: s.createdTs, public_key_prefix: "", signature: "", type: "CONTRACT" })),
          ],
        });
  const senderAddress = (num) => {
    const a = accounts.get(num);
    return a?.alias ? `0x${a.alias}` : longZero(num);
  };

  /** Resuelve un AccountID del protobuf (número o alias EVM). Si es un alias nuevo y `create`, crea una cuenta hueca. */
  const resolve = (id, create = false) => {
    if (!id) return null;
    if (id.alias?.length === 20) {
      const alias = hex(id.alias);
      let num = byAlias.get(alias);
      if (num == null && create) {
        num = next++;
        // Como en la red real (HIP-904), las cuentas creadas por alias aceptan tokens sin límite.
        accounts.set(num, { key: null, balance: 0n, alias, memo: "lazy-created account", maxAuto: -1 });
        byAlias.set(alias, num);
      }
      return num ?? null;
    }
    const num = n(id.accountNum);
    return accounts.has(num) ? num : null;
  };

  // ---- reglas de firma ------------------------------------------------------------------------
  const satisfied = (key, crypto, contractSet) => {
    if (!key) return false;
    if (key.ed25519?.length) return crypto.has(hex(key.ed25519));
    if (key.ECDSASecp256k1?.length) return crypto.has(hex(key.ECDSASecp256k1));
    if (key.contractID) return contractSet.has(n(key.contractID.contractNum));
    if (key.keyList) return key.keyList.keys.length > 0 && key.keyList.keys.every((k) => satisfied(k, crypto, contractSet));
    if (key.thresholdKey) {
      const keys = key.thresholdKey.keys?.keys ?? [];
      const need = Math.max(1, Math.min(key.thresholdKey.threshold, keys.length));
      return keys.filter((k) => satisfied(k, crypto, contractSet)).length >= need;
    }
    return false;
  };
  const constituents = (key, out = new Set()) => {
    if (key?.ed25519?.length) out.add(hex(key.ed25519));
    if (key?.ECDSASecp256k1?.length) out.add(hex(key.ECDSASecp256k1));
    for (const k of key?.keyList?.keys ?? []) constituents(k, out);
    for (const k of key?.thresholdKey?.keys?.keys ?? []) constituents(k, out);
    return out;
  };
  /** Firmas válidas: clave en hex → PublicKey. */
  const verifiedSigners = (signed) => {
    const out = new Map();
    for (const pair of signed.sigMap?.sigPair ?? []) {
      const signature = pair.ed25519?.length ? pair.ed25519 : pair.ECDSASecp256k1;
      if (!signature?.length) continue;
      const key = PublicKey.fromBytes(pair.pubKeyPrefix);
      if (key.verify(signed.bodyBytes, signature)) out.set(hex(key.toBytesRaw()), key);
    }
    return out;
  };

  /** Claves que debe reunir una transacción, además de la del pagador. */
  const requiredKeys = (body) => {
    const keys = [];
    for (const aa of body.cryptoTransfer?.transfers?.accountAmounts ?? []) {
      if (n(aa.amount) < 0) keys.push(accounts.get(resolve(aa.accountID))?.key ?? null);
    }
    for (const list of body.cryptoTransfer?.tokenTransfers ?? []) {
      for (const aa of list.transfers ?? []) if (n(aa.amount) < 0) keys.push(accounts.get(resolve(aa.accountID))?.key ?? null);
      for (const nt of list.nftTransfers ?? []) keys.push(accounts.get(resolve(nt.senderAccountID))?.key ?? null);
    }
    if (body.tokenMint) keys.push(accounts.get(tokens.get(n(body.tokenMint.token?.tokenNum))?.treasury)?.key ?? null);
    if (body.tokenAssociate) keys.push(accounts.get(resolve(body.tokenAssociate.account))?.key ?? null);
    if (body.tokenCreation) keys.push(accounts.get(resolve(body.tokenCreation.treasury))?.key ?? null);
    if (body.cryptoUpdateAccount) {
      keys.push(accounts.get(resolve(body.cryptoUpdateAccount.accountIDToUpdate))?.key ?? null);
      if (body.cryptoUpdateAccount.key) keys.push(body.cryptoUpdateAccount.key);
    }
    if (body.cryptoDelete) keys.push(accounts.get(resolve(body.cryptoDelete.deleteAccountID))?.key ?? null);
    for (const al of body.cryptoApproveAllowance?.cryptoAllowances ?? []) keys.push(accounts.get(resolve(al.owner))?.key ?? null);
    return keys;
  };

  /** Comisiones propias de un token: solo las fijas en HBAR (las que cobran al que envía). */
  const feesOf = (list) =>
    (list ?? []).filter((f) => f.fixedFee && !f.fixedFee.denominatingTokenId).map((f) => ({ amount: BigInt(n(f.fixedFee.amount)), collector: resolve(f.feeCollectorAccountId) }));

  const apply = (body) => {
    if (body.tokenFeeScheduleUpdate) {
      const token = tokens.get(n(body.tokenFeeScheduleUpdate.tokenId?.tokenNum));
      if (!token) return RC.INVALID_TOKEN_ID;
      token.fees = feesOf(body.tokenFeeScheduleUpdate.customFees);
      return RC.SUCCESS;
    }
    if (body.cryptoTransfer) {
      const moves = (body.cryptoTransfer.transfers?.accountAmounts ?? []).map((aa) => ({ num: resolve(aa.accountID, n(aa.amount) > 0), amount: BigInt(n(aa.amount)) }));
      for (const m of moves) {
        if (m.num == null) return RC.INVALID_ACCOUNT_ID;
        if (accounts.get(m.num).balance + m.amount < 0n) return RC.INSUFFICIENT_ACCOUNT_BALANCE;
      }
      // Tokens: se valida todo antes de mover nada (la transferencia es atómica).
      const tokenMoves = [];
      const nftMoves = [];
      const newAssoc = new Map(); // cuenta → nº de asociaciones automáticas nuevas
      for (const list of body.cryptoTransfer.tokenTransfers ?? []) {
        const tokenNum = n(list.token?.tokenNum);
        const token = tokens.get(tokenNum);
        if (!token) return RC.INVALID_TOKEN_ID;
        if (list.expectedDecimals != null && n(list.expectedDecimals.value) !== token.decimals) return RC.UNEXPECTED_TOKEN_DECIMALS;
        for (const aa of list.transfers ?? []) {
          const amount = BigInt(n(aa.amount));
          const num = resolve(aa.accountID, amount > 0n);
          if (num == null) return RC.INVALID_ACCOUNT_ID;
          const held = tokensOf(num);
          if (!held.has(tokenNum)) {
            if (amount < 0n) return RC.TOKEN_NOT_ASSOCIATED_TO_ACCOUNT;
            const a = accounts.get(num);
            const used = (a.autoUsed ?? 0) + (newAssoc.get(num) ?? 0);
            if (!(a.maxAuto === -1 || used < (a.maxAuto ?? 0))) return RC.TOKEN_NOT_ASSOCIATED_TO_ACCOUNT;
            newAssoc.set(num, (newAssoc.get(num) ?? 0) + 1);
          }
          if ((held.get(tokenNum) ?? 0n) + amount < 0n) return RC.INSUFFICIENT_TOKEN_BALANCE;
          tokenMoves.push({ num, tokenNum, amount });
        }
        for (const nt of list.nftTransfers ?? []) {
          if (!token.nft) return RC.ACCOUNT_AMOUNT_TRANSFERS_ONLY_ALLOWED_FOR_FUNGIBLE_COMMON;
          const serial = n(nt.serialNumber);
          const item = nfts.get(`${tokenNum}:${serial}`);
          const from = resolve(nt.senderAccountID);
          const to = resolve(nt.receiverAccountID, true);
          if (from == null || to == null) return RC.INVALID_ACCOUNT_ID;
          if (!item) return RC.INVALID_NFT_ID;
          if (item.owner !== from) return RC.SENDER_DOES_NOT_OWN_NFT_SERIAL_NO;
          if (!tokensOf(to).has(tokenNum) && !newAssoc.has(`${to}:${tokenNum}`)) {
            const a = accounts.get(to);
            const used = (a.autoUsed ?? 0) + (newAssoc.get(to) ?? 0);
            if (!(a.maxAuto === -1 || used < (a.maxAuto ?? 0))) return RC.TOKEN_NOT_ASSOCIATED_TO_ACCOUNT;
            newAssoc.set(to, (newAssoc.get(to) ?? 0) + 1);
            newAssoc.set(`${to}:${tokenNum}`, 1);
          }
          tokenMoves.push({ num: from, tokenNum, amount: -1n });
          tokenMoves.push({ num: to, tokenNum, amount: 1n });
          nftMoves.push({ key: `${tokenNum}:${serial}`, to });
        }
      }
      // Comisiones fijas en HBAR de cada token: las paga quien lo envía (salvo la tesorería y quien cobra).
      const feeMoves = [];
      for (const list of body.cryptoTransfer.tokenTransfers ?? []) {
        const token = tokens.get(n(list.token?.tokenNum));
        for (const fee of token?.fees ?? []) {
          const senders = new Set([...(list.transfers ?? []).filter((aa) => n(aa.amount) < 0).map((aa) => resolve(aa.accountID)), ...(list.nftTransfers ?? []).map((nt) => resolve(nt.senderAccountID))]);
          for (const from of senders) {
            if (from === token.treasury || from === fee.collector) continue;
            feeMoves.push({ num: from, amount: -fee.amount }, { num: fee.collector, amount: fee.amount });
          }
        }
      }
      const after = new Map();
      for (const m of [...moves, ...feeMoves]) after.set(m.num, (after.get(m.num) ?? accounts.get(m.num).balance) + m.amount);
      for (const [num, bal] of after) if (bal < 0n) return feeMoves.some((f) => f.num === num) ? RC.INSUFFICIENT_SENDER_ACCOUNT_BALANCE_FOR_CUSTOM_FEE : RC.INSUFFICIENT_ACCOUNT_BALANCE;
      for (const m of [...moves, ...feeMoves]) accounts.get(m.num).balance += m.amount;
      for (const [num, k] of newAssoc) if (typeof num === "number") accounts.get(num).autoUsed = (accounts.get(num).autoUsed ?? 0) + k;
      for (const t of tokenMoves) tokensOf(t.num).set(t.tokenNum, (tokensOf(t.num).get(t.tokenNum) ?? 0n) + t.amount);
      for (const m of nftMoves) nfts.get(m.key).owner = m.to;
      return RC.SUCCESS;
    }
    if (body.cryptoUpdateAccount) {
      const account = accounts.get(resolve(body.cryptoUpdateAccount.accountIDToUpdate));
      if (!account) return RC.INVALID_ACCOUNT_ID;
      if (body.cryptoUpdateAccount.key) account.key = body.cryptoUpdateAccount.key;
      if (body.cryptoUpdateAccount.maxAutomaticTokenAssociations) account.maxAuto = n(body.cryptoUpdateAccount.maxAutomaticTokenAssociations.value);
      if (body.cryptoUpdateAccount.stakedNodeId != null) {
        const node = n(body.cryptoUpdateAccount.stakedNodeId);
        account.stakedNode = node >= 0 ? node : null;
        account.stakedAccount = null;
      }
      if (body.cryptoUpdateAccount.stakedAccountId) {
        account.stakedAccount = resolve(body.cryptoUpdateAccount.stakedAccountId);
        account.stakedNode = null;
      }
      if (body.cryptoUpdateAccount.declineReward) account.declineReward = Boolean(body.cryptoUpdateAccount.declineReward.value);
      return RC.SUCCESS;
    }
    if (body.tokenAssociate) {
      const num = resolve(body.tokenAssociate.account);
      if (num == null) return RC.INVALID_ACCOUNT_ID;
      for (const t of body.tokenAssociate.tokens ?? []) {
        const tokenNum = n(t.tokenNum);
        if (!tokens.has(tokenNum)) return RC.INVALID_TOKEN_ID;
        if (tokensOf(num).has(tokenNum)) return RC.TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT;
      }
      for (const t of body.tokenAssociate.tokens ?? []) tokensOf(num).set(n(t.tokenNum), 0n);
      return RC.SUCCESS;
    }
    if (body.cryptoDelete) {
      const from = resolve(body.cryptoDelete.deleteAccountID);
      const to = resolve(body.cryptoDelete.transferAccountID);
      if (from == null || to == null) return RC.INVALID_ACCOUNT_ID;
      accounts.get(to).balance += accounts.get(from).balance;
      accounts.delete(from);
      return RC.SUCCESS;
    }
    if (body.cryptoApproveAllowance) {
      for (const al of body.cryptoApproveAllowance.cryptoAllowances ?? []) allowances.push({ owner: resolve(al.owner), spender: resolve(al.spender), amount: BigInt(n(al.amount)) });
      return RC.SUCCESS;
    }
    return RC.NOT_SUPPORTED;
  };

  const tryExecute = (s) => {
    if (s.executed) return;
    const keys = [accounts.get(s.payer)?.key, ...requiredKeys(s.body)];
    if (keys.every((k) => satisfied(k, s.crypto, s.contracts))) {
      apply(s.body);
      s.executed = consensusTs();
    }
  };
  const hssCalls = async () => (await chain.read(mockAbi, HSS, "calls"))[0];

  const recordLogs = (contractNum, resLogs, ts) => {
    resLogs.forEach(([address, topics, data], index) => {
      logs.push({ contractNum, address: `0x${hex(address)}`, topics: topics.map((t) => `0x${hex(t)}`), data: `0x${hex(data)}`, timestamp: ts.text, index });
    });
  };

  const handle = async (body, signers, payer) => {
    chain.now = BigInt(Math.floor(Date.now() / 1000));
    const ts = consensusTs();
    const signerHex = new Set(signers.keys());

    if (body.cryptoCreateAccount) {
      const op = body.cryptoCreateAccount;
      const balance = BigInt(n(op.initialBalance));
      if (accounts.get(payer).balance < balance) return { status: RC.INSUFFICIENT_PAYER_BALANCE };
      const num = next++;
      const alias = op.alias?.length === 20 ? hex(op.alias) : null;
      accounts.get(payer).balance -= balance;
      const stakedNode = op.stakedNodeId != null && n(op.stakedNodeId) >= 0 ? n(op.stakedNodeId) : null;
      accounts.set(num, { key: op.key, balance, alias, memo: op.memo ?? "", maxAuto: n(op.maxAutomaticTokenAssociations), autoUsed: 0, stakedNode, stakedAccount: null, declineReward: Boolean(op.declineReward) });
      if (alias) byAlias.set(alias, num);
      return { status: RC.SUCCESS, accountID: accountIdProto(num) };
    }

    if (body.tokenCreation) {
      const op = body.tokenCreation;
      const treasury = resolve(op.treasury);
      if (treasury == null) return { status: RC.INVALID_TREASURY_ACCOUNT_FOR_TOKEN };
      if (!requiredKeys(body).every((k) => satisfied(k, signerHex, new Set()))) return { status: RC.INVALID_SIGNATURE };
      const num = next++;
      const nft = n(op.tokenType) === 1;
      tokens.set(num, {
        name: op.name ?? "",
        symbol: op.symbol ?? "",
        decimals: n(op.decimals),
        treasury,
        nft,
        nextSerial: 1,
        fees: feesOf(op.customFees),
        keys: { admin: !!op.adminKey, freeze: !!op.freezeKey, wipe: !!op.wipeKey, pause: !!op.pauseKey, kyc: !!op.kycKey, feeSchedule: !!op.feeScheduleKey, supply: !!op.supplyKey },
      });
      tokensOf(treasury).set(num, nft ? 0n : BigInt(n(op.initialSupply)));
      return { status: RC.SUCCESS, tokenID: { shardNum: 0, realmNum: 0, tokenNum: num } };
    }

    if (body.tokenMint) {
      const tokenNum = n(body.tokenMint.token?.tokenNum);
      const token = tokens.get(tokenNum);
      if (!token) return { status: RC.INVALID_TOKEN_ID };
      if (!requiredKeys(body).every((k) => satisfied(k, signerHex, new Set()))) return { status: RC.INVALID_SIGNATURE };
      if (!token.nft) {
        tokensOf(token.treasury).set(tokenNum, (tokensOf(token.treasury).get(tokenNum) ?? 0n) + BigInt(n(body.tokenMint.amount)));
        return { status: RC.SUCCESS };
      }
      const serials = [];
      for (const meta of body.tokenMint.metadata ?? []) {
        const serial = token.nextSerial++;
        nfts.set(`${tokenNum}:${serial}`, { owner: token.treasury, metadata: Buffer.from(meta).toString("base64") });
        serials.push(serial);
      }
      tokensOf(token.treasury).set(tokenNum, (tokensOf(token.treasury).get(tokenNum) ?? 0n) + BigInt(serials.length));
      return { status: RC.SUCCESS, serialNumbers: serials };
    }

    // Servicio de archivos: como en Hedera, sirve para crear contratos cuyo código no cabe en una transacción.
    if (body.fileCreate) {
      const num = next++;
      files.set(num, { contents: Buffer.from(body.fileCreate.contents ?? []), deleted: false });
      return { status: RC.SUCCESS, fileID: { shardNum: 0, realmNum: 0, fileNum: num } };
    }
    if (body.fileAppend) {
      const f = files.get(n(body.fileAppend.fileID?.fileNum));
      if (!f) return { status: RC.INVALID_FILE_ID };
      if (f.deleted) return { status: RC.FILE_DELETED };
      f.contents = Buffer.concat([f.contents, Buffer.from(body.fileAppend.contents ?? [])]);
      return { status: RC.SUCCESS };
    }
    if (body.fileDelete) {
      const f = files.get(n(body.fileDelete.fileID?.fileNum));
      if (!f) return { status: RC.INVALID_FILE_ID };
      f.deleted = true;
      return { status: RC.SUCCESS };
    }

    if (body.contractCreateInstance) {
      const op = body.contractCreateInstance;
      let initcode;
      if (op.initcode?.length) {
        // Como el nodo real: con initcode en línea, constructorParameters se ignora.
        initcode = hex(op.initcode);
      } else if (op.fileID) {
        // Desde un archivo: el código va en hexadecimal (texto) y se le añaden los parámetros del constructor.
        const f = files.get(n(op.fileID.fileNum));
        if (!f || f.deleted) return { status: RC.INVALID_FILE_ID };
        const text = f.contents.toString("utf8");
        if (!/^(0x)?[0-9a-fA-F]*$/.test(text) || text.replace(/^0x/, "").length % 2) return { status: RC.ERROR_DECODING_BYTESTRING };
        initcode = text.replace(/^0x/, "") + hex(op.constructorParameters ?? []);
      } else return { status: RC.NOT_SUPPORTED };
      // Como en Hedera, un contrato creado con ContractCreate vive en la long-zero de su ContractID
      // (es lo que ve como `address(this)`).
      const num = next;
      const res = await chain.deployAt({ from: senderAddress(payer), at: longZero(num), data: `0x${initcode}` });
      if (!res.ok) return { status: RC.CONTRACT_REVERT_EXECUTED };
      next++;
      contracts.set(num, longZero(num));
      contractByAddress.set(longZero(num), num);
      recordLogs(num, res.logs, ts);
      return { status: RC.SUCCESS, contractID: { shardNum: 0, realmNum: 0, contractNum: num } };
    }

    if (body.contractDeleteInstance || body.contractUpdateInstance) {
      // Los contratos se despliegan sin llave de administración: nadie puede borrarlos ni cambiarlos.
      return { status: RC.MODIFYING_IMMUTABLE_CONTRACT };
    }

    if (body.contractCall && n(body.contractCall.contractID.contractNum) === 363) {
      // Una CUENTA (no un contrato) llama al Schedule Service: como en el nodo real, lo único que
      // aporta son las firmas con las que ha firmado esta llamada (HssCallAttempt.getKeysForEOASender).
      const data = hex(body.contractCall.functionParameters);
      const s = schedules.get(Number(BigInt(`0x${data.slice(8, 72) || "0"}`)));
      let rc = RC.INVALID_SCHEDULE_ID;
      if (s && !s.executed) {
        const wanted = new Set([...constituents(accounts.get(s.payer)?.key), ...requiredKeys(s.body).flatMap((k) => [...constituents(k)])]);
        const fresh = [...signerHex].filter((k) => wanted.has(k) && !s.crypto.has(k));
        for (const k of fresh) s.crypto.add(k);
        rc = fresh.length ? RC.SUCCESS : RC.NO_NEW_VALID_SIGNATURES;
        tryExecute(s);
      }
      return {
        status: RC.SUCCESS,
        contract: { contractID: body.contractCall.contractID, contractCallResult: Buffer.from(rc.toString(16).padStart(64, "0"), "hex"), errorMessage: "", gasUsed: 30_000 },
      };
    }

    if (body.contractCall) {
      const num = n(body.contractCall.contractID.contractNum);
      if (!contracts.has(num)) return { status: RC.INVALID_CONTRACT_ID };
      const before = await hssCalls();
      const res = await chain.raw({ from: senderAddress(payer), to: contracts.get(num), data: `0x${hex(body.contractCall.functionParameters)}` });
      if (res.ok) {
        recordLogs(num, res.logs, ts);
        if ((await hssCalls()) > before) {
          const scheduleNum = Number(BigInt((await chain.read(mockAbi, HSS, "lastSchedule"))[0]));
          const caller = contractByAddress.get((await chain.read(mockAbi, HSS, "lastCaller"))[0].toLowerCase());
          const s = schedules.get(scheduleNum);
          if (s && caller != null && !s.executed) {
            s.contracts.add(caller);
            tryExecute(s);
          }
        }
      }
      return {
        status: res.ok ? RC.SUCCESS : RC.CONTRACT_REVERT_EXECUTED,
        contract: {
          contractID: body.contractCall.contractID,
          contractCallResult: Buffer.from(res.returnData.slice(2), "hex"),
          errorMessage: res.ok ? "" : res.returnData,
          gasUsed: Number(res.gasUsed) + 21_000,
        },
      };
    }

    if (body.tokenFeeScheduleUpdate) {
      const token = tokens.get(n(body.tokenFeeScheduleUpdate.tokenId?.tokenNum));
      if (!token || !satisfied(accounts.get(token.treasury)?.key, signerHex, new Set())) return { status: RC.INVALID_SIGNATURE };
      return { status: apply(body) };
    }
    if (body.cryptoTransfer || body.cryptoUpdateAccount || body.cryptoDelete || body.cryptoApproveAllowance || body.tokenAssociate) {
      if (!requiredKeys(body).every((k) => satisfied(k, signerHex, new Set()))) return { status: RC.INVALID_SIGNATURE };
      return { status: apply(body) };
    }

    if (body.scheduleCreate) {
      const op = body.scheduleCreate;
      const num = next++;
      const s = {
        id: num,
        creator: payer,
        payer: op.payerAccountID ? resolve(op.payerAccountID) : payer,
        body: op.scheduledTransactionBody,
        bodyBase64: Buffer.from(proto.SchedulableTransactionBody.encode(op.scheduledTransactionBody).finish()).toString("base64"),
        memo: op.memo ?? "",
        expirationTime: op.expirationTime ?? { seconds: Math.floor(Date.now() / 1000) + 1800, nanos: 0 },
        // Como el mirror real: sin caducidad explícita, expiration_time sale null.
        explicitExpiry: !!op.expirationTime,
        crypto: new Set(),
        contracts: new Set(),
        executed: null,
        createdTs: ts.text,
      };
      const wanted = new Set([...constituents(accounts.get(s.payer)?.key), ...requiredKeys(s.body).flatMap((k) => [...constituents(k)])]);
      for (const signer of signerHex) if (wanted.has(signer)) s.crypto.add(signer);
      schedules.set(num, s);
      tryExecute(s);
      return { status: RC.SUCCESS, scheduleID: { shardNum: 0, realmNum: 0, scheduleNum: num } };
    }

    if (body.scheduleSign) {
      const s = schedules.get(n(body.scheduleSign.scheduleID.scheduleNum));
      if (!s) return { status: RC.INVALID_SCHEDULE_ID };
      if (s.executed) return { status: RC.SCHEDULE_ALREADY_EXECUTED };
      const wanted = new Set([...constituents(accounts.get(s.payer)?.key), ...requiredKeys(s.body).flatMap((k) => [...constituents(k)])]);
      const fresh = [...signerHex].filter((k) => wanted.has(k) && !s.crypto.has(k));
      if (fresh.length === 0) return { status: RC.NO_NEW_VALID_SIGNATURES };
      for (const k of fresh) s.crypto.add(k);
      tryExecute(s);
      return { status: RC.SUCCESS };
    }

    return { status: RC.NOT_SUPPORTED };
  };

  // ---- gRPC --------------------------------------------------------------------------------------
  const onTransaction = async (buffer) => {
    const tx = proto.Transaction.decode(buffer);
    const signed = proto.SignedTransaction.decode(tx.signedTransactionBytes);
    const body = proto.TransactionBody.decode(signed.bodyBytes);
    const payer = n(body.transactionID.accountID.accountNum);
    const signers = verifiedSigners(signed);
    const account = accounts.get(payer);
    let code = RC.OK;
    // Como el nodo real: ninguna transacción firmada puede pasar de 6 KB.
    if (buffer.length > 6144) return proto.TransactionResponse.encode({ nodeTransactionPrecheckCode: RC.TRANSACTION_OVERSIZE, cost: 0 }).finish();
    if (account && account.key == null && account.alias) {
      // Cuenta hueca: se completa si firma la clave ECDSA de su dirección.
      const match = [...signers.values()].find((k) => k.type === "secp256k1" && k.toEvmAddress().toLowerCase() === account.alias);
      if (match) account.key = match._toProtobufKey();
    }
    if (!account || !satisfied(account.key, new Set(signers.keys()), new Set())) code = RC.INVALID_SIGNATURE;
    else if (account.balance < 1_000_000n) code = RC.INSUFFICIENT_PAYER_BALANCE;
    else {
      account.balance -= 100_000n; // comisión simbólica
      results.set(txKey(body.transactionID), await handle(body, signers, payer));
    }
    return proto.TransactionResponse.encode({ nodeTransactionPrecheckCode: code, cost: 0 }).finish();
  };

  const receiptOf = (result) => ({
    status: result?.status ?? RC.RECEIPT_NOT_FOUND,
    accountID: result?.accountID,
    contractID: result?.contractID,
    scheduleID: result?.scheduleID,
    tokenID: result?.tokenID,
    fileID: result?.fileID,
    serialNumbers: result?.serialNumbers ?? [],
    exchangeRate: {
      currentRate: { hbarEquiv: 30000, centEquiv: 196447, expirationTime: { seconds: 4_000_000_000 } },
      nextRate: { hbarEquiv: 30000, centEquiv: 196447, expirationTime: { seconds: 4_000_000_000 } },
    },
  });

  const onQuery = async (buffer) => {
    const query = proto.Query.decode(buffer);
    const name = /** @type {string} */ (query.query);
    const q = query[name];
    const header = { nodeTransactionPrecheckCode: RC.OK, responseType: q.header?.responseType ?? 0, cost: 100_000 };
    const reply = (content) => proto.Response.encode({ [name]: { header, ...content } }).finish();
    if (name === "cryptogetAccountBalance") {
      const num = resolve(q.accountID);
      return reply({ accountID: q.accountID, balance: Number(num != null ? accounts.get(num).balance : 0n) });
    }
    if (header.responseType === COST_ANSWER) return reply({});
    if (name === "transactionGetReceipt") return reply({ receipt: receiptOf(results.get(txKey(q.transactionID))) });
    if (name === "transactionGetRecord") {
      const result = results.get(txKey(q.transactionID));
      const ts = consensusTs();
      return reply({
        transactionRecord: {
          receipt: receiptOf(result),
          transactionHash: Buffer.alloc(48),
          consensusTimestamp: { seconds: ts.seconds, nanos: ts.nanos },
          transactionID: q.transactionID,
          memo: "",
          transactionFee: 100_000,
          transferList: { accountAmounts: [] },
          contractCallResult: result?.contract ? { ...result.contract, bloom: Buffer.alloc(256), logInfo: [], createdContractIDs: [] } : undefined,
        },
      });
    }
    return proto.Response.encode({ [name]: { header: { ...header, nodeTransactionPrecheckCode: RC.NOT_SUPPORTED } } }).finish();
  };

  const server = new grpc.Server();
  for (const service of ["CryptoService", "SmartContractService", "ScheduleService", "NetworkService", "FileService", "TokenService"]) {
    for (const method of Object.getOwnPropertyNames(proto[service].prototype)) {
      if (method === "constructor") continue;
      const work = isQuery(method) ? onQuery : onTransaction;
      server.register(
        `/proto.${service}/${method}`,
        (call, callback) => {
          work(call.request).then(
            (out) => callback(null, Buffer.from(out)),
            (err) => callback({ code: grpc.status.INTERNAL, message: String(err?.stack ?? err) }),
          );
        },
        (v) => v,
        (v) => v,
        "unary",
      );
    }
  }
  await new Promise((ok, ko) => server.bindAsync(`127.0.0.1:${grpcPort}`, grpc.ServerCredentials.createInsecure(), (e) => (e ? ko(e) : ok(undefined))));

  // ---- mirror node (REST) --------------------------------------------------------------------------
  const mirrorKey = (key) => {
    if (!key) return null;
    if (key.ed25519?.length) return { _type: "ED25519", key: hex(key.ed25519) };
    if (key.ECDSASecp256k1?.length) return { _type: "ECDSA_SECP256K1", key: hex(key.ECDSASecp256k1) };
    return { _type: "ProtobufEncoded", key: hex(proto.Key.encode(key).finish()) };
  };
  const tsOf = (t) => `${n(t.seconds)}.${String(n(t.nanos)).padStart(9, "0")}`;

  const mirror = createServer(async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    try {
      const url = new URL(req.url ?? "/", "http://x");
      const p = url.pathname;
      let m;
      if (req.method === "GET" && p === "/api/v1/accounts") {
        const wanted = (url.searchParams.get("account.publickey") ?? "").toLowerCase();
        const list = [...accounts.entries()]
          .filter(([, a]) => wanted && (hex(a.key?.ed25519) === wanted || hex(a.key?.ECDSASecp256k1) === wanted))
          .map(([num, a]) => ({ account: `0.0.${num}`, evm_address: senderAddress(num), balance: { balance: Number(a.balance) }, key: mirrorKey(a.key), deleted: false }));
        return send(200, { accounts: list, links: { next: null } });
      }
      if (req.method === "GET" && (m = /^\/api\/v1\/accounts\/([^/]+)$/.exec(p))) {
        const id = m[1];
        const num = id.startsWith("0x") ? byAlias.get(id.slice(2).toLowerCase()) : Number(id.split(".")[2]);
        const a = num != null ? accounts.get(num) : null;
        if (!a) return send(404, { _status: { messages: [{ message: "Not found" }] } });
        return send(200, {
          account: `0.0.${num}`,
          evm_address: senderAddress(num),
          balance: { balance: Number(a.balance) },
          key: mirrorKey(a.key),
          memo: a.memo,
          max_automatic_token_associations: a.maxAuto ?? 0,
          staked_node_id: a.stakedNode ?? null,
          staked_account_id: a.stakedAccount != null ? `0.0.${a.stakedAccount}` : null,
          decline_reward: Boolean(a.declineReward),
          // Simulación: una cuenta en staking tiene 0,5 HBAR pendientes por cada 100 HBAR.
          pending_reward: a.stakedNode != null && !a.declineReward ? Number(a.balance / 200n) : 0,
        });
      }
      if (req.method === "GET" && p === "/api/v1/network/nodes") {
        // Tres nodos de prueba: el 4 paga más pero está lleno.
        const node = (id, rate, rewarded, max, description) => ({ node_id: id, node_account_id: `0.0.${id + 3}`, description, stake: rewarded, stake_rewarded: rewarded, max_stake: max, reward_rate_start: rate });
        return send(200, { nodes: [node(3, 5000, 10, 100, "Hosted by Prueba A"), node(4, 9000, 100, 100, "Hosted by Prueba B"), node(5, 5000, 5, 100, "Hosted by Prueba C")], links: { next: null } });
      }
      if (req.method === "GET" && (m = /^\/api\/v1\/accounts\/([^/]+)\/rewards$/.exec(p))) {
        const num = Number(m[1].split(".")[2]);
        const a = accounts.get(num);
        if (!a) return send(404, { _status: { messages: [{ message: "Not found" }] } });
        const rewards = a.stakedNode != null ? [{ account_id: `0.0.${num}`, amount: 1234, timestamp: "1.000000001" }, { account_id: `0.0.${num}`, amount: 766, timestamp: "2.000000001" }] : [];
        return send(200, { rewards, links: { next: null } });
      }
      if (req.method === "GET" && (m = /^\/api\/v1\/accounts\/([^/]+)\/tokens$/.exec(p))) {
        const id = m[1];
        const num = id.startsWith("0x") ? byAlias.get(id.slice(2).toLowerCase()) : Number(id.split(".")[2]);
        if (num == null || !accounts.has(num)) return send(404, { _status: { messages: [{ message: "Not found" }] } });
        const list = [...tokensOf(num).entries()].map(([t, bal]) => ({ token_id: `0.0.${t}`, balance: Number(bal), decimals: tokens.get(t)?.decimals ?? 0, automatic_association: false }));
        return send(200, { tokens: list, links: { next: null } });
      }
      if (req.method === "GET" && (m = /^\/api\/v1\/tokens\/0\.0\.(\d+)$/.exec(p))) {
        const t = tokens.get(Number(m[1]));
        if (!t) return send(404, { _status: { messages: [{ message: "Not found" }] } });
        const key = (on) => (on ? { _type: "ED25519", key: "aa".repeat(32) } : null);
        return send(200, {
          token_id: `0.0.${m[1]}`,
          name: t.name,
          symbol: t.symbol,
          decimals: String(t.decimals),
          type: t.nft ? "NON_FUNGIBLE_UNIQUE" : "FUNGIBLE_COMMON",
          treasury_account_id: `0.0.${t.treasury}`,
          admin_key: key(t.keys?.admin),
          freeze_key: key(t.keys?.freeze),
          wipe_key: key(t.keys?.wipe),
          pause_key: key(t.keys?.pause),
          kyc_key: key(t.keys?.kyc),
          fee_schedule_key: key(t.keys?.feeSchedule),
          supply_key: key(t.keys?.supply),
          custom_fees: { fixed_fees: (t.fees ?? []).map((f) => ({ amount: Number(f.amount), collector_account_id: `0.0.${f.collector}`, denominating_token_id: null })), fractional_fees: [], royalty_fees: [] },
        });
      }
      if (req.method === "GET" && (m = /^\/api\/v1\/accounts\/([^/]+)\/nfts$/.exec(p))) {
        const id = m[1];
        const num = id.startsWith("0x") ? byAlias.get(id.slice(2).toLowerCase()) : Number(id.split(".")[2]);
        if (num == null || !accounts.has(num)) return send(404, { _status: { messages: [{ message: "Not found" }] } });
        const list = [...nfts.entries()]
          .filter(([, v]) => v.owner === num)
          .map(([k, v]) => {
            const [t, serial] = k.split(":");
            return { account_id: `0.0.${num}`, token_id: `0.0.${t}`, serial_number: Number(serial), metadata: v.metadata, deleted: false };
          });
        return send(200, { nfts: list, links: { next: null } });
      }
      if (req.method === "GET" && (m = /^\/api\/v1\/contracts\/0\.0\.(\d+)\/results\/logs$/.exec(p))) {
        const num = Number(m[1]);
        const after = (url.searchParams.get("timestamp") ?? "").replace(/^gt:/, "");
        const toNs = (t) => {
          const [sec, frac = ""] = t.split(".");
          return BigInt(sec) * 1_000_000_000n + BigInt((frac + "000000000").slice(0, 9));
        };
        const asc = logs.filter((l) => l.contractNum === num && (!after || toNs(l.timestamp) > toNs(after)));
        const list = url.searchParams.get("order") === "desc" ? [...asc].reverse() : asc;
        return send(200, { logs: list.map((l) => ({ address: l.address, topics: l.topics, data: l.data, timestamp: l.timestamp, index: l.index, contract_id: `0.0.${num}` })), links: { next: null } });
      }
      if (req.method === "GET" && (m = /^\/api\/v1\/contracts\/0\.0\.(\d+)$/.exec(p))) {
        const num = Number(m[1]);
        if (!contracts.has(num)) return send(404, { _status: { messages: [{ message: "Not found" }] } });
        return send(200, { contract_id: `0.0.${num}`, evm_address: longZero(num), admin_key: null, deleted: false });
      }
      if (req.method === "GET" && p === "/api/v1/schedules") {
        // Como el mirror real: account.id filtra por la cuenta que la creó.
        const who = url.searchParams.get("account.id");
        const num = who ? Number(who.split(".")[2]) : null;
        const limit = Math.min(100, Number(url.searchParams.get("limit") ?? 25));
        const desc = (url.searchParams.get("order") ?? "asc") === "desc";
        let list = [...schedules.values()].filter((s) => num == null || s.creator === num);
        list.sort((a, b) => (desc ? b.id - a.id : a.id - b.id));
        list = list.slice(0, limit);
        return send(200, { schedules: list.map(scheduleJson), links: { next: null } });
      }
      if (req.method === "GET" && (m = /^\/api\/v1\/schedules\/0\.0\.(\d+)$/.exec(p))) {
        const s = schedules.get(Number(m[1]));
        if (!s) return send(404, { _status: { messages: [{ message: "Not found" }] } });
        return send(200, scheduleJson(s));
      }
      if (req.method === "POST" && p === "/api/v1/contracts/call") {
        let raw = "";
        for await (const c of req) raw += c;
        const body = JSON.parse(raw || "{}");
        const from = body.from ?? longZero(2);
        if (!body.to) {
          const r = await simChain.raw({ from, data: body.data });
          return r.ok ? send(200, { result: r.returnData }) : send(400, { _status: { messages: [{ message: "CONTRACT_REVERT_EXECUTED", data: r.returnData }] } });
        }
        const target = String(body.to).toLowerCase();
        const num = contractByAddress.get(target);
        chain.now = BigInt(Math.floor(Date.now() / 1000));
        const r = await chain.raw({ from, to: num != null ? contracts.get(num) : target, data: body.data, isStatic: true });
        return r.ok ? send(200, { result: r.returnData }) : send(400, { _status: { messages: [{ message: "CONTRACT_REVERT_EXECUTED", data: r.returnData }] } });
      }
      send(404, { _status: { messages: [{ message: "Not found" }] } });
    } catch (e) {
      send(500, { _status: { messages: [{ message: String(e) }] } });
    }
  });
  await new Promise((ok) => mirror.listen(mirrorPort, "127.0.0.1", () => ok(undefined)));

  return {
    accounts,
    schedules,
    tokens,
    nfts,
    balanceOf: (num) => accounts.get(num)?.balance ?? 0n,
    tokenBalanceOf: (num, tokenNum) => accounts.get(num)?.tokens?.get(tokenNum) ?? null,
    stop: () => {
      server.forceShutdown();
      mirror.close();
    },
  };
}
