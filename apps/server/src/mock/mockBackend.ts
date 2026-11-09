// Scripted, protocol-valid world for `pnpm dev:mock` (docs/TEAM_SPLIT.md §3).
// Not the economy: prices follow a tick-driven script (script.ts) and commands apply simplified rules
// so the frontend can build success and failure states. Replaced by SimBackend behind the same API.
import { randomUUID } from 'node:crypto';
import {
  ECONOMY,
  GATHER_NODES,
  GOOD_NAMES,
  GOODS,
  NODE_NAMES,
  RECIPE_NAMES,
  RECIPES,
  ROSTER,
  SHIP_NAME,
  type Good,
  type GatherNodeKey,
  type RosterEntry,
} from '@saltmarket/shared/config';
import {
  HARBOR_VENUE_ID,
  PROTOCOL_VERSION,
  type ActiveEvent,
  type Catalog,
  type CraftJob,
  type Explain,
  type FeedItem,
  type GatherNode,
  type Health,
  type Investment,
  type JudgeLedger,
  type Leaderboard,
  type MarketHistory,
  type NpcCard,
  type NpcDecision,
  type Offer,
  type PlayerView,
  type Quote,
  type Reasoning,
  type Session,
  type Ship,
  type TimelapseFrame,
  type TownStats,
  type Venue,
  type WorldDelta,
  type WorldSnapshot,
} from '@saltmarket/shared/protocol';
import {
  fail,
  type CommandOutcome,
  type GameBackend,
  type GameCommand,
  type Result,
  type TimelapseEmit,
  type TimelapseHandle,
  type TimelapseOptions,
} from '../backend.js';
import { MOCK_START_TICK, makeRng, pct, priceAt, scriptedStorms, shipPhase, volumeAt, type Interval, type ShockKind } from './script.js';

const E = ECONOMY;
const TPD = E.time.ticksPerDay;
const RULES_FILE = 'packages/sim/src/pricing/merchant-rules.ts';
const marks = (pips: number) => {
  const v = pips / 100;
  return Number.isInteger(v) ? `${v}` : v.toFixed(1);
};

type MockOrder = { id: string; venueId: string; good: Good; side: 'buy' | 'sell'; pricePips: number; qty: number; createdTick: number };

type MockPlayer = {
  id: string;
  name: string;
  marks: number;
  inv: Record<Good, number>;
  readyAt: number;
  gatheredToday: number;
  crafting: CraftJob[];
  level: number;
  orders: MockOrder[];
  halls: string[];
  investments: Investment[];
  joinedTick: number;
  arrears: number;
  lastHarborBuyTick: number;
};

type MockNpc = {
  entry: RosterEntry;
  status: 'open' | 'paused' | 'closed';
  purse: number;
  prevPurse: number;
  inv: Partial<Record<Good, number>>;
  closedSince?: number;
  rescueAt?: number;
  investor?: { playerId: string; displayName: string; principalPips: number; paidOutPips: number; capPips: number };
  reasoning: Reasoning;
  recent: NpcDecision[];
};

type MockHall = { id: string; name: string; ownerId: string | null; ownerName: string; feeBps: number; feeIncomeTotal: number };

/** A feed item plus who may see it. `playerId` marks it as "mine" for that viewer; `private` hides it from others. */
type InternalFeed = { item: Omit<FeedItem, 'mine'>; playerId?: string; private?: boolean };

type Settlement = JudgeLedger['settlements'][number];

const SELLS: Record<string, Good[]> = {
  fisherman: ['fish'], salt_panner: ['salt'], woodcutter: ['timber'], cooper: ['barrel'], smokehouse: ['cured_fish'], captain: [],
};
const BUYS: Record<string, Good[]> = {
  fisherman: [], salt_panner: [], woodcutter: [], cooper: ['timber'], smokehouse: ['fish', 'salt', 'barrel'], captain: ['cured_fish'],
};

export type MockOptions = {
  seed?: number;
  /** Override time-lapse frame spacing (tests). */
  timelapseFrameMs?: number;
};

export class MockBackend implements GameBackend {
  readonly mode = 'mock' as const;

  private tick = MOCK_START_TICK;
  private readonly startTick = MOCK_START_TICK;
  private speed = 1;
  private paused = false;
  private readonly rng: () => number;
  private seq = 0;

  private readonly tokens = new Map<string, string>();
  private readonly players = new Map<string, MockPlayer>();
  private readonly npcMap = new Map<string, MockNpc>();
  private readonly halls = new Map<string, MockHall>();
  private readonly nodeStock: Record<GatherNodeKey, number>;
  private readonly gatherers: Record<GatherNodeKey, number[]> = { pier: [], pans: [], grove: [] };
  private devIntervals: Interval[] = [];

  private ceiling: number = E.captain.startCeiling;
  private shipFilled = 0;
  private shipFilledAtTick: number | null = null;
  private shipVolume: number = E.captain.volume;

  private townFund = 100000;
  private marksSupplyBase = 0;
  private feedLog: InternalFeed[] = [];
  private lastStepFeed: InternalFeed[] = [];
  private prevOfferIds = new Set<string>();
  private removedOfferIds: string[] = [];
  private settlements: Settlement[] = [];
  private activeTimelapses = 0;
  private readonly timelapseFrameMs: number | undefined;

  constructor(opts: MockOptions = {}) {
    this.rng = makeRng(opts.seed ?? 42);
    this.timelapseFrameMs = opts.timelapseFrameMs;
    this.nodeStock = { pier: 30, pans: 18, grove: 24 };
    for (const entry of ROSTER) {
      const cfg = entry.archetype === 'captain' ? undefined : E.npcs[entry.archetype];
      const npc: MockNpc = {
        entry,
        status: 'open',
        purse: cfg?.startCash ?? 0,
        prevPurse: cfg?.startCash ?? 0,
        inv: { ...(cfg?.startInventory ?? {}) },
        reasoning: { code: 'STEADY', text: 'Opening the stall for the day.', factors: [], tick: this.tick },
        recent: [],
      };
      this.npcMap.set(entry.id, npc);
    }
    // Scripted: Ludo the salt-panner starts the demo closed and needing investment.
    this.closeNpc('salt-2', 'Out of cash after a slow week. Closing until someone backs me.', false);
    this.halls.set('hall-1', { id: 'hall-1', name: "Gull's Rest Exchange", ownerId: null, ownerName: 'Wren', feeBps: 300, feeIncomeTotal: 184000 });
    this.marksSupplyBase = this.sumMarks();
    for (const npc of this.npcMap.values()) this.updateReasoning(npc, true);
    this.prevOfferIds = new Set(this.allOffers(null).map((o) => o.id));
  }

  // ───────────── auth ─────────────

  login(provider: 'guest' | 'social', displayName?: string): Result<Session> {
    const id = `p-${randomUUID().slice(0, 8)}`;
    const name = displayName?.trim() || `Guest ${100 + Math.floor(this.rng() * 900)}`;
    const token = randomUUID();
    this.tokens.set(token, id);
    this.players.set(id, {
      id, name, marks: E.player.startMarks, inv: { ...E.player.startInventory }, readyAt: this.tick, gatheredToday: 0,
      crafting: [], level: 1, orders: [], halls: [], investments: [], joinedTick: this.tick, arrears: 0, lastHarborBuyTick: -1,
    });
    this.pushFeed({ kind: 'system', text: `${name} opened a stall at the harbor.`, notable: false }, id);
    return { ok: true, data: { token, playerId: id, displayName: name, provider } };
  }

  /** Mock: any non-empty credential is accepted and always maps to the same player (for building the UI flow). */
  async loginSocial(credential: string, displayName?: string): Promise<Result<Session>> {
    if (!credential.trim()) return fail('BAD_CREDENTIAL', 'Sign-in failed. Please try again.');
    const existing = this.socialPlayers.get(credential);
    const token = randomUUID();
    if (existing) {
      this.tokens.set(token, existing);
      return { ok: true, data: { token, playerId: existing, displayName: this.players.get(existing)!.name, provider: 'social' } };
    }
    const r = this.login('social', displayName);
    if (r.ok) this.socialPlayers.set(credential, r.data.playerId);
    return r;
  }
  private readonly socialPlayers = new Map<string, string>();

  playerForToken(token: string): string | null {
    return this.tokens.get(token) ?? null;
  }

  // ───────────── time ─────────────

  realMsPerTick(): number {
    return Math.max(50, Math.round(E.time.realMsPerTick / this.speed));
  }
  isPaused(): boolean {
    return this.paused;
  }

