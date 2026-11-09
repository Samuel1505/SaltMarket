// NPC agent loop, each tick: observe → decide (merchant-rules.ts) → guard → act → log (NPC_AGENTS §2).
// This file only gathers observations and applies decisions; every price and quantity comes from the rules file.
import { ECONOMY, GOODS, ROSTER, type Good } from '@saltmarket/shared/config';
import { createGood, destroyGood, nextId } from '../ledger.js';
import { cancelOrder, placeOrder, takeAsks } from '../market.js';
import { askPrice, bidPrice, chooseVenue, dailyOutput, MERCHANT_RULES, switchReason } from '../pricing/merchant-rules.js';
import { isActive, setReason, weatherFactor } from '../events.js';
import { listedSupply, medianPrice, soldBy } from '../metrics.js';
import { guardBuy, guardSell } from './guard.js';
import { HARBOR, type Npc, type Reason, type SimEvent, type WorldState } from '../types.js';

const E = ECONOMY;
const personality = (id: string) => ROSTER.find((r) => r.id === id)!.personality;

/** Keep exactly one resting order per (npc, good, side) with a stable id, updating it in place when it changes. */
function setOrder(s: WorldState, npc: Npc, good: Good, side: 'buy' | 'sell', price: number, qty: number): void {
  const id = `${npc.id}:${good}:${side}`;
  const cur = s.orders[id];
  if (cur && cur.venueId === npc.venueId && cur.price === price && cur.qty === qty) return;
  if (cur) cancelOrder(s, id);
  if (qty > 0 && price > 0) placeOrder(s, { id, owner: npc.id, venueId: npc.venueId, good, side, price, qty });
}

