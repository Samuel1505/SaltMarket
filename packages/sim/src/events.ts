// Shocks and merchant lifecycle: storms and other events, closures, rescues, floods (ECONOMY §8.6, GAME_DESIGN §7).
// The judge buttons, the time-lapse toggles, and natural causes all go through these same functions.
import { ECONOMY, ROSTER, type Good } from '@saltmarket/shared/config';
import { burn, createGood, transfer } from './ledger.js';
import { cancelAllOf, placeOrder } from './market.js';
import { fmt } from './pricing/merchant-rules.js';
import { HARBOR, TOWN_FUND, type Npc, type Reason, type ShockKind, type SimEvent, type WorldState } from './types.js';

const E = ECONOMY;
export const npcName = (id: string): string => ROSTER.find((r) => r.id === id)?.name ?? id;

export const LABEL: Record<ShockKind, { name: string; description: string; start: string; end: string }> = {
  storm: { name: 'Storm', description: 'Boats stay in. Fish catch down 85% today, 25% tomorrow.', start: 'A storm rolls in. The boats stay in harbor.', end: 'The storm has passed. Boats head out again.' },
  fair_winds: { name: 'Fair Winds', description: 'The next ship wants 50% more cured fish.', start: 'Fair winds! The next ship will want more cured fish.', end: 'The fair winds have died down.' },
  salt_glut: { name: 'Salt Glut', description: 'The pans overflow: salt output up 60% today.', start: 'The salt pans overflow. Salt is everywhere.', end: 'Salt output is back to normal.' },
  flood: { name: 'Market flood', description: 'A trader dumped a pile of goods on the market.', start: 'A trader dumps a pile of goods on the market.', end: 'The flood of goods has been absorbed.' },
};

export const isActive = (s: WorldState, kind: ShockKind, t = s.tick): boolean => s.events.some((e) => e.kind === kind && e.start <= t && t < e.end);

/** Schedule an event lasting one day from `start`. Returns false if one of that kind is already running. */
export function scheduleEvent(s: WorldState, kind: ShockKind, start: number, extra: { good?: Good; qty?: number } = {}): boolean {
  if (s.events.some((e) => e.kind === kind && e.end > start && e.start <= start)) return false;
  s.events.push({ id: `${kind}-${start}`, kind, start, end: start + E.time.ticksPerDay, ...extra });
  return true;
}

/** Called at the start of each tick: announce events and apply one-off effects (a flood lists its goods). */
export function tickEvents(s: WorldState, ev: SimEvent[]): void {
  for (const e of s.events) {
    if (e.start === s.tick) {
      ev.push({ kind: 'event_start', text: LABEL[e.kind].start, notable: true });
      if (e.kind === 'flood') floodMarket(s, e.good ?? 'timber', e.qty ?? 200);
    }
    if (e.end === s.tick) ev.push({ kind: 'event_end', text: LABEL[e.kind].end, notable: true });
  }
  s.events = s.events.filter((e) => e.end > s.tick - 7 * E.time.ticksPerDay);
}

/** Weather multiplier on fishing (ECONOMY §8.3): storm day 0.15, the day after 0.75. */
export function weatherFactor(s: WorldState): number {
  for (const e of s.events) {
    if (e.kind !== 'storm') continue;
    if (e.start <= s.tick && s.tick < e.end) return E.stormWeatherFactor;
    if (e.end <= s.tick && s.tick < e.end + E.time.ticksPerDay) return E.stormSecondDayFactor;
  }
  return 1;
}

/** Scripted flood (TESTING §3.5): a trader's goods appear and are listed cheaply at the harbor. */
export function floodMarket(s: WorldState, good: Good, qty: number): void {
  const id = 'flood-trader';
  if (!s.accounts[id]) s.accounts[id] = { id, kind: 'player', name: 'A passing trader', marks: 0, inv: { fish: 0, salt: 0, timber: 0, barrel: 0, cured_fish: 0 } };
  createGood(s, id, good, qty);
  placeOrder(s, { owner: id, venueId: HARBOR, good, side: 'sell', price: Math.round(E.goods[good].anchor * E.floodPriceOfAnchor), qty });
}

