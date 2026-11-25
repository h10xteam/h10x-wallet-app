// @ts-check
// Consultas gratuitas al mirror node (REST). Funciona igual en Node y en React Native.
import { AccountId, Key, PublicKey } from "@hiero-ledger/sdk";
import * as HieroProto from "@hiero-ledger/proto";
import { decodeBase64, getBytes, hexlify } from "ethers";
import { decodeNotaryLog } from "./notary.js";

/**
 * @typedef {{ id: AccountId, evmAddress: string, balance: bigint, key: Key | null, maxAutoAssociations: number,
 *   stakedNodeId?: number | null, stakedAccountId?: string | null, pendingReward?: bigint, declineReward?: boolean,
 *   ethereumNonce?: number, deleted?: boolean }} MirrorAccount
 *   ethereumNonce (0.10.2): nonce EVM de la cuenta (para firmar una transacción EVM, acciones con SODAX).
 */
/**
 * Nodo de consenso para el staking nativo. `rewardRateStart`: tinybars pagados por cada HBAR en staking en
 * el último día (≈ rendimiento diario). Las cantidades son aproximadas (el mirror las da como número).
 * @typedef {{ nodeId: number, accountId: string, description: string, stake: number, stakeRewarded: number,
 *   maxStake: number, rewardRateStart: number }} StakingNode
 */
/** @typedef {{ tokenId: string, amount: bigint }} TokenMove */
/** @typedef {{ tokenId: string, serial: number }} NftRef */
/**
 * `staking`: SOLO cambia el nodo de staking (y quizá si se aceptan recompensas). `nodeId: null` = dejar de
 * hacer staking. Si además toca cualquier otra cosa, es `settings` con `autoAssociations: null` (rara).
 * @typedef {{ kind: "transfer", from: string, to: string, tinybars: bigint, tokens: TokenMove[], nfts: NftRef[],
 *     fee: { to: string, tinybars: bigint } | null, extra: { to: string, tinybars: bigint }[] }
 *   | { kind: "keyChange", account: string }
 *   | { kind: "staking", account: string, nodeId: number | null, declineReward: boolean | null }
 *   | { kind: "settings", account: string, autoAssociations: number | null }
 *   | { kind: "other" }} ScheduleAction
 */
/**
 * `signers`: claves públicas (hex crudo) que ya han firmado la programada; `contractSigners`: cuántos
 * contratos la han autorizado.
 * @typedef {{ id: string, executed: boolean, deleted: boolean, expiresAt: number, payer: string, creator: string,
 *   action: ScheduleAction, memo: string, signers: string[], contractSigners: number }} MirrorSchedule
 */
/**
 * Comisiones propias de un token (las cobra la red al moverlo). `fixedHbar` y `fixedTokens`: fijas, las
 * paga QUIEN ENVÍA; `fractional`: se quedan una parte del propio token; `royalty`: en NFT (con «fallback»
 * las paga quien recibe).
 * @typedef {{ fixedHbar: bigint, fixedTokens: { tokenId: string, amount: bigint }[], fractional: number, royalty: number }} TokenFees
 * @typedef {{ tokenId: string, name: string, symbol: string, decimals: number, fungible: boolean, fees?: TokenFees, issuerKeys?: string[],
 *   deleted?: boolean, paused?: boolean, freezeDefault?: boolean, createdAt?: number | null, treasury?: string | null }} TokenInfo
 *   deleted/paused/freezeDefault (0.10.2): para no dejar cambiar un token borrado, pausado o que nace congelado.
 *   createdAt (0.10.2): segundos desde 1970 en que se creó (para avisar de un token recién creado).
 */
/** @typedef {{ tokenId: string, balance: bigint, decimals: number | null }} TokenHolding */
/** @typedef {{ tokenId: string, serial: number, metadata: string, spender?: string | null }} NftHolding metadata en base64, tal cual; spender: quien tiene permiso para moverlo */

/**
 * @typedef {{ kind: "hbar", spender: string, amount: bigint }
 *   | { kind: "token", tokenId: string, spender: string, amount: bigint }
 *   | { kind: "nftAll", tokenId: string, spender: string }
 *   | { kind: "nft", tokenId: string, serial: number, spender: string }} Allowance
 * Permiso de gasto vigente que ha dado una cuenta (amount en tinybars o en unidades mínimas del token).
 */

