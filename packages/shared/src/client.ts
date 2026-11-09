// Client helpers for apps/web (pure, framework-agnostic, tested). They encode the protocol's apply rules so the
// UI never has to re-derive them. Import from '@saltmarket/shared/client'.
import type { ClientMessage, FeedItem, NpcCard, Offer, Quote, WorldDelta, WorldSnapshot } from './protocol.js';

const byKey = <T>(items: T[], key: (x: T) => string, updates: T[] | undefined): T[] => {
  if (!updates || updates.length === 0) return items;
  const map = new Map(items.map((x) => [key(x), x] as const));
  for (const u of updates) map.set(key(u), u);
  return [...map.values()];
};

export const quoteKey = (q: Pick<Quote, 'venueId' | 'good'>): string => `${q.venueId}:${q.good}`;

/**
 * Apply a `delta` to the current world (protocol.ts → WorldDelta):
 * clock/me/ship/town/events replace; venues/quotes/npcs/nodes/offers upsert by key; removedOfferIds delete.
 * Returns a new object (safe for React/Zustand equality checks); untouched collections keep their identity.
 */
export function applyDelta(world: WorldSnapshot, d: WorldDelta): WorldSnapshot {
  const removed = new Set(d.removedOfferIds ?? []);
  let offers = byKey(world.offers, (o) => o.id, d.offers);
  if (removed.size) offers = offers.filter((o) => !removed.has(o.id));
  return {
    ...world,
    clock: d.clock,
    ...(d.me !== undefined ? { me: d.me } : {}),
    ...(d.ship ? { ship: d.ship } : {}),
    ...(d.town ? { town: d.town } : {}),
    ...(d.events ? { events: d.events } : {}),
    venues: byKey(world.venues, (v) => v.id, d.venues),
    quotes: byKey(world.quotes, quoteKey, d.quotes),
    npcs: byKey(world.npcs, (n) => n.id, d.npcs),
    nodes: byKey(world.nodes, (n) => n.id, d.nodes),
    offers,
  };
}

/** Merge `{ t:'feed', items }` into the feed: newest first, de-duplicated by id (repeat counts update), capped. */
export function applyFeed(feed: FeedItem[], items: FeedItem[], cap = 100): FeedItem[] {
  const incoming = new Map(items.map((i) => [i.id, i] as const));
  const rest = feed.filter((f) => !incoming.has(f.id));
  return [...items, ...rest].sort((a, b) => b.tick - a.tick).slice(0, cap);
}

/** Pips → display marks: 1050 → "10.5", 1000 → "10", 1234 → "12.34". Thousands separators for big numbers. */
export function formatMarks(pips: number): string {
  const neg = pips < 0;
  const abs = Math.abs(pips);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  const w = whole.toLocaleString('en-US');
  const f = frac === 0 ? '' : frac % 10 === 0 ? `.${frac / 10}` : `.${String(frac).padStart(2, '0')}`;
  return `${neg ? '-' : ''}${w}${f}`;
}

/** Basis points → percent text: 250 → "2.5%". */
export const formatBps = (bps: number): string => `${Number((bps / 100).toFixed(2))}%`;

/** Real seconds for a number of game ticks at the current pacing. */
export const ticksToSeconds = (ticks: number, clock: WorldSnapshot['clock']): number => Math.max(0, Math.ceil((ticks * clock.realMsPerTick) / 1000));

/** Seconds until the player can gather again (0 = ready). */
export function gatherReadyIn(world: WorldSnapshot): number {
  if (!world.me) return 0;
  return ticksToSeconds(world.me.gather.readyAtTick - world.clock.tick, world.clock);
}

/** Seconds until the ship docks (0 while docked) and until it leaves (0 while away). */
export function shipTimers(world: WorldSnapshot): { arrivesIn: number; leavesIn: number } {
  return { arrivesIn: ticksToSeconds(world.ship.ticksToArrival, world.clock), leavesIn: ticksToSeconds(world.ship.ticksToDeparture, world.clock) };
}

export function quoteFor(world: WorldSnapshot, venueId: string, good: Quote['good']): Quote | undefined {
  return world.quotes.find((q) => q.venueId === venueId && q.good === good);
}

/** Resting offers for a good at a venue, best first (buy offers: highest price; sell offers: lowest). */
export function offersFor(world: WorldSnapshot, venueId: string, good: Offer['good'], side: Offer['side']): Offer[] {
  return world.offers.filter((o) => o.venueId === venueId && o.good === good && o.side === side)
    .sort((a, b) => (side === 'buy' ? b.pricePips - a.pricePips : a.pricePips - b.pricePips));
}

/** What a merchant card should show as its action: invest only when closed and nobody has backed it yet. */
export function npcAction(npc: NpcCard): 'invest' | 'none' {
  return npc.status === 'closed' && !npc.investor ? 'invest' : 'none';
}

/** ▲ / ▼ / – for a trend (never convey direction by colour alone; CLAUDE.md §9). */
export const trendGlyph = (t: Quote['trend']): string => (t === 'up' ? '▲' : t === 'down' ? '▼' : '–');

let seq = 0;
/** A unique cmdId for a client message (≤ 64 chars). */
export const newCmdId = (): string => `c${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Build a client message with a fresh cmdId: `send(cmd({ t: 'gather', node: 'pier' }))`. */
export function cmd<T extends ClientMessage['t']>(m: Omit<Extract<ClientMessage, { t: T }>, 'cmdId'> & { t: T }): Extract<ClientMessage, { t: T }> {
  return { ...m, cmdId: newCmdId() } as Extract<ClientMessage, { t: T }>;
}
