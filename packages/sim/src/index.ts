// Deterministic economy engine. No I/O, no wall clock, no ambient randomness (CLAUDE.md §6.1).
export * from './types.js';
export * from './world.js';
export * from './step.js';
export * from './commands.js';
export * from './invariants.js';
export * from './metrics.js';
export * from './events.js';
export * from './market.js';
export * from './pricing/merchant-rules.js';
export { policyFor } from './npcs/guard.js';