  step(): void {
    this.lastStepFeed = [];
    const before = this.shipPhaseNow();
    this.tick += 1;
    const t = this.tick;
    const after = this.shipPhaseNow();

    // Events starting/ending.
    for (const iv of this.intervals()) {
      if (iv.start === t) this.pushFeed({ kind: 'event_start', text: eventLabel(iv.kind).start, notable: true });
      if (iv.end === t) this.pushFeed({ kind: 'event_end', text: eventLabel(iv.kind).end, notable: true });
    }

    // Ship arrival / buying / departure.
    if (!before.docked && after.docked) {
      this.shipFilled = 0;
      this.shipFilledAtTick = null;
      this.shipVolume = this.activeKinds(t).has('fair_winds') ? Math.round(E.captain.volume * 1.5) : E.captain.volume;
      this.pushFeed({ kind: 'ship_docked', text: `${SHIP_NAME} has docked. Captain Maren is buying up to ${this.shipVolume} cured fish at ${marks(this.ceiling)} marks or less.`, notable: true, npcId: 'captain', good: 'cured_fish' });
    }
    if (after.docked) this.captainBuysFromSmokehouse();
    if (before.docked && !after.docked) this.shipDeparts();

    // Gather nodes: other townsfolk gather a little; daily regeneration.
    if (t % 6 === 0) for (const n of GATHER_NODES) this.nodeStock[n] = Math.max(0, this.nodeStock[n] - (this.rng() < 0.5 ? 1 : 0));

    // Player crafts and resting orders.
    for (const p of this.players.values()) {
      for (const job of p.crafting.filter((j) => j.doneTick <= t)) {
        const r = E.recipes[job.recipe];
        for (const [g, q] of Object.entries(r.out)) p.inv[g as Good] += q;
        this.pushFeed({ kind: 'craft', text: job.recipe === 'cure_fish' ? 'Your batch is cured: +4 cured fish.' : 'Your barrel is ready: +1 barrel.', notable: false }, p.id, true);
      }
      p.crafting = p.crafting.filter((j) => j.doneTick > t);
      this.fillRestingOrders(p);
    }

    // Daily boundary.
    if (t % TPD === 0) this.dailyBoundary();

    // NPC state and reasoning.
    for (const npc of this.npcMap.values()) {
      npc.prevPurse = npc.purse;
      if (npc.status !== 'closed' && npc.entry.archetype !== 'captain') npc.purse = Math.max(500, npc.purse + Math.round((this.rng() - 0.47) * 300));
      if (npc.status === 'closed' && npc.rescueAt !== undefined && t >= npc.rescueAt && !npc.investor) this.rescueNpc(npc);
      this.updateReasoning(npc, false);
    }

    // Background trades for a lively feed.
    if (t % 5 === 0) this.backgroundTrade();

    // Memory-ledger settlement records (fake but well-formed receipts, ARCHITECTURE §5).
    if (t % 6 === 0) {
      const from = t - 6;
      this.settlements.unshift({ batchId: `${from}-${t}`, tickFrom: from, tickTo: t, status: 'settled', deltaCount: 8 + Math.floor(this.rng() * 20), attempts: 1, txHash: `mem-${(t * 2654435761 >>> 0).toString(16)}` });
      this.settlements = this.settlements.slice(0, 200);
    }

    const ids = new Set(this.allOffers(null).map((o) => o.id));
    this.removedOfferIds = [...this.prevOfferIds].filter((id) => !ids.has(id));
    this.prevOfferIds = ids;
  }

  // ───────────── views ─────────────

  snapshot(playerId: string | null): WorldSnapshot {
    return {
      protocolVersion: PROTOCOL_VERSION,
      serverMode: 'mock',
      clock: this.clock(),
      catalog: this.catalog(),
      me: this.meView(playerId),
      venues: this.venues(playerId),
      quotes: this.quotes(),
      offers: this.allOffers(playerId),
      nodes: this.nodes(),
      npcs: this.npcs_(playerId),
      ship: this.ship(),
      events: this.events(),
      feed: this.feedLog.filter((f) => !f.private || f.playerId === playerId).slice(0, 40).map((f) => personalise(f, playerId)),
      town: this.town(),
    };
  }

  deltaFor(playerId: string | null): WorldDelta {
    return {
      clock: this.clock(),
      me: this.meView(playerId),
      venues: this.venues(playerId),
      quotes: this.quotes(),
      offers: this.allOffers(playerId),
      removedOfferIds: this.removedOfferIds,
      nodes: this.nodes(),
      npcs: this.npcs_(playerId),
      ship: this.ship(),
      events: this.events(),
      town: this.town(),
    };
  }

  feedFor(playerId: string | null): FeedItem[] {
    return this.lastStepFeed
      .filter((f) => !f.private || f.playerId === playerId)
      .map((f) => personalise(f, playerId))
      .reverse();
  }

  /** Feed items created outside a tick (e.g., by a command), for immediate delivery. */
  drainCommandFeed(playerId: string | null): FeedItem[] {
    const items = this.pendingCommandFeed.filter((f) => !f.private || f.playerId === playerId).map((f) => personalise(f, playerId));
    return items.reverse();
  }
  clearCommandFeed(): void {
    this.pendingCommandFeed = [];
  }
  private pendingCommandFeed: InternalFeed[] = [];
  private inCommand = false;

  npcs(playerId: string | null): NpcCard[] {
    return this.npcs_(playerId);
  }

  explain(npcId: string): Result<Explain> {
    const npc = this.npcMap.get(npcId);
    if (!npc) return fail('NOT_FOUND', 'No merchant by that name in town.');
    const prices = this.npcOffers(npc, HARBOR_VENUE_ID).map((o) => ({ good: o.good, side: o.side, pricePips: o.pricePips, reasoning: o.reason ?? npc.reasoning }));
    return { ok: true, data: { npcId, name: npc.entry.name, status: npc.status, reasoning: npc.reasoning, prices, rulesFile: RULES_FILE } };
  }

  history(good: Good, days: number, venueId: string | null): Result<MarketHistory> {
    if (venueId && !this.venueExists(venueId)) return fail('NOT_FOUND', 'No such market.');
    const bucket = 6;
    const from = Math.max(0, this.tick - Math.max(1, Math.min(days, 30)) * TPD);
    const ivs = this.intervals();
    const points = [];
    for (let t = from - (from % bucket); t <= this.tick; t += bucket) {
      const p = priceAt(good, t, ivs);
      let vol = 0;
      for (let k = 0; k < bucket; k++) vol += volumeAt(good, t + k);
      points.push({ tick: t, medianPips: p, lastPips: Math.round(p * (1 + (volumeAt(good, t) - 3) * 0.01)), volume: vol });
    }
    return { ok: true, data: { good, venueId, bucketTicks: bucket, points } };
  }

  leaderboard(playerId: string | null): Leaderboard {
    const rivals = [
      { playerId: 'p-wren', displayName: 'Wren', worth: 168000, hall: 184000 },
      { playerId: 'p-juno', displayName: 'Juno', worth: 92000, hall: 0 },
      { playerId: 'p-pip', displayName: 'Pip', worth: 41000, hall: 0 },
    ];
    const rows = [
      ...rivals,
      ...[...this.players.values()].map((p) => ({ playerId: p.id, displayName: p.name, worth: this.netWorth(p), hall: p.halls.reduce((s, h) => s + (this.halls.get(h)?.feeIncomeTotal ?? 0), 0) })),
    ];
    const rank = (key: 'worth' | 'hall') =>
      [...rows].sort((a, b) => b[key] - a[key]).filter((r) => key === 'worth' || r.hall > 0)
        .map((r, i) => ({ rank: i + 1, playerId: r.playerId, displayName: r.displayName, isMe: r.playerId === playerId, valuePips: r[key] }));
    return { netWorth: rank('worth'), hallIncome: rank('hall'), town: this.town() };
  }

  health(): Health {
    return { ok: true, protocolVersion: PROTOCOL_VERSION, serverMode: 'mock', tick: this.tick, ledger: { mode: 'memory', health: 'ok', queueDepth: 0 } };
  }

  // ───────────── commands ─────────────

  command(playerId: string, msg: GameCommand): CommandOutcome {
    const p = this.players.get(playerId);
    if (!p) return { ok: false, code: 'UNAUTHORIZED', message: 'Please sign in to trade.' };
    this.inCommand = true;
    try {
      return this.runCommand(p, msg);
    } finally {
      this.inCommand = false;
    }
  }