export function runNpc(s: WorldState, npc: Npc, ev: SimEvent[]): void {
  if (npc.status === 'closed' || npc.archetype === 'captain') return;
  const a = npc.archetype;
  const rule = MERCHANT_RULES[a];
  const pers = personality(npc.id);
  const acc = s.accounts[npc.id]!;
  const held = (g: Good) => acc.inv[g] + (s.orders[`${npc.id}:${g}:sell`]?.qty ?? 0);
  const median = Object.fromEntries(GOODS.map((g) => [g, medianPrice(s, g)])) as Record<Good, number>;
  const reasons: Reason[] = [];

  // Venue choice once a day per merchant, staggered (ECONOMY §6.3).
  const idx = ROSTER.findIndex((r) => r.id === npc.id);
  if ((s.tick + idx) % E.time.ticksPerDay === 0) {
    const venues = [{ id: HARBOR, feeBps: E.fees.harborTaxBps, frictionBps: E.fees.harborFrictionBps }, ...Object.values(s.halls).map((h) => ({ id: h.id, feeBps: E.fees.harborTaxBps + h.feeBps, frictionBps: 0 }))];
    const v = chooseVenue(npc.venueId, venues, pers.venueLoyalty);
    if (v.switched) {
      npc.venueId = v.venueId;
      reasons.push(switchReason(s.halls[v.venueId]?.name ?? 'the Harbor Market', s.tick));
    }
  }

  // Produce (fisherman, salt-panner, woodcutter): ECONOMY §8.3, spread over the day.
  if (a === 'fisherman' || a === 'salt_panner' || a === 'woodcutter') {
    const good = rule.sells[0]!;
    if (held(good) < 3 * rule.targetStock) {
      const perDay = dailyOutput({ archetype: a, medianPrice: median[good], weatherFactor: weatherFactor(s), eventFactor: a === 'salt_panner' && isActive(s, 'salt_glut') ? 1.6 : 1, pausedLowPrice: npc.prodPaused });
      npc.prodCarry += Math.round((perDay * 1000) / E.time.ticksPerDay);
      const whole = Math.floor(npc.prodCarry / 1000);
      if (whole > 0) { createGood(s, npc.id, good, whole); npc.prodCarry -= whole * 1000; }
    }
  }

  // Craft (cooper, smokehouse) when idle, stocked, and the output isn't piling up.
  if ((a === 'cooper' || a === 'smokehouse') && npc.jobs.length === 0 && npc.status === 'open') {
    const recipe = a === 'cooper' ? 'craft_barrel' : 'cure_fish';
    const r = E.recipes[recipe];
    const out = rule.sells[0]!;
    const hasAll = (Object.entries(r.in) as [Good, number][]).every(([g, q]) => acc.inv[g] >= q);
    if (hasAll && held(out) < 2 * rule.targetStock) {
      for (const [g, q] of Object.entries(r.in) as [Good, number][]) destroyGood(s, npc.id, g, q);
      npc.jobs.push({ id: nextId(s, 'j'), recipe, started: s.tick, done: s.tick + r.ticks });
    }
  }

  // Buy inputs: take cheap asks up to the bid, then leave a resting buy offer for sellers.
  let pausedAny = false;
  for (const good of Object.keys(rule.buys) as Good[]) {
    if (a !== 'cooper' && a !== 'smokehouse') break;
    const ema = s.listedEma[good];
    const d = bidPrice({ archetype: a, good, stock: acc.inv[good], margin: pers.margin, patience: pers.patience, previous: npc.lastPrice[`${good}:buy`], median, glutRatio: ema > 0 ? listedSupply(s, good) / ema - 1 : 0 }, s.tick);
    reasons.push(d.reason);
    if (d.paused) { pausedAny = true; setOrder(s, npc, good, 'buy', 0, 0); continue; }
    npc.lastPrice[`${good}:buy`] = d.price;
    setOrder(s, npc, good, 'buy', 0, 0); // release escrow before taking
    let bought = 0;
    if (d.qty > 0) {
      const g = guardBuy(s, npc, good, d.qty, d.price);
      if (g.ok) {
        const got = takeAsks(s, npc.id, 'any', good, g.qty, d.price, g.budget);
        npc.spentToday += got.gross;
        bought = got.qty;
      }
    }
    const want = d.standingQty - bought;
    if (want > 0) {
      const g = guardBuy(s, npc, good, want, d.price);
      if (g.ok) setOrder(s, npc, good, 'buy', d.price, g.qty);
    }
  }
  if (a === 'smokehouse') npc.status = pausedAny && acc.inv.fish < 6 ? 'paused' : 'open';

  // Sell output at the asking price from the rules.
  for (const good of rule.sells) {
    const stock = held(good);
    const unitCost = a === 'cooper' ? 3 * median.timber : a === 'smokehouse' ? (6 * median.fish + 3 * median.salt + median.barrel) / 4 : undefined;
    // The Smokehouse holds cured fish for the ship: list only while it is docked or due within 12 ticks.
    const shipNear = s.ship.docked || s.ship.arrivalTick - s.tick <= 12;
    const d = askPrice({ archetype: a, good, stock, margin: pers.margin, patience: pers.patience, soldLastDay: soldBy(s, npc.id, good), previous: npc.lastPrice[`${good}:sell`], stormActive: isActive(s, 'storm'), ...(unitCost !== undefined ? { unitCost } : {}), ...(a === 'smokehouse' ? { captainCeiling: s.ship.ceiling } : {}) }, s.tick);
    npc.lastPrice[`${good}:sell`] = d.price;
    reasons.unshift(d.reason);
    const listQty = a === 'smokehouse' && !shipNear ? 0 : guardSell(npc, good, stock);
    setOrder(s, npc, good, 'sell', d.price, listQty);
    if (a === 'smokehouse' && !shipNear && stock > 0) reasons.unshift({ code: 'SHIP_NEAR_HOLD_STOCK', text: `Holding ${stock} cured fish for the ship, due in ${s.ship.arrivalTick - s.tick} hours.`, factors: [], tick: s.tick });
  }

  // Headline reason: the most notable decision this tick.
  const headline = reasons.find((r) => r.code !== 'STEADY') ?? reasons[0];
  if (headline) setReason(s, npc, headline, ev);
}
