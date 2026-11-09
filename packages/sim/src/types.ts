// World state: plain JSON (no classes, Maps, or Dates) so snapshots, clones, and replays are trivial.
import type { Archetype, GatherNodeKey, Good, RecipeKey } from '@saltmarket/shared/config';

export type Pips = number;
export type Inv = Record<Good, number>;
export type AccountKind = 'player' | 'npc' | 'townfund' | 'captain';

export type Account = { id: string; kind: AccountKind; name: string; marks: Pips; inv: Inv };

/** Resting order. Escrow: a sell order holds its goods, a buy order holds price × qty marks. */
export type Order = { id: string; owner: string; venueId: string; good: Good; side: 'buy' | 'sell'; price: Pips; qty: number; tick: number };

export type Job = { id: string; recipe: RecipeKey; started: number; done: number };

export type Factor = { key: string; label: string; value: number | string; unit?: 'pips' | 'pct' | 'count' | 'ticks' | 'text'; of?: number };
export type Reason = { code: string; text: string; detail?: string; factors: Factor[]; tick: number };
export type Decision = { tick: number; reasoning: Reason; repeat: number };

export type Player = {
  id: string;
  joinedTick: number;
  readyAt: number;
  gatheredToday: number;
  jobs: Job[];
  level: number;
  arrears: Pips;
  lastHarborBuyTick: number;
  /** Ids of goods-flow counterparties today, for the anti-wash pair limit. */
  pairTrades: Record<string, number>;
};

export type Investor = { playerId: string; principal: Pips; paidOut: Pips; cap: Pips };

export type Npc = {
  id: string;
  archetype: Archetype;
  status: 'open' | 'paused' | 'closed';
  brokeDays: number;
  closedSince: number | null;
  rescueAt: number | null;
  investor: Investor | null;
  jobs: Job[];
  /** Fractional production carried between ticks, in thousandths of a unit. */
  prodCarry: number;
  /** Production paused by the low-price rule (woodcutters). */
  prodPaused: boolean;
  lowPriceDays: number;
  dayStartMarks: Pips;
  spentToday: Pips;
  /** Last posted price per good and side, for patience smoothing. */
  lastPrice: Record<string, Pips>;
  venueId: string;
  reasoning: Reason;
  recent: Decision[];
};

export type Hall = { id: string; name: string; ownerId: string; feeBps: number; nextFeeBps: number; feeIncomeTotal: Pips };

export type Ship = {
  visit: number;
  docked: boolean;
  arrivalTick: number;
  departureTick: number;
  volume: number;
  filled: number;
  smokehouseSold: number;
  filledAtTick: number | null;
  ceiling: Pips;
  /** The Captain's latest reasoning (he is not a regular merchant). */
  reason: Reason;
};

export type ShockKind = 'storm' | 'fair_winds' | 'salt_glut' | 'flood';
export type ActiveEvent = { id: string; kind: ShockKind; start: number; end: number; good?: Good; qty?: number };

export type Trade = { tick: number; venueId: string; good: Good; qty: number; price: Pips; buyer: string; seller: string };
export type HistoryPoint = { tick: number; median: Pips | null; last: Pips | null; volume: number };

export type WorldState = {
  version: 1;
  seed: number;
  rngState: number;
  tick: number;
  seq: number;
  accounts: Record<string, Account>;
  players: Record<string, Player>;
  npcs: Record<string, Npc>;
  orders: Record<string, Order>;
  halls: Record<string, Hall>;
  nodes: Record<GatherNodeKey, number>;
  ship: Ship;
  events: ActiveEvent[];
  /** Mark supply accounting (ECONOMY §10.1). */
  supply: { genesis: Pips; minted: Pips; burned: Pips };
  /** Good supply accounting (ECONOMY §10.2). */
  goods: { initial: Inv; created: Inv; destroyed: Inv };
  trades: Trade[];
  history: Record<Good, HistoryPoint[]>;
  /** Daily mint/burn totals, newest last (for burn/mint ratio). */
  daily: { day: number; minted: Pips; burned: Pips }[];
  /** Moving average of listed supply per good (for the glut term, ECONOMY §8.5). */
  listedEma: Record<Good, number>;
};

export const TOWN_FUND = 'townfund';
export const CAPTAIN = 'captain';
export const HARBOR = 'harbor';

/** A sim event: feed material for the server. `accountId` marks it as concerning that player. */
export type SimEvent = {
  kind: string;
  text: string;
  notable: boolean;
  accountId?: string;
  private?: boolean;
  npcId?: string;
  good?: Good;
};