  private runCommand(p: MockPlayer, msg: GameCommand): CommandOutcome {
    const shuttered = p.arrears > 0 && this.tick - p.joinedTick > (E.player.rentGraceDays + E.player.shutterAfterBrokeDays) * TPD;
    const blockedWhenShuttered = ['buy', 'sell', 'list', 'bid', 'craft'];
    if (shuttered && blockedWhenShuttered.includes(msg.t)) return no('STALL_SHUTTERED', 'Your stall is shuttered until you pay the rent you owe.');

    switch (msg.t) {
      case 'gather': {
        if (this.tick < p.readyAt) {
          const secs = Math.ceil(((p.readyAt - this.tick) * this.realMsPerTick()) / 1000);
          return no('COOLDOWN', `You're still catching your breath. Ready again in ${secs} s.`);
        }
        if (p.gatheredToday >= E.gather.perPlayerPerDay) return no('DAILY_CAP', `You've gathered ${E.gather.perPlayerPerDay} today. The ${NODE_NAMES[msg.node].toLowerCase()} will be there tomorrow.`);
        const node = E.gather.nodes[msg.node];
        const yieldNow = this.yieldFor(msg.node);
        if (yieldNow === 0) return no('NODE_DEPLETED', `The ${NODE_NAMES[msg.node].toLowerCase()} is picked clean. It refills overnight.`);
        const qty = Math.min(yieldNow, E.gather.perPlayerPerDay - p.gatheredToday);
        p.inv[node.good] += qty;
        p.gatheredToday += qty;
        p.readyAt = this.tick + E.gather.cooldownTicks;
        this.nodeStock[msg.node] -= qty;
        this.gatherers[msg.node].push(this.tick);
        return yes(`+${qty} ${GOOD_NAMES[node.good].toLowerCase()}`, { kind: 'gathered', node: msg.node, good: node.good, qty, readyAtTick: p.readyAt });
      }

      case 'sell': {
        if (!this.venueExists(msg.venueId)) return no('NOT_FOUND', 'No such market.');
        if (p.inv[msg.good] < msg.qty) return no('INSUFFICIENT_GOODS', `Not enough ${GOOD_NAMES[msg.good].toLowerCase()}: you have ${p.inv[msg.good]}, you tried to sell ${msg.qty}.`);
        const bids = this.allOffers(p.id).filter((o) => o.venueId === msg.venueId && o.good === msg.good && o.side === 'buy' && !o.owner.isMe && o.pricePips >= (msg.minPricePips ?? 0)).sort((a, b) => b.pricePips - a.pricePips);
        if (bids.length === 0) return no('NO_BUYER', `Nobody here is buying ${GOOD_NAMES[msg.good].toLowerCase()}${msg.minPricePips ? ` at ${marks(msg.minPricePips)} marks or more` : ' right now'}.`);
        let left = msg.qty;
        let gross = 0;
        const who = new Set<string>();
        for (const b of bids) {
          let take = Math.min(left, b.qty);
          if (b.owner.kind === 'captain') take = Math.min(take, this.shipVolume - this.shipFilled);
          if (take <= 0) continue;
          left -= take;
          gross += take * b.pricePips;
          who.add(b.owner.name);
          if (b.owner.kind === 'captain') {
            this.shipFilled += take;
            if (this.shipFilled >= this.shipVolume && this.shipFilledAtTick === null) this.shipFilledAtTick = this.tick;
          }
          if (left === 0) break;
        }
        const sold = msg.qty - left;
        if (sold === 0) return no('NO_BUYER', `Nobody here is buying ${GOOD_NAMES[msg.good].toLowerCase()} right now.`);
        const { tax, fee } = this.fees(msg.venueId, gross);
        p.inv[msg.good] -= sold;
        p.marks += gross - tax - fee;
        this.townFund += tax;
        this.creditHall(msg.venueId, fee);
        const names = [...who];
        const text = `Sold ${sold} ${GOOD_NAMES[msg.good].toLowerCase()} to ${names.join(', ')} for ${marks(gross - tax - fee)} marks`;
        this.pushFeed({ kind: 'trade', text, notable: false, good: msg.good }, p.id);
        return yes(text, { kind: 'trade', side: 'sell', good: msg.good, qty: sold, avgPricePips: Math.round(gross / sold), totalPips: gross - tax - fee, taxPips: tax, feePips: fee, counterparties: names });
      }

      case 'buy': {
        if (!this.venueExists(msg.venueId)) return no('NOT_FOUND', 'No such market.');
        if (msg.venueId === HARBOR_VENUE_ID && p.lastHarborBuyTick === this.tick) return no('RATE_LIMITED', 'The Harbor Market allows one purchase per hour. Wait a moment, or trade in a Hall.');
        const asks = this.allOffers(p.id).filter((o) => o.venueId === msg.venueId && o.good === msg.good && o.side === 'sell' && !o.owner.isMe && o.pricePips <= (msg.maxPricePips ?? Infinity)).sort((a, b) => a.pricePips - b.pricePips);
        if (asks.length === 0) return no('NO_SELLER', `Nobody here is selling ${GOOD_NAMES[msg.good].toLowerCase()}${msg.maxPricePips ? ` at ${marks(msg.maxPricePips)} marks or less` : ' right now'}.`);
        let left = msg.qty;
        let cost = 0;
        const who = new Set<string>();
        for (const a of asks) {
          const affordable = Math.floor((p.marks - cost) / a.pricePips);
          const take = Math.min(left, a.qty, affordable);
          if (take <= 0) break;
          left -= take;
          cost += take * a.pricePips;
          who.add(a.owner.name);
          if (left === 0) break;
        }
        const bought = msg.qty - left;
        if (bought === 0) return no('INSUFFICIENT_FUNDS', `Not enough marks: ${GOOD_NAMES[msg.good].toLowerCase()} costs ${marks(asks[0]!.pricePips)} marks and you have ${marks(p.marks)}.`);
        p.marks -= cost;
        p.inv[msg.good] += bought;
        if (msg.venueId === HARBOR_VENUE_ID) p.lastHarborBuyTick = this.tick;
        const { tax, fee } = this.fees(msg.venueId, cost);
        this.townFund += tax;
        this.creditHall(msg.venueId, fee);
        const names = [...who];
        const text = `Bought ${bought} ${GOOD_NAMES[msg.good].toLowerCase()} from ${names.join(', ')} for ${marks(cost)} marks`;
        this.pushFeed({ kind: 'trade', text, notable: false, good: msg.good }, p.id);
        return yes(text, { kind: 'trade', side: 'buy', good: msg.good, qty: bought, avgPricePips: Math.round(cost / bought), totalPips: cost, taxPips: tax, feePips: fee, counterparties: names });
      }

      case 'list': {
        if (!this.venueExists(msg.venueId)) return no('NOT_FOUND', 'No such market.');
        if (p.inv[msg.good] < msg.qty) return no('INSUFFICIENT_GOODS', `Not enough ${GOOD_NAMES[msg.good].toLowerCase()}: you have ${p.inv[msg.good]}, you tried to list ${msg.qty}.`);
        p.inv[msg.good] -= msg.qty;
        const order: MockOrder = { id: `o-${++this.seq}`, venueId: msg.venueId, good: msg.good, side: 'sell', pricePips: msg.pricePips, qty: msg.qty, createdTick: this.tick };
        p.orders.push(order);
        return yes(`Listed ${msg.qty} ${GOOD_NAMES[msg.good].toLowerCase()} at ${marks(msg.pricePips)} marks each`, { kind: 'listed', orderId: order.id, good: msg.good, qty: msg.qty, pricePips: msg.pricePips });
      }

      case 'bid': {
        if (!this.venueExists(msg.venueId)) return no('NOT_FOUND', 'No such market.');
        if (msg.venueId === HARBOR_VENUE_ID) return no('BAD_REQUEST', 'The Harbor Market takes no standing buy offers. Post one in a Hall.');
        const reserve = msg.qty * msg.pricePips;
        if (p.marks < reserve) return no('INSUFFICIENT_FUNDS', `Not enough marks: this offer needs ${marks(reserve)} and you have ${marks(p.marks)}.`);
        p.marks -= reserve;
        const order: MockOrder = { id: `o-${++this.seq}`, venueId: msg.venueId, good: msg.good, side: 'buy', pricePips: msg.pricePips, qty: msg.qty, createdTick: this.tick };
        p.orders.push(order);
        return yes(`Offered to buy ${msg.qty} ${GOOD_NAMES[msg.good].toLowerCase()} at ${marks(msg.pricePips)} marks each`, { kind: 'listed', orderId: order.id, good: msg.good, qty: msg.qty, pricePips: msg.pricePips });
      }

      case 'cancel': {
        const o = p.orders.find((x) => x.id === msg.orderId);
        if (!o) return no('NOT_FOUND', 'That offer is already gone.');
        if (o.side === 'sell') p.inv[o.good] += o.qty;
        else p.marks += o.qty * o.pricePips;
        p.orders = p.orders.filter((x) => x !== o);
        return yes('Offer withdrawn', { kind: 'cancelled', orderId: o.id });
      }

      case 'craft': {
        if (p.crafting.length >= p.level) return no('CRAFT_BUSY', 'Your workbench is busy. Wait for the current batch or upgrade your stall.');
        const r = E.recipes[msg.recipe];
        for (const [g, q] of Object.entries(r.in) as [Good, number][]) {
          if (p.inv[g] < q) return no('INSUFFICIENT_GOODS', `Not enough ${GOOD_NAMES[g].toLowerCase()}: you need ${q}, you have ${p.inv[g]}.`);
        }
        for (const [g, q] of Object.entries(r.in) as [Good, number][]) p.inv[g] -= q;
        const job: CraftJob = { id: `j-${++this.seq}`, recipe: msg.recipe, startedTick: this.tick, doneTick: this.tick + r.ticks };
        p.crafting.push(job);
        return yes(`${RECIPE_NAMES[msg.recipe]}: ready in ${Math.round((r.ticks * this.realMsPerTick()) / 1000)} s`, { kind: 'craft_started', job });
      }

      case 'upgradeStall': {
        if (p.level >= E.stall.maxLevel) return no('MAX_UPGRADE', 'Your stall is already as big as the harbor allows.');
        if (p.marks < E.stall.upgradeCost) return no('INSUFFICIENT_FUNDS', `An upgrade costs ${marks(E.stall.upgradeCost)} marks; you have ${marks(p.marks)}.`);
        p.marks -= E.stall.upgradeCost;
        p.level += 1;
        return yes('Stall upgraded: a second workbench is ready.', { kind: 'stall_upgraded', level: p.level });
      }

      case 'buyHall': {
        if (p.halls.length > 0) return no('BAD_REQUEST', 'You already own an Exchange Hall.');
        if (p.marks < E.sinks.hallLicense) return no('INSUFFICIENT_FUNDS', `A Hall license costs ${marks(E.sinks.hallLicense)} marks; you have ${marks(p.marks)}.`);
        p.marks -= E.sinks.hallLicense;
        const id = `hall-${this.halls.size + 1}`;
        const name = msg.name ?? `${p.name}'s Exchange`;
        this.halls.set(id, { id, name, ownerId: p.id, ownerName: p.name, feeBps: 200, feeIncomeTotal: 0 });
        p.halls.push(id);
        this.pushFeed({ kind: 'hall_licensed', text: `${p.name} opened ${name}, charging a 2% fee.`, notable: true }, p.id);
        return yes(`You own ${name}. Set your fee to attract traders.`, { kind: 'hall_bought', hallId: id });
      }

      case 'setHallFee': {
        const h = this.halls.get(msg.hallId);
        if (!h) return no('NOT_FOUND', 'No such Hall.');
        if (h.ownerId !== p.id) return no('NOT_HALL_OWNER', 'Only the owner can set this Hall’s fee.');
        if (msg.bps < 0 || msg.bps > E.fees.hallFeeMaxBps) return no('FEE_OUT_OF_RANGE', `Fees must be between 0% and ${E.fees.hallFeeMaxBps / 100}%.`);
        h.feeBps = msg.bps;
        this.pushFeed({ kind: 'hall_fee_changed', text: `${h.name} now charges ${msg.bps / 100}%.`, notable: false }, p.id);
        return yes(`Fee set to ${msg.bps / 100}% from the next hour.`, { kind: 'hall_fee_set', hallId: h.id, bps: msg.bps });
      }

      case 'invest': {
        const npc = this.npcMap.get(msg.npcId);
        if (!npc) return no('NOT_FOUND', 'No merchant by that name in town.');
        if (npc.status !== 'closed') return no('MERCHANT_OPEN', `${npc.entry.name} is open for business and doesn't need backing.`);
        if (npc.investor) return no('MERCHANT_HAS_INVESTOR', `${npc.entry.name} already has a backer.`);
        const { investMin, investMax } = E.merchants;
        if (msg.amountPips < investMin || msg.amountPips > investMax) return no('INVEST_OUT_OF_RANGE', `Invest between ${marks(investMin)} and ${marks(investMax)} marks.`);
        if (p.marks < msg.amountPips) return no('INSUFFICIENT_FUNDS', `You have ${marks(p.marks)} marks.`);
        p.marks -= msg.amountPips;
        npc.purse += msg.amountPips;
        const cap = Math.round((msg.amountPips * E.merchants.payoutCapBps) / 10000);
        npc.investor = { playerId: p.id, displayName: p.name, principalPips: msg.amountPips, paidOutPips: 0, capPips: cap };
        p.investments.push({ npcId: npc.entry.id, npcName: npc.entry.name, principalPips: msg.amountPips, paidOutPips: 0, capPips: cap, active: true });
        this.reopenNpc(npc, 'INVESTMENT_RECEIVED_REOPEN', `${p.name} backed me with ${marks(msg.amountPips)} marks. Back in business.`);
        this.pushFeed({ kind: 'MERCHANT_REOPENED', text: `${npc.entry.name} reopened, backed by ${p.name}.`, notable: true, npcId: npc.entry.id }, p.id);
        return yes(`You backed ${npc.entry.name} with ${marks(msg.amountPips)} marks. You'll get 25% of daily profit until you've received ${marks(cap)}.`, { kind: 'invested', npcId: npc.entry.id, amountPips: msg.amountPips });
      }
    }
  }

