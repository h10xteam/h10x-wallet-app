// @ts-check
// Historial completo de la wallet (0.10): todo lo que ha pasado en la Cartera y en la bóveda, no solo las operaciones
// con cuenta atrás. Lee las transacciones tal como las da el mirror (/api/v1/transactions?account.id=…) y las cuenta
// en palabras: envíos, recibos, lo que se guarda o se saca de la bóveda, cambios (swaps), NFT, staking, permisos y lo
// que se firmó para una dApp. Sin dependencias: lo usan la app y las pruebas sin red.

/**
 * @typedef {"sent" | "received" | "deposit" | "fromVault" | "swap" | "nftSent" | "nftReceived" | "reward" | "vaultOp"
 *   | "vaultCreated" | "allowance" | "associate" | "contract" | "evm" | "message" | "airdrop" | "settings" | "other"} ActivityKind
 * @typedef {{ tokenId: string, amount: bigint }} TokenDelta  amount > 0 entra, < 0 sale (unidades mínimas del token)
 * @typedef {{ tokenId: string, serial: number }} ActivityNft
 * @typedef {{
 *   id: string, txId: string, consensus: string, at: number, kind: ActivityKind, name: string, ok: boolean, result: string,
 *   where: "pocket" | "vault" | "both", hbar: bigint, fee: bigint, reward: bigint, tokens: TokenDelta[],
 *   nftsIn: ActivityNft[], nftsOut: ActivityNft[], counterparty: string | null, contract: string | null, memo: string,
 *   scheduled: boolean, via?: string
 * }} ActivityItem
 *   hbar: lo que entra (+) o sale (−) de la wallet, sin la comisión de red ni el staking · fee: comisión de red que pagó
 *   la wallet · reward: recompensas de staking cobradas en esa transacción · counterparty: la otra cuenta (si hay una
 *   clara) · contract: el contrato llamado · via: la dApp para la que se firmó (lo apunta la app al firmar)
 * @typedef {{ pocket: string, vault?: string | null, notary?: string | null, routers?: ReadonlyArray<string> }} ActivityAccounts
 *   routers: contratos de SaucerSwap (una llamada a uno de ellos es un cambio)
 */

/** Número de una cuenta 0.0.N (las de la red, por debajo de 1000, no son de nadie: nodos, comisiones, staking). */
const num = (/** @type {string} */ id) => {
  const m = /^0\.0\.(\d+)$/.exec(String(id ?? ""));
  return m ? Number(m[1]) : -1;
};
const isSystem = (/** @type {string} */ id) => {
  const n = num(id);
  return n >= 0 && n < 1000;
};
/** @returns {bigint} */
const big = (/** @type {unknown} */ v) => {
  try {
    return BigInt(String(v ?? 0));
  } catch {
    return 0n;
  }
};
/** Segundos de una marca del mirror («1794584098.001309548»). */
const seconds = (/** @type {string} */ ts) => Number(String(ts ?? "0").split(".")[0]) || 0;

/**
 * ID de una transacción en el formato del mirror («0.0.x-segundos-nanos», nanos con 9 cifras), a partir del del SDK
 * («0.0.x@segundos.nanos»), del mismo formato del mirror, o del transactionID de un cuerpo (protobuf). null si no se puede.
 * @param {unknown} id
 * @returns {string | null}
 */
export function mirrorTxId(id) {
  if (typeof id === "string") {
    const s = id.trim();
    const m = /^(\d+\.\d+\.\d+)[@-](\d+)[.-](\d{1,9})(?:\?.*)?$/.exec(s);
    return m ? `${m[1]}-${m[2]}-${m[3].padStart(9, "0")}` : null;
  }
  const t = /** @type {any} */ (id);
  const acc = t?.accountID;
  const vs = t?.transactionValidStart;
  if (!acc || !vs) return null;
  const n = (/** @type {unknown} */ x) => String(x ?? 0);
  const parts = [n(acc.shardNum), n(acc.realmNum), n(acc.accountNum), n(vs.seconds), n(vs.nanos)];
  if (!parts.every((p) => /^\d+$/.test(p)) || parts[4].length > 9) return null;
  return `${parts[0]}.${parts[1]}.${parts[2]}-${parts[3]}-${parts[4].padStart(9, "0")}`;
}

/** Texto de la nota (memo en base64), limpio y corto. Nunca lanza. @param {unknown} b64 */
export function memoText(b64) {
  if (typeof b64 !== "string" || !b64) return "";
  try {
    const bin = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return text.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 100);
  } catch {
    return "";
  }
}

/**
 * Lo que una transacción del mirror significa para UNA cuenta de la wallet (la Cartera o la bóveda).
 * @param {any} tx transacción tal cual la da el mirror
 * @param {"pocket" | "vault"} where @param {ActivityAccounts} accounts
 * @returns {ActivityItem | null} null si la transacción no toca esa cuenta
 */