/**
 * Permisos vigentes a partir de las respuestas del mirror: /allowances/crypto, /allowances/tokens,
 * /allowances/nfts (colecciones enteras) y los NFT de la cuenta con su «spender» (NFT sueltos). Los ya
 * gastados o quitados (cantidad 0, o «todos» retirado) no salen.
 * @param {{ crypto?: any[], tokens?: any[], nfts?: any[], held?: NftHolding[] }} p
 * @returns {Allowance[]}
 */
export function allowancesFromMirror({ crypto = [], tokens = [], nfts = [], held = [] }) {
  const big = (/** @type {unknown} */ v) => {
    try {
      return BigInt(String(v ?? 0));
    } catch {
      return 0n;
    }
  };
  /** @type {Allowance[]} */
  const out = [];
  for (const a of crypto) {
    const amount = big(a?.amount ?? a?.amount_granted);
    if (a?.spender && amount > 0n) out.push({ kind: "hbar", spender: String(a.spender), amount });
  }
  for (const a of tokens) {
    const amount = big(a?.amount ?? a?.amount_granted);
    if (a?.spender && a?.token_id && amount > 0n) out.push({ kind: "token", tokenId: String(a.token_id), spender: String(a.spender), amount });
  }
  for (const a of nfts) if (a?.approved_for_all === true && a?.spender && a?.token_id) out.push({ kind: "nftAll", tokenId: String(a.token_id), spender: String(a.spender) });
  for (const n of held) if (n.spender) out.push({ kind: "nft", tokenId: n.tokenId, serial: n.serial, spender: n.spender });
  return out;
}

/** @param {string} ts marca de tiempo del mirror ("segundos.nanos") */
const tsSeconds = (ts) => Number(ts.split(".")[0]);

/**
 * Clave tal como la devuelve el mirror node.
 * @param {{ _type: string, key: string } | null | undefined} k
 * @returns {Key | null}
 */
export function keyFromMirror(k) {
  if (!k) return null;
  if (k._type === "ED25519") return PublicKey.fromStringED25519(k.key);
  if (k._type === "ECDSA_SECP256K1") return PublicKey.fromStringECDSA(k.key);
  if (k._type === "ProtobufEncoded") return Key._fromProtobufKey(HieroProto.proto.Key.decode(getBytes(`0x${k.key}`)));
  return null;
}

/**
 * Nombre de una cuenta tal como viene en una transacción: «0.0.N» por número; por alias, su dirección EVM
 * («0x…», o «0.0.N» si es la dirección «larga de ceros» de una cuenta numerada) o la clave del alias.
 * Cada alias distinto da un nombre distinto: antes todos salían como «0.0.?» y dos destinos diferentes
 * podían parecer el mismo.
 * @param {any} id
 */
export function accountName(id) {
  if (!id) return "0.0.?";
  const alias = id.alias;
  if (alias != null && alias.length) {
    const bytes = typeof alias === "string" ? decodeBase64(alias) : alias;
    const hex = Array.from(bytes, (/** @type {number} */ b) => b.toString(16).padStart(2, "0")).join("");
    if (hex.length === 40) return /^0{24}/.test(hex) ? `0.0.${BigInt(`0x${hex.slice(24)}`).toString()}` : `0x${hex}`;
    return `alias:${hex}`;
  }
  return `0.0.${id.accountNum?.toString() ?? "?"}`;
}

/**
 * Resume qué hace una transacción programada.
 * Una transferencia solo se describe si sale de UNA cuenta; los abonos a `feeCollector` se muestran
 * como comisión. Cualquier otro abono queda en `extra`, para que nada pase desapercibido.
 * @param {string} base64Body SchedulableTransactionBody en base64
 * @param {string | null} [feeCollector] cuenta 0.0.x que cobra la comisión del servicio
 * @returns {ScheduleAction}
 */
