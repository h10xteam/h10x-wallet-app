// @ts-check
// Cotización de una pool V2 de SaucerSwap (liquidez concentrada, el mismo cálculo que Uniswap v3) a partir de su
// estado: precio, liquidez y ticks. Es lo que hace el QuoterV2 por dentro, pero sin llamarlo: el mirror público de
// Hedera rechaza (429 «Invalid request») las consultas al QuoterV2 aunque sean pocas y con poco gas, mientras que las
// lecturas de la pool (slot0, liquidity, tickBitmap, ticks) sí las contesta.
//
// Traducción literal a BigInt de TickMath, SqrtPriceMath, SwapMath, TickBitmap y el bucle de UniswapV3Pool.swap
// (exactInput). Comprobado con el QuoterV2 real de mainnet en el mismo bloque (test/swapv3.test.mjs): da lo mismo,
// unidad a unidad. Sin dependencias, para poder probarlo en cualquier sitio.

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
const Q96 = 1n << 96n;
const MAX_UINT256 = (1n << 256n) - 1n;
const ONE_MILLION = 1_000_000n;

/** Selectores de las lecturas de la pool. */
export const POOL_READS = Object.freeze({ slot0: "0x3850c7bd", liquidity: "0x1a686502", tickSpacing: "0xd0c93a7c", tickBitmap: "0x5339c296", ticks: "0xf30dba93" });

/** Entero con signo → 32 bytes en complemento a dos (hex, sin 0x). @param {number | bigint} v */
export const encodeInt256 = (v) => ((BigInt(v) + (1n << 256n)) % (1n << 256n)).toString(16).padStart(64, "0");
/** Palabra `i` (32 bytes) de una respuesta, sin signo. @param {string} hex @param {number} i */
export function wordAt(hex, i) {
  const h = String(hex).replace(/^0x/, "");
  const w = h.slice(64 * i, 64 * (i + 1));
  if (w.length !== 64 || /[^0-9a-f]/i.test(w)) throw new Error("respuesta corta");
  return BigInt(`0x${w}`);
}
/** Palabra `i` con signo. @param {string} hex @param {number} i */
export const signedWordAt = (hex, i) => {
  const w = wordAt(hex, i);
  return w >= 1n << 255n ? w - (1n << 256n) : w;
};

/** @param {bigint} a @param {bigint} b @param {bigint} d */
const mulDiv = (a, b, d) => (a * b) / d;
/** @param {bigint} a @param {bigint} b @param {bigint} d */
const mulDivRoundingUp = (a, b, d) => {
  const p = a * b;
  return p / d + (p % d > 0n ? 1n : 0n);
};
/** @param {bigint} a @param {bigint} b */
const divRoundingUp = (a, b) => a / b + (a % b > 0n ? 1n : 0n);

