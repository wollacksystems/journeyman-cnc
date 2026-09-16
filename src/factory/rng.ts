/**
 * Deterministic seeded RNG (mulberry32) plus the helpers the factory layers
 * use to stay reproducible.
 *
 * The factory contract: a seed fully determines the generated environment and
 * every scenario script built on it. Two factory runs with the same seed
 * produce identical specs — same geometry, same beat timings, same narration
 * picks — so generated footage is reproducible ground truth for the ingest
 * pipeline (the manifest records the seed for recall/replay).
 *
 * @module
 * @example
 * ```ts
 * import { createRng, hashSeed } from "@/factory/rng.ts";
 *
 * const rng = createRng(2026);
 * rng.next();          // 0.8401877171544095 — same float forever, same seed
 * rng.int(1, 10);      // integer in [1, 10] inclusive
 * rng.pick(["a", "b"]);
 * rng.shuffle(items);  // shallow copy, input untouched
 *
 * // hashSeed turns a string into a seed: stable across machines and runs.
 * const seed = hashSeed("env-00:sensor-trip");
 * ```
 */
export interface Rng {
  /** Next float in [0, 1). */
  next(): number;
  /** Float in [min, max). */
  range(min: number, max: number): number;
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Pick one element. */
  pick<T>(items: readonly T[]): T;
  /** Pick `count` distinct elements (throws when the bank is too small). */
  pickSome<T>(items: readonly T[], count: number): T[];
  /** True with the given probability (0..1). */
  chance(p: number): boolean;
  /** Shallow copy, shuffled without touching the input. */
  shuffle<T>(items: readonly T[]): T[];
}

/**
 * Pure mulberry32 PRNG: same seed -> same float sequence, forever.
 *
 * @example
 * ```ts
 * const a = createRng(7);
 * const b = createRng(7);
 * a.next() === b.next(); // true — the sequence is a function of the seed
 * ```
 */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => {
      if (items.length === 0) throw new Error("rng.pick: empty list");
      return items[Math.floor(next() * items.length)]!;
    },
    pickSome: (items, count) => {
      if (count > items.length) {
        throw new Error(`rng.pickSome: requested ${count} of ${items.length}`);
      }
      return shuffleWith(items, next).slice(0, count);
    },
    chance: (p) => next() < p,
    shuffle: (items) => shuffleWith(items, next),
  };
}

function shuffleWith<T>(items: readonly T[], next: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

/**
 * Stable 32-bit FNV-1a string hash, for deriving sub-seeds from ids.
 *
 * @example
 * ```ts
 * hashSeed("env-00:sensor-trip"); // same value on every machine, every run
 * ```
 */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