export function describeScheduledBody(base64Body, feeCollector = null) {
  const body = HieroProto.proto.SchedulableTransactionBody.decode(decodeBase64(base64Body));
  const asId = (/** @type {any} */ aa) => accountName(aa.accountID);
  const amount = (/** @type {any} */ aa) => BigInt(aa.amount?.toString() ?? "0");
  if (body.cryptoTransfer) {
    const hbar = (body.cryptoTransfer.transfers?.accountAmounts ?? []).map((aa) => ({ id: asId(aa), amount: amount(aa) }));
    const lists = (body.cryptoTransfer.tokenTransfers ?? []).map((l) => ({
      tokenId: `0.0.${l.token?.tokenNum?.toString() ?? "?"}`,
      moves: (l.transfers ?? []).map((aa) => ({ id: asId(aa), amount: amount(aa) })),
      nfts: (l.nftTransfers ?? []).map((nt) => ({
        from: accountName(nt.senderAccountID),
        to: accountName(nt.receiverAccountID),
        serial: Number(nt.serialNumber?.toString() ?? "0"),
        approval: Boolean(nt.isApproval),
      })),
    }));
    const nftMoves = lists.flatMap((l) => l.nfts.map((m) => ({ ...m, tokenId: l.tokenId })));
    // Con permisos de terceros (allowance) no se describe: que se vea como operación rara.
    if (nftMoves.some((m) => m.approval)) return { kind: "other" };
    const debits = [...hbar, ...lists.flatMap((l) => l.moves)].filter((m) => m.amount < 0n);
    const from = debits[0]?.id ?? nftMoves[0]?.from;
    if (!from || debits.some((d) => d.id !== from) || nftMoves.some((m) => m.from !== from)) return { kind: "other" };
    /** @type {TokenMove[]} */
    const tokens = [];
    let tokenTo = "";
    for (const l of lists) {
      if (l.moves.length === 0) continue;
      const credits = l.moves.filter((m) => m.amount > 0n);
      if (credits.length !== 1 || (tokenTo && credits[0].id !== tokenTo)) return { kind: "other" };
      tokenTo = credits[0].id;
      tokens.push({ tokenId: l.tokenId, amount: credits[0].amount });
    }
    // Todos los NFT tienen que ir al mismo destino que los tokens.
    for (const m of nftMoves) {
      if (tokenTo && m.to !== tokenTo) return { kind: "other" };
      tokenTo = m.to;
    }
    /** @type {NftRef[]} */
    const nfts = nftMoves.map((m) => ({ tokenId: m.tokenId, serial: m.serial }));
    let credits = hbar.filter((m) => m.amount > 0n);
    let fee = null;
    const feeLeg = feeCollector ? credits.find((c) => c.id === feeCollector) : undefined;
    if (feeLeg && (credits.length > 1 || tokens.length > 0 || nfts.length > 0)) {
      fee = { to: feeLeg.id, tinybars: feeLeg.amount };
      credits = credits.filter((c) => c !== feeLeg);
    }
    credits.sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
    const main = tokenTo ? credits.find((c) => c.id === tokenTo) : credits[0];
    const to = tokenTo || main?.id || "";
    if (!to) return { kind: "other" };
    return {
      kind: "transfer",
      from,
      to,
      tinybars: main?.amount ?? 0n,
      tokens,
      nfts,
      fee,
      extra: credits.filter((c) => c !== main).map((c) => ({ to: c.id, tinybars: c.amount })),
    };
  }
  if (body.cryptoUpdateAccount) {
    const u = /** @type {any} */ (body.cryptoUpdateAccount);
    const account = `0.0.${u.accountIDToUpdate?.accountNum?.toString() ?? "?"}`;
    if (u.key) return { kind: "keyChange", account };
    // Solo cuentan los campos que vienen de verdad en la transacción.
    // (las listas vacías vienen siempre; una con algo —p. ej. ganchos, HIP-1195— sí cuenta).
    const touched = Object.keys(u).filter((k) => k !== "accountIDToUpdate" && u[k] != null && !(Array.isArray(u[k]) && u[k].length === 0));
    if (touched.includes("stakedNodeId") && touched.every((k) => k === "stakedNodeId" || k === "declineReward")) {
      const node = Number(u.stakedNodeId.toString());
      return { kind: "staking", account, nodeId: node >= 0 ? node : null, declineReward: u.declineReward != null ? Boolean(u.declineReward.value) : null };
    }
    if (touched.length === 1 && touched[0] === "maxAutomaticTokenAssociations") {
      return { kind: "settings", account, autoAssociations: Number(u.maxAutomaticTokenAssociations.value ?? 0) };
    }
    // Cualquier otra mezcla (firma obligatoria para recibir, caducidad, staking a otra cuenta…): rara.
    return { kind: "settings", account, autoAssociations: null };
  }
  return { kind: "other" };
}

export class Mirror {
  /**
   * @param {string} baseUrl p. ej. https://testnet.mirrornode.hedera.com
   * @param {typeof fetch} [fetchImpl]
   * @param {{ feeCollector?: string | null }} [options] cuenta que cobra la comisión (para describir retiradas)
   */
  constructor(baseUrl, fetchImpl = fetch, options = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetch = fetchImpl;
    this.feeCollector = options.feeCollector ?? null;
    /** @type {Map<string, TokenInfo>} */
    this.tokenCache = new Map();
  }