/** TickMath.getSqrtRatioAtTick. @param {number} tick */
export function getSqrtRatioAtTick(tick) {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new Error("tick fuera de rango");
  const abs = BigInt(Math.abs(tick));
  let ratio = abs & 0x1n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  /** @type {[bigint, bigint][]} */
  const steps = [
    [0x2n, 0xfff97272373d413259a46990580e213an],
    [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
    [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
    [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
    [0x20n, 0xff973b41fa98c081472e6896dfb254c0n],
    [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
    [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n],
    [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
    [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
    [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
    [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n],
    [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
    [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n],
    [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
    [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
    [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
    [0x20000n, 0x5d6af8dedb81196699c329225ee604n],
    [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
    [0x80000n, 0x48a170391f7dc42444e8fa2n],
  ];
  for (const [bit, mul] of steps) if (abs & bit) ratio = (ratio * mul) >> 128n;
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/** SqrtPriceMath.getAmount0Delta. @param {bigint} a @param {bigint} b @param {bigint} liquidity @param {boolean} roundUp */
export function getAmount0Delta(a, b, liquidity, roundUp) {
  if (a > b) [a, b] = [b, a];
  const n1 = liquidity << 96n;
  const n2 = b - a;
  return roundUp ? divRoundingUp(mulDivRoundingUp(n1, n2, b), a) : mulDiv(n1, n2, b) / a;
}
/** SqrtPriceMath.getAmount1Delta. @param {bigint} a @param {bigint} b @param {bigint} liquidity @param {boolean} roundUp */
export function getAmount1Delta(a, b, liquidity, roundUp) {
  if (a > b) [a, b] = [b, a];
  return roundUp ? mulDivRoundingUp(liquidity, b - a, Q96) : mulDiv(liquidity, b - a, Q96);
}

/**
 * SqrtPriceMath.getNextSqrtPriceFromInput (solo entrada: se suma al pool). Con los mismos desbordamientos de 256 bits
 * que el contrato, porque cambian el redondeo.
 * @param {bigint} sqrtP @param {bigint} liquidity @param {bigint} amountIn @param {boolean} zeroForOne
 */
export function getNextSqrtPriceFromInput(sqrtP, liquidity, amountIn, zeroForOne) {
  if (sqrtP <= 0n || liquidity <= 0n) throw new Error("precio o liquidez a cero");
  if (amountIn === 0n) return sqrtP;
  if (zeroForOne) {
    const n1 = liquidity << 96n;
    const product = amountIn * sqrtP;
    if (product <= MAX_UINT256) {
      const denominator = n1 + product;
      if (denominator <= MAX_UINT256) return mulDivRoundingUp(n1, sqrtP, denominator);
    }
    return divRoundingUp(n1, n1 / sqrtP + amountIn);
  }
  const next = sqrtP + (amountIn << 96n) / liquidity;
  if (next >= 1n << 160n) throw new Error("precio fuera de rango");
  return next;
}

/**
 * SwapMath.computeSwapStep para una entrada exacta.
 * @param {bigint} current @param {bigint} target @param {bigint} liquidity @param {bigint} remaining @param {number} feePips
 * @returns {{ next: bigint, amountIn: bigint, amountOut: bigint, feeAmount: bigint }}
 */
export function computeSwapStep(current, target, liquidity, remaining, feePips) {
  const fee = BigInt(feePips);
  const zeroForOne = current >= target;
  const lessFee = mulDiv(remaining, ONE_MILLION - fee, ONE_MILLION);
  let amountIn = zeroForOne ? getAmount0Delta(target, current, liquidity, true) : getAmount1Delta(current, target, liquidity, true);
  const next = lessFee >= amountIn ? target : getNextSqrtPriceFromInput(current, liquidity, lessFee, zeroForOne);
  const max = next === target;
  if (zeroForOne) {
    if (!max) amountIn = getAmount0Delta(next, current, liquidity, true);
  } else if (!max) {
    amountIn = getAmount1Delta(current, next, liquidity, true);
  }
  const amountOut = zeroForOne ? getAmount1Delta(next, current, liquidity, false) : getAmount0Delta(current, next, liquidity, false);
  const feeAmount = !max ? remaining - amountIn : mulDivRoundingUp(amountIn, fee, ONE_MILLION - fee);
  return { next, amountIn, amountOut, feeAmount };
}

/** Bit más alto / más bajo puesto (BitMath). @param {bigint} x */
const msb = (x) => x.toString(2).length - 1;
/** @param {bigint} x */
const lsb = (x) => (x & -x).toString(2).length - 1;
/** División entera hacia −∞. @param {number} a @param {number} b */
const floorDiv = (a, b) => Math.floor(a / b);

/**
 * TickBitmap.nextInitializedTickWithinOneWord.
 * @param {(wordPos: number) => Promise<bigint>} getWord @param {number} tick @param {number} spacing @param {boolean} lte
 * @returns {Promise<{ next: number, initialized: boolean }>}
 */
export async function nextInitializedTickWithinOneWord(getWord, tick, spacing, lte) {
  const compressed = floorDiv(tick, spacing);
  if (lte) {
    const wordPos = compressed >> 8;
    const bitPos = ((compressed % 256) + 256) % 256;
    const mask = (1n << BigInt(bitPos)) - 1n + (1n << BigInt(bitPos));
    const masked = (await getWord(wordPos)) & mask;
    return masked !== 0n ? { next: (compressed - (bitPos - msb(masked))) * spacing, initialized: true } : { next: (compressed - bitPos) * spacing, initialized: false };
  }
  const c = compressed + 1;
  const wordPos = c >> 8;
  const bitPos = ((c % 256) + 256) % 256;
  const mask = MAX_UINT256 ^ ((1n << BigInt(bitPos)) - 1n);
  const masked = (await getWord(wordPos)) & mask;
  return masked !== 0n ? { next: (c + (lsb(masked) - bitPos)) * spacing, initialized: true } : { next: (c + (255 - bitPos)) * spacing, initialized: false };
}

/**
 * @typedef {{ sqrtPriceX96: bigint, tick: number, liquidity: bigint, tickSpacing: number }} PoolState
 * @typedef {{ getWord: (wordPos: number) => Promise<bigint>, getLiquidityNet: (tick: number) => Promise<bigint> }} PoolTicks
 */

/**
 * Lo que da la pool por `amountIn` (entrada exacta, sin límite de precio, como el QuoterV2). null si la liquidez no
 * llega para todo el importe (el swap se quedaría a medias) o si hace falta leer demasiado (`maxSteps` pasos).
 * @param {PoolState} state @param {PoolTicks} ticks
 * @param {{ zeroForOne: boolean, amountIn: bigint, feePips: number, maxSteps?: number }} p
 * @returns {Promise<{ amountOut: bigint, sqrtPriceX96After: bigint, ticksCrossed: number } | null>}
 */
export async function quoteExactInputLocal(state, ticks, { zeroForOne, amountIn, feePips, maxSteps = 12 }) {
  if (amountIn <= 0n || state.tickSpacing <= 0) return null;
  const limit = zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n;
  let remaining = amountIn;
  let out = 0n;
  let sqrtP = state.sqrtPriceX96;
  let tick = state.tick;
  let liquidity = state.liquidity;
  let crossed = 0;
  for (let steps = 0; remaining !== 0n && sqrtP !== limit; steps++) {
    if (steps >= maxSteps) return null;
    let { next, initialized } = await nextInitializedTickWithinOneWord(ticks.getWord, tick, state.tickSpacing, zeroForOne);
    if (next < MIN_TICK) next = MIN_TICK;
    else if (next > MAX_TICK) next = MAX_TICK;
    const sqrtNext = getSqrtRatioAtTick(next);
    const target = (zeroForOne ? sqrtNext < limit : sqrtNext > limit) ? limit : sqrtNext;
    const step = computeSwapStep(sqrtP, target, liquidity, remaining, feePips);
    sqrtP = step.next;
    remaining -= step.amountIn + step.feeAmount;
    out += step.amountOut;
    if (sqrtP === sqrtNext) {
      if (initialized) {
        const net = await ticks.getLiquidityNet(next);
        liquidity += zeroForOne ? -net : net;
        if (liquidity < 0n) throw new Error("liquidez negativa");
        crossed++;
      }
      tick = zeroForOne ? next - 1 : next;
    } else if (remaining !== 0n) {
      // El precio no llegó al siguiente tick y aún queda importe: solo pasa al tocar el límite de precio.
      break;
    }
  }
  if (remaining !== 0n) return null;
  return { amountOut: out, sqrtPriceX96After: sqrtP, ticksCrossed: crossed };
}

/** slot0() → precio y tick. @param {string} hex */
export const decodeSlot0 = (hex) => ({ sqrtPriceX96: wordAt(hex, 0), tick: Number(signedWordAt(hex, 1)) });
