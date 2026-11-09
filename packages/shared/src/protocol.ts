// Saltmarket client ↔ server protocol (the interface between backend and frontend; docs/TEAM_SPLIT.md §2).
//
// RULES FOR CHANGING THIS FILE
// - Additive only: add fields, add message types, add optional properties. Never rename or remove.
//   Additive change → bump PROTOCOL_VERSION minor. Breaking change → bump major and tell the frontend owner.
// - Money is integer pips everywhere (1 mark = 100 pips). The client formats marks for display.
// - Player-facing payloads carry no chain vocabulary. Chain data lives only under `Judge*` schemas.
// - Open-ended code lists (error codes, reason codes, feed kinds, event kinds) are typed as strings so a
//   newer server never breaks an older client. Known values are exported as constants.
// - Clients MUST ignore unknown fields (zod strips them by default) and unknown WS message types.
//
// TRANSPORT
// - REST base: `/api`. Auth: `Authorization: Bearer <token>` from POST /api/auth/login.
// - WebSocket: `/ws?token=<token>`. Without a token the socket is a read-only spectator (`me` is null and
//   commands are rejected with UNAUTHORIZED).
// - On connect the server sends `hello` then `snapshot`. After that: `tick`, `delta`, `feed`, `ack`,
//   `timelapse`, `error`. On reconnect, the client should expect a fresh `snapshot` (or call GET /api/world).

import { z } from 'zod';
import { ARCHETYPES, GATHER_NODES, GOODS, RECIPES } from './config/economy.js';

export const PROTOCOL_VERSION = '0.1.0';

// ───────────────────────────── primitives ─────────────────────────────

/** Integer pips. 1 mark = 100 pips. */
export const Pips = z.number().int();
/** Basis points (1% = 100 bps). */
export const Bps = z.number().int();
export const Tick = z.number().int().nonnegative();
export const Qty = z.number().int().nonnegative();

export const GoodId = z.enum(GOODS);
export const RecipeId = z.enum(RECIPES);
export const GatherNodeId = z.enum(GATHER_NODES);
export const ArchetypeId = z.enum(ARCHETYPES);
/** 'harbor' is the town's free venue; halls are 'hall-<n>'. */
export const VenueId = z.string().min(1);
export const HARBOR_VENUE_ID = 'harbor';
export const NpcId = z.string().min(1);
export const PlayerId = z.string().min(1);
export const OrderId = z.string().min(1);

/** Full inventory: every good present (0 when empty). */
export const Inventory = z.record(GoodId, Qty);
/** Sparse inventory: only goods that matter (e.g., an NPC's stock). */
export const PartialInventory = z.partialRecord(GoodId, Qty);

export const Trend = z.enum(['up', 'down', 'flat']);

// ───────────────────────────── errors ─────────────────────────────

/** Stable error codes. `message` is friendly, player-facing text. New codes may be added. */
export const ERROR_CODES = [
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'NOT_FOUND',
  'INSUFFICIENT_FUNDS',
  'INSUFFICIENT_GOODS',
  'NO_BUYER', // nobody is buying this good at or above your minimum price
  'NO_SELLER', // nobody is selling this good at or below your maximum price
  'COOLDOWN',
  'DAILY_CAP',
  'NODE_DEPLETED',
  'CRAFT_BUSY',
  'STALL_SHUTTERED',
  'SELF_TRADE',
  'NOT_HALL_OWNER',
  'FEE_OUT_OF_RANGE',
  'MERCHANT_OPEN', // invest target is not closed
  'MERCHANT_HAS_INVESTOR',
  'INVEST_OUT_OF_RANGE',
  'MAX_UPGRADE',
  'RATE_LIMITED',
  'TIMELAPSE_BUSY',
  'JUDGE_ONLY',
  'VERSION_MISMATCH',
  'INTERNAL',
] as const;
export type KnownErrorCode = (typeof ERROR_CODES)[number];