  // ───────────── time-lapse ─────────────

  startTimelapse(opts: TimelapseOptions, emit: TimelapseEmit): Result<TimelapseHandle> {
    if (this.activeTimelapses >= 3) return fail('TIMELAPSE_BUSY', 'The harbor clerk is busy. Try the time-lapse again in a minute.');
    const id = `tl-${++this.seq}`;
    const totalTicks = opts.days * TPD;
    const step = E.timelapse.frameEveryTicks;
    const frames = Math.floor(totalTicks / step);
    const frameMs = this.timelapseFrameMs ?? Math.round((opts.wallSeconds * 1000) / frames);
    const t0 = this.tick;
    const ivs: Interval[] = this.intervals().filter((iv) => iv.end + 120 > t0);
    const closures: { npcId: string; from: number; to: number; invested: boolean }[] = [];
    for (const s of opts.shocks) {
      const at = t0 + s.day * TPD + 6;
      if (s.kind === 'storm') ivs.push({ id: `${id}-storm`, kind: 'storm', start: at, end: at + 24 });
      if (s.kind === 'flood') ivs.push({ id: `${id}-flood`, kind: 'flood', start: at, end: at + 24, good: s.good });
      if (s.kind === 'close_merchant') {
        const to = s.investDay !== undefined ? t0 + s.investDay * TPD + 6 : at + E.merchants.rescueAfterDays * TPD;
        closures.push({ npcId: s.npcId ?? 'cooper', from: at, to, invested: s.investDay !== undefined });
      }
    }
    let i = 0;
    let stopped = false;
    let peak = { price: 0, day: 0 };
    let ceiling: number = this.ceiling;
    const notesSent = new Set<string>();
    emit({ t: 'timelapse', timelapseId: id, phase: 'started', totalTicks });
    this.activeTimelapses += 1;

    const finish = (phase: 'done' | 'stopped') => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      this.activeTimelapses -= 1;
      const endFish = priceAt('fish', t0 + totalTicks, ivs);
      const summary = phase === 'done'
        ? [
            `Fish peaked at ${marks(peak.price)} marks on day ${peak.day + 1} and ended the week at ${marks(endFish)} marks.`,
            `Captain Maren's ceiling finished at ${marks(ceiling)} marks per cured fish.`,
            closures.length ? `Closed shops reopened ${closures.some((c) => c.invested) ? 'with a backer' : 'with Town Fund help'}.` : 'No shop closed this week.',
            'No patch, no tweaks: every change came from merchants reacting to stock and demand.',
          ]
        : undefined;
      emit({ t: 'timelapse', timelapseId: id, phase, totalTicks, ...(summary ? { summary } : {}) });
    };

    const timer = setInterval(() => {
      if (stopped) return;
      i += 1;
      const off = i * step;
      const t = t0 + off;
      const prices = Object.fromEntries(GOODS.map((g) => [g, priceAt(g, t, ivs)])) as Record<Good, number>;
      const volume = Object.fromEntries(GOODS.map((g) => [g, volumeAt(g, t) * step])) as Record<Good, number>;
      if (prices.fish > peak.price) peak = { price: prices.fish, day: Math.floor(off / TPD) };
      const kinds = [...new Set(ivs.filter((iv) => iv.start <= t && t < iv.end).map((iv) => iv.kind))];
      const ph = shipPhase(t, this.startTick);
      const notes: TimelapseFrame['notes'] = [];
      const note = (key: string, n: TimelapseFrame['notes'][number]) => {
        if (!notesSent.has(key)) { notesSent.add(key); notes.push(n); }
      };
      for (const iv of ivs) {
        if (iv.start <= t && t < iv.start + step && iv.kind === 'storm') {
          note(`${iv.id}-a`, { npcId: 'fisher-2', name: 'Brina', code: 'STORM_SUPPLY_CUT', text: 'Storm kept the boats in. Stock is low, raising my price 20%.' });
          note(`${iv.id}-b`, { npcId: 'smokehouse', name: "Old Pell's Smokehouse", code: 'MARGIN_NEGATIVE_PAUSE_BUY', text: 'Fish is too dear to cure at a profit. Pausing purchases.' });
        }
        if (iv.start <= t && t < iv.start + step && iv.kind === 'flood') note(`${iv.id}-a`, { npcId: 'cooper', name: 'Agathe', code: 'MARKET_GLUT_LOWER_BID', text: `${GOOD_NAMES[iv.good ?? 'timber']} is flooding in. Lowering my bid 30%.` });
        if (iv.end <= t && t < iv.end + 3 * TPD && t >= iv.end + 2 * TPD && iv.kind === 'storm') note(`${iv.id}-c`, { npcId: 'smokehouse', name: "Old Pell's Smokehouse", code: 'STEADY', text: 'Fish is back near normal. Curing again.' });
      }
      if (ph.docked && ph.ticksToDeparture <= step) {
        const raise = kinds.includes('storm') || ivs.some((iv) => iv.kind === 'storm' && iv.end <= t && t < iv.end + 36);
        ceiling = Math.max(E.captain.minCeiling, Math.min(E.captain.maxCeiling, Math.round(ceiling * (raise ? 1.1 : 0.97))));
        note(`ship-${ph.visit}`, { npcId: 'captain', name: 'Captain Maren', code: raise ? 'CAPTAIN_CEILING_RAISE' : 'CAPTAIN_CEILING_LOWER', text: raise ? `Only part of my order filled. Raising my ceiling to ${marks(ceiling)} marks.` : `Plenty of cured fish. Easing my ceiling to ${marks(ceiling)} marks.` });
      }
      for (const c of closures) {
        if (c.from <= t && t < c.from + step) note(`${c.npcId}-close`, { npcId: c.npcId, name: this.npcMap.get(c.npcId)?.entry.name ?? c.npcId, code: 'SHOP_CLOSED_BROKE', text: 'Out of cash. Closing until someone backs me.' });
        if (c.to <= t && t < c.to + step) note(`${c.npcId}-open`, { npcId: c.npcId, name: this.npcMap.get(c.npcId)?.entry.name ?? c.npcId, code: c.invested ? 'INVESTMENT_RECEIVED_REOPEN' : 'RESCUED_BY_TOWN_FUND', text: c.invested ? 'A backer stepped in. Back in business.' : 'The Town Fund tided me over. Reopening.' });
      }
      const merchants = ROSTER.filter((r) => r.archetype !== 'captain').map((r, k) => {
        const closed = closures.some((c) => c.npcId === r.id && c.from <= t && t < c.to);
        const paused = r.archetype === 'smokehouse' && kinds.includes('storm');
        const base = r.archetype === 'captain' ? 0 : E.npcs[r.archetype].startCash;
        return { id: r.id, name: r.name, pursePips: closed ? 400 : Math.max(500, Math.round(base * (1 + 0.15 * Math.sin(t / (9 + k))))), status: closed ? ('closed' as const) : paused ? ('paused' as const) : ('open' as const) };
      });
      emit({
        t: 'timelapse', timelapseId: id, phase: 'frame', totalTicks,
        frame: {
          tickOffset: off, day: Math.floor(off / TPD), hour: t % TPD, prices, volume, merchants,
          captainCeilingPips: ceiling, shipDocked: ph.docked,
          marksSupplyPips: Math.round(this.marksSupplyBase * (1 + 0.04 * Math.sin(t / 40))),
          burnMintRatio: Math.round((0.97 + 0.08 * Math.sin(t / 17)) * 100) / 100,
          events: kinds, notes,
        },
      });
      if (off >= totalTicks) finish('done');
    }, frameMs);

