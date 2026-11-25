// 0.10.1 · Cotización de la V2 sin el QuoterV2. El mirror público de Hedera contesta 429 «Invalid request» a
// cualquier consulta al QuoterV2 de SaucerSwap (24-nov-2026, una sola consulta, con 600.000 de gas y con o sin
// remitente), así que la app nunca veía la V2 y siempre cambiaba por la V1. Ahora la V2 se cotiza con el estado de la
// pool (core/src/swapv3.js): estas pruebas comparan ese cálculo con lo que contestó el QuoterV2 real en el mismo
// bloque, y comprueban que quotePool lo usa cuando el mirror rechaza el QuoterV2.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SQRT_RATIO,
  MAX_TICK,
  MIN_SQRT_RATIO,
  MIN_TICK,
  POOL_READS,
  decodeSlot0,
  encodeInt256,
  getSqrtRatioAtTick,
  quoteExactInputLocal,
  signedWordAt,
} from "../core/src/swapv3.js";
import { POOL_READ_GAS, QUOTER_REFUSED_MS, SAUCERSWAP, bestSwapQuote, longZero, quotePool, swapSetup } from "../core/src/swap.js";

const HBAR = 100_000_000n;

// ---- La pool V2 WHBAR/H10X al 0,3 % en mainnet, bloque 0x61f7743 (24-nov-2026), leída del propio contrato -------
const POOL = "0x2b594ee52b87616c7f59c83901949e4300c08cf0";
const SLOT0 =
  "0x00000000000000000000000000000000000000004c82968dc3f4b61b3ac71b3bffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa1a300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000660000000000000000000000000000000000000000000000000000000000000001";
const LIQUIDITY = "0x00000000000000000000000000000000000000000000000000000c76e62dd731";
const SPACING = "0x000000000000000000000000000000000000000000000000000000000000003c";
/** tickBitmap: la palabra -2 tiene los cuatro ticks de las posiciones; de la -9 a la -1, el resto a cero. */
const WORDS = new Map([[-2, "0x0000000000000000000000000001000010000020000400000000000000000000"]]);
for (let w = -9; w <= -1; w++) if (!WORDS.has(w)) WORDS.set(w, `0x${"0".repeat(64)}`);
/** ticks(t): liquidityGross y liquidityNet (lo demás no se usa). */
const TICKS = new Map([
  [-25800, "0x0000000000000000000000000000000000000000000000000000021ba98f28b60000000000000000000000000000000000000000000000000000021ba98f28b6"],
  [-24660, "0x00000000000000000000000000000000000000000000000000000a4add55170600000000000000000000000000000000000000000000000000000a4add551706"],
  [-23280, "0x00000000000000000000000000000000000000000000000000000a4add551706fffffffffffffffffffffffffffffffffffffffffffffffffffff5b522aae8fa"],
  [-22080, "0x0000000000000000000000000000000000000000000000000000021ba98f28b6fffffffffffffffffffffffffffffffffffffffffffffffffffffde45670d74a"],
]);
/** Lo que contestó el QuoterV2 (quoteExactInput) en ese bloque: importe de entrada → lo que sale. */
const QUOTER = [
  { side: "buy", amountIn: 100n * HBAR, amountOut: 890_345_285n },
  { side: "buy", amountIn: 5_000n * HBAR, amountOut: 44_048_094_664n },
  { side: "buy", amountIn: 30_000n * HBAR, amountOut: 156_683_241_148n, note: "cruza dos ticks" },
  { side: "buy", amountIn: 200_000n * HBAR, amountOut: 159_514_140_997n, note: "sale del rango y baja hasta la liquidez ancha" },
  { side: "sell", amountIn: 10n * HBAR, amountOut: 11_159_166_021n },
  { side: "sell", amountIn: 300n * HBAR, amountOut: 332_428_945_628n },
  { side: "sell", amountIn: 1_500n * HBAR, amountOut: 1_615_304_484_629n },
];

