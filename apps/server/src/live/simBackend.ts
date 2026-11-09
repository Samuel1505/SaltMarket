// The live backend: the real sim (packages/sim) behind the same GameBackend interface as the mock.
// Holds the world, maps sim state to protocol views, runs settlement to the LedgerAdapter, and
// runs "Watch a week" in a cloned sandbox that never touches the live world or the ledger.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ECONOMY, GATHER_NODES, GOOD_NAMES, GOODS, NODE_NAMES, RECIPE_NAMES, RECIPES, ROSTER, SHIP_NAME, type GatherNodeKey, type Good } from '@saltmarket/shared/config';
import {
  HARBOR_VENUE_ID, PROTOCOL_VERSION,
  type Explain, type FeedItem, type Health, type JudgeLedger, type Leaderboard, type MarketHistory, type NpcCard, type Offer,
  type PlayerView, type Quote, type Session, type TimelapseFrame, type Venue, type WorldDelta, type WorldSnapshot,
} from '@saltmarket/shared/protocol';
import {
  addPlayer, applyCommand, assertInvariants, burnMintRatio, buysOf, CAPTAIN, checkInvariants, createWorld, forceBroke, LABEL,
  marksSupply, medianPrice, RULES_FILE, scheduleEvent, sellsOf, step, Timelapse, TOWN_FUND, volume, yieldFor,
  type Command, type SimEvent, type WorldState,
} from '@saltmarket/sim';
import type { LedgerAdapter, SettlementBatch, TokenId } from '@saltmarket/chain';
import { fail, type CommandOutcome, type GameBackend, type GameCommand, type Result, type TimelapseEmit, type TimelapseHandle, type TimelapseOptions } from '../backend.js';

const E = ECONOMY;
const TPD = E.time.ticksPerDay;
const SETTLE_EVERY = 6;

type FeedRec = { item: Omit<FeedItem, 'mine'>; accountId?: string; private?: boolean };
type SettlementRec = JudgeLedger['settlements'][number];

export type SimOptions = {
  seed?: number;
  ledger: LedgerAdapter;
  /** Where to keep the JSON snapshot (replaces SQLite). Omit for a purely in-memory world. */
  snapshotPath?: string;
  /** Throw on invariant failure (tests/dev). In demo mode we log and pause instead. */
  strictInvariants?: boolean;
  timelapseFrameMs?: number;
  log?: (msg: string) => void;
};

const fmt = (p: number) => { const v = p / 100; return Number.isInteger(v) ? `${v}` : v.toFixed(1); };
const personalise = (f: FeedRec, pid: string | null): FeedItem => ({ ...f.item, mine: !!pid && f.accountId === pid });

export class SimBackend implements GameBackend {
  readonly mode = 'live' as const;
  private s: WorldState;
  private speed = 1;
  private paused = false;
  private readonly tokens = new Map<string, string>();
  private persistedTokens: Record<string, string> = {};
  private feedLog: FeedRec[] = [];
  private lastStepFeed: FeedRec[] = [];
  private pendingCommandFeed: FeedRec[] = [];
  private feedSeq = 0;
  private gatherLog: Record<GatherNodeKey, number[]> = { pier: [], pans: [], grove: [] };
  private prevOfferIds = new Set<string>();
  private removedOfferIds: string[] = [];
  private settlements: SettlementRec[] = [];
  private lastSettled = new Map<string, bigint>();
  private queueDepth = 0;
  private reconciliation: { tick: number | null; mismatches: number } = { tick: null, mismatches: 0 };
  private activeTimelapses = 0;
  private readonly log: (m: string) => void;

  constructor(private readonly opts: SimOptions) {
    this.log = opts.log ?? (() => {});
    this.s = this.loadSnapshot() ?? createWorld(opts.seed ?? 42);
    for (const [token, pid] of Object.entries(this.persistedTokens)) this.tokens.set(token, pid);
    this.prevOfferIds = new Set(this.offers(null).map((o) => o.id));
  }

  // ───────────── auth ─────────────