export const ApiError = z.object({
  ok: z.literal(false),
  code: z.string(),
  message: z.string(),
});
export type ApiError = z.infer<typeof ApiError>;

/** Every REST success body is `{ ok: true, data }`; every failure is `ApiError`. */
export const apiResult = <T extends z.ZodType>(data: T) =>
  z.union([z.object({ ok: z.literal(true), data }), ApiError]);

// ───────────────────────────── reasoning ─────────────────────────────

/** A single input that drove an NPC decision, ready to show in a tooltip. */
export const ReasonFactor = z.object({
  key: z.string(), // machine key, e.g. 'stock'
  label: z.string(), // "Stock"
  value: z.union([z.number(), z.string()]),
  unit: z.enum(['pips', 'pct', 'count', 'ticks', 'text']).optional(),
  /** Optional comparison value, e.g. target stock for "3 of 14". */
  of: z.number().optional(),
});
export type ReasonFactor = z.infer<typeof ReasonFactor>;

/** Known reason codes (NPC_AGENTS.md §5). New codes may be added. */
export const REASON_CODES = [
  'STEADY',
  'LOW_STOCK_RAISE_ASK',
  'EXCESS_STOCK_DISCOUNT',
  'PRICE_BELOW_COST_PAUSE',
  'MARGIN_NEGATIVE_PAUSE_BUY',
  'STORM_SUPPLY_CUT',
  'SHIP_NEAR_HOLD_STOCK',
  'SWITCH_VENUE_LOWER_FEE',
  'DEMAND_UP_RAISE_ASK',
  'MARKET_GLUT_LOWER_BID',
  'CAPTAIN_CEILING_RAISE',
  'CAPTAIN_CEILING_LOWER',
  'SHOP_CLOSED_BROKE',
  'INVESTMENT_RECEIVED_REOPEN',
  'RESCUED_BY_TOWN_FUND',
] as const;

export const Reasoning = z.object({
  code: z.string(),
  /** One line, e.g. "Salt is scarce, raising my price 12%." */
  text: z.string().min(1),
  /** Key-factor line for tooltips, e.g. "Stock 3 of 14, sold 9 in the last day, margin 16%." */
  detail: z.string().optional(),
  factors: z.array(ReasonFactor),
  tick: Tick,
});
export type Reasoning = z.infer<typeof Reasoning>;

// ───────────────────────────── world pieces ─────────────────────────────

export const Clock = z.object({
  tick: Tick,
  day: z.number().int().nonnegative(), // 0-based game day
  hour: z.number().int().min(0).max(23),
  realMsPerTick: z.number().int().positive(), // current pacing, for client clock interpolation
  speed: z.number().positive(), // 1, 4, 16 …
  paused: z.boolean(),
});
export type Clock = z.infer<typeof Clock>;

/** Static facts that rarely change; sent in the snapshot so the UI never hardcodes numbers. */
export const Catalog = z.object({
  goods: z.array(
    z.object({
      id: GoodId,
      name: z.string(), // "Cured fish"
      anchorPips: Pips,
      spoilsPerDayBps: Bps,
    }),
  ),
  recipes: z.array(
    z.object({
      id: RecipeId,
      name: z.string(), // "Cure fish"
      inputs: PartialInventory,
      outputs: PartialInventory,
      ticks: z.number().int().positive(),
    }),
  ),
  ticksPerDay: z.number().int().positive(),
  harborTaxBps: Bps,
  hallFeeMaxBps: Bps,
  hallLicensePips: Pips,
  stallRentPerDayPips: Pips,
  investMinPips: Pips,
  investMaxPips: Pips,
  gatherCooldownTicks: z.number().int().positive(),
  gatherDailyCap: z.number().int().positive(),
});
export type Catalog = z.infer<typeof Catalog>;

