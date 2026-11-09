// Seeded PRNG (mulberry32). State lives in WorldState.rngState so snapshots and clones replay exactly.
// Never use Math.random() in the sim (CLAUDE.md §6.1).
import type { WorldState } from './types.js';

/** Next float in [0, 1), advancing the world's RNG state. */
export function rand(s: WorldState): number {
  s.rngState = (s.rngState + 0x6d2b79f5) >>> 0;
  let x = s.rngState;
  x = Math.imul(x ^ (x >>> 15), x | 1);
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
}

/** Stochastic rounding: 2.3 → 2 (70%) or 3 (30%). Keeps small rates like spoilage unbiased. */
export function roundStochastic(s: WorldState, x: number): number {
  const f = Math.floor(x);
  return f + (rand(s) < x - f ? 1 : 0);
}