  /** @param {string} path */
  async #get(path) {
    const res = await this.fetch(`${this.baseUrl}${path}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`mirror ${res.status} en ${path}`);
    return res.json();
  }

  /**
   * Cuenta por ID (0.0.x) o por dirección EVM. Devuelve null si no existe todavía.
   * @param {string} idOrEvm
   * @returns {Promise<MirrorAccount | null>}
   */
  async account(idOrEvm) {
    const a = await this.#get(`/api/v1/accounts/${idOrEvm}?transactions=false`);
    if (!a || !a.account) return null;
    return {
      id: AccountId.fromString(a.account),
      evmAddress: String(a.evm_address).toLowerCase(),
      balance: BigInt(a.balance?.balance ?? 0),
      key: keyFromMirror(a.key),
      maxAutoAssociations: Number(a.max_automatic_token_associations ?? 0),
      stakedNodeId: a.staked_node_id == null ? null : Number(a.staked_node_id),
      stakedAccountId: a.staked_account_id ? String(a.staked_account_id) : null,
      pendingReward: BigInt(Math.max(0, Math.trunc(Number(a.pending_reward ?? 0)))),
      declineReward: Boolean(a.decline_reward),
      ethereumNonce: Math.max(0, Math.trunc(Number(a.ethereum_nonce ?? 0))) || 0,
      deleted: a.deleted === true,
    };
  }

  /**
   * Nodos de consenso con su stake y su rendimiento del último día.
   * @returns {Promise<StakingNode[]>}
   */
  async nodes() {
    /** @type {StakingNode[]} */
    const out = [];
    let path = "/api/v1/network/nodes?limit=25&order=asc";
    for (let page = 0; page < 10 && path; page++) {
      const body = await this.#get(path);
      if (!body) break;
      for (const n of body.nodes ?? []) {
        out.push({
          nodeId: Number(n.node_id),
          accountId: String(n.node_account_id ?? ""),
          description: String(n.description ?? "").trim(),
          stake: Number(n.stake ?? 0),
          stakeRewarded: Number(n.stake_rewarded ?? 0),
          maxStake: Number(n.max_stake ?? 0),
          rewardRateStart: Number(n.reward_rate_start ?? 0),
        });
      }
      path = body.links?.next ?? "";
    }
    return out;
  }

  /**
   * Recompensas de staking ya cobradas por una cuenta (suma de los pagos más recientes, hasta 1.000).
   * @param {string} accountId
   * @returns {Promise<bigint>}
   */
  async stakingRewardsTotal(accountId) {
    let total = 0n;
    let path = `/api/v1/accounts/${accountId}/rewards?limit=100&order=desc`;
    for (let page = 0; page < 10 && path; page++) {
      const body = await this.#get(path);
      if (!body) break;
      for (const r of body.rewards ?? []) total += BigInt(Math.max(0, Math.trunc(Number(r.amount ?? 0))));
      path = body.links?.next ?? "";
    }
    return total;
  }

  /**
   * Tokens asociados a una cuenta (también los que tienen saldo 0).
   * @param {string} accountId
   * @returns {Promise<TokenHolding[]>}
   */
  async accountTokens(accountId) {
    /** @type {TokenHolding[]} */
    const out = [];
    let path = `/api/v1/accounts/${accountId}/tokens?limit=100`;
    for (let page = 0; page < 10 && path; page++) {
      const body = await this.#get(path);
      if (!body) break;
      for (const t of body.tokens ?? []) {
        out.push({ tokenId: String(t.token_id), balance: BigInt(t.balance ?? 0), decimals: t.decimals == null ? null : Number(t.decimals) });
      }
      path = body.links?.next ?? "";
    }
    return out;
  }

  /**
   * NFT que tiene una cuenta (todas las colecciones), con su metadata en base64.
   * @param {string} accountId
   * @returns {Promise<NftHolding[]>}
   */
  async accountNfts(accountId) {
    /** @type {NftHolding[]} */
    const out = [];
    let path = `/api/v1/accounts/${accountId}/nfts?limit=100`;
    for (let page = 0; page < 20 && path; page++) {
      const body = await this.#get(path);
      if (!body) break;
      for (const t of body.nfts ?? []) {
        if (t.deleted) continue;
        out.push({ tokenId: String(t.token_id), serial: Number(t.serial_number), metadata: String(t.metadata ?? ""), spender: t.spender ? String(t.spender) : null });
      }
      path = body.links?.next ?? "";
    }
    return out;
  }

  /**
   * Permisos de gasto vigentes que ha dado una cuenta: HBAR, tokens, colecciones de NFT y NFT sueltos.
   * @param {string} accountId
   * @returns {Promise<Allowance[]>}
   */
  async allowances(accountId) {
    const all = async (/** @type {string} */ kind) => {
      /** @type {any[]} */
      const out = [];
      let path = `/api/v1/accounts/${accountId}/allowances/${kind}?limit=100`;
      for (let page = 0; page < 10 && path; page++) {
        const body = await this.#get(path);
        if (!body) break;
        out.push(...(body.allowances ?? []));
        path = body.links?.next ?? "";
      }
      return out;
    };
    const [crypto, tokens, nfts, held] = await Promise.all([all("crypto"), all("tokens"), all("nfts"), this.accountNfts(accountId)]);
    return allowancesFromMirror({ crypto, tokens, nfts, held });
  }

  /**
   * Nombre, símbolo, decimales, comisiones y llaves del emisor de un token (se guardan en memoria).
   * Con `fresh`, se vuelve a pedir: las comisiones pueden cambiar si el token tiene llave para ello.
   * @param {string} tokenId @param {{ fresh?: boolean }} [opts]
   * @returns {Promise<TokenInfo | null>}
   */
  async tokenInfo(tokenId, { fresh = false } = {}) {
    const cached = this.tokenCache.get(tokenId);
    if (cached && !fresh) return cached;
    const t = await this.#get(`/api/v1/tokens/${tokenId}`);
    if (!t) return null;
    const cf = t.custom_fees ?? {};
    const big = (/** @type {any} */ x) => BigInt(Math.max(0, Math.trunc(Number(x ?? 0))));
    const fixed = Array.isArray(cf.fixed_fees) ? cf.fixed_fees : [];
    const KEYS = /** @type {const} */ ([["admin_key", "admin"], ["freeze_key", "freeze"], ["wipe_key", "wipe"], ["pause_key", "pause"], ["kyc_key", "kyc"], ["fee_schedule_key", "feeSchedule"], ["supply_key", "supply"]]);
    /** @type {TokenInfo} */
    const info = {
      tokenId,
      name: String(t.name ?? tokenId),
      symbol: String(t.symbol ?? "?"),
      decimals: Number(t.decimals ?? 0),
      fungible: String(t.type ?? "FUNGIBLE_COMMON") === "FUNGIBLE_COMMON",
      fees: {
        fixedHbar: fixed.filter((/** @type {any} */ f) => !f.denominating_token_id).reduce((/** @type {bigint} */ a, /** @type {any} */ f) => a + big(f.amount), 0n),
        fixedTokens: fixed.filter((/** @type {any} */ f) => f.denominating_token_id).map((/** @type {any} */ f) => ({ tokenId: String(f.denominating_token_id), amount: big(f.amount) })),
        fractional: Array.isArray(cf.fractional_fees) ? cf.fractional_fees.length : 0,
        royalty: Array.isArray(cf.royalty_fees) ? cf.royalty_fees.length : 0,
      },
      issuerKeys: KEYS.filter(([k]) => t[k]).map(([, name]) => name),
      deleted: Boolean(t.deleted),
      paused: String(t.pause_status ?? "") === "PAUSED",
      freezeDefault: Boolean(t.freeze_default),
      createdAt: t.created_timestamp ? Math.floor(Number(String(t.created_timestamp).split(".")[0])) || null : null,
      treasury: /^0\.0\.\d+$/.test(String(t.treasury_account_id ?? "")) ? String(t.treasury_account_id) : null,
    };
    this.tokenCache.set(tokenId, info);
    return info;
  }

  /**
   * Cuentas cuya clave es exactamente esta clave pública (hex crudo). Sirve para encontrar la
   * cuenta del kit de rescate a partir de las 24 palabras.
   * @param {string} publicKeyHex
   * @returns {Promise<MirrorAccount[]>}
   */
  async accountsByPublicKey(publicKeyHex) {
    const body = await this.#get(`/api/v1/accounts?account.publickey=${publicKeyHex}&balance=true&limit=25`);
    return (body?.accounts ?? [])
      .filter((/** @type {any} */ a) => !a.deleted)
      .map((/** @type {any} */ a) => ({
        id: AccountId.fromString(a.account),
        evmAddress: String(a.evm_address).toLowerCase(),
        balance: BigInt(a.balance?.balance ?? 0),
        key: keyFromMirror(a.key),
        maxAutoAssociations: Number(a.max_automatic_token_associations ?? 0),
      }));
  }

  /**
   * Logs crudos de un contrato posteriores a `afterTimestamp` (en orden). Con `newest`, los MÁS RECIENTES
   * (hasta 2.000), también en orden: así nadie puede esconder lo último detrás de miles de avisos basura.
   * @param {string} contractId @param {string} [afterTimestamp] "segundos.nanos" @param {{ newest?: boolean }} [opts]
   * @returns {Promise<{ logs: { topics: string[], data: string, timestamp: string }[], last: string | undefined }>}
   */
  async contractLogs(contractId, afterTimestamp, { newest = false } = {}) {
    if (newest) {
      /** @type {{ topics: string[], data: string, timestamp: string }[]} */
      const recent = [];
      let p = `/api/v1/contracts/${contractId}/results/logs?order=desc&limit=100`;
      for (let page = 0; page < 20 && p; page++) {
        const body = await this.#get(p);
        if (!body) break;
        for (const log of body.logs ?? []) recent.push({ topics: log.topics, data: log.data, timestamp: log.timestamp });
        p = body.links?.next ?? "";
      }
      recent.reverse();
      return { logs: recent, last: recent.at(-1)?.timestamp };
    }
    /** @type {{ topics: string[], data: string, timestamp: string }[]} */
    const logs = [];
    let path = `/api/v1/contracts/${contractId}/results/logs?order=asc&limit=100${afterTimestamp ? `&timestamp=gt:${afterTimestamp}` : ""}`;
    let last = afterTimestamp;
    for (let page = 0; page < 20 && path; page++) {
      const body = await this.#get(path);
      if (!body) break;
      for (const log of body.logs ?? []) {
        logs.push({ topics: log.topics, data: log.data, timestamp: log.timestamp });
        last = log.timestamp;
      }
      path = body.links?.next ?? "";
    }
    return { logs, last };
  }

  /**
   * Eventos del notario posteriores a `afterTimestamp` (en orden), con la marca de tiempo del último.
   * @param {string} notaryId @param {string} [afterTimestamp] "segundos.nanos"
   * @returns {Promise<{ events: (import("./notary.js").NotaryEvent & { timestamp: string })[], last: string | undefined }>}
   */
  async notaryEvents(notaryId, afterTimestamp) {
    /** @type {(import("./notary.js").NotaryEvent & { timestamp: string })[]} */
    const events = [];
    let path = `/api/v1/contracts/${notaryId}/results/logs?order=asc&limit=100${afterTimestamp ? `&timestamp=gt:${afterTimestamp}` : ""}`;
    let last = afterTimestamp;
    for (let page = 0; page < 20 && path; page++) {
      const body = await this.#get(path);
      if (!body) break;
      for (const log of body.logs ?? []) {
        const ev = decodeNotaryLog(log);
        if (ev) events.push({ ...ev, timestamp: log.timestamp });
        last = log.timestamp;
      }
      path = body.links?.next ?? "";
    }
    return { events, last };
  }

  /**
   * @param {string} scheduleId 0.0.x
   * @returns {Promise<MirrorSchedule | null>}
   */
  async schedule(scheduleId) {
    const s = await this.#get(`/api/v1/schedules/${scheduleId}`);
    if (!s) return null;
    return this.#scheduleOf(s);
  }

  /**
   * Programadas que creó (y pagó al crearlas) una cuenta, las más recientes primero, con su cuerpo en base64 para
   * revisarlo a fondo (el cambio de móvil lo valida campo a campo).
   * @param {string} accountId 0.0.x
   * @param {{ limit?: number }} [opts]
   * @returns {Promise<(MirrorSchedule & { body: string, createdAt: number })[]>}
   */
  async schedulesCreatedBy(accountId, { limit = 25 } = {}) {
    if (!/^0\.0\.\d+$/.test(accountId)) throw new Error("cuenta no válida");
    const n = Math.min(100, Math.max(1, Math.floor(limit)));
    const body = await this.#get(`/api/v1/schedules?account.id=${accountId}&order=desc&limit=${n}`);
    return (body?.schedules ?? []).map((/** @type {any} */ s) => ({
      ...this.#scheduleOf(s),
      body: typeof s.transaction_body === "string" ? s.transaction_body : "",
      createdAt: s.consensus_timestamp ? tsSeconds(s.consensus_timestamp) : 0,
    }));
  }

  /** Un cuerpo que no se entiende (o trucado) no rompe la lista: se ve como operación rara. @param {string} b */
  #describe(b) {
    try {
      return describeScheduledBody(b, this.feeCollector);
    } catch {
      return /** @type {ScheduleAction} */ ({ kind: "other" });
    }
  }

  /** @param {any} s @returns {MirrorSchedule} */
  #scheduleOf(s) {
    return {
      id: s.schedule_id,
      executed: s.executed_timestamp != null,
      deleted: Boolean(s.deleted),
      expiresAt: s.expiration_time ? tsSeconds(s.expiration_time) : 0,
      payer: s.payer_account_id,
      creator: s.creator_account_id ?? "",
      action: s.transaction_body ? this.#describe(String(s.transaction_body)) : { kind: "other" },
      memo: s.memo ?? "",
      signers: (s.signatures ?? [])
        .filter((/** @type {any} */ x) => x.type !== "CONTRACT" && x.public_key_prefix)
        .map((/** @type {any} */ x) => hexlify(decodeBase64(String(x.public_key_prefix))).slice(2).toLowerCase()),
      contractSigners: (s.signatures ?? []).filter((/** @type {any} */ x) => x.type === "CONTRACT").length,
    };
  }

  /**
   * Simulación gratuita (eth_call) en la EVM del mirror node. Sin `to`, simula un despliegue.
   * Devuelve { ok, result } o { ok: false, error } si revierte. Con `estimate`, `result` es el gas estimado (hex).
   * `value`: HBAR que se mandarían con la llamada, en tinybars.
   * @param {{ to?: string, from?: string, data: Uint8Array | string, gas?: number, value?: bigint, estimate?: boolean }} p
   */
  async simulate({ to, from, data, gas = 900_000, value, estimate = false }) {
    const res = await this.fetch(`${this.baseUrl}/api/v1/contracts/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to,
        from,
        data: typeof data === "string" ? data : hexlify(data),
        gas,
        estimate,
        block: "latest",
        ...(value != null && value > 0n ? { value: Number(value) } : {}),
      }),
    });
    const text = await res.text();
    if (res.ok) return { ok: true, result: /** @type {string} */ (JSON.parse(text).result ?? "0x"), error: "", status: res.status };
    // `status`: para distinguir un rechazo por límite (429) de un revert.
    return { ok: false, result: "0x", error: text.slice(0, 400), status: res.status };
  }

  /**
   * Transacciones de una cuenta, de la más nueva a la más vieja (100 como mucho por página), tal como las da el mirror,
   * y el enlace a la página siguiente. Para el historial de la app (core/src/activity.js las describe).
   * @param {string} accountId 0.0.x
   * @param {{ next?: string | null, limit?: number }} [opts] next: el enlace `links.next` de la página anterior
   * @returns {Promise<{ transactions: any[], next: string | null }>}
   */
  async accountTransactions(accountId, { next = null, limit = 25 } = {}) {
    if (!/^0\.0\.\d+$/.test(accountId)) throw new Error("cuenta no válida");
    // Solo se sigue un enlace del propio mirror (misma cuenta, misma ruta): nada que venga de fuera.
    const same = new RegExp(`[?&]account\\.id=${accountId.replace(/\./g, "\\.")}(?:&|$)`);
    const path =
      next && next.startsWith("/api/v1/transactions?") && same.test(next) && !/[\s#]/.test(next)
        ? next
        : `/api/v1/transactions?account.id=${accountId}&order=desc&limit=${Math.min(100, Math.max(1, Math.floor(limit)))}`;
    const body = await this.#get(path);
    return { transactions: Array.isArray(body?.transactions) ? body.transactions : [], next: typeof body?.links?.next === "string" ? body.links.next : null };
  }

  /**
   * Dirección EVM de un contrato (la suya si la tiene; si no, la long-zero de su ID).
   * @param {string} contractId
   */
  async contractEvmAddress(contractId) {
    const c = await this.#get(`/api/v1/contracts/${contractId}`).catch(() => null);
    if (c && /^0x[0-9a-fA-F]{40}$/.test(String(c.evm_address ?? ""))) return String(c.evm_address).toLowerCase();
    return `0x${BigInt(String(contractId).split(".")[2]).toString(16).padStart(40, "0")}`;
  }

  /**
   * Resultado de una llamada a un contrato por su ID de transacción (0.0.x@s.n): lo que devolvió, si revirtió, por
   * qué, y los contratos que creó. null si el mirror aún no lo tiene.
   * @param {string} txId
   * @returns {Promise<{ result: string, error: string | null, createdContractIds: string[], contractId: string | null } | null>}
   */
  async contractResult(txId) {
    const m = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(String(txId));
    if (!m) return null;
    const c = await this.#get(`/api/v1/contracts/results/${m[1]}-${m[2]}-${m[3]}`).catch(() => null);
    if (!c) return null;
    const created = Array.isArray(c.created_contract_ids) ? c.created_contract_ids.map(String).filter((/** @type {string} */ x) => /^0\.0\.\d+$/.test(x)) : [];
    return {
      result: String(c.call_result ?? "0x"),
      error: c.error_message ? String(c.error_message) : null,
      createdContractIds: created,
      contractId: c.contract_id ? String(c.contract_id) : null,
    };
  }

  /**
   * 0.10.2 · Una transacción EVM ya ejecutada, por su hash de 32 bytes: a quién llamó, con qué datos y cómo acabó.
   * Sirve para rehacer una orden de SODAX a partir de la transacción que la creó (y poder cancelarla).
   * @param {string} hash
   * @returns {Promise<{ from: string, to: string, input: string, result: string, amount: bigint } | null>}
   */
  async evmTx(hash) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash))) return null;
    const c = await this.#get(`/api/v1/contracts/results/${hash}`).catch(() => null);
    if (!c || typeof c.function_parameters !== "string") return null;
    return {
      from: String(c.from ?? "").toLowerCase(),
      to: String(c.to ?? "").toLowerCase(),
      input: String(c.function_parameters).toLowerCase(),
      result: String(c.result ?? ""),
      amount: /^\d+$/.test(String(c.amount ?? "")) ? BigInt(c.amount) : 0n,
    };
  }

  /**
   * Cambio oficial de la red (dólares por HBAR) con el que Hedera calcula sus comisiones. null si no se puede leer.
   * @returns {Promise<number | null>}
   */
  async usdPerHbar() {
    const r = await this.#get("/api/v1/network/exchangerate").catch(() => null);
    const c = r?.current_rate;
    const v = c && Number(c.hbar_equivalent) > 0 ? Number(c.cent_equivalent) / Number(c.hbar_equivalent) / 100 : NaN;
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  /**
   * Precio del gas de una llamada a contrato, en tinybars por unidad. null si no se puede leer.
   * @returns {Promise<bigint | null>}
   */
  async contractGasPrice() {
    const r = await this.#get("/api/v1/network/fees").catch(() => null);
    const g = (r?.fees ?? []).find((/** @type {any} */ f) => f?.transaction_type === "ContractCall")?.gas;
    return Number.isInteger(g) && g > 0 && g < 100_000 ? BigInt(g) : null;
  }

  /**
   * Datos públicos de un contrato: su dirección EVM, su código en ejecución y su clave de administrador. null si no existe.
   * @param {string} idOrEvm 0.0.x o dirección EVM
   * @returns {Promise<{ id: string, evmAddress: string, runtimeBytecode: string, deleted: boolean, adminKey: import("@hiero-ledger/sdk").Key | null, adminKeyRaw: any } | null>}
   */
  async contractInfo(idOrEvm) {
    if (!/^(0\.0\.\d+|0x[0-9a-fA-F]{40})$/.test(String(idOrEvm))) return null;
    const c = await this.#get(`/api/v1/contracts/${idOrEvm}`);
    if (!c || !/^0\.0\.\d+$/.test(String(c.contract_id ?? ""))) return null;
    let adminKey = null;
    try {
      adminKey = keyFromMirror(c.admin_key);
    } catch {
      adminKey = null;
    }
    return {
      id: String(c.contract_id),
      evmAddress: /^0x[0-9a-fA-F]{40}$/.test(String(c.evm_address ?? "")) ? String(c.evm_address).toLowerCase() : "",
      runtimeBytecode: /^0x[0-9a-fA-F]*$/.test(String(c.runtime_bytecode ?? "")) ? String(c.runtime_bytecode).toLowerCase() : "0x",
      deleted: Boolean(c.deleted),
      adminKey,
      adminKeyRaw: c.admin_key ?? null,
    };
  }
}
