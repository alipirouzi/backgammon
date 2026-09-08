/**
 * The engine's dice stream, ported bit for bit from `bg_core::DiceRng`
 * (`engine/bg-core/src/dice.rs`): `ChaCha8Rng::seed_from_u64(seed)` from
 * `rand_chacha` 0.10 / `rand_core` 0.10, one die per accepted 32-bit word
 * with rejection sampling above the largest multiple of six.
 *
 * Why this exists: the engine's `replay` verifies every logged roll against
 * the seed but never fills one in ("turn has no dice"), so the browser must
 * know the next roll before it can append a roll turn. The record stays the
 * single source of truth — every roll drawn here is immediately checked by
 * `replay`, and a divergence would surface as the engine's "logged dice a-b
 * but the seed gives c-d" error rather than being accepted silently.
 *
 * Oracle: `web/tests/dice.test.ts` (the frozen first 100 rolls of seed 42
 * from dice.rs, plus acceptance by the real wasm `replay`).
 */

import type { Dice } from "@/engine/types";

/** The largest seed a record may carry (`bg_core::record::MAX_SEED`, 2^53 − 1). */
export const MAX_SEED = Number.MAX_SAFE_INTEGER;

const MASK32 = BigInt("0xffffffff");
const MASK64 = BigInt("0xffffffffffffffff");
const PCG_MUL = BigInt("0x5851f42d4c957f2d");
const PCG_INC = BigInt("0xa17654e46fbe17f3");
// Shift amounts as BigInt (the tsconfig target predates BigInt literals).
const SHIFT_18 = BigInt(18);
const SHIFT_27 = BigInt(27);
const SHIFT_59 = BigInt(59);

/** `"expand 32-byte k"` as four little-endian words. */
const CHACHA_CONSTANTS = [0x6170_7865, 0x3320_646e, 0x7962_2d32, 0x6b20_6574] as const;
const CHACHA8_DOUBLE_ROUNDS = 4;
const BLOCK_WORDS = 16;

/** Largest multiple of 6 that fits in a u32; words at or above it are rejected. */
const ZONE = 0x1_0000_0000 - (0x1_0000_0000 % 6);

/** Throws unless `seed` is an integer in `0..=MAX_SEED`. */
export function assertSeed(seed: number): void {
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new RangeError(`invalid seed ${seed}: must be an integer in 0..=${MAX_SEED}`);
  }
}

function rotr32(x: number, n: number): number {
  const r = n & 31;
  return r === 0 ? x >>> 0 : ((x >>> r) | (x << (32 - r))) >>> 0;
}

function rotl32(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

/**
 * `rand_core`'s `SeedableRng::seed_from_u64`: a PCG32 stream expands the
 * 64-bit seed into the 32-byte ChaCha key, four little-endian bytes per
 * output — which, read back as little-endian words, is the output itself.
 */
export function seedToKeyWords(seed: number): Uint32Array {
  assertSeed(seed);
  let state = BigInt(seed);
  const key = new Uint32Array(8);
  for (let i = 0; i < key.length; i++) {
    state = (state * PCG_MUL + PCG_INC) & MASK64;
    const xorshifted = Number((((state >> SHIFT_18) ^ state) >> SHIFT_27) & MASK32);
    const rot = Number(state >> SHIFT_59);
    key[i] = rotr32(xorshifted, rot);
  }
  return key;
}

function quarterRound(x: Uint32Array, a: number, b: number, c: number, d: number): void {
  x[a] = (x[a] + x[b]) >>> 0;
  x[d] = rotl32(x[d] ^ x[a], 16);
  x[c] = (x[c] + x[d]) >>> 0;
  x[b] = rotl32(x[b] ^ x[c], 12);
  x[a] = (x[a] + x[b]) >>> 0;
  x[d] = rotl32(x[d] ^ x[a], 8);
  x[c] = (x[c] + x[d]) >>> 0;
  x[b] = rotl32(x[b] ^ x[c], 7);
}

/**
 * ChaCha8 keystream with a 64-bit block counter and a zero 64-bit nonce
 * (`ChaCha::new(&seed, &[0u8; 8])`), emitting words block by block in the
 * order `rand_core::block::BlockRng` hands them out.
 */
class ChaCha8Words {
  private readonly state = new Uint32Array(BLOCK_WORDS);
  private readonly block = new Uint32Array(BLOCK_WORDS);
  private index = BLOCK_WORDS;

  constructor(key: Uint32Array) {
    this.state.set(CHACHA_CONSTANTS, 0);
    this.state.set(key, 4);
    // Words 12–13: block counter (little-endian u64), 14–15: nonce, all zero.
  }

  /** An independent generator at exactly this position of the stream. */
  clone(): ChaCha8Words {
    const copy = new ChaCha8Words(this.state.subarray(4, 12));
    copy.state.set(this.state);
    copy.block.set(this.block);
    copy.index = this.index;
    return copy;
  }

  next(): number {
    if (this.index >= BLOCK_WORDS) {
      this.refill();
    }
    const word = this.block[this.index];
    this.index += 1;
    return word;
  }

  private refill(): void {
    const x = this.block;
    x.set(this.state);
    for (let i = 0; i < CHACHA8_DOUBLE_ROUNDS; i++) {
      quarterRound(x, 0, 4, 8, 12);
      quarterRound(x, 1, 5, 9, 13);
      quarterRound(x, 2, 6, 10, 14);
      quarterRound(x, 3, 7, 11, 15);
      quarterRound(x, 0, 5, 10, 15);
      quarterRound(x, 1, 6, 11, 12);
      quarterRound(x, 2, 7, 8, 13);
      quarterRound(x, 3, 4, 9, 14);
    }
    for (let i = 0; i < BLOCK_WORDS; i++) {
      x[i] = (x[i] + this.state[i]) >>> 0;
    }
    this.index = 0;
    // Increment the 64-bit block counter.
    this.state[12] = (this.state[12] + 1) >>> 0;
    if (this.state[12] === 0) {
      this.state[13] = (this.state[13] + 1) >>> 0;
    }
  }
}

/** The minimal generator interface the record helpers need. */
export interface DieSource {
  /** One die, uniformly in `1..=6`. */
  rollOne(): number;
}

/** A seeded, reproducible dice generator identical to `bg_core::DiceRng`. */
export class DiceRng implements DieSource {
  private readonly words: ChaCha8Words;

  constructor(seed: number, words?: ChaCha8Words) {
    this.words = words ?? new ChaCha8Words(seedToKeyWords(seed));
  }

  /** A copy that continues the same stream independently of this one. */
  clone(): DiceRng {
    return new DiceRng(0, this.words.clone());
  }

  /** Rolls one die, uniformly in `1..=6`. */
  rollOne(): number {
    for (;;) {
      const word = this.words.next();
      if (word < ZONE) {
        return (word % 6) + 1;
      }
    }
  }

  /** Rolls two dice, `hi >= lo`. */
  roll(): Dice {
    const a = this.rollOne();
    const b = this.rollOne();
    return { hi: Math.max(a, b), lo: Math.min(a, b) };
  }
}