export const Venue = z.object({
  id: VenueId,
  kind: z.enum(['harbor', 'hall']),
  name: z.string(),
  ownerName: z.string().optional(), // halls only
  ownerIsMe: z.boolean(),
  feeBps: Bps, // hall fee (0 for harbor), charged to the seller
  taxBps: Bps, // harbor tax, charged to the seller
  frictionBps: Bps, // harbor friction used in effective-price comparisons (0 for halls)
  volume24hPips: Pips,
  feeIncome24hPips: Pips,
  feeIncomeTotalPips: Pips,
});
export type Venue = z.infer<typeof Venue>;

/** Top-of-book and trend for one good at one venue. Upsert key: `${venueId}:${good}`. */
export const Quote = z.object({
  venueId: VenueId,
  good: GoodId,
  bestBidPips: Pips.nullable(), // best price someone will pay you now
  bestBidQty: Qty,
  bestAskPips: Pips.nullable(), // best price you can buy at now
  bestAskQty: Qty,
  lastPips: Pips.nullable(),
  median2dPips: Pips.nullable(),
  change24hBps: Bps, // signed
  trend: Trend,
  /** Short why-line for price tooltips, e.g. "Fish ▲ 12%: storm reduced the catch". */
  trendReason: z.string().optional(),
  volume24h: Qty,
});
export type Quote = z.infer<typeof Quote>;

/** A resting offer someone can trade against. Upsert key: `id`. */
export const Offer = z.object({
  id: OrderId,
  venueId: VenueId,
  good: GoodId,
  side: z.enum(['buy', 'sell']), // 'buy' = a buy offer you can sell into
  pricePips: Pips,
  qty: Qty, // remaining
  owner: z.object({
    kind: z.enum(['npc', 'player', 'captain']),
    id: z.string(),
    name: z.string(),
    isMe: z.boolean(),
  }),
  /** Present on merchant offers: why this price (tooltip). */
  reason: Reasoning.optional(),
  createdTick: Tick,
});
export type Offer = z.infer<typeof Offer>;

export const GatherNode = z.object({
  id: GatherNodeId,
  name: z.string(), // "Pier"
  good: GoodId,
  stock: Qty,
  cap: Qty,
  regenPerDay: Qty,
  /** Units a gather yields right now (2, 1, or 0 by fullness tier). */
  yieldNow: Qty,
  /** How many players gathered here in the last 24 ticks (crowding signal). */
  gatherers24h: Qty,
});
export type GatherNode = z.infer<typeof GatherNode>;

export const CraftJob = z.object({
  id: z.string(),
  recipe: RecipeId,
  startedTick: Tick,
  doneTick: Tick,
});
export type CraftJob = z.infer<typeof CraftJob>;

export const Investment = z.object({
  npcId: NpcId,
  npcName: z.string(),
  principalPips: Pips,
  paidOutPips: Pips,
  capPips: Pips, // payouts stop at this total (125% of principal)
  active: z.boolean(),
});
export type Investment = z.infer<typeof Investment>;

/** The signed-in player's own state. Full replacement on every delta that includes it. */
export const PlayerView = z.object({
  playerId: PlayerId,
  displayName: z.string(),
  marksPips: Pips,
  inventory: Inventory,
  stall: z.object({
    level: z.number().int().positive(),
    maxLevel: z.number().int().positive(),
    craftSlots: z.number().int().positive(),
    crafting: z.array(CraftJob),
    upgradeCostPips: Pips.nullable(), // null at max level
    rentPerDayPips: Pips,
    rentGraceDaysLeft: z.number().int().nonnegative(),
    arrearsPips: Pips,
    shuttered: z.boolean(),
  }),
  gather: z.object({
    readyAtTick: Tick, // can gather when clock.tick >= readyAtTick
    gatheredToday: Qty,
    dailyCap: Qty,
  }),
  openOrders: z.array(Offer),
  hallIds: z.array(VenueId),
  investments: z.array(Investment),
  netWorthPips: Pips,
});
export type PlayerView = z.infer<typeof PlayerView>;