  login(provider: 'guest' | 'social', displayName?: string): Result<Session> {
    const id = `p-${randomUUID().slice(0, 8)}`;
    const name = (displayName?.trim() || `Guest ${100 + (this.s.seq % 900)}`).slice(0, 24);
    addPlayer(this.s, id, name);
    const token = randomUUID();
    this.tokens.set(token, id);
    this.persistedTokens[token] = id;
    this.pushFeed([{ kind: 'system', text: `${name} opened a stall at the harbor.`, notable: false, accountId: id }], 'command');
    return { ok: true, data: { token, playerId: id, displayName: name, provider } };
  }
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
    const ev = step(this.s);
    const bad = checkInvariants(this.s);
    if (bad.length) {
      // Better a visible pause than silent corruption (ARCHITECTURE §10).
      if (this.opts.strictInvariants) throw new Error(`invariants failed at tick ${this.s.tick}: ${bad.join('; ')}`);
      this.log(`INVARIANT FAILURE at tick ${this.s.tick}, pausing: ${bad.join('; ')}`);
      this.paused = true;
    }
    this.pushFeed(ev, 'step');
    if (this.s.tick % SETTLE_EVERY === 0) this.settle();
    if (this.opts.snapshotPath && this.s.tick % TPD === 0) this.saveSnapshot();
    const ids = new Set(this.offers(null).map((o) => o.id));
    this.removedOfferIds = [...this.prevOfferIds].filter((id) => !ids.has(id));
    this.prevOfferIds = ids;
  }

  // ───────────── commands ─────────────

  command(playerId: string, msg: GameCommand): CommandOutcome {
    const { cmdId: _cmdId, ...rest } = msg;
    void _cmdId;
    const ev: SimEvent[] = [];
    const r = applyCommand(this.s, playerId, rest as Command, ev);
    if (r.ok && msg.t === 'gather') this.gatherLog[msg.node].push(this.s.tick);
    this.pushFeed(ev, 'command');
    if (this.opts.strictInvariants) assertInvariants(this.s);
    return r;
  }

  // ───────────── views ─────────────

  snapshot(pid: string | null): WorldSnapshot {
    return {
      protocolVersion: PROTOCOL_VERSION, serverMode: 'live', clock: this.clock(), catalog: this.catalog(), me: this.me(pid),
      venues: this.venues(pid), quotes: this.quotes(), offers: this.offers(pid), nodes: this.nodes(), npcs: this.npcCards(pid),
      ship: this.ship(), events: this.events(), town: this.town(),
      feed: this.feedLog.filter((f) => !f.private || f.accountId === pid).slice(0, 40).map((f) => personalise(f, pid)),
    };
  }
  deltaFor(pid: string | null): WorldDelta {
    return {
      clock: this.clock(), me: this.me(pid), venues: this.venues(pid), quotes: this.quotes(), offers: this.offers(pid),
      removedOfferIds: this.removedOfferIds, nodes: this.nodes(), npcs: this.npcCards(pid), ship: this.ship(), events: this.events(), town: this.town(),
    };
  }
  feedFor(pid: string | null): FeedItem[] {
    return this.lastStepFeed.filter((f) => !f.private || f.accountId === pid).map((f) => personalise(f, pid)).reverse();
  }
  drainCommandFeed(pid: string | null): FeedItem[] {
    return this.pendingCommandFeed.filter((f) => !f.private || f.accountId === pid).map((f) => personalise(f, pid)).reverse();
  }
  clearCommandFeed(): void {
    this.pendingCommandFeed = [];
  }

  npcs(pid: string | null): NpcCard[] {
    return this.npcCards(pid);
  }

  explain(npcId: string): Result<Explain> {
    const card = this.npcCards(null).find((n) => n.id === npcId);
    if (!card) return fail('NOT_FOUND', 'No merchant by that name in town.');
    const prices = this.offers(null).filter((o) => o.owner.id === npcId).map((o) => ({ good: o.good, side: o.side, pricePips: o.pricePips, reasoning: o.reason ?? card.reasoning }));
    return { ok: true, data: { npcId, name: card.name, status: card.status, reasoning: card.reasoning, prices, rulesFile: RULES_FILE } };
  }

  history(good: Good, days: number, venueId: string | null): Result<MarketHistory> {
    if (venueId && venueId !== HARBOR_VENUE_ID && !this.s.halls[venueId]) return fail('NOT_FOUND', 'No such market.');
    const from = this.s.tick - Math.max(1, Math.min(days, 30)) * TPD;
    const points = this.s.history[good].filter((p) => p.tick > from).map((p) => ({ tick: p.tick, medianPips: p.median, lastPips: p.last, volume: p.volume }));
    // History is kept for all venues combined; venueId null says so.
    return { ok: true, data: { good, venueId: null, bucketTicks: 6, points } };
  }

  leaderboard(pid: string | null): Leaderboard {
    const players = Object.keys(this.s.players).map((id) => ({
      id, name: this.s.accounts[id]!.name, worth: this.netWorth(id),
      hall: Object.values(this.s.halls).filter((h) => h.ownerId === id).reduce((n, h) => n + h.feeIncomeTotal, 0),
    }));
    const rank = (key: 'worth' | 'hall') => [...players].filter((p) => key === 'worth' || p.hall > 0).sort((a, b) => b[key] - a[key] || a.id.localeCompare(b.id))
      .map((p, i) => ({ rank: i + 1, playerId: p.id, displayName: p.name, isMe: p.id === pid, valuePips: p[key] }));
    return { netWorth: rank('worth'), hallIncome: rank('hall'), town: this.town() };
  }

  health(): Health {
    const st = this.opts.ledger.status();
    return { ok: true, protocolVersion: PROTOCOL_VERSION, serverMode: 'live', tick: this.s.tick, ledger: { mode: st.mode, health: st.health, queueDepth: this.queueDepth } };
  }

  // ───────────── judge / dev ─────────────

  devEvent(kind: 'storm' | 'fair_winds' | 'salt_glut' | 'force_broke', npcId?: string): Result<{ message: string }> {
    if (kind === 'force_broke') {
      const id = npcId ?? 'cooper';
      const ev: SimEvent[] = [];
      const r = forceBroke(this.s, id, ev);
      if (!r.ok) return fail(r.code, r.message);
      this.pushFeed(ev, 'command');
      return { ok: true, data: { message: `${this.s.accounts[id]!.name} went broke and closed.` } };
    }
    if (!scheduleEvent(this.s, kind, this.s.tick + 1)) return fail('BAD_REQUEST', `A ${LABEL[kind].name.toLowerCase()} is already under way.`);
    return { ok: true, data: { message: `${LABEL[kind].name} starts next hour.` } };
  }
  devSpeed(speed?: number, paused?: boolean): Result<{ message: string }> {
    if (speed !== undefined) this.speed = speed;
    if (paused !== undefined) this.paused = paused;
    return { ok: true, data: { message: this.paused ? 'Paused.' : `Speed ${this.speed}×.` } };
  }

  judgeLedger(limit: number): JudgeLedger {
    const st = this.opts.ledger.status();
    const accounts: JudgeLedger['accounts'] = Object.values(this.s.accounts).filter((a) => a.id !== 'flood-trader').map((a) => {
      const e = this.opts.ledger.explorerUrl('account', a.id);
      return {
        ownerKind: a.kind === 'townfund' ? 'townfund' : a.kind === 'captain' ? 'captain' : a.kind === 'npc' ? 'npc' : 'player',
        ownerName: a.name, accountId: a.id, ...(e ? { explorerUrl: e } : {}),
        marksPips: a.marks, ledgerMarksPips: this.lastSettled.has(`${a.id}|marks`) ? Number(this.lastSettled.get(`${a.id}|marks`)) : null,
      };
    });
    return {
      mode: st.mode, health: st.health, network: st.network, contractId: st.contractId,
      contractExplorerUrl: st.contractId ? this.opts.ledger.explorerUrl('account', st.contractId) : null,
      queueDepth: this.queueDepth, lastSettledTick: this.settlements.find((x) => x.status === 'settled')?.tickTo ?? null,
      settlements: this.settlements.slice(0, Math.max(1, Math.min(limit, 200))), accounts, reconciliation: this.reconciliation,
    };
  }

  // ───────────── time-lapse ("Watch a week") ─────────────

  startTimelapse(o: TimelapseOptions, emit: TimelapseEmit): Result<TimelapseHandle> {
    if (this.activeTimelapses >= 3) return fail('TIMELAPSE_BUSY', 'The harbor clerk is busy. Try the time-lapse again in a minute.');
    const id = `tl-${randomUUID().slice(0, 8)}`;
    // Sandbox: Timelapse deep-clones the world; nothing in it writes back to the live world or the ledger.
    const tl = new Timelapse(this.s, o.shocks, o.days);
    const totalTicks = tl.totalTicks;
    const frameMs = this.opts.timelapseFrameMs ?? Math.round((o.wallSeconds * 1000) / Math.floor(totalTicks / E.timelapse.frameEveryTicks));
    let stopped = false;
    this.activeTimelapses += 1;
    emit({ t: 'timelapse', timelapseId: id, phase: 'started', totalTicks });
    const finish = (phase: 'done' | 'stopped') => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      this.activeTimelapses -= 1;
      emit({ t: 'timelapse', timelapseId: id, phase, totalTicks, ...(phase === 'done' ? { summary: tl.summary() } : {}) });
    };
    const timer = setInterval(() => {
      if (stopped) return;
      emit({ t: 'timelapse', timelapseId: id, phase: 'frame', totalTicks, frame: tl.next() });
      if (tl.done) finish('done');
    }, frameMs);
    return { ok: true, data: { id, totalTicks, stop: () => finish('stopped') } };
  }

  // ───────────── view builders ─────────────

  private clock(): WorldSnapshot['clock'] {
    return { tick: this.s.tick, day: Math.floor(this.s.tick / TPD), hour: this.s.tick % TPD, realMsPerTick: this.realMsPerTick(), speed: this.speed, paused: this.paused };
  }

  private catalog(): WorldSnapshot['catalog'] {
    return {
      goods: GOODS.map((g) => ({ id: g, name: GOOD_NAMES[g], anchorPips: E.goods[g].anchor, spoilsPerDayBps: Math.round(E.goods[g].spoilPerDay * 10000) })),
      recipes: RECIPES.map((r) => ({ id: r, name: RECIPE_NAMES[r], inputs: { ...E.recipes[r].in }, outputs: { ...E.recipes[r].out }, ticks: E.recipes[r].ticks })),
      ticksPerDay: TPD, harborTaxBps: E.fees.harborTaxBps, hallFeeMaxBps: E.fees.hallFeeMaxBps, hallLicensePips: E.sinks.hallLicense,
      stallRentPerDayPips: E.sinks.stallRentPerDay, investMinPips: E.merchants.investMin, investMaxPips: E.merchants.investMax,
      gatherCooldownTicks: E.gather.cooldownTicks, gatherDailyCap: E.gather.perPlayerPerDay,
    };
  }

  private me(pid: string | null): PlayerView | null {
    const p = pid ? this.s.players[pid] : undefined;
    const a = pid ? this.s.accounts[pid] : undefined;
    if (!p || !a || !pid) return null;
    return {
      playerId: pid, displayName: a.name, marksPips: a.marks, inventory: { ...a.inv },
      stall: {
        level: p.level, maxLevel: E.stall.maxLevel, craftSlots: p.level,
        crafting: p.jobs.map((j) => ({ id: j.id, recipe: j.recipe, startedTick: j.started, doneTick: j.done })),
        upgradeCostPips: p.level >= E.stall.maxLevel ? null : E.stall.upgradeCost,
        rentPerDayPips: E.sinks.stallRentPerDay, rentGraceDaysLeft: Math.max(0, E.player.rentGraceDays - Math.floor((this.s.tick - p.joinedTick) / TPD)),
        arrearsPips: p.arrears, shuttered: p.arrears > 0 && this.s.tick - p.joinedTick > (E.player.rentGraceDays + E.player.shutterAfterBrokeDays) * TPD,
      },
      gather: { readyAtTick: p.readyAt, gatheredToday: p.gatheredToday, dailyCap: E.gather.perPlayerPerDay },
      openOrders: this.offers(pid).filter((o) => o.owner.isMe),
      hallIds: Object.values(this.s.halls).filter((h) => h.ownerId === pid).map((h) => h.id),
      investments: Object.values(this.s.npcs).filter((n) => n.investor?.playerId === pid).map((n) => ({
        npcId: n.id, npcName: this.s.accounts[n.id]!.name, principalPips: n.investor!.principal, paidOutPips: n.investor!.paidOut, capPips: n.investor!.cap, active: true,
      })),
      netWorthPips: this.netWorth(pid),
    };
  }

  private venues(pid: string | null): Venue[] {
    const vol = (v: string) => GOODS.reduce((n, g) => n + volume(this.s, g, TPD, v).pips, 0);
    return [
      { id: HARBOR_VENUE_ID, kind: 'harbor', name: 'Harbor Market', ownerIsMe: false, feeBps: 0, taxBps: E.fees.harborTaxBps, frictionBps: E.fees.harborFrictionBps, volume24hPips: vol(HARBOR_VENUE_ID), feeIncome24hPips: 0, feeIncomeTotalPips: 0 },
      ...Object.values(this.s.halls).map((h) => ({
        id: h.id, kind: 'hall' as const, name: h.name, ownerName: this.s.accounts[h.ownerId]?.name ?? 'Someone', ownerIsMe: h.ownerId === pid,
        feeBps: h.feeBps, taxBps: E.fees.harborTaxBps, frictionBps: 0, volume24hPips: vol(h.id),
        feeIncome24hPips: Math.floor((vol(h.id) * h.feeBps) / 10000), feeIncomeTotalPips: h.feeIncomeTotal,
      })),
    ];
  }

  private offers(pid: string | null): Offer[] {
    const out: Offer[] = Object.values(this.s.orders).map((o) => {
      const a = this.s.accounts[o.owner]!;
      const npc = this.s.npcs[o.owner];
      return {
        id: o.id, venueId: o.venueId, good: o.good, side: o.side, pricePips: o.price, qty: o.qty,
        owner: { kind: a.kind === 'npc' ? ('npc' as const) : ('player' as const), id: o.owner, name: a.name, isMe: o.owner === pid },
        ...(npc ? { reason: npc.reasoning } : {}), createdTick: o.tick,
      };
    });
    const sh = this.s.ship;
    if (sh.docked && sh.filled < sh.volume) {
      out.push({
        id: 'captain:harbor:cured_fish:buy', venueId: HARBOR_VENUE_ID, good: 'cured_fish', side: 'buy', pricePips: sh.ceiling, qty: sh.volume - sh.filled,
        owner: { kind: 'captain', id: CAPTAIN, name: 'Captain Maren', isMe: false }, reason: sh.reason, createdTick: sh.arrivalTick,
      });
    }
    return out;
  }

  private quotes(): Quote[] {
    const offers = this.offers(null);
    const out: Quote[] = [];
    const stormRecent = this.s.events.some((e) => e.kind === 'storm' && e.start <= this.s.tick && this.s.tick < e.end + 2 * TPD);
    for (const v of [HARBOR_VENUE_ID, ...Object.keys(this.s.halls)]) {
      for (const g of GOODS) {
        const here = offers.filter((o) => o.venueId === v && o.good === g);
        const bid = here.filter((o) => o.side === 'buy').sort((a, b) => b.pricePips - a.pricePips)[0];
        const ask = here.filter((o) => o.side === 'sell').sort((a, b) => a.pricePips - b.pricePips)[0];
        const now = medianPrice(this.s, g, TPD);
        const h = this.s.history[g];
        const dayAgo = h.length >= 4 ? h[h.length - 4]!.median ?? now : now;
        const change = dayAgo > 0 ? Math.round(((now - dayAgo) / dayAgo) * 10000) : 0;
        const why = Math.abs(change) < 300 ? undefined
          : g === 'fish' && stormRecent ? (change > 0 ? 'storm cut the catch' : 'boats are back out after the storm')
          : change > 0 ? 'buyers are taking stock fast' : 'more stock than buyers';
        out.push({
          venueId: v, good: g, bestBidPips: bid?.pricePips ?? null, bestBidQty: bid?.qty ?? 0, bestAskPips: ask?.pricePips ?? null, bestAskQty: ask?.qty ?? 0,
          lastPips: this.s.trades.filter((t) => t.good === g && t.venueId === v).at(-1)?.price ?? null, median2dPips: medianPrice(this.s, g, 2 * TPD),
          change24hBps: change, trend: change > 100 ? 'up' : change < -100 ? 'down' : 'flat',
          ...(why ? { trendReason: `${GOOD_NAMES[g]} ${change > 0 ? '▲' : '▼'} ${Math.round(Math.abs(change) / 100)}%: ${why}` } : {}),
          volume24h: volume(this.s, g, TPD, v).qty,
        });
      }
    }
    return out;
  }

  private nodes(): WorldSnapshot['nodes'] {
    return GATHER_NODES.map((id) => {
      this.gatherLog[id] = this.gatherLog[id].filter((t) => t > this.s.tick - TPD);
      const n = E.gather.nodes[id];
      return { id, name: NODE_NAMES[id], good: n.good, stock: this.s.nodes[id], cap: n.cap, regenPerDay: n.regenPerDay, yieldNow: yieldFor(this.s, id), gatherers24h: this.gatherLog[id].length };
    });
  }

  private npcCards(pid: string | null): NpcCard[] {
    const cards: NpcCard[] = [];
    for (const r of ROSTER) {
      if (r.archetype === 'captain') {
        const reason = this.s.ship.reason;
        cards.push({
          id: CAPTAIN, name: r.name, title: r.title, bio: r.bio, archetype: 'captain', status: 'open', purse: { pips: 0, trend: 'flat' }, inventory: {},
          sells: [], buys: ['cured_fish'], reasoning: reason, recent: [{ tick: reason.tick, reasoning: reason, repeat: 1 }],
        });
        continue;
      }
      const n = this.s.npcs[r.id]!;
      const a = this.s.accounts[r.id]!;
      const inv: Partial<Record<Good, number>> = {};
      for (const g of [...sellsOf(n.archetype), ...buysOf(n.archetype)]) inv[g] = a.inv[g] + (this.s.orders[`${n.id}:${g}:sell`]?.qty ?? 0);
      const card: NpcCard = {
        id: n.id, name: r.name, title: r.title, bio: r.bio, archetype: n.archetype, status: n.status,
        purse: { pips: a.marks, trend: a.marks > n.dayStartMarks ? 'up' : a.marks < n.dayStartMarks ? 'down' : 'flat' },
        inventory: inv, sells: sellsOf(n.archetype), buys: buysOf(n.archetype), reasoning: n.reasoning, recent: n.recent.slice(0, 5),
      };
      if (n.status === 'closed') {
        card.closed = { sinceTick: n.closedSince ?? this.s.tick, investMinPips: E.merchants.investMin, investMaxPips: E.merchants.investMax, rescueInTicks: Math.max(0, (n.rescueAt ?? this.s.tick) - this.s.tick) };
      }
      if (n.investor) {
        card.investor = { displayName: this.s.accounts[n.investor.playerId]?.name ?? 'A backer', isMe: n.investor.playerId === pid, principalPips: n.investor.principal, paidOutPips: n.investor.paidOut, capPips: n.investor.cap };
      }
      cards.push(card);
    }
    return cards;
  }

  private ship(): WorldSnapshot['ship'] {
    const sh = this.s.ship;
    return {
      captainNpcId: CAPTAIN, name: SHIP_NAME, status: sh.docked ? 'docked' : 'away',
      ticksToArrival: sh.docked ? 0 : Math.max(0, sh.arrivalTick - this.s.tick), ticksToDeparture: sh.docked ? Math.max(0, sh.departureTick - this.s.tick) : 0,
      ceilingPips: sh.ceiling, volume: sh.volume, filled: sh.docked ? sh.filled : 0,
    };
  }

  private events(): WorldSnapshot['events'] {
    return this.s.events.filter((e) => e.start <= this.s.tick && this.s.tick < e.end)
      .map((e) => ({ id: e.id, kind: e.kind, label: LABEL[e.kind].name, description: LABEL[e.kind].description, startedTick: e.start, endsTick: e.end }));
  }

  private town(): WorldSnapshot['town'] {
    const npcs = Object.values(this.s.npcs);
    return {
      marksSupplyPips: marksSupply(this.s), townFundPips: this.s.accounts[TOWN_FUND]!.marks,
      volume24hPips: GOODS.reduce((n, g) => n + volume(this.s, g, TPD).pips, 0),
      openMerchants: npcs.filter((n) => n.status !== 'closed').length, closedMerchants: npcs.filter((n) => n.status === 'closed').length,
    };
  }

  private netWorth(id: string): number {
    const a = this.s.accounts[id]!;
    let w = a.marks;
    for (const g of GOODS) w += a.inv[g] * medianPrice(this.s, g);
    for (const o of Object.values(this.s.orders)) if (o.owner === id) w += o.side === 'buy' ? o.qty * o.price : o.qty * medianPrice(this.s, o.good);
    return w;
  }

  // ───────────── feed ─────────────

  private pushFeed(ev: SimEvent[], into: 'step' | 'command'): void {
    for (const e of ev) {
      const rec: FeedRec = {
        item: { id: `f-${this.s.tick}-${this.feedSeq++}`, tick: this.s.tick, kind: e.kind, text: e.text, notable: e.notable, repeat: 1, ...(e.npcId ? { npcId: e.npcId } : {}), ...(e.good ? { good: e.good } : {}) },
        ...(e.accountId ? { accountId: e.accountId } : {}), ...(e.private ? { private: true } : {}),
      };
      const last = this.feedLog[0];
      if (last && !rec.private && last.item.text === rec.item.text && last.accountId === rec.accountId) { last.item.repeat += 1; continue; }
      this.feedLog.unshift(rec);
      (into === 'step' ? this.lastStepFeed : this.pendingCommandFeed).push(rec);
    }
    if (this.feedLog.length > 200) this.feedLog.length = 200;
  }

  // ───────────── settlement (write-behind; never blocks the game) ─────────────

  /** Owned balances per (account, token), counting escrow in resting orders as still owned. */
  private balances(): Map<string, bigint> {
    const b = new Map<string, bigint>();
    const add = (k: string, v: number) => b.set(k, (b.get(k) ?? 0n) + BigInt(v));
    for (const a of Object.values(this.s.accounts)) {
      add(`${a.id}|marks`, a.marks);
      for (const g of GOODS) add(`${a.id}|${g}`, a.inv[g]);
    }
    for (const o of Object.values(this.s.orders)) add(o.side === 'buy' ? `${o.owner}|marks` : `${o.owner}|${o.good}`, o.side === 'buy' ? o.qty * o.price : o.qty);
    for (const h of Object.values(this.s.halls)) add(`${h.ownerId}|hall_license`, 1);
    return b;
  }

  private settle(): void {
    const now = this.balances();
    const deltas: SettlementBatch['deltas'] = [];
    for (const k of new Set([...now.keys(), ...this.lastSettled.keys()])) {
      const d = (now.get(k) ?? 0n) - (this.lastSettled.get(k) ?? 0n);
      if (d !== 0n) { const [account, token] = k.split('|') as [string, TokenId]; deltas.push({ account, token, delta: d }); }
    }
    const tickTo = this.s.tick;
    const tickFrom = tickTo - SETTLE_EVERY;
    const batch: SettlementBatch = { batchId: `${tickFrom}-${tickTo}`, tickFrom, tickTo, deltas };
    const rec: SettlementRec = { batchId: batch.batchId, tickFrom, tickTo, status: 'queued', deltaCount: deltas.length, attempts: 0 };
    this.settlements.unshift(rec);
    if (this.settlements.length > 200) this.settlements.length = 200;
    this.lastSettled = now;
    this.queueDepth += 1;
    const attempt = () => {
      rec.attempts += 1;
      rec.status = 'submitted';
      this.opts.ledger.settle(batch).then(
        (r) => {
          rec.status = 'settled';
          rec.txHash = r.txHash;
          const u = this.opts.ledger.explorerUrl('tx', r.txHash);
          if (u) rec.explorerUrl = u;
          this.queueDepth -= 1;
          if (tickTo % TPD === 0) void this.reconcile(now, tickTo);
        },
        (err: unknown) => {
          rec.status = 'failed';
          rec.error = err instanceof Error ? err.message : String(err);
          setTimeout(attempt, Math.min(60000, 1000 * 2 ** rec.attempts));
        },
      );
    };
    attempt();
  }

  private async reconcile(expected: Map<string, bigint>, tick: number): Promise<void> {
    let mismatches = 0;
    for (const [k, v] of expected) {
      const [account, token] = k.split('|') as [string, TokenId];
      if ((await this.opts.ledger.balanceOf(account, token)) !== v) mismatches += 1;
    }
    this.reconciliation = { tick, mismatches };
    if (mismatches) this.log(`reconciliation: ${mismatches} mismatched balances at tick ${tick}`);
  }

  // ───────────── JSON snapshot (replaces SQLite) ─────────────

  private loadSnapshot(): WorldState | null {
    if (!this.opts.snapshotPath) return null;
    try {
      const data = JSON.parse(readFileSync(this.opts.snapshotPath, 'utf8')) as { world: WorldState; tokens?: Record<string, string> };
      assertInvariants(data.world);
      this.persistedTokens = data.tokens ?? {};
      this.log(`restored world at tick ${data.world.tick} from ${this.opts.snapshotPath}`);
      return data.world;
    } catch {
      return null;
    }
  }

  /** Atomic write: temp file then rename. Called daily and on shutdown. */
  saveSnapshot(): void {
    if (!this.opts.snapshotPath) return;
    mkdirSync(dirname(this.opts.snapshotPath), { recursive: true });
    const tmp = `${this.opts.snapshotPath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ world: this.s, tokens: this.persistedTokens }));
    renameSync(tmp, this.opts.snapshotPath);
  }

  /** Test hook: the live world (treat as read-only). */
  world(): Readonly<WorldState> {
    return this.s;
  }
}