export function setReason(s: WorldState, npc: Npc, r: Reason, ev: SimEvent[]): void {
  const changed = npc.reasoning.code !== r.code;
  npc.reasoning = changed ? r : { ...r, tick: npc.reasoning.tick };
  if (!changed) return;
  const top = npc.recent[0];
  if (top && top.reasoning.code === r.code) { top.repeat += 1; top.reasoning = r; }
  else { npc.recent.unshift({ tick: s.tick, reasoning: r, repeat: 1 }); npc.recent = npc.recent.slice(0, 5); }
  if (r.code !== 'STEADY' && !['SHOP_CLOSED_BROKE', 'INVESTMENT_RECEIVED_REOPEN', 'RESCUED_BY_TOWN_FUND'].includes(r.code)) {
    ev.push({ kind: 'npc_decision', text: `${npcName(npc.id)}: ${r.text}`, notable: false, npcId: npc.id });
  }
}

export function closeNpc(s: WorldState, npc: Npc, text: string, ev: SimEvent[]): void {
  cancelAllOf(s, npc.id);
  npc.status = 'closed';
  npc.closedSince = s.tick;
  npc.rescueAt = s.tick + E.merchants.rescueAfterDays * E.time.ticksPerDay;
  npc.jobs = [];
  setReason(s, npc, { code: 'SHOP_CLOSED_BROKE', text, factors: [{ key: 'purse', label: 'Purse', value: s.accounts[npc.id]!.marks, unit: 'pips' }], tick: s.tick }, ev);
  ev.push({ kind: 'MERCHANT_CLOSED', text: `${npcName(npc.id)} went broke and closed. Needs investment to reopen.`, notable: true, npcId: npc.id });
}

/** Judge action: drain a merchant's purse (a logged burn) and close it now. */
export function forceBroke(s: WorldState, npcId: string, ev: SimEvent[]): { ok: true } | { ok: false; code: string; message: string } {
  const npc = s.npcs[npcId];
  if (!npc) return { ok: false, code: 'NOT_FOUND', message: 'Pick a merchant to bankrupt (not the Captain).' };
  if (npc.status === 'closed') return { ok: false, code: 'BAD_REQUEST', message: `${npcName(npcId)} is already closed.` };
  cancelAllOf(s, npc.id);
  const a = s.accounts[npc.id]!;
  burn(s, npc.id, Math.max(0, a.marks - E.sinks.npcLivingCostPerDay / 2));
  closeNpc(s, npc, 'Out of cash. Closing until someone backs me.', ev);
  return { ok: true };
}

export function reopenNpc(s: WorldState, npc: Npc, r: Reason, ev: SimEvent[]): void {
  npc.status = 'open';
  npc.closedSince = null;
  npc.rescueAt = null;
  npc.brokeDays = 0;
  npc.dayStartMarks = s.accounts[npc.id]!.marks;
  setReason(s, npc, r, ev);
}

/** Town Fund rescue after 5 days closed with no investor (ECONOMY §8.6). */
export function rescueDue(s: WorldState, ev: SimEvent[]): void {
  for (const npc of Object.values(s.npcs)) {
    if (npc.status !== 'closed' || npc.investor || npc.rescueAt === null || s.tick < npc.rescueAt) continue;
    const seed = Math.min(E.merchants.rescueSeed, s.accounts[TOWN_FUND]!.marks);
    transfer(s, TOWN_FUND, npc.id, seed);
    reopenNpc(s, npc, { code: 'RESCUED_BY_TOWN_FUND', text: `Nobody backed me, so the Town Fund lent ${fmt(seed)} marks. Reopening.`, factors: [], tick: s.tick }, ev);
    ev.push({ kind: 'MERCHANT_RESCUED', text: `The Town Fund rescued ${npcName(npc.id)} after ${E.merchants.rescueAfterDays} days closed.`, notable: true, npcId: npc.id });
  }
}