export const NpcDecision = z.object({
  tick: Tick,
  reasoning: Reasoning,
  /** ×N when the same reason repeated (NPC_AGENTS §5 dedupe). */
  repeat: z.number().int().positive(),
});
export type NpcDecision = z.infer<typeof NpcDecision>;

/** One NPC card. Upsert key: `id`. */
export const NpcCard = z.object({
  id: NpcId,
  name: z.string(), // "Brina"
  title: z.string(), // "Fisherman"
  bio: z.string(), // one line of flavor
  archetype: ArchetypeId,
  status: z.enum(['open', 'paused', 'closed']),
  purse: z.object({ pips: Pips, trend: Trend }),
  inventory: PartialInventory,
  sells: z.array(GoodId),
  buys: z.array(GoodId),
  /** Current headline reason (card line and tooltip). */
  reasoning: Reasoning,
  /** Last 5 meaningful decisions, newest first. */
  recent: z.array(NpcDecision),
  /** Present when status === 'closed'. */
  closed: z
    .object({
      sinceTick: Tick,
      investMinPips: Pips,
      investMaxPips: Pips,
      /** Ticks until the Town Fund rescues it if nobody invests. */
      rescueInTicks: z.number().int().nonnegative(),
    })
    .optional(),
  /** Present while an investor holds a stake. */
  investor: z
    .object({ displayName: z.string(), isMe: z.boolean(), principalPips: Pips, paidOutPips: Pips, capPips: Pips })
    .optional(),
});
export type NpcCard = z.infer<typeof NpcCard>;

export const Ship = z.object({
  captainNpcId: NpcId,
  name: z.string(), // "the Gull"
  status: z.enum(['away', 'docked']),
  ticksToArrival: z.number().int().nonnegative(), // 0 while docked
  ticksToDeparture: z.number().int().nonnegative(), // 0 while away
  ceilingPips: Pips, // the most the Captain pays per cured fish
  volume: Qty, // cured fish wanted this visit
  filled: Qty, // bought so far this visit
});
export type Ship = z.infer<typeof Ship>;

/** Known event kinds. New kinds may be added. */
export const EVENT_KINDS = ['storm', 'fair_winds', 'salt_glut'] as const;
export const ActiveEvent = z.object({
  id: z.string(),
  kind: z.string(),
  label: z.string(), // "Storm"
  description: z.string(), // "Boats stay in. Fish catch down 85% today."
  startedTick: Tick,
  endsTick: Tick,
});
export type ActiveEvent = z.infer<typeof ActiveEvent>;

/** Known feed kinds. New kinds may be added; render unknown kinds as plain lines. */
export const FEED_KINDS = [
  'trade',
  'gather',
  'craft',
  'ship_docked',
  'ship_departed',
  'captain_ceiling',
  'npc_decision',
  'event_start',
  'event_end',
  'MERCHANT_CLOSED',
  'MERCHANT_REOPENED',
  'MERCHANT_RESCUED',
  'investor_payout',
  'hall_licensed',
  'hall_fee_changed',
  'rent',
  'system',
] as const;

export const FeedItem = z.object({
  id: z.string(),
  tick: Tick,
  kind: z.string(),
  text: z.string(), // "Sold 4 cured fish to Captain Maren for 180 marks"
  /** Toast-worthy (storm, closure, reopening, ship docked). */
  notable: z.boolean(),
  /** Concerns the signed-in player directly. */
  mine: z.boolean(),
  npcId: NpcId.optional(),
  good: GoodId.optional(),
  /** ×N when collapsed with identical neighbours. */
  repeat: z.number().int().positive(),
});
export type FeedItem = z.infer<typeof FeedItem>;

export const TownStats = z.object({
  marksSupplyPips: Pips,
  townFundPips: Pips,
  volume24hPips: Pips, // the prosperity meter
  openMerchants: Qty,
  closedMerchants: Qty,
});
export type TownStats = z.infer<typeof TownStats>;