const state = () => ({ ...decodeSlot0(SLOT0), liquidity: BigInt(LIQUIDITY), tickSpacing: 60 });
const ticksOf = (reads = []) => ({
  getWord: async (/** @type {number} */ w) => {
    reads.push(`w${w}`);
    if (!WORDS.has(w)) throw new Error(`palabra ${w} no grabada`);
    return BigInt(WORDS.get(w));
  },
  getLiquidityNet: async (/** @type {number} */ t) => {
    reads.push(`t${t}`);
    if (!TICKS.has(t)) throw new Error(`tick ${t} no grabado`);
    return signedWordAt(TICKS.get(t), 1);
  },
});

test("0.10.1 · TickMath: los extremos exactos y cada bit como 1,0001^(t/2)", () => {
  assert.equal(getSqrtRatioAtTick(MIN_TICK), MIN_SQRT_RATIO);
  assert.equal(getSqrtRatioAtTick(MAX_TICK), MAX_SQRT_RATIO);
  assert.equal(getSqrtRatioAtTick(0), 1n << 96n);
  for (let k = 0; k < 20; k++) {
    for (const t of [1 << k, -(1 << k)]) {
      if (Math.abs(t) > MAX_TICK) continue;
      const exact = Number(getSqrtRatioAtTick(t)) / 2 ** 96;
      const approx = Math.exp((t * Math.log(1.0001)) / 2);
      assert.ok(Math.abs(exact - approx) / approx < 1e-9, `tick ${t}`);
    }
  }
  assert.throws(() => getSqrtRatioAtTick(MAX_TICK + 1));
});

test("0.10.1 · con el estado de la pool sale lo mismo que el QuoterV2 real, unidad a unidad, en compra y venta", async () => {
  assert.equal(state().tick, -24157);
  for (const q of QUOTER) {
    const reads = [];
    const r = await quoteExactInputLocal(state(), ticksOf(reads), { zeroForOne: q.side === "buy", amountIn: q.amountIn, feePips: 3000, maxSteps: 20 });
    assert.equal(r?.amountOut, q.amountOut, `${q.side} ${q.amountIn / HBAR} ${q.note ?? ""}`);
  }
});

test("0.10.1 · si hace falta leer demasiado o no hay liquidez para todo el importe, no hay cotización", async () => {
  // 10 millones de HBAR: más pasos de los permitidos (y más de lo que la pool puede dar).
  const far = { ...ticksOf(), getWord: async (/** @type {number} */ w) => BigInt(WORDS.get(w) ?? 0) };
  assert.equal(await quoteExactInputLocal(state(), far, { zeroForOne: true, amountIn: 10_000_000n * HBAR, feePips: 3000 }), null);
  // Sin liquidez en ningún sitio: el precio llega al límite y queda importe sin cambiar.
  const empty = { getWord: async () => 0n, getLiquidityNet: async () => 0n };
  assert.equal(await quoteExactInputLocal({ ...state(), liquidity: 0n }, empty, { zeroForOne: false, amountIn: HBAR, feePips: 3000, maxSteps: 2000 }), null);
  assert.equal(await quoteExactInputLocal(state(), ticksOf(), { zeroForOne: true, amountIn: 0n, feePips: 3000 }), null);
  // Una lectura que falla no se convierte en número.
  const broken = { getWord: async () => Promise.reject(new Error("429")), getLiquidityNet: async () => 0n };
  await assert.rejects(quoteExactInputLocal(state(), broken, { zeroForOne: true, amountIn: HBAR, feePips: 3000 }));
});

// ---- quotePool con un mirror como el público ------------------------------------------------------------------

const QUOTER_ADDRESS = longZero(SAUCERSWAP.mainnet.quoterV2).toLowerCase();
const REFUSED = '{"_status":{"messages":[{"message":"Too Many Requests","detail":"Invalid request","data":""}]}}';
const REVERT = '{"_status":{"messages":[{"message":"CONTRACT_REVERT_EXECUTED"}]}}';
const ANSWERS = new Map([
  [POOL_READS.slot0, SLOT0],
  [POOL_READS.liquidity, LIQUIDITY],
  [POOL_READS.tickSpacing, SPACING],
  ...[...WORDS].map(([w, h]) => /** @type {[string, string]} */ ([POOL_READS.tickBitmap + encodeInt256(w), h])),
  ...[...TICKS].map(([t, h]) => /** @type {[string, string]} */ ([POOL_READS.ticks + encodeInt256(t), h])),
]);

