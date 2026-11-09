// The single economy config (CLAUDE.md §9). Every tunable number lives here and nowhere else.
// All money values are integer pips (1 mark = 100 pips). Rates are plain fractions.
// Section references point at docs/ECONOMY.md unless stated otherwise.

export const GOODS = ['fish', 'salt', 'timber', 'barrel', 'cured_fish'] as const;
export type Good = (typeof GOODS)[number];

export const RECIPES = ['craft_barrel', 'cure_fish'] as const;
export type RecipeKey = (typeof RECIPES)[number];

export const GATHER_NODES = ['pier', 'pans', 'grove'] as const;
export type GatherNodeKey = (typeof GATHER_NODES)[number];

export const ARCHETYPES = ['fisherman', 'salt_panner', 'woodcutter', 'cooper', 'smokehouse', 'captain'] as const;
export type Archetype = (typeof ARCHETYPES)[number];

export const PIPS_PER_MARK = 100;
/** Convert whole marks to pips for config readability. */
const m = (marks: number): number => Math.round(marks * PIPS_PER_MARK);

export const ECONOMY = {
  // §1 — 1 tick = 1 game hour = 2.5 s real time by default.
  time: { ticksPerDay: 24, realMsPerTick: 2500 },
  currency: { pipsPerMark: PIPS_PER_MARK },

  // §2 — anchors are reference prices for rules and sanity checks, not fixed prices.
  goods: {
    fish: { anchor: m(10), spoilPerDay: 0.04, kind: 'raw' },
    salt: { anchor: m(6), spoilPerDay: 0, kind: 'raw' },
    timber: { anchor: m(8), spoilPerDay: 0, kind: 'raw' },
    barrel: { anchor: m(30), spoilPerDay: 0, kind: 'intermediate' },
    cured_fish: { anchor: m(45), spoilPerDay: 0.005, kind: 'valuable' },
  },

  // §3 — one craft slot on a basic stall.
  recipes: {
    craft_barrel: { in: { timber: 3 }, out: { barrel: 1 }, ticks: 3 },
    cure_fish: { in: { fish: 6, salt: 3, barrel: 1 }, out: { cured_fish: 4 }, ticks: 6 },
  },

  // §4 — player starting kit. Approved loop (2026-11-09): first trade is gather → sell.
  player: {
    startMarks: m(300),
    startInventory: { fish: 5, salt: 2, timber: 0, barrel: 0, cured_fish: 0 },
    rentGraceDays: 3,
    shutterAfterBrokeDays: 5,
  },

  // GAME_DESIGN §4 — stall upgrade adds a second craft slot (cut-list item 7; keep it cheap to remove).
  stall: { maxLevel: 2, upgradeCost: m(250) },

  // §5 faucets/sinks and §6 venues.
  fees: { harborTaxBps: 200, hallFeeMaxBps: 500, harborFrictionBps: 150 },
  sinks: {
    stallRentPerDay: m(15),
    hallLicense: m(400),
    npcLivingCostPerDay: m(15),
    demurrage: { thresholdPips: m(1000), bpsPerDay: 50 },
  },

  // §7 — Captain. Approved loop: the first ship docks ~50 s into a fresh world (tick 20 at 2.5 s/tick).
  captain: {
    firstArrivalTick: 20,
    everyTicks: 48,
    dockTicks: 12,
    volume: 16,
    startCeiling: m(60),
    minCeiling: m(35),
    maxCeiling: m(90),
    fastFillTicks: 6, // filled within this many ticks → ceiling −5%
    lowerBps: 500,
    unfilledRaiseThresholdBps: 2500, // ≥ 25% unfilled → ceiling +10%
    raiseBps: 1000,
  },

  // §5 — Town Fund recycles harbor tax; balance above the cap is burned weekly.
  townFund: { balanceCap: m(5000) },

  // §8.3 — supply elasticity.
  elasticity: 0.8,
  rateFactorClamp: [0.3, 1.8] as const,
  stormWeatherFactor: 0.15,
  stormSecondDayFactor: 0.75,

  // §8.1, §8.2, §8.5 — pricing coefficients (used only by packages/sim/src/pricing/merchant-rules.ts).
  pricing: {
    kStock: 0.4,
    kDemand: 0.25,
    kGlut: 0.3,
    askClampAnchor: [0.5, 2.5] as const,
    demandPressureClamp: [-0.5, 1.0] as const,
    glutClamp: [0, 1.5] as const,
    excessStockMultiple: 2,
    excessStockMaxDiscount: 0.15,
  },

  // §5 — gathering. Approved loop: 10 s cooldown (4 ticks). perPlayerPerDay counts units, not actions.
  gather: {
    cooldownTicks: 4,
    perPlayerPerDay: 12,
    yieldTiers: { fullAtOrAbove: 0.5, fullYield: 2, partialAtOrAbove: 0.15, partialYield: 1 },
    nodes: {
      pier: { good: 'fish', cap: 40, regenPerDay: 20 },
      pans: { good: 'salt', cap: 24, regenPerDay: 10 },
      grove: { good: 'timber', cap: 30, regenPerDay: 15 },
    },
  },

  // §8.6 — closure, investment, rescue.
  merchants: {
    closeAfterDaysBroke: 3,
    investMin: m(150),
    investMax: m(600),
    profitShareBps: 2500,
    payoutCapBps: 12500,
    rescueAfterDays: 5,
    rescueSeed: m(150),
  },

  // §4 + §5 — NPC roster seed values and daily upkeep.
  npcs: {
    fisherman: { count: 3, startCash: m(200), startInventory: { fish: 10 }, baseOutputPerDay: 8, upkeepPerDay: m(20), targetStock: 12 },
    salt_panner: { count: 2, startCash: m(150), startInventory: { salt: 12 }, baseOutputPerDay: 6, upkeepPerDay: m(12), targetStock: 14 },
    woodcutter: { count: 2, startCash: m(150), startInventory: { timber: 15 }, baseOutputPerDay: 10, upkeepPerDay: m(12), targetStock: 15 },
    cooper: { count: 1, startCash: m(300), startInventory: { timber: 6, barrel: 2 }, baseOutputPerDay: 0, upkeepPerDay: m(10), targetStock: 4 },
    // Approved loop: the Smokehouse sells at most ~half the Captain's order per visit, leaving room for players.
    smokehouse: {
      count: 1, startCash: m(600), startInventory: { fish: 10, salt: 6, barrel: 2 }, baseOutputPerDay: 0, upkeepPerDay: m(15), targetStock: 8,
      maxCuredSellPerVisit: 8,
    },
  },

  hallAntiWash: { maxTradesPerPairPerDay: 10 },

  // GAME_LOOP §6 / ARCHITECTURE §3.5 — "Watch a week".
  timelapse: { ticks: 168, targetWallSeconds: 60, frameEveryTicks: 6, minWallSeconds: 30, maxWallSeconds: 120 },
} as const;

export type EconomyConfig = typeof ECONOMY;