// ───────────────────────────── snapshot & delta ─────────────────────────────

export const WorldSnapshot = z.object({
  protocolVersion: z.string(),
  serverMode: z.enum(['mock', 'live']),
  clock: Clock,
  catalog: Catalog,
  me: PlayerView.nullable(), // null for spectators
  venues: z.array(Venue),
  quotes: z.array(Quote),
  offers: z.array(Offer), // capped; best offers per venue/good
  nodes: z.array(GatherNode),
  npcs: z.array(NpcCard),
  ship: Ship,
  events: z.array(ActiveEvent),
  feed: z.array(FeedItem), // most recent first, capped
  town: TownStats,
});
export type WorldSnapshot = z.infer<typeof WorldSnapshot>;

/**
 * Changes since the previous tick. Apply rules:
 * - `clock`, `me`, `ship`, `town`, `events`: replace wholesale when present.
 * - `venues`, `quotes`, `npcs`, `nodes`, `offers`: upsert by key (see each schema).
 * - `removedOfferIds`: delete those offers.
 * Feed items arrive separately as `{ t:'feed' }`.
 */
export const WorldDelta = z.object({
  clock: Clock,
  me: PlayerView.nullable().optional(),
  venues: z.array(Venue).optional(),
  quotes: z.array(Quote).optional(),
  offers: z.array(Offer).optional(),
  removedOfferIds: z.array(OrderId).optional(),
  nodes: z.array(GatherNode).optional(),
  npcs: z.array(NpcCard).optional(),
  ship: Ship.optional(),
  events: z.array(ActiveEvent).optional(),
  town: TownStats.optional(),
});
export type WorldDelta = z.infer<typeof WorldDelta>;

// ───────────────────────────── time-lapse ("Watch a week") ─────────────────────────────

export const Shock = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('storm'), day: z.number().int().min(0).max(6) }),
  z.object({ kind: z.literal('flood'), good: GoodId, qty: Qty, day: z.number().int().min(0).max(6) }),
  z.object({
    kind: z.literal('close_merchant'),
    npcId: NpcId.optional(), // server picks one if omitted
    day: z.number().int().min(0).max(6),
    /** Day a bot investor reopens it; omit to let the Town Fund rescue it. */
    investDay: z.number().int().min(0).max(6).optional(),
  }),
]);
export type Shock = z.infer<typeof Shock>;

export const TimelapseFrame = z.object({
  tickOffset: z.number().int().nonnegative(), // 0…168 from the start of the sandbox
  day: z.number().int().nonnegative(),
  hour: z.number().int().min(0).max(23),
  prices: z.record(GoodId, Pips.nullable()), // median across venues
  volume: z.record(GoodId, Qty),
  merchants: z.array(z.object({ id: NpcId, name: z.string(), pursePips: Pips, status: z.enum(['open', 'paused', 'closed']) })),
  captainCeilingPips: Pips,
  shipDocked: z.boolean(),
  marksSupplyPips: Pips,
  /** marks burned ÷ marks minted over the trailing day, or null when nothing was minted. */
  burnMintRatio: z.number().nullable(),
  events: z.array(z.string()), // active event kinds
  notes: z.array(z.object({ npcId: NpcId.optional(), name: z.string(), code: z.string(), text: z.string() })),
});
export type TimelapseFrame = z.infer<typeof TimelapseFrame>;

// ───────────────────────────── WS: client → server ─────────────────────────────

const cmd = { cmdId: z.string().min(1).max(64) };