/** Mirror como el público: 429 a todo lo que vaya al QuoterV2; las lecturas de la pool, con lo grabado. */
function publicMirror({ poolDown = false } = {}) {
  /** @type {{ to: string, data: string, gas?: number }[]} */
  const calls = [];
  return {
    calls,
    count: (/** @type {string} */ to, /** @type {string} */ prefix = "") => calls.filter((c) => c.to === to && c.data.startsWith(prefix)).length,
    async simulate(/** @type {{ to?: string, data: string, gas?: number }} */ p) {
      const to = String(p.to).toLowerCase();
      const data = String(p.data);
      calls.push({ to, data, gas: p.gas });
      if (to === QUOTER_ADDRESS) return { ok: false, result: "0x", error: REFUSED, status: 429 };
      if (to === POOL && !poolDown && ANSWERS.has(data)) return { ok: true, result: ANSWERS.get(data), error: "", status: 200 };
      return { ok: false, result: "0x", error: REVERT, status: 400 };
    },
  };
}

const setup = swapSetup("mainnet");
const V2 = /** @type {const} */ ({ venue: "V2", address: POOL, fee: 3000 });
const sleep = async () => {};

test("0.10.1 · el mirror rechaza el QuoterV2 (429): la V2 se cotiza con la pool y da lo mismo que el QuoterV2", async () => {
  assert.ok(setup);
  const m = publicMirror();
  let clock = 1_000_000;
  const now = () => clock;
  const buy = await quotePool(m, setup, V2, "buy", 100n * HBAR, { sleep, now });
  assert.deepEqual(buy, { venue: "V2", fee: 3000, address: POOL, amountIn: 100n * HBAR, amountOut: 890_345_285n });
  assert.equal(m.count(QUOTER_ADDRESS), 1, "al QuoterV2 se le pregunta una vez, sin insistir en un 429");
  const sell = await quotePool(m, setup, V2, "sell", 300n * HBAR, { sleep, now });
  assert.equal(sell?.amountOut, 332_428_945_628n);
  assert.equal(m.count(QUOTER_ADDRESS), 1, "a ese mirror ya no se le pregunta al QuoterV2");
  assert.ok(m.calls.filter((c) => c.to === POOL).every((c) => c.gas === POOL_READ_GAS), "lecturas de la pool con poco gas");
  // Pasado el plazo, se vuelve a probar el QuoterV2 (por si el mirror lo vuelve a dejar).
  clock += QUOTER_REFUSED_MS + 1;
  assert.equal((await quotePool(m, setup, V2, "buy", 100n * HBAR, { sleep, now }))?.amountOut, 890_345_285n);
  assert.equal(m.count(QUOTER_ADDRESS), 2);
});

test("0.10.1 · bestSwapQuote lee la pool una sola vez (también para el impacto) y, si la pool no contesta, la marca como fallida", async () => {
  const m = publicMirror();
  const q = await bestSwapQuote(m, setup, [V2], "buy", 5_000n * HBAR, { sleep });
  assert.equal(q?.best.venue, "V2");
  assert.equal(q?.best.amountOut, 44_048_094_664n);
  assert.ok(q?.impactPct != null && q.impactPct > 0 && q.impactPct < 5, `impacto ${q?.impactPct}`);
  assert.equal(m.count(POOL, POOL_READS.slot0), 1, "slot0 una vez para las dos cotizaciones");
  assert.equal(m.count(POOL, POOL_READS.tickBitmap), 1, "la palabra del bitmap, una vez");
  const down = publicMirror({ poolDown: true });
  assert.equal(await bestSwapQuote(down, setup, [V2], "buy", 5_000n * HBAR, { sleep }), null);
  assert.equal(await quotePool(down, setup, V2, "buy", HBAR, { sleep }), null);
});