export function describeForAccount(tx, where, accounts) {
  const me = where === "vault" ? accounts.vault : accounts.pocket;
  if (!me || !tx || typeof tx.transaction_id !== "string") return null;
  const other = where === "vault" ? accounts.pocket : accounts.vault ?? null;
  const payer = tx.transaction_id.split("-")[0];
  // Tal como las da el mirror (sin tipo): `any[]` para que la comprobación de tipos de la app no pida uno a cada línea.
  /** @type {any[]} */
  const transfers = Array.isArray(tx.transfers) ? tx.transfers : [];
  /** @type {any[]} */
  const tokenTransfers = Array.isArray(tx.token_transfers) ? tx.token_transfers : [];
  /** @type {any[]} */
  const nftTransfers = Array.isArray(tx.nft_transfers) ? tx.nft_transfers : [];
  /** @type {any[]} */
  const rewards = Array.isArray(tx.staking_reward_transfers) ? tx.staking_reward_transfers : [];

  /** @type {bigint} */
  let mineHbar = 0n;
  for (const t of transfers) if (t?.account === me) mineHbar += big(t.amount);
  /** @type {bigint} */
  let reward = 0n;
  for (const r of rewards) if (r?.account === me) reward += big(r.amount);
  /** @type {bigint} */
  const fee = payer === me ? big(tx.charged_tx_fee) : 0n;
  // Lo que se mueve de verdad: sin la comisión que pagó (si pagó) y sin el staking que cobró en ese momento.
  const hbar = mineHbar + fee - reward;
  /** @type {Map<string, bigint>} */
  const byToken = new Map();
  for (const t of tokenTransfers) if (t?.account === me) byToken.set(String(t.token_id), (byToken.get(String(t.token_id)) ?? 0n) + big(t.amount));
  const tokens = [...byToken].filter(([, a]) => a !== 0n).map(([tokenId, amount]) => ({ tokenId, amount }));
  const nftsIn = nftTransfers.filter((n) => n?.receiver_account_id === me).map((n) => ({ tokenId: String(n.token_id), serial: Number(n.serial_number) }));
  const nftsOut = nftTransfers.filter((n) => n?.sender_account_id === me).map((n) => ({ tokenId: String(n.token_id), serial: Number(n.serial_number) }));
  const touches =
    payer === me || mineHbar !== 0n || tokens.length > 0 || nftsIn.length > 0 || nftsOut.length > 0 || reward > 0n || tx.entity_id === me;
  if (!touches) return null;

  // La otra parte: la cuenta (que no sea de la red ni esta misma) que se lleva o da lo contrario que esta.
  const sign = hbar !== 0n ? (hbar > 0n ? 1 : -1) : tokens.length ? (tokens[0].amount > 0n ? 1 : -1) : nftsIn.length ? 1 : nftsOut.length ? -1 : 0;
  /** @type {Map<string, bigint>} */
  const others = new Map();
  for (const t of transfers) if (t?.account && t.account !== me && !isSystem(t.account)) others.set(t.account, (others.get(t.account) ?? 0n) + big(t.amount));
  for (const t of tokenTransfers) if (t?.account && t.account !== me && !isSystem(t.account)) others.set(t.account, (others.get(t.account) ?? 0n) + big(t.amount));
  for (const n of nftTransfers) {
    if (n?.receiver_account_id === me && n.sender_account_id) others.set(n.sender_account_id, (others.get(n.sender_account_id) ?? 0n) - 1n);
    if (n?.sender_account_id === me && n.receiver_account_id) others.set(n.receiver_account_id, (others.get(n.receiver_account_id) ?? 0n) + 1n);
  }
  /** @type {string | null} */
  let counterparty = null;
  let best = 0n;
  for (const [acc, amt] of others) {
    if (sign === 0 || (sign > 0 ? amt < 0n : amt > 0n)) {
      const size = amt < 0n ? -amt : amt;
      if (size > best) {
        best = size;
        counterparty = acc;
      }
    }
  }
  if (!counterparty && payer !== me && !isSystem(payer)) counterparty = payer;

  const name = String(tx.name ?? "");
  const contract = typeof tx.entity_id === "string" && (name === "CONTRACTCALL" || name === "CONTRACTCREATEINSTANCE") ? tx.entity_id : null;
  const routers = new Set(accounts.routers ?? []);
  const gotIn = hbar > 0n || tokens.some((t) => t.amount > 0n);
  const gaveOut = hbar < 0n || tokens.some((t) => t.amount < 0n);
  /** @type {ActivityKind} */
  let kind = "other";
  if (name === "CONTRACTCALL" && contract && routers.has(contract)) kind = "swap";
  else if (name === "CONTRACTCALL" && contract && contract === accounts.notary) kind = "vaultOp";
  else if (name === "SCHEDULECREATE" || name === "SCHEDULESIGN" || name === "SCHEDULEDELETE") kind = "vaultOp";
  else if (name === "CRYPTOCREATEACCOUNT" && tx.entity_id && tx.entity_id === accounts.vault) kind = "vaultCreated";
  else if (name === "CRYPTOAPPROVEALLOWANCE" || name === "CRYPTODELETEALLOWANCE") kind = "allowance";
  else if (name === "TOKENASSOCIATE" || name === "TOKENDISSOCIATE") kind = "associate";
  else if (name === "ETHEREUMTRANSACTION") kind = "evm";
  else if (name === "CONSENSUSSUBMITMESSAGE") kind = "message";
  else if (name === "TOKENAIRDROP" || name === "TOKENCLAIMAIRDROP" || name === "TOKENCANCELAIRDROP" || name === "TOKENREJECT") kind = "airdrop";
  else if (name === "CRYPTOUPDATEACCOUNT") kind = "settings";
  else if (name === "CONTRACTCALL" || name === "CONTRACTCREATEINSTANCE") kind = gotIn && gaveOut ? "swap" : "contract";
  else if (other && counterparty === other && (hbar !== 0n || tokens.length || nftsIn.length || nftsOut.length)) kind = where === "pocket" ? (gaveOut ? "deposit" : "fromVault") : gotIn ? "deposit" : "fromVault";
  else if (gotIn && gaveOut) kind = "swap";
  else if (nftsOut.length && !gotIn) kind = "nftSent";
  else if (nftsIn.length && !gaveOut) kind = "nftReceived";
  else if (gaveOut) kind = "sent";
  else if (gotIn) kind = "received";
  else if (reward > 0n) kind = "reward";

  return {
    id: `${tx.transaction_id}@${tx.consensus_timestamp}`,
    txId: tx.transaction_id,
    consensus: String(tx.consensus_timestamp ?? ""),
    at: seconds(tx.consensus_timestamp),
    kind,
    name,
    ok: tx.result === "SUCCESS",
    result: String(tx.result ?? ""),
    where,
    hbar,
    fee,
    reward,
    tokens,
    nftsIn,
    nftsOut,
    counterparty,
    contract,
    memo: memoText(tx.memo_base64),
    scheduled: Boolean(tx.scheduled),
  };
}