export const ClientMessage = z.discriminatedUnion('t', [
  /** Buy now from the best sell offer at the venue, up to maxPricePips per unit. */
  z.object({ t: z.literal('buy'), ...cmd, good: GoodId, qty: z.number().int().positive(), venueId: VenueId, maxPricePips: Pips.optional() }),
  /** Sell now into the best buy offer at the venue, at no less than minPricePips per unit. */
  z.object({ t: z.literal('sell'), ...cmd, good: GoodId, qty: z.number().int().positive(), venueId: VenueId, minPricePips: Pips.optional() }),
  /** Post a resting sell offer (ask) at your price. */
  z.object({ t: z.literal('list'), ...cmd, good: GoodId, qty: z.number().int().positive(), pricePips: Pips.positive(), venueId: VenueId }),
  /** Post a resting buy offer (halls only). */
  z.object({ t: z.literal('bid'), ...cmd, good: GoodId, qty: z.number().int().positive(), pricePips: Pips.positive(), venueId: VenueId }),
  z.object({ t: z.literal('cancel'), ...cmd, orderId: OrderId }),
  z.object({ t: z.literal('craft'), ...cmd, recipe: RecipeId }),
  z.object({ t: z.literal('upgradeStall'), ...cmd }),
  z.object({ t: z.literal('buyHall'), ...cmd, name: z.string().min(2).max(40).optional() }),
  z.object({ t: z.literal('setHallFee'), ...cmd, hallId: VenueId, bps: Bps.min(0) }),
  z.object({ t: z.literal('gather'), ...cmd, node: GatherNodeId }),
  z.object({ t: z.literal('invest'), ...cmd, npcId: NpcId, amountPips: Pips.positive() }),
  z.object({
    t: z.literal('timelapse'),
    ...cmd,
    action: z.enum(['start', 'stop']),
    days: z.number().int().min(1).max(7).optional(), // default 7
    wallSeconds: z.number().int().min(30).max(120).optional(), // default 60
    shocks: z.array(Shock).max(5).optional(),
  }),
  /** Optional; the server sends everything by default. */
  z.object({ t: z.literal('subscribe'), ...cmd, topics: z.array(z.string()) }),
  z.object({ t: z.literal('ping'), ...cmd }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;
export type ClientMessageType = ClientMessage['t'];

// ───────────────────────────── WS: server → client ─────────────────────────────

/** Structured result attached to a successful ack, so the UI can show "+2 fish" or a trade line. */
export const AckResult = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('trade'),
    side: z.enum(['buy', 'sell']),
    good: GoodId,
    qty: Qty,
    avgPricePips: Pips,
    totalPips: Pips, // what you paid (buy) or received after tax and fee (sell)
    taxPips: Pips,
    feePips: Pips,
    counterparties: z.array(z.string()),
  }),
  z.object({ kind: z.literal('listed'), orderId: OrderId, good: GoodId, qty: Qty, pricePips: Pips }),
  z.object({ kind: z.literal('cancelled'), orderId: OrderId }),
  z.object({ kind: z.literal('gathered'), node: GatherNodeId, good: GoodId, qty: Qty, readyAtTick: Tick }),
  z.object({ kind: z.literal('craft_started'), job: CraftJob }),
  z.object({ kind: z.literal('stall_upgraded'), level: z.number().int().positive() }),
  z.object({ kind: z.literal('hall_bought'), hallId: VenueId }),
  z.object({ kind: z.literal('hall_fee_set'), hallId: VenueId, bps: Bps }),
  z.object({ kind: z.literal('invested'), npcId: NpcId, amountPips: Pips }),
  z.object({ kind: z.literal('timelapse'), timelapseId: z.string() }),
  z.object({ kind: z.literal('none') }),
]);
export type AckResult = z.infer<typeof AckResult>;