    return { ok: true, data: { id, totalTicks, stop: () => finish('stopped') } };
  }

  // ───────────── dev / judge ─────────────

  devEvent(kind: 'storm' | 'fair_winds' | 'salt_glut' | 'force_broke', npcId?: string): Result<{ message: string }> {
    if (kind === 'force_broke') {
      const id = npcId ?? 'cooper';
      const npc = this.npcMap.get(id);
      if (!npc || npc.entry.archetype === 'captain') return fail('NOT_FOUND', 'Pick a merchant to bankrupt (not the Captain).');
      if (npc.status === 'closed') return fail('BAD_REQUEST', `${npc.entry.name} is already closed.`);
      npc.purse = 300;
      this.closeNpc(id, 'Out of cash. Closing until someone backs me.', true);
      return { ok: true, data: { message: `${npc.entry.name} went broke and closed.` } };
    }
    if (this.activeKinds(this.tick + 1).has(kind)) return fail('BAD_REQUEST', `A ${eventLabel(kind).name.toLowerCase()} is already under way.`);
    this.devIntervals.push({ id: `${kind}-${this.tick + 1}`, kind, start: this.tick + 1, end: this.tick + 1 + TPD });
    return { ok: true, data: { message: `${eventLabel(kind).name} starts next hour.` } };
  }

  devSpeed(speed?: number, paused?: boolean): Result<{ message: string }> {
    if (speed !== undefined) this.speed = speed;
    if (paused !== undefined) this.paused = paused;
    return { ok: true, data: { message: this.paused ? 'Paused.' : `Speed ${this.speed}×.` } };
  }

  judgeLedger(limit: number): JudgeLedger {
    const accounts: JudgeLedger['accounts'] = [
      ...[...this.npcMap.values()].map((n) => ({ ownerKind: n.entry.archetype === 'captain' ? ('captain' as const) : ('npc' as const), ownerName: n.entry.name, accountId: `${n.entry.id}.saltmarket.local`, marksPips: n.purse, ledgerMarksPips: n.purse })),
      { ownerKind: 'townfund', ownerName: 'Town Fund', accountId: 'townfund.saltmarket.local', marksPips: this.townFund, ledgerMarksPips: this.townFund },
      ...[...this.players.values()].map((p) => ({ ownerKind: 'player' as const, ownerName: p.name, accountId: `${p.id}.saltmarket.local`, marksPips: p.marks, ledgerMarksPips: p.marks })),
    ];
    return {
      mode: 'memory', health: 'ok', network: null, contractId: null, contractExplorerUrl: null, queueDepth: 0,
      lastSettledTick: this.settlements[0]?.tickTo ?? null,
      settlements: this.settlements.slice(0, Math.max(1, Math.min(limit, 200))),
      accounts,
      reconciliation: { tick: this.tick - (this.tick % TPD), mismatches: 0 },
    };
  }

  // ───────────── internals: view builders ─────────────

  private clock(): WorldSnapshot['clock'] {
    return { tick: this.tick, day: Math.floor(this.tick / TPD), hour: this.tick % TPD, realMsPerTick: this.realMsPerTick(), speed: this.speed, paused: this.paused };
  }

  private catalog(): Catalog {
    return {
      goods: GOODS.map((g) => ({ id: g, name: GOOD_NAMES[g], anchorPips: E.goods[g].anchor, spoilsPerDayBps: Math.round(E.goods[g].spoilPerDay * 10000) })),
      recipes: RECIPES.map((r) => ({ id: r, name: RECIPE_NAMES[r], inputs: { ...E.recipes[r].in }, outputs: { ...E.recipes[r].out }, ticks: E.recipes[r].ticks })),
      ticksPerDay: TPD,
      harborTaxBps: E.fees.harborTaxBps,
      hallFeeMaxBps: E.fees.hallFeeMaxBps,
      hallLicensePips: E.sinks.hallLicense,
      stallRentPerDayPips: E.sinks.stallRentPerDay,
      investMinPips: E.merchants.investMin,
      investMaxPips: E.merchants.investMax,
      gatherCooldownTicks: E.gather.cooldownTicks,
      gatherDailyCap: E.gather.perPlayerPerDay,
    };
  }

  private meView(playerId: string | null): PlayerView | null {
    const p = playerId ? this.players.get(playerId) : undefined;
    if (!p) return null;
    const graceLeft = Math.max(0, E.player.rentGraceDays - Math.floor((this.tick - p.joinedTick) / TPD));
    return {
      playerId: p.id,
      displayName: p.name,
      marksPips: p.marks,
      inventory: { ...p.inv },
      stall: {
        level: p.level, maxLevel: E.stall.maxLevel, craftSlots: p.level, crafting: p.crafting.map((j) => ({ ...j })),
        upgradeCostPips: p.level >= E.stall.maxLevel ? null : E.stall.upgradeCost,
        rentPerDayPips: E.sinks.stallRentPerDay, rentGraceDaysLeft: graceLeft, arrearsPips: p.arrears,
        shuttered: p.arrears > 0 && this.tick - p.joinedTick > (E.player.rentGraceDays + E.player.shutterAfterBrokeDays) * TPD,
      },
      gather: { readyAtTick: p.readyAt, gatheredToday: p.gatheredToday, dailyCap: E.gather.perPlayerPerDay },
      openOrders: p.orders.map((o) => this.orderToOffer(o, p, playerId)),
      hallIds: [...p.halls],
      investments: p.investments.map((i) => ({ ...i })),
      netWorthPips: this.netWorth(p),
    };
  }

  private venues(playerId: string | null): Venue[] {
    const harbor: Venue = {
      id: HARBOR_VENUE_ID, kind: 'harbor', name: 'Harbor Market', ownerIsMe: false, feeBps: 0, taxBps: E.fees.harborTaxBps, frictionBps: E.fees.harborFrictionBps,
      volume24hPips: this.volume24h(1), feeIncome24hPips: 0, feeIncomeTotalPips: 0,
    };
    const halls = [...this.halls.values()].map((h) => ({
      id: h.id, kind: 'hall' as const, name: h.name, ownerName: h.ownerName, ownerIsMe: h.ownerId !== null && h.ownerId === playerId,
      feeBps: h.feeBps, taxBps: E.fees.harborTaxBps, frictionBps: 0,
      volume24hPips: this.volume24h(h.ownerId ? 0.2 : 0.5), feeIncome24hPips: Math.round((this.volume24h(h.ownerId ? 0.2 : 0.5) * h.feeBps) / 10000), feeIncomeTotalPips: h.feeIncomeTotal,
    }));
    return [harbor, ...halls];
  }

  private quotes(): Quote[] {
    const offers = this.allOffers(null);
    const ivs = this.intervals();
    const out: Quote[] = [];
    for (const v of [HARBOR_VENUE_ID, ...this.halls.keys()]) {
      for (const g of GOODS) {
        const here = offers.filter((o) => o.venueId === v && o.good === g);
        const bids = here.filter((o) => o.side === 'buy').sort((a, b) => b.pricePips - a.pricePips);
        const asks = here.filter((o) => o.side === 'sell').sort((a, b) => a.pricePips - b.pricePips);
        const now = priceAt(g, this.tick, ivs);
        const dayAgo = priceAt(g, this.tick - TPD, ivs);
        const change = Math.round(((now - dayAgo) / dayAgo) * 10000);
        const trend = change > 100 ? 'up' : change < -100 ? 'down' : 'flat';
        let median = 0;
        for (let k = 0; k < 8; k++) median += priceAt(g, this.tick - k * 6, ivs);
        const reason = trendReason(g, change, this.activeKinds(this.tick), ivs, this.tick);
        out.push({
          venueId: v, good: g,
          bestBidPips: bids[0]?.pricePips ?? null, bestBidQty: bids[0]?.qty ?? 0,
          bestAskPips: asks[0]?.pricePips ?? null, bestAskQty: asks[0]?.qty ?? 0,
          lastPips: now, median2dPips: Math.round(median / 8), change24hBps: change, trend,
          ...(reason ? { trendReason: reason } : {}),
          volume24h: v === HARBOR_VENUE_ID ? Array.from({ length: TPD }, (_, k) => volumeAt(g, this.tick - k)).reduce((a, b) => a + b, 0) : Math.round(volumeAt(g, this.tick) * 4),
        });
      }
    }
    return out;
  }

  private allOffers(playerId: string | null): Offer[] {
    const out: Offer[] = [];
    const venues = [HARBOR_VENUE_ID, 'hall-1'];
    for (const npc of this.npcMap.values()) for (const v of venues) out.push(...this.npcOffers(npc, v));
    for (const p of this.players.values()) for (const o of p.orders) out.push(this.orderToOffer(o, p, playerId));
    return out;
  }

  /** Offers an NPC currently shows at a venue (derived from the script + its state). */
  private npcOffers(npc: MockNpc, venueId: string): Offer[] {
    if (npc.status === 'closed') return [];
    const a = npc.entry.archetype;
    const ivs = this.intervals();
    const inHall = venueId !== HARBOR_VENUE_ID;
    // In the hall, only a few merchants trade (venue choice by effective cost, ECONOMY §6.3).
    if (inHall && !['fisher-2', 'salt-1', 'smokehouse'].includes(npc.entry.id)) return [];
    const out: Offer[] = [];
    const tilt = 1 + (npc.entry.personality.margin - 0.14) * 0.5;
    const owner = { kind: a === 'captain' ? ('captain' as const) : ('npc' as const), id: npc.entry.id, name: npc.entry.name, isMe: false };
    for (const g of SELLS[a] ?? []) {
      const p = priceAt(g, this.tick, ivs);
      const qty = Math.max(1, Math.round((npc.inv[g] ?? 6) * (this.activeKinds(this.tick).has('storm') && g === 'fish' ? 0.3 : 1)));
      out.push({ id: `${npc.entry.id}:${venueId}:${g}:sell`, venueId, good: g, side: 'sell', pricePips: Math.round(p * (inHall ? 1.02 : 1.05) * tilt), qty, owner, reason: this.priceReason(npc, g, 'sell'), createdTick: this.tick - (this.tick % 6) });
    }
    const pausedFish = a === 'smokehouse' && npc.status === 'paused';
    for (const g of BUYS[a] ?? []) {
      if (pausedFish && g === 'fish') continue;
      if (a === 'captain') {
        const ph = this.shipPhaseNow();
        if (!ph.docked || inHall || this.shipFilled >= this.shipVolume) continue;
        out.push({ id: `captain:${venueId}:cured_fish:buy`, venueId, good: g, side: 'buy', pricePips: this.ceiling, qty: this.shipVolume - this.shipFilled, owner, reason: this.priceReason(npc, g, 'buy'), createdTick: ph.arrivalTick });
        continue;
      }
      const p = priceAt(g, this.tick, ivs);
      out.push({ id: `${npc.entry.id}:${venueId}:${g}:buy`, venueId, good: g, side: 'buy', pricePips: Math.round(p * (inHall ? 0.95 : 0.92)), qty: g === 'barrel' ? 2 : 8, owner, reason: this.priceReason(npc, g, 'buy'), createdTick: this.tick - (this.tick % 6) });
    }
    return out;
  }

  private orderToOffer(o: MockOrder, p: MockPlayer, viewer: string | null): Offer {
    return { id: o.id, venueId: o.venueId, good: o.good, side: o.side, pricePips: o.pricePips, qty: o.qty, owner: { kind: 'player', id: p.id, name: p.name, isMe: p.id === viewer }, createdTick: o.createdTick };
  }

  private nodes(): GatherNode[] {
    return GATHER_NODES.map((id) => {
      const n = E.gather.nodes[id];
      this.gatherers[id] = this.gatherers[id].filter((t) => t > this.tick - TPD);
      return { id, name: NODE_NAMES[id], good: n.good, stock: this.nodeStock[id], cap: n.cap, regenPerDay: n.regenPerDay, yieldNow: this.yieldFor(id), gatherers24h: this.gatherers[id].length };
    });
  }

  private npcs_(playerId: string | null): NpcCard[] {
    return [...this.npcMap.values()].map((n) => {
      const card: NpcCard = {
        id: n.entry.id, name: n.entry.name, title: n.entry.title, bio: n.entry.bio, archetype: n.entry.archetype, status: n.status,
        purse: { pips: n.purse, trend: n.purse > n.prevPurse ? 'up' : n.purse < n.prevPurse ? 'down' : 'flat' },
        inventory: { ...n.inv }, sells: [...(SELLS[n.entry.archetype] ?? [])], buys: [...(BUYS[n.entry.archetype] ?? [])],
        reasoning: n.reasoning, recent: n.recent.slice(0, 5),
      };
      if (n.status === 'closed' && n.closedSince !== undefined) {
        card.closed = { sinceTick: n.closedSince, investMinPips: E.merchants.investMin, investMaxPips: E.merchants.investMax, rescueInTicks: Math.max(0, (n.rescueAt ?? this.tick) - this.tick) };
      }
      if (n.investor) {
        const { displayName, principalPips, paidOutPips, capPips, playerId: pid } = n.investor;
        card.investor = { displayName, isMe: pid === playerId, principalPips, paidOutPips, capPips };
      }
      return card;
    });
  }

  private ship(): Ship {
    const ph = this.shipPhaseNow();
    return {
      captainNpcId: 'captain', name: SHIP_NAME, status: ph.docked ? 'docked' : 'away', ticksToArrival: ph.ticksToArrival, ticksToDeparture: ph.ticksToDeparture,
      ceilingPips: this.ceiling, volume: ph.docked ? this.shipVolume : E.captain.volume, filled: ph.docked ? this.shipFilled : 0,
    };
  }

  private events(): ActiveEvent[] {
    return this.intervals()
      .filter((iv) => iv.start <= this.tick && this.tick < iv.end)
      .map((iv) => ({ id: iv.id, kind: iv.kind, label: eventLabel(iv.kind).name, description: eventLabel(iv.kind).description, startedTick: iv.start, endsTick: iv.end }));
  }

  private town(): TownStats {
    const all = [...this.npcMap.values()].filter((n) => n.entry.archetype !== 'captain');
    return {
      marksSupplyPips: this.sumMarks(), townFundPips: this.townFund, volume24hPips: this.volume24h(1.6),
      openMerchants: all.filter((n) => n.status !== 'closed').length, closedMerchants: all.filter((n) => n.status === 'closed').length,
    };
  }

  // ───────────── internals: behaviour ─────────────

  private intervals(): Interval[] {
    return [...scriptedStorms(this.startTick, this.tick + 2 * TPD), ...this.devIntervals];
  }

  private activeKinds(t: number): Set<ShockKind> {
    return new Set(this.intervals().filter((iv) => iv.start <= t && t < iv.end).map((iv) => iv.kind));
  }

  private shipPhaseNow() {
    return shipPhase(this.tick, this.startTick);
  }

  private yieldFor(node: GatherNodeKey): number {
    const frac = this.nodeStock[node] / E.gather.nodes[node].cap;
    const y = E.gather.yieldTiers;
    return frac >= y.fullAtOrAbove ? y.fullYield : frac >= y.partialAtOrAbove ? y.partialYield : 0;
  }

  private venueExists(id: string): boolean {
    return id === HARBOR_VENUE_ID || this.halls.has(id);
  }

  private fees(venueId: string, gross: number): { tax: number; fee: number } {
    const tax = Math.round((gross * E.fees.harborTaxBps) / 10000);
    const fee = Math.round((gross * (this.halls.get(venueId)?.feeBps ?? 0)) / 10000);
    return { tax, fee };
  }

  private creditHall(venueId: string, fee: number): void {
    const h = this.halls.get(venueId);
    if (!h || fee === 0) return;
    h.feeIncomeTotal += fee;
    const owner = h.ownerId ? this.players.get(h.ownerId) : undefined;
    if (owner) owner.marks += fee;
  }

  private captainBuysFromSmokehouse(): void {
    // The Smokehouse sells at most ~half the order per visit (approved loop), leaving room for players.
    const cap = E.npcs.smokehouse.maxCuredSellPerVisit;
    const storm = this.activeKinds(this.tick).has('storm');
    if (this.tick % 2 === 0 && this.shipFilled < Math.min(this.shipVolume, storm ? cap / 2 : cap)) {
      this.shipFilled += 1;
      const sh = this.npcMap.get('smokehouse');
      if (sh) sh.purse += this.ceiling;
      if (this.shipFilled === this.shipVolume && this.shipFilledAtTick === null) this.shipFilledAtTick = this.tick;
    }
  }

  private shipDeparts(): void {
    const c = E.captain;
    const unfilledBps = Math.round(((this.shipVolume - this.shipFilled) / this.shipVolume) * 10000);
    const before = this.ceiling;
    const fastFill = this.shipFilledAtTick !== null && this.shipFilledAtTick - (this.shipPhaseNow().arrivalTick - c.everyTicks) <= c.fastFillTicks;
    if (unfilledBps >= c.unfilledRaiseThresholdBps) this.ceiling = Math.min(c.maxCeiling, Math.round((this.ceiling * (10000 + c.raiseBps)) / 10000));
    else if (fastFill) this.ceiling = Math.max(c.minCeiling, Math.round((this.ceiling * (10000 - c.lowerBps)) / 10000));
    const captain = this.npcMap.get('captain');
    const text = this.ceiling > before
      ? `Only ${this.shipFilled} of ${this.shipVolume} cured fish available. Raising my ceiling next visit to ${marks(this.ceiling)} marks.`
      : this.ceiling < before
        ? `Filled my hold fast. Lowering my ceiling to ${marks(this.ceiling)} marks.`
        : `Bought ${this.shipFilled} of ${this.shipVolume}. Keeping my ceiling at ${marks(this.ceiling)} marks.`;
    if (captain) this.setReasoning(captain, this.ceiling > before ? 'CAPTAIN_CEILING_RAISE' : this.ceiling < before ? 'CAPTAIN_CEILING_LOWER' : 'STEADY', text, this.captainFactors(), true);
    this.pushFeed({ kind: 'ship_departed', text: `${SHIP_NAME} sailed with ${this.shipFilled} of ${this.shipVolume} cured fish.`, notable: true, npcId: 'captain' });
    if (this.ceiling !== before) this.pushFeed({ kind: 'captain_ceiling', text: `Captain Maren: ${text}`, notable: false, npcId: 'captain', good: 'cured_fish' });
  }

  private fillRestingOrders(p: MockPlayer): void {
    const ivs = this.intervals();
    for (const o of p.orders) {
      if (o.qty === 0 || this.rng() > 0.4) continue;
      const ref = priceAt(o.good, this.tick, ivs);
      const fills = o.side === 'sell' ? o.pricePips <= ref * 1.08 : o.pricePips >= ref * 0.95;
      if (!fills) continue;
      o.qty -= 1;
      const counterparty = o.side === 'sell' ? buyerName(o.good) : sellerName(o.good);
      if (o.side === 'sell') {
        const { tax, fee } = this.fees(o.venueId, o.pricePips);
        p.marks += o.pricePips - tax - fee;
        this.townFund += tax;
        this.creditHall(o.venueId, fee);
        this.pushFeed({ kind: 'trade', text: `${counterparty} bought 1 ${GOOD_NAMES[o.good].toLowerCase()} from your stall for ${marks(o.pricePips)} marks`, notable: false, good: o.good }, p.id);
      } else {
        p.inv[o.good] += 1;
        this.pushFeed({ kind: 'trade', text: `Your buy offer filled: 1 ${GOOD_NAMES[o.good].toLowerCase()} from ${counterparty} for ${marks(o.pricePips)} marks`, notable: false, good: o.good }, p.id);
      }
    }
    p.orders = p.orders.filter((o) => o.qty > 0);
  }

  private dailyBoundary(): void {
    for (const n of GATHER_NODES) this.nodeStock[n] = Math.min(E.gather.nodes[n].cap, this.nodeStock[n] + E.gather.nodes[n].regenPerDay);
    for (const p of this.players.values()) {
      p.gatheredToday = 0;
      if (this.tick - p.joinedTick >= E.player.rentGraceDays * TPD) {
        const rent = E.sinks.stallRentPerDay;
        if (p.marks >= rent) {
          p.marks -= rent;
          this.pushFeed({ kind: 'rent', text: `Paid ${marks(rent)} marks stall rent.`, notable: false }, p.id, true);
        } else {
          p.arrears += rent;
          this.pushFeed({ kind: 'rent', text: `Couldn't pay rent. You owe ${marks(p.arrears)} marks.`, notable: true }, p.id, true);
        }
      }
    }
    for (const npc of this.npcMap.values()) {
      const inv = npc.investor;
      if (!inv || npc.status === 'closed') continue;
      const profit = 1500 + Math.floor(this.rng() * 2500);
      const pay = Math.min(Math.round((profit * E.merchants.profitShareBps) / 10000), inv.capPips - inv.paidOutPips);
      if (pay <= 0) continue;
      inv.paidOutPips += pay;
      npc.purse -= pay;
      const p = this.players.get(inv.playerId);
      const stake = p?.investments.find((i) => i.npcId === npc.entry.id && i.active);
      if (p && stake) {
        p.marks += pay;
        stake.paidOutPips = inv.paidOutPips;
        if (inv.paidOutPips >= inv.capPips) stake.active = false;
        this.pushFeed({ kind: 'investor_payout', text: `${npc.entry.name} paid you ${marks(pay)} marks.`, notable: false, npcId: npc.entry.id }, p.id, true);
      }
      if (inv.paidOutPips >= inv.capPips) delete npc.investor;
    }
  }

  private backgroundTrade(): void {
    const options: [string, string, Good][] = [
      ['Agathe', 'Fenn', 'timber'], ['Agathe', 'Ivo', 'timber'], ["Old Pell's Smokehouse", 'Oskar', 'fish'],
      ["Old Pell's Smokehouse", 'Hester', 'salt'], ["Old Pell's Smokehouse", 'Agathe', 'barrel'], ['Juno', 'Brina', 'fish'],
    ];
    const [buyer, seller, good] = options[Math.floor(this.rng() * options.length)]!;
    const sellerNpc = [...this.npcMap.values()].find((n) => n.entry.name === seller);
    if (sellerNpc?.status === 'closed') return;
    const qty = 1 + Math.floor(this.rng() * 4);
    const price = priceAt(good, this.tick, this.intervals());
    this.pushFeed({ kind: 'trade', text: `${buyer} bought ${qty} ${GOOD_NAMES[good].toLowerCase()} from ${seller} for ${marks(qty * price)} marks`, notable: false, good });
  }

  private closeNpc(id: string, text: string, feed: boolean): void {
    const npc = this.npcMap.get(id);
    if (!npc) return;
    npc.status = 'closed';
    npc.closedSince = this.tick;
    npc.rescueAt = this.tick + E.merchants.rescueAfterDays * TPD;
    npc.purse = Math.min(npc.purse, 400);
    this.setReasoning(npc, 'SHOP_CLOSED_BROKE', text, [{ key: 'purse', label: 'Purse', value: npc.purse, unit: 'pips' }, { key: 'daysBroke', label: 'Days short of cash', value: E.merchants.closeAfterDaysBroke, unit: 'count' }], true);
    if (feed) this.pushFeed({ kind: 'MERCHANT_CLOSED', text: `${npc.entry.name} went broke and closed. Needs investment to reopen.`, notable: true, npcId: id });
  }

  private reopenNpc(npc: MockNpc, code: string, text: string): void {
    npc.status = 'open';
    delete npc.closedSince;
    delete npc.rescueAt;
    this.setReasoning(npc, code, text, [{ key: 'purse', label: 'Purse', value: npc.purse, unit: 'pips' }], true);
  }

  private rescueNpc(npc: MockNpc): void {
    npc.purse += E.merchants.rescueSeed;
    this.townFund -= E.merchants.rescueSeed;
    this.reopenNpc(npc, 'RESCUED_BY_TOWN_FUND', `Nobody backed me, so the Town Fund lent ${marks(E.merchants.rescueSeed)} marks. Reopening.`);
    this.pushFeed({ kind: 'MERCHANT_RESCUED', text: `The Town Fund rescued ${npc.entry.name} after ${E.merchants.rescueAfterDays} days closed.`, notable: true, npcId: npc.entry.id });
  }

  // ───────────── internals: reasoning ─────────────

  private updateReasoning(npc: MockNpc, force: boolean): void {
    if (npc.status === 'closed') return;
    const a = npc.entry.archetype;
    const storm = this.activeKinds(this.tick).has('storm');
    const ivs = this.intervals();
    const good: Good | undefined = (SELLS[a] ?? [])[0];
    const change = good ? Math.round(((priceAt(good, this.tick, ivs) - priceAt(good, this.tick - TPD, ivs)) / priceAt(good, this.tick - TPD, ivs)) * 10000) : 0;
    let code = 'STEADY';
    let text = '';
    const stock = good ? npc.inv[good] ?? 0 : 0;
    const target = a !== 'captain' ? E.npcs[a].targetStock : 0;
    switch (a) {
      case 'fisherman':
        if (storm) { code = 'STORM_SUPPLY_CUT'; text = `Storm kept the boats in. Stock is low, raising my price ${Math.max(10, pct(change))}%.`; }
        else if (change > 300) { code = 'DEMAND_UP_RAISE_ASK'; text = `Fish is selling fast, nudging my price up ${pct(change)}%.`; }
        else if (change < -300) { code = 'EXCESS_STOCK_DISCOUNT'; text = `Good catch and slow buyers. Discounting ${pct(change)}%.`; }
        else text = `Fair catch today. Holding near ${marks(priceAt('fish', this.tick, ivs))} marks.`;
        break;
      case 'salt_panner':
        if (change > 300) { code = 'LOW_STOCK_RAISE_ASK'; text = `Salt is scarce, raising my price ${pct(change)}%.`; }
        else if (this.activeKinds(this.tick).has('salt_glut')) { code = 'EXCESS_STOCK_DISCOUNT'; text = `Too much salt on hand, discounting ${Math.max(5, pct(change))}%.`; }
        else text = `Pans are steady. Salt at ${marks(priceAt('salt', this.tick, ivs))} marks.`;
        break;
      case 'woodcutter':
        text = change < -300 ? `Timber is cheap. Cutting less until it recovers.` : `Steady work. Timber at ${marks(priceAt('timber', this.tick, ivs))} marks.`;
        if (change < -300) code = 'PRICE_BELOW_COST_PAUSE';
        break;
      case 'cooper':
        if (this.shipPhaseNow().ticksToArrival > 0 && this.shipPhaseNow().ticksToArrival < 12) { code = 'DEMAND_UP_RAISE_ASK'; text = 'Barrel demand is up before the ship. Buying more timber.'; }
        else text = `Barrels at ${marks(priceAt('barrel', this.tick, ivs))} marks. Buying timber as needed.`;
        break;
      case 'smokehouse': {
        const margin = Math.round((1 - (6 * priceAt('fish', this.tick, ivs) + 3 * priceAt('salt', this.tick, ivs) + priceAt('barrel', this.tick, ivs)) / (4 * priceAt('cured_fish', this.tick, ivs))) * 100);
        if (storm || margin < 8) { code = 'MARGIN_NEGATIVE_PAUSE_BUY'; text = `Cured fish margin is only ${Math.max(0, margin)}% at current fish prices. Pausing fish purchases until fish drops.`; npc.status = 'paused'; }
        else {
          npc.status = 'open';
          const ph = this.shipPhaseNow();
          if (!ph.docked && ph.ticksToArrival <= 12) { code = 'SHIP_NEAR_HOLD_STOCK'; text = `Ship due in ${ph.ticksToArrival} hours. Holding my cured fish for the Captain.`; }
          else text = `Curing steadily at a ${margin}% margin.`;
        }
        break;
      }
      case 'captain': {
        const ph = this.shipPhaseNow();
        if (ph.docked) { code = 'STEADY'; text = `Docked. Buying up to ${this.shipVolume - this.shipFilled} more cured fish at ${marks(this.ceiling)} marks or less.`; }
        else if (!force && npc.reasoning.code.startsWith('CAPTAIN_CEILING') && this.tick - npc.reasoning.tick < 24) return;
        else text = `Sailing in ${ph.ticksToArrival} hours. I'll pay up to ${marks(this.ceiling)} marks a cured fish.`;
        this.setReasoning(npc, code, text, this.captainFactors(), force);
        return;
      }
    }
    const factors: Reasoning['factors'] = [];
    if (good) {
      factors.push({ key: 'stock', label: 'Stock', value: stock, unit: 'count', of: target });
      factors.push({ key: 'change24h', label: 'Price change (24h)', value: Math.round(change / 100), unit: 'pct' });
    }
    factors.push({ key: 'margin', label: 'Margin', value: Math.round(npc.entry.personality.margin * 100), unit: 'pct' });
    this.setReasoning(npc, code, text, factors, force);
  }

  private captainFactors(): Reasoning['factors'] {
    return [
      { key: 'ceiling', label: 'Ceiling', value: this.ceiling, unit: 'pips' },
      { key: 'filled', label: 'Bought this visit', value: this.shipFilled, unit: 'count', of: this.shipVolume },
    ];
  }

  private setReasoning(npc: MockNpc, code: string, text: string, factors: Reasoning['factors'], force: boolean): void {
    const detail = factors.map((f) => `${f.label} ${fmtFactor(f)}`).join(', ');
    const changed = npc.reasoning.code !== code || force;
    // Keep the original tick for an unchanged reason, so "since" stays meaningful.
    npc.reasoning = { code, text, detail, factors, tick: changed ? this.tick : npc.reasoning.tick };
    if (!changed) return;
    const top = npc.recent[0];
    if (top && top.reasoning.code === code) {
      top.repeat += 1;
      top.reasoning = npc.reasoning;
    } else {
      npc.recent.unshift({ tick: this.tick, reasoning: npc.reasoning, repeat: 1 });
      npc.recent = npc.recent.slice(0, 5);
    }
    if (code !== 'STEADY' && !code.startsWith('SHOP_') && !code.startsWith('INVESTMENT') && !code.startsWith('RESCUED')) {
      this.pushFeed({ kind: 'npc_decision', text: `${npc.entry.name}: ${text}`, notable: false, npcId: npc.entry.id });
    }
  }

  private priceReason(npc: MockNpc, good: Good, side: 'buy' | 'sell'): Reasoning {
    if (side === 'sell' && (SELLS[npc.entry.archetype] ?? [])[0] === good) return npc.reasoning;
    const ivs = this.intervals();
    const p = priceAt(good, this.tick, ivs);
    const text = npc.entry.archetype === 'captain'
      ? `Paying up to ${marks(this.ceiling)} marks per cured fish this visit.`
      : this.activeKinds(this.tick).has('salt_glut') && good === 'salt'
        ? 'Salt is flooding in. Lowering my bid.'
        : `Buying ${GOOD_NAMES[good].toLowerCase()} below ${marks(Math.round(p * 0.95))} marks to keep my margin.`;
    return { code: npc.entry.archetype === 'captain' ? 'STEADY' : this.activeKinds(this.tick).has('salt_glut') && good === 'salt' ? 'MARKET_GLUT_LOWER_BID' : 'STEADY', text, factors: [{ key: 'reference', label: 'Recent price', value: p, unit: 'pips' }], detail: `Recent price ${marks(p)} marks`, tick: this.tick };
  }

  // ───────────── internals: misc ─────────────

  private pushFeed(item: Omit<FeedItem, 'id' | 'tick' | 'mine' | 'repeat'>, playerId?: string, isPrivate = false): void {
    const f: InternalFeed = { item: { ...item, id: `f-${++this.seq}`, tick: this.tick, repeat: 1 }, ...(playerId ? { playerId } : {}), ...(isPrivate ? { private: true } : {}) };
    // Collapse identical consecutive public lines (×N).
    const last = this.feedLog[0];
    if (last && !isPrivate && last.item.text === f.item.text && last.playerId === f.playerId) {
      last.item.repeat += 1;
      return;
    }
    this.feedLog.unshift(f);
    this.feedLog = this.feedLog.slice(0, 200);
    if (this.inCommand) this.pendingCommandFeed.push(f);
    else this.lastStepFeed.push(f);
  }

  private netWorth(p: MockPlayer): number {
    const ivs = this.intervals();
    let w = p.marks;
    for (const g of GOODS) w += p.inv[g] * priceAt(g, this.tick, ivs);
    for (const o of p.orders) w += o.side === 'sell' ? o.qty * priceAt(o.good, this.tick, ivs) : o.qty * o.pricePips;
    return w;
  }

  private volume24h(scale: number): number {
    const ivs = this.intervals();
    let v = 0;
    for (const g of GOODS) v += Array.from({ length: TPD }, (_, k) => volumeAt(g, this.tick - k)).reduce((a, b) => a + b, 0) * priceAt(g, this.tick, ivs);
    return Math.round(v * scale);
  }

  private sumMarks(): number {
    let s = this.townFund;
    for (const n of this.npcMap.values()) s += n.purse;
    for (const p of this.players.values()) s += p.marks;
    return s;
  }
}

