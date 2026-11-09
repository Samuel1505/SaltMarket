// NPC names, titles, and one-line bios (flavor only; numbers live in economy.ts).
// Shared by the mock server and the real sim so names never drift.
import type { Archetype } from './economy.js';

export type RosterEntry = {
  id: string;
  archetype: Archetype;
  name: string;
  title: string;
  bio: string;
  /** NPC_AGENTS.md §7 personality seeds. */
  personality: { margin: number; riskTolerance: number; patience: number; venueLoyalty: number };
};

export const ROSTER: readonly RosterEntry[] = [
  { id: 'fisher-1', archetype: 'fisherman', name: 'Oskar', title: 'Fisherman', bio: 'Careful with his nets and his prices.', personality: { margin: 0.1, riskTolerance: 0.3, patience: 0.8, venueLoyalty: 0.7 } },
  { id: 'fisher-2', archetype: 'fisherman', name: 'Brina', title: 'Fisherman', bio: 'First out, first to raise her price.', personality: { margin: 0.18, riskTolerance: 0.7, patience: 0.2, venueLoyalty: 0.3 } },
  { id: 'fisher-3', archetype: 'fisherman', name: 'Tam', title: 'Fisherman', bio: 'Fishes when the fishing is fair.', personality: { margin: 0.14, riskTolerance: 0.5, patience: 0.5, venueLoyalty: 0.5 } },
  { id: 'salt-1', archetype: 'salt_panner', name: 'Hester', title: 'Salt-panner', bio: 'Keeps a full shed and a long memory.', personality: { margin: 0.16, riskTolerance: 0.8, patience: 0.7, venueLoyalty: 0.6 } },
  { id: 'salt-2', archetype: 'salt_panner', name: 'Ludo', title: 'Salt-panner', bio: 'Sells what the pans give, no fuss.', personality: { margin: 0.12, riskTolerance: 0.4, patience: 0.5, venueLoyalty: 0.5 } },
  { id: 'wood-1', archetype: 'woodcutter', name: 'Fenn', title: 'Woodcutter', bio: 'Steady axe, thin margins.', personality: { margin: 0.08, riskTolerance: 0.3, patience: 0.6, venueLoyalty: 0.6 } },
  { id: 'wood-2', archetype: 'woodcutter', name: 'Ivo', title: 'Woodcutter', bio: 'Stops cutting when timber is cheap.', personality: { margin: 0.1, riskTolerance: 0.4, patience: 0.5, venueLoyalty: 0.6 } },
  { id: 'cooper', archetype: 'cooper', name: 'Agathe', title: 'Cooper', bio: 'Turns timber into barrels and gossip.', personality: { margin: 0.15, riskTolerance: 0.5, patience: 0.5, venueLoyalty: 0.5 } },
  { id: 'smokehouse', archetype: 'smokehouse', name: "Old Pell's Smokehouse", title: 'Smokehouse', bio: 'Cures fish for the ships. Your main rival.', personality: { margin: 0.18, riskTolerance: 0.6, patience: 0.4, venueLoyalty: 0.4 } },
  { id: 'captain', archetype: 'captain', name: 'Captain Maren', title: 'Ship captain', bio: 'Master of the Gull. Buys cured fish by the crate.', personality: { margin: 0, riskTolerance: 0.5, patience: 0.5, venueLoyalty: 0.5 } },
];

export const SHIP_NAME = 'the Gull';
export const NODE_NAMES = { pier: 'Pier', pans: 'Salt pans', grove: 'Grove' } as const;
export const GOOD_NAMES = { fish: 'Fish', salt: 'Salt', timber: 'Timber', barrel: 'Barrel', cured_fish: 'Cured fish' } as const;
export const RECIPE_NAMES = { craft_barrel: 'Craft barrel', cure_fish: 'Cure fish' } as const;
