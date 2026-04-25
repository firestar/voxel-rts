// xoshiro128++ — fast, high-quality 32-bit PRNG. Period 2^128 - 1.
// Pinned for sim-critical determinism. Allocates two 32-bit pairs (state).

export class Xoshiro128 {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number) {
    // splitmix32 to expand a 32-bit seed into 4 nonzero state words.
    let x = (seed | 0) || 0x9e3779b9;
    const next = () => {
      x = (x + 0x9e3779b9) | 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next();
  }

  /** Returns a 32-bit unsigned integer. */
  nextU32(): number {
    const result = (Math.imul(this.rotl(this.s0 + this.s3, 7), 1) + this.s0) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = this.rotl(this.s3, 11);
    return result;
  }

  /** Float in [0, 1). 24 bits of randomness. */
  next(): number {
    return (this.nextU32() >>> 8) / 0x1000000;
  }

  /** Uniform int in [lo, hi). */
  intRange(lo: number, hi: number): number {
    return lo + ((this.nextU32() / 0x100000000) * (hi - lo)) | 0;
  }

  private rotl(x: number, k: number): number {
    return (((x << k) | (x >>> (32 - k))) >>> 0);
  }
}

/** Stateless 32-bit integer hash (splitmix-style) — useful for spatially-keyed noise without state. */
export function hash32(x: number, y: number, z: number, seed: number): number {
  let h = (seed ^ Math.imul(x | 0, 0x27d4eb2d)) >>> 0;
  h = Math.imul(h ^ (y | 0), 0x165667b1);
  h = Math.imul(h ^ (z | 0), 0x9e3779b9);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