/**
 * Junta lo de la Cartera y lo de la bóveda en una sola lista, de lo más nuevo a lo más viejo. Una transacción que toca
 * las dos (guardar o sacar de la bóveda) sale una vez, como movimiento entre ellas: no es dinero que entra o sale.
 * `dapps`: transacciones firmadas para una dApp (las apunta la app): se marcan con su nombre.
 * @param {{ pocket?: any[], vault?: any[], accounts: ActivityAccounts, dapps?: ReadonlyMap<string, string> }} p
 * @returns {ActivityItem[]}
 */
export function buildActivity({ pocket = [], vault = [], accounts, dapps = new Map() }) {
  /** @type {Map<string, ActivityItem>} */
  const byId = new Map();
  const add = (/** @type {ActivityItem | null} */ item) => {
    if (!item) return;
    const prev = byId.get(item.id);
    if (!prev) {
      byId.set(item.id, item);
      return;
    }
    // La misma transacción vista desde las dos cuentas. Si el dinero pasa de una a otra, es un movimiento interno (se
    // cuenta desde la Cartera); si no, manda la cuenta en la que se mueve algo (p. ej. la bóveda envía y la Cartera
    // solo paga la comisión).
    const p = prev.where === "pocket" ? prev : item;
    const v = prev.where === "vault" ? prev : item;
    const internal = (p.kind === "deposit" || p.kind === "fromVault") && (v.kind === "deposit" || v.kind === "fromVault");
    const moves = (/** @type {ActivityItem} */ x) => x.hbar !== 0n || x.tokens.length > 0 || x.nftsIn.length > 0 || x.nftsOut.length > 0;
    const main = internal ? p : moves(v) && !moves(p) ? v : p;
    byId.set(item.id, { ...main, where: "both", fee: p.fee + v.fee, reward: p.reward + v.reward, counterparty: internal ? null : main.counterparty });
  };
  for (const tx of pocket) add(describeForAccount(tx, "pocket", accounts));
  if (accounts.vault) for (const tx of vault) add(describeForAccount(tx, "vault", accounts));
  const items = [...byId.values()];
  for (const it of items) {
    const via = dapps.get(it.txId);
    if (via) it.via = via;
  }
  return items.sort((a, b) => (a.consensus < b.consensus ? 1 : a.consensus > b.consensus ? -1 : 0));
}

/**
 * Hasta dónde se puede enseñar sin huecos: la marca más vieja que ya se ha leído en LAS DOS cuentas. Lo anterior de
 * una sola podría tener delante algo de la otra que aún no se ha pedido.
 * @param {{ items: any[], done: boolean }[]} pages una por cuenta: lo leído y si ya no hay más
 * @returns {string} marca «segundos.nanos» (vacío: se puede enseñar todo)
 */
export function activityHorizon(pages) {
  let horizon = "";
  for (const p of pages) {
    if (p.done || p.items.length === 0) continue;
    const oldest = String(p.items[p.items.length - 1]?.consensus_timestamp ?? "");
    if (oldest && (!horizon || oldest > horizon)) horizon = oldest;
  }
  return horizon;
}