// ───────────── helpers ─────────────

function yes(message: string, result: CommandOutcome['result']): CommandOutcome {
  return result ? { ok: true, message, result } : { ok: true, message };
}
function no(code: string, message: string): CommandOutcome {
  return { ok: false, code, message };
}

function personalise(f: InternalFeed, playerId: string | null): FeedItem {
  return { ...f.item, mine: !!playerId && f.playerId === playerId };
}

function fmtFactor(f: Reasoning['factors'][number]): string {
  const v = typeof f.value === 'number' && f.unit === 'pips' ? `${marks(f.value)} marks` : f.unit === 'pct' ? `${f.value}%` : `${f.value}`;
  return f.of !== undefined ? `${v} of ${f.of}` : v;
}

function eventLabel(kind: ShockKind): { name: string; description: string; start: string; end: string } {
  switch (kind) {
    case 'storm': return { name: 'Storm', description: 'Boats stay in. Fish catch down 85% today, 25% tomorrow.', start: 'A storm rolls in. The boats stay in harbor.', end: 'The storm has passed. Boats head out again.' };
    case 'fair_winds': return { name: 'Fair Winds', description: 'The next ship wants 50% more cured fish.', start: 'Fair winds! The next ship will want more cured fish.', end: 'The fair winds have died down.' };
    case 'salt_glut': return { name: 'Salt Glut', description: 'The pans overflow: salt output up 60% today.', start: 'The salt pans overflow. Salt is everywhere.', end: 'Salt output is back to normal.' };
    case 'flood': return { name: 'Market flood', description: 'Someone dumped a pile of goods on the market.', start: 'A trader dumps a pile of goods on the market.', end: 'The flood of goods has been absorbed.' };
  }
}

