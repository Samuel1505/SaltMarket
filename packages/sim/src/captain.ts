// The Ship Captain: the demand engine (ECONOMY §7). Visits on a fixed schedule, buys the cheapest cured
// fish at or under his ceiling with minted marks, then adjusts the ceiling by how the visit went.
import { ECONOMY } from '@saltmarket/shared/config';
import { executeTrade, book } from './market.js';
import { captainCeiling, captainVolume } from './pricing/merchant-rules.js';
import { isActive } from './events.js';
import { CAPTAIN, type SimEvent, type WorldState } from './types.js';

const E = ECONOMY;

export function shipArrives(s: WorldState, ev: SimEvent[]): void {
  const sh = s.ship;
  if (sh.docked || s.tick !== sh.arrivalTick) return;
  sh.docked = true;
  sh.filled = 0;
  sh.smokehouseSold = 0;
  sh.filledAtTick = null;
  sh.volume = isActive(s, 'fair_winds') ? Math.round(sh.baseVolume * 1.5) : sh.baseVolume;
  ev.push({ kind: 'ship_docked', text: `the Gull has docked. Captain Maren is buying up to ${sh.volume} cured fish at ${sh.ceiling / 100} marks or less.`, notable: true, npcId: CAPTAIN, good: 'cured_fish' });
}

/** Each docked tick: buy the cheapest cured fish at or under the ceiling. The Smokehouse may supply at most half. */
export function captainBuys(s: WorldState): void {
  const sh = s.ship;
  if (!sh.docked) return;
  for (const o of book(s, 'any', 'cured_fish', 'sell')) {
    if (sh.filled >= sh.volume || o.price > sh.ceiling) break;
    let n = Math.min(o.qty, sh.volume - sh.filled);
    // The Smokehouse supplies at most half the order, except in the last hours of the visit when it may fill what players left.
    const lateFill = sh.departureTick - s.tick <= E.captain.smokehouseLateFillTicks;
    if (o.owner === 'smokehouse' && !lateFill) n = Math.min(n, E.npcs.smokehouse.maxCuredSellPerVisit - sh.smokehouseSold);
    if (n <= 0) continue;
    executeTrade(s, { buyer: CAPTAIN, seller: o.owner, good: 'cured_fish', qty: n, price: o.price, venueId: o.venueId, sellEscrow: true });
    o.qty -= n;
    if (o.qty === 0) delete s.orders[o.id];
    sh.filled += n;
    if (o.owner === 'smokehouse') sh.smokehouseSold += n;
    if (sh.filled >= sh.volume && sh.filledAtTick === null) sh.filledAtTick = s.tick;
  }
}

export function shipDeparts(s: WorldState, ev: SimEvent[]): void {
  const sh = s.ship;
  if (!sh.docked || s.tick !== sh.departureTick) return;
  const fast = sh.filledAtTick !== null && sh.filledAtTick - sh.arrivalTick <= E.captain.fastFillTicks;
  const d = captainCeiling(sh.ceiling, sh.filled, sh.volume, fast, s.tick);
  const before = sh.ceiling;
  sh.ceiling = d.price;
  sh.reason = d.reason;
  sh.baseVolume = captainVolume(sh.baseVolume, sh.filled, fast);
  sh.docked = false;
  sh.visit += 1;
  sh.arrivalTick += E.captain.everyTicks;
  sh.departureTick = sh.arrivalTick + E.captain.dockTicks;
  ev.push({ kind: 'ship_departed', text: `the Gull sailed with ${sh.filled} of ${sh.volume} cured fish.`, notable: true, npcId: CAPTAIN });
  if (sh.ceiling !== before) ev.push({ kind: 'captain_ceiling', text: `Captain Maren: ${d.reason.text}`, notable: false, npcId: CAPTAIN, good: 'cured_fish' });
}