export const ServerMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), protocolVersion: z.string(), serverMode: z.enum(['mock', 'live']), playerId: PlayerId.nullable() }),
  z.object({ t: z.literal('snapshot'), world: WorldSnapshot }),
  z.object({ t: z.literal('tick'), tick: Tick, day: z.number().int().nonnegative(), hour: z.number().int().min(0).max(23) }),
  z.object({ t: z.literal('delta'), tick: Tick, changes: WorldDelta }),
  z.object({ t: z.literal('feed'), items: z.array(FeedItem) }),
  z.object({
    t: z.literal('ack'),
    cmdId: z.string(),
    ok: z.boolean(),
    /** Present when ok === false. */
    code: z.string().optional(),
    /** Friendly line for a toast in both cases, e.g. "Sold 2 fish for 19 marks". */
    message: z.string(),
    result: AckResult.optional(),
  }),
  z.object({
    t: z.literal('timelapse'),
    timelapseId: z.string(),
    phase: z.enum(['started', 'frame', 'done', 'stopped']),
    totalTicks: z.number().int().positive(),
    frame: TimelapseFrame.optional(), // present when phase === 'frame'
    /** Present when phase === 'done': a few sentences summarising the week. */
    summary: z.array(z.string()).optional(),
  }),
  /** Unparseable message or socket-level problem with no cmdId to ack. */
  z.object({ t: z.literal('error'), code: z.string(), message: z.string() }),
  z.object({ t: z.literal('pong'), cmdId: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
export type ServerMessageType = ServerMessage['t'];

// ───────────────────────────── REST ─────────────────────────────

/** POST /api/auth/login */
export const LoginRequest = z.object({
  provider: z.enum(['guest', 'social']).default('guest'),
  displayName: z.string().min(1).max(24).optional(),
  /** For provider 'social': the credential returned by the sign-in widget. Shape decided with the frontend. */
  credential: z.string().optional(),
});
export type LoginRequest = z.infer<typeof LoginRequest>;
export const Session = z.object({
  token: z.string(),
  playerId: PlayerId,
  displayName: z.string(),
  provider: z.enum(['guest', 'social']),
});
export type Session = z.infer<typeof Session>;
export const LoginResponse = apiResult(Session);

/** GET /api/world  (Authorization optional; without it `me` is null) */
export const WorldResponse = apiResult(WorldSnapshot);

/** GET /api/market/:good/history?days=5&venueId=harbor */
export const PricePoint = z.object({
  tick: Tick,
  medianPips: Pips.nullable(),
  lastPips: Pips.nullable(),
  volume: Qty,
});
export const MarketHistory = z.object({
  good: GoodId,
  venueId: VenueId.nullable(), // null = all venues combined
  bucketTicks: z.number().int().positive(), // ticks per point
  points: z.array(PricePoint), // oldest first
});
export type MarketHistory = z.infer<typeof MarketHistory>;
export const MarketHistoryResponse = apiResult(MarketHistory);

/** GET /api/npcs */
export const NpcsResponse = apiResult(z.object({ npcs: z.array(NpcCard) }));

/** GET /api/npcs/:id/explain — tooltip payload, generated from merchant-rules.ts */
export const Explain = z.object({
  npcId: NpcId,
  name: z.string(),
  status: z.enum(['open', 'paused', 'closed']),
  reasoning: Reasoning,
  /** Per-good price reasons for the goods this merchant trades. */
  prices: z.array(z.object({ good: GoodId, side: z.enum(['buy', 'sell']), pricePips: Pips, reasoning: Reasoning })),
  /** Path of the rules file, so judges can open it. */
  rulesFile: z.string(),
});
export type Explain = z.infer<typeof Explain>;
export const ExplainResponse = apiResult(Explain);

/** GET /api/leaderboard */
export const LeaderboardEntry = z.object({
  rank: z.number().int().positive(),
  playerId: PlayerId,
  displayName: z.string(),
  isMe: z.boolean(),
  valuePips: Pips,
});
export const Leaderboard = z.object({
  netWorth: z.array(LeaderboardEntry),
  hallIncome: z.array(LeaderboardEntry),
  town: TownStats,
});
export type Leaderboard = z.infer<typeof Leaderboard>;
export const LeaderboardResponse = apiResult(Leaderboard);

/** POST /api/timelapse — frames then stream over the caller's WS (send the same session token). */
export const TimelapseRequest = z.object({
  days: z.number().int().min(1).max(7).optional(),
  wallSeconds: z.number().int().min(30).max(120).optional(),
  shocks: z.array(Shock).max(5).optional(),
});
export const TimelapseResponse = apiResult(z.object({ timelapseId: z.string(), totalTicks: z.number().int().positive() }));

/** GET /healthz (no envelope) */
export const Health = z.object({
  ok: z.boolean(),
  protocolVersion: z.string(),
  serverMode: z.enum(['mock', 'live']),
  tick: Tick,
  ledger: z.object({ mode: z.enum(['memory', 'near']), health: z.enum(['ok', 'degraded', 'offline']), queueDepth: Qty }),
});
export type Health = z.infer<typeof Health>;

// ───────────────────────────── judge / dev (JUDGE_MODE=1 and ?judge=1 only) ─────────────────────────────
// Chain vocabulary is allowed below this line and nowhere else in player-facing payloads.

/** POST /api/dev/event */
export const DevEventRequest = z.object({
  kind: z.enum(['storm', 'fair_winds', 'salt_glut', 'force_broke']),
  npcId: NpcId.optional(), // for force_broke; server picks one if omitted
});
/** POST /api/dev/speed */
export const DevSpeedRequest = z.object({
  speed: z.number().positive().max(64).optional(),
  paused: z.boolean().optional(),
});
export const DevOkResponse = apiResult(z.object({ message: z.string() }));

/** GET /api/judge/ledger?limit=50 */
export const JudgeSettlement = z.object({
  batchId: z.string(), // `${tickFrom}-${tickTo}`
  tickFrom: Tick,
  tickTo: Tick,
  status: z.enum(['queued', 'submitted', 'settled', 'failed']),
  deltaCount: Qty,
  attempts: Qty,
  txHash: z.string().optional(),
  explorerUrl: z.string().optional(),
  error: z.string().optional(),
});
export const JudgeAccount = z.object({
  ownerKind: z.enum(['player', 'npc', 'townfund', 'captain', 'authority']),
  ownerName: z.string(),
  accountId: z.string(),
  explorerUrl: z.string().optional(),
  marksPips: Pips, // sim balance
  ledgerMarksPips: Pips.nullable(), // last reconciled ledger balance
});
export const JudgeLedger = z.object({
  mode: z.enum(['memory', 'near']),
  health: z.enum(['ok', 'degraded', 'offline']),
  network: z.string().nullable(), // 'testnet'
  contractId: z.string().nullable(),
  contractExplorerUrl: z.string().nullable(),
  queueDepth: Qty,
  lastSettledTick: Tick.nullable(),
  settlements: z.array(JudgeSettlement), // newest first
  accounts: z.array(JudgeAccount),
  reconciliation: z.object({ tick: Tick.nullable(), mismatches: Qty }),
});
export type JudgeLedger = z.infer<typeof JudgeLedger>;
export const JudgeLedgerResponse = apiResult(JudgeLedger);

/** Route table, so both sides agree on paths. */
export const ROUTES = {
  login: { method: 'POST', path: '/api/auth/login' },
  world: { method: 'GET', path: '/api/world' },
  marketHistory: { method: 'GET', path: '/api/market/:good/history' },
  npcs: { method: 'GET', path: '/api/npcs' },
  explain: { method: 'GET', path: '/api/npcs/:id/explain' },
  leaderboard: { method: 'GET', path: '/api/leaderboard' },
  timelapse: { method: 'POST', path: '/api/timelapse' },
  judgeLedger: { method: 'GET', path: '/api/judge/ledger' },
  devEvent: { method: 'POST', path: '/api/dev/event' },
  devSpeed: { method: 'POST', path: '/api/dev/speed' },
  health: { method: 'GET', path: '/healthz' },
  ws: { method: 'GET', path: '/ws' },
} as const;