function trendReason(good: Good, change: number, active: Set<ShockKind>, ivs: Interval[], t: number): string | undefined {
  if (Math.abs(change) < 300) return undefined;
  const arrow = change > 0 ? '▲' : '▼';
  const name = GOOD_NAMES[good];
  const recentStorm = active.has('storm') || ivs.some((iv) => iv.kind === 'storm' && iv.end <= t && t < iv.end + 48);
  let why = change > 0 ? 'buyers are taking stock fast' : 'more stock than buyers';
  if (good === 'fish' && recentStorm) why = change > 0 ? 'storm cut the catch' : 'boats are back out after the storm';
  if (good === 'cured_fish' && recentStorm) why = change > 0 ? 'fewer batches cured since the storm' : 'curing has resumed';
  if (good === 'salt' && active.has('salt_glut')) why = 'the pans overflowed';
  return `${name} ${arrow} ${pct(change)}%: ${why}`;
}

function buyerName(good: Good): string {
  return good === 'timber' ? 'Agathe' : good === 'cured_fish' ? 'a passing trader' : "Old Pell's Smokehouse";
}
function sellerName(good: Good): string {
  return ({ fish: 'Oskar', salt: 'Hester', timber: 'Fenn', barrel: 'Agathe', cured_fish: "Old Pell's Smokehouse" } as const)[good];
}
