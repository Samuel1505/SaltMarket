// ─────────────────────────────────────────────────────────────────────────────────────────────
//  SALTMARKET MERCHANT RULES — every merchant price and quantity decision lives in this file.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
//  How to read it (no programming needed for the gist):
//   1. MERCHANT_RULES says, per kind of merchant, what it sells, what it buys, how much stock it
//      wants on hand, and how fast it produces. The numbers come from the one economy config
//      (packages/shared/src/config/economy.ts) so tuning happens in one place.
//   2. askPrice()  — what a merchant charges for what it sells. Starts from its cost plus its
//      margin, then goes UP when its stock is low or it is selling fast, and DOWN when it has
//      far too much. Clamped to 0.5×–2.5× the good's usual price.            (docs/ECONOMY.md §8.1)
//   3. bidPrice()  — what a merchant pays for its inputs. It works backwards from what its
//      finished product sells for, so if inputs get too dear it stops buying.  (§8.2)
//      When the market floods with a good, it lowers its bid.                  (§8.5)
//   4. dailyOutput() — how much a producer makes: more when prices are high, less when low,
//      far less in a storm.                                                    (§8.3)
//   5. captainCeiling() — how the ship captain changes the most he'll pay.     (§7)
//   6. chooseVenue() — which market a merchant trades in, by total fees.       (§6.3)
//   Every function returns a Reason: a one-line sentence plus the factors behind it. Those are
//   exactly what the game shows in tooltips, so the explanation can never drift from the rule.
//
//  Rules elsewhere in the code may CALL these functions but must not compute prices themselves.

import { ECONOMY, type Archetype, type Good } from '@saltmarket/shared/config';
import type { Factor, Reason } from '../types.js';

const E = ECONOMY;
const P = E.pricing;
const NAME: Record<Good, string> = { fish: 'fish', salt: 'salt', timber: 'timber', barrel: 'barrels', cured_fish: 'cured fish' };
const Cap = (g: Good) => NAME[g][0]!.toUpperCase() + NAME[g].slice(1);
const isAre = (g: Good) => (g === 'barrel' ? 'are' : 'is');

// ─── 1. Who does what ─────────────────────────────────────────────────────────────────────────

type MerchantRule = {
  /** Goods this merchant sells. */
  sells: Good[];
  /** Goods it buys as inputs, with how many it likes to keep on hand. */
  buys: Partial<Record<Good, number>>;
  /** How many of its product it likes to keep on hand. */
  targetStock: number;
  /** Units produced per day at normal prices (producers only). */
  baseOutputPerDay: number;
  /** Units it expects to sell on a normal day: spreads its daily costs, and is the yardstick for "selling fast". */
  expectedDailySales: number;
  /** Fishing is weather-sensitive; storms cut the catch. */
  weatherSensitive: boolean;
  /** Woodcutters stop cutting when timber is too cheap, and restart when it recovers. */
  pauseBelowAnchorRatio?: number;
  resumeAboveAnchorRatio?: number;
};

export const MERCHANT_RULES: Record<Exclude<Archetype, 'captain'>, MerchantRule> = {
  fisherman: { sells: ['fish'], buys: {}, targetStock: E.npcs.fisherman.targetStock, baseOutputPerDay: E.npcs.fisherman.baseOutputPerDay, expectedDailySales: E.npcs.fisherman.baseOutputPerDay, weatherSensitive: true },
  salt_panner: { sells: ['salt'], buys: {}, targetStock: E.npcs.salt_panner.targetStock, baseOutputPerDay: E.npcs.salt_panner.baseOutputPerDay, expectedDailySales: E.npcs.salt_panner.baseOutputPerDay, weatherSensitive: false },
  woodcutter: { sells: ['timber'], buys: {}, targetStock: E.npcs.woodcutter.targetStock, baseOutputPerDay: E.npcs.woodcutter.baseOutputPerDay, expectedDailySales: E.npcs.woodcutter.baseOutputPerDay, weatherSensitive: false, pauseBelowAnchorRatio: 0.6, resumeAboveAnchorRatio: 0.75 },
  cooper: { sells: ['barrel'], buys: { ...E.npcs.cooper.inputTargets }, targetStock: E.npcs.cooper.targetStock, baseOutputPerDay: 0, expectedDailySales: E.npcs.cooper.expectedDailySales, weatherSensitive: false },
  smokehouse: { sells: ['cured_fish'], buys: { ...E.npcs.smokehouse.inputTargets }, targetStock: E.npcs.smokehouse.targetStock, baseOutputPerDay: 0, expectedDailySales: E.npcs.smokehouse.expectedDailySales, weatherSensitive: false },
};

export const sellsOf = (a: Archetype): Good[] => (a === 'captain' ? [] : MERCHANT_RULES[a].sells);
export const buysOf = (a: Archetype): Good[] => (a === 'captain' ? ['cured_fish'] : (Object.keys(MERCHANT_RULES[a].buys) as Good[]));

// ─── 2. Asking price (§8.1) ───────────────────────────────────────────────────────────────────

export type AskInput = {
  archetype: Exclude<Archetype, 'captain'>;
  good: Good;
  stock: number;
  margin: number;
  patience: number;
  /** Units this merchant sold in the last day. */
  soldLastDay: number;
  /** Materials cost of one unit at current input prices (crafters; producers have none). */
  unitCost?: number;
  /** Price posted last tick, for patience smoothing. */
  previous?: number;
  stormActive: boolean;
  /** Smokehouse only: the Captain's current ceiling. */
  captainCeiling?: number;
  /** Best standing buy offer from someone else for this good (what buyers will pay right now). */
  bestBid?: number;
};
export type PriceDecision = { price: number; reason: Reason };

export function askPrice(i: AskInput, tick: number): PriceDecision {
  const rule = MERCHANT_RULES[i.archetype];
  const anchor = E.goods[i.good].anchor;
  const target = rule.targetStock;
  // Cost of one unit (§8.1 cost_basis): materials at live prices plus this unit's share of the
  // merchant's daily living cost and upkeep, spread over what it expects to sell in a day.
  const dailyCosts = E.sinks.npcLivingCostPerDay + E.npcs[i.archetype].upkeepPerDay;
  const cost = (i.unitCost ?? 0) + dailyCosts / rule.expectedDailySales;
  // Positive when stock is below target (scarce → raise), negative when above.
  const stockPressure = (target - i.stock) / target;
  // Positive when selling faster than a normal day (one target's worth), negative when slower.
  const expected = Math.max(1, rule.expectedDailySales);
  const demandPressure = clamp(i.soldLastDay / expected - 1, P.demandPressureClamp[0], P.demandPressureClamp[1]);
  const normal = cost * (1 + i.margin);
  let raw = normal * (1 + P.kStock * stockPressure) * (1 + P.kDemand * demandPressure);
  // Too much on hand: spoilage punishes hoarding, so discount up to 15%.
  const excess = i.stock > P.excessStockMultiple * target;
  if (excess) raw *= 1 - Math.min(P.excessStockMaxDiscount, ((i.stock - P.excessStockMultiple * target) / target) * 0.1 + 0.05);
  // Weather-sensitive sellers price in the coming shortage as soon as a storm hits (NPC_AGENTS §4.1).
  if (i.stormActive && rule.weatherSensitive) raw *= 1 + E.stormAskPremium;
  // Don't sell far below what buyers are openly bidding (tuning L3): surplus goes to the producer, not the middleman.
  const bidFloor = i.bestBid ? i.bestBid * E.askOfBestBid : 0;
  const followsBid = bidFloor > raw && !excess;
  if (followsBid) raw = bidFloor;
  // The Smokehouse knows what the ship pays and prices just under the Captain's ceiling.
  if (i.archetype === 'smokehouse' && i.captainCeiling) raw = Math.max(normal, i.captainCeiling * E.smokehouseAskOfCeiling);
  const clamped = clamp(raw, P.askClampAnchor[0] * anchor, P.askClampAnchor[1] * anchor);
  const price = Math.max(1, Math.round(smooth(i.previous, clamped, i.patience)));
  const pctVsNormal = Math.round((price / normal - 1) * 100);

  const factors: Factor[] = [
    { key: 'stock', label: 'Stock', value: i.stock, unit: 'count', of: target },
    { key: 'soldLastDay', label: 'Sold in the last day', value: i.soldLastDay, unit: 'count' },
    { key: 'margin', label: 'Margin', value: Math.round(i.margin * 100), unit: 'pct' },
    { key: 'unitCost', label: 'Cost per unit', value: Math.round(cost), unit: 'pips' },
  ];
  // First matching condition picks the sentence (NPC_AGENTS §5.1).
  const g = NAME[i.good];
  let code = 'STEADY';
  let text = `${Cap(i.good)} at ${fmt(price)} marks, my usual price.`;
  if (i.stormActive && rule.weatherSensitive) { code = 'STORM_SUPPLY_CUT'; text = `Storm kept the boats in. Stock is low, raising my price ${Math.max(0, pctVsNormal)}%.`; }
  else if (excess) { code = 'EXCESS_STOCK_DISCOUNT'; text = `Too much ${g} on hand, discounting ${Math.max(0, -pctVsNormal)}%.`; }
  else if (i.stock < 0.5 * target && pctVsNormal > 0) { code = 'LOW_STOCK_RAISE_ASK'; text = `${Cap(i.good)} ${isAre(i.good)} scarce, raising my price ${pctVsNormal}%.`; }
  else if (followsBid && pctVsNormal > 0) { code = 'DEMAND_UP_RAISE_ASK'; text = `Buyers are bidding up to ${fmt(i.bestBid ?? 0)} marks for ${g}. Raising my price ${pctVsNormal}%.`; factors.push({ key: 'bestBid', label: 'Best buy offer', value: i.bestBid ?? 0, unit: 'pips' }); }
  else if (demandPressure > 0.3 && pctVsNormal > 0) { code = 'DEMAND_UP_RAISE_ASK'; text = `${Cap(i.good)} ${isAre(i.good)} selling fast, nudging my price up ${pctVsNormal}%.`; }
  else if (pctVsNormal < -5) { code = 'EXCESS_STOCK_DISCOUNT'; text = `${Cap(i.good)} ${isAre(i.good)} slow to sell, discounting ${-pctVsNormal}%.`; }
  else if (i.archetype === 'smokehouse' && i.captainCeiling) { code = 'SHIP_NEAR_HOLD_STOCK'; text = `Pricing cured fish just under the Captain's ${fmt(i.captainCeiling)} marks.`; }
  return { price, reason: reason(code, text, factors, tick) };
}

// ─── 3. Bid for inputs (§8.2, §8.5) ───────────────────────────────────────────────────────────

export type BidInput = {
  archetype: 'cooper' | 'smokehouse';
  good: Good;
  stock: number;
  margin: number;
  patience: number;
  previous?: number;
  /** Recent median prices of every good (for input costs and output value). */
  median: Record<Good, number>;
  /** listed supply now ÷ its 2-day average, minus 1 (> 0 means the market is flooded). */
  glutRatio: number;
};
export type BidDecision = PriceDecision & {
  /** Units to buy now from sellers' asks (up to target stock). */
  qty: number;
  /** Units to keep offering to buy at the bid, so players can always sell in (up to 2× target). */
  standingQty: number;
  paused: boolean;
};

export function bidPrice(i: BidInput, tick: number): BidDecision {
  const rule = MERCHANT_RULES[i.archetype];
  const target = rule.buys[i.good] ?? 0;
  const m = i.median;
  // Work backwards from what the output sells for, minus the other inputs.
  let maxBid: number;
  if (i.archetype === 'cooper') {
    maxBid = m.barrel / 3; // 3 timber → 1 barrel
  } else {
    const batch = 4 * m.cured_fish; // 6 fish + 3 salt + 1 barrel → 4 cured fish
    const others = { fish: 3 * m.salt + m.barrel, salt: 6 * m.fish + m.barrel, barrel: 6 * m.fish + 3 * m.salt } as Record<Good, number>;
    const per = { fish: 6, salt: 3, barrel: 1 } as Record<Good, number>;
    maxBid = (batch - (others[i.good] ?? 0)) / (per[i.good] ?? 1);
  }
  const glut = clamp(i.glutRatio, P.glutClamp[0], P.glutClamp[1]);
  // Tuning L4: bid near the going price, more when short of stock, less when full; never above break-even.
  const need = target > 0 ? clamp((target - i.stock) / target, -1, 1) : 0;
  const market = m[i.good] * (1 + E.bidNeedPremium * need);
  const breakEven = maxBid * (1 - i.margin);
  let bid = Math.min(breakEven, market) * (1 - P.kGlut * glut);
  // Scenario tuning S4: when badly short, raise last tick's bid a little each tick (up to break-even) until sellers bite.
  const escalating = need > 0.5 && i.previous !== undefined && i.previous > 0 && i.previous * (1 + E.bidEscalatePerTick) > bid;
  if (escalating) bid = Math.min(breakEven, (i.previous ?? 0) * (1 + E.bidEscalatePerTick));
  // Tuning L14: bids live in the same 0.5×–2.5× band as asks (a flood can make goods cheap, not free).
  bid = Math.min(bid, P.askClampAnchor[1] * E.goods[i.good].anchor);
  if (bid > 0) bid = Math.max(bid, P.askClampAnchor[0] * E.goods[i.good].anchor);
  const price = Math.max(0, Math.round(smooth(i.previous, bid, i.patience)));
  const marginPct = Math.round((1 - (i.previous ?? price) / Math.max(1, maxBid)) * 100);
  const factors: Factor[] = [
    { key: 'stock', label: 'Stock', value: i.stock, unit: 'count', of: target },
    { key: 'maxBid', label: 'Break-even price', value: Math.max(0, Math.round(maxBid)), unit: 'pips' },
    { key: 'margin', label: 'Margin', value: Math.round(i.margin * 100), unit: 'pct' },
  ];
  const g = NAME[i.good];
  if (maxBid <= P.askClampAnchor[0] * E.goods[i.good].anchor || price <= 0) {
    return { price: 0, qty: 0, standingQty: 0, paused: true, reason: reason('MARGIN_NEGATIVE_PAUSE_BUY', `${i.archetype === 'smokehouse' ? 'Curing' : 'Barrel-making'} isn't profitable at current prices. Pausing ${g} purchases.`, factors, tick) };
  }
  if (i.archetype === 'smokehouse' && marginPct < 8 && i.good === 'fish') {
    return { price: 0, qty: 0, standingQty: 0, paused: true, reason: reason('MARGIN_NEGATIVE_PAUSE_BUY', `Cured fish margin is only ${Math.max(0, marginPct)}% at current fish prices. Pausing purchases until fish drops.`, factors, tick) };
  }
  const qty = i.stock >= P.excessStockMultiple * target ? 0 : Math.max(0, target - i.stock);
  const standingQty = Math.max(0, P.excessStockMultiple * target - i.stock);
  if (glut > 0.2) return { price, qty, standingQty, paused: false, reason: reason('MARKET_GLUT_LOWER_BID', `${Cap(i.good)} ${isAre(i.good)} flooding in. Lowering my bid ${Math.round(P.kGlut * glut * 100)}%.`, factors, tick) };
  if (escalating && qty > 0) return { price, qty, standingQty, paused: false, reason: reason('DEMAND_UP_RAISE_ASK', `Short of ${g} (${i.stock} of ${target}). Raising my bid to ${fmt(price)} marks.`, factors, tick) };
  if (qty === 0) return { price, qty, standingQty, paused: false, reason: reason('STEADY', `Enough ${g} on hand. Not buying more for now.`, factors, tick) };
  return { price, qty, standingQty, paused: false, reason: reason('STEADY', `Buying ${g} up to ${fmt(price)} marks to keep my margin.`, factors, tick) };
}

// ─── 4. Production (§8.3) ─────────────────────────────────────────────────────────────────────

export type OutputInput = {
  archetype: 'fisherman' | 'salt_panner' | 'woodcutter';
  medianPrice: number;
  /** 1 normally; storm day 0.15, the day after 0.75 (weather-sensitive producers only). */
  weatherFactor: number;
  /** Extra multiplier from events such as a salt glut (+60%). */
  eventFactor: number;
  pausedLowPrice: boolean;
  /** Units on hand, including those listed for sale. */
  stock: number;
};
export function dailyOutput(i: OutputInput): number {
  if (i.pausedLowPrice) return 0;
  const rule = MERCHANT_RULES[i.archetype];
  // Tuning L11: a full shed means no more production; otherwise the excess-stock discount drags the price below cost.
  if (i.stock >= E.productionStopOfTarget * rule.targetStock) return 0;
  const good = rule.sells[0]!;
  const ratio = i.medianPrice / E.goods[good].anchor;
  const rate = clamp(Math.pow(ratio, E.elasticity), E.rateFactorClamp[0], E.rateFactorClamp[1]);
  return rule.baseOutputPerDay * rate * (rule.weatherSensitive ? i.weatherFactor : 1) * i.eventFactor;
}

/** Woodcutters' daily review: pause below 0.6× the usual price for 2 days, resume above 0.75×. */
export function lowPriceRule(archetype: Archetype, medianPrice: number, good: Good, paused: boolean, lowDays: number): { paused: boolean; lowDays: number; reason?: Reason; tick?: number } {
  if (archetype === 'captain') return { paused, lowDays };
  const rule = MERCHANT_RULES[archetype];
  if (rule.pauseBelowAnchorRatio === undefined || rule.resumeAboveAnchorRatio === undefined) return { paused, lowDays };
  const ratio = medianPrice / E.goods[good].anchor;
  if (!paused) {
    const days = ratio < rule.pauseBelowAnchorRatio ? lowDays + 1 : 0;
    return { paused: days >= 2, lowDays: days };
  }
  return { paused: ratio <= rule.resumeAboveAnchorRatio, lowDays: 0 };
}
export const lowPriceReason = (good: Good, paused: boolean, tick: number): Reason =>
  paused
    ? reason('PRICE_BELOW_COST_PAUSE', `${Cap(good)} ${isAre(good)} too cheap to be worth cutting. Pausing until it recovers.`, [], tick)
    : reason('STEADY', `${Cap(good)} prices recovered. Back to work.`, [], tick);

// ─── 5. The Captain's ceiling (§7) ────────────────────────────────────────────────────────────

/** Tuning L15: the Captain's order size follows supply: a hold filled fast brings a bigger order, a thin one a smaller order. */
export function captainVolume(volume: number, filled: number, filledFast: boolean): number {
  const c = E.captain;
  if (filledFast) return Math.min(c.maxVolume, volume + c.volumeStep);
  if ((volume - filled) / volume >= c.unfilledRaiseThresholdBps / 10000) return Math.max(c.minVolume, volume - c.volumeStep);
  return volume;
}

export function captainCeiling(current: number, filled: number, volume: number, filledFast: boolean, tick: number): PriceDecision {
  const c = E.captain;
  const unfilledBps = Math.round(((volume - filled) / volume) * 10000);
  let next = current;
  let code = 'STEADY';
  let text = `Bought ${filled} of ${volume}. Keeping my ceiling at ${fmt(current)} marks.`;
  if (unfilledBps >= c.unfilledRaiseThresholdBps) {
    next = Math.min(c.maxCeiling, Math.round((current * (10000 + c.raiseBps)) / 10000));
    code = 'CAPTAIN_CEILING_RAISE';
    text = `Only ${filled} of ${volume} cured fish available. Raising my ceiling next visit to ${fmt(next)} marks.`;
  } else if (filledFast) {
    next = Math.max(c.minCeiling, Math.round((current * (10000 - c.lowerBps)) / 10000));
    code = 'CAPTAIN_CEILING_LOWER';
    text = `Filled my hold fast. Lowering my ceiling to ${fmt(next)} marks.`;
  } else if (filled >= volume) {
    next = Math.max(c.minCeiling, Math.round((current * (10000 - c.fullFillLowerBps)) / 10000));
    code = 'CAPTAIN_CEILING_LOWER';
    text = `Got all ${volume} cured fish I wanted. Easing my ceiling to ${fmt(next)} marks.`;
  }
  return { price: next, reason: reason(code, text, [{ key: 'ceiling', label: 'Ceiling', value: next, unit: 'pips' }, { key: 'filled', label: 'Bought this visit', value: filled, unit: 'count', of: volume }], tick) };
}

// ─── 6. Venue choice (§6.3) ───────────────────────────────────────────────────────────────────

export type VenueCost = { id: string; feeBps: number; frictionBps: number };
/** Pick the venue with the lowest seller cost; switch only if it beats the current one by more than loyalty × 1%. */
export function chooseVenue(current: string, venues: VenueCost[], loyalty: number): { venueId: string; switched: boolean } {
  const cost = (v: VenueCost) => v.feeBps + v.frictionBps;
  const cur = venues.find((v) => v.id === current) ?? venues[0]!;
  const best = [...venues].sort((a, b) => cost(a) - cost(b) || a.id.localeCompare(b.id))[0]!;
  if (best.id !== cur.id && cost(cur) - cost(best) > loyalty * 100) return { venueId: best.id, switched: true };
  return { venueId: cur.id, switched: false };
}
export const switchReason = (venueName: string, tick: number): Reason =>
  reason('SWITCH_VENUE_LOWER_FEE', `Moving my stall to ${venueName}: lower fees.`, [], tick);

// ─── explain(): tooltip text from a Reason ────────────────────────────────────────────────────

export const RULES_FILE = 'packages/sim/src/pricing/merchant-rules.ts';

/** One line of key factors, e.g. "Stock 3 of 14, Sold in the last day 9, Margin 16%". */
export function explain(r: Reason): string {
  return r.factors.map((f) => `${f.label} ${fmtFactor(f)}`).join(', ');
}

// ─── helpers ──────────────────────────────────────────────────────────────────────────────────

function reason(code: string, text: string, factors: Factor[], tick: number): Reason {
  const r: Reason = { code, text, factors, tick };
  const d = explain(r);
  if (d) r.detail = d;
  return r;
}
function smooth(prev: number | undefined, target: number, patience: number): number {
  if (prev === undefined || prev <= 0) return target;
  return prev + (target - prev) * E.priceSmoothing * (1 - 0.7 * patience);
}
function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
export function fmt(pips: number): string {
  const v = pips / 100;
  return Number.isInteger(v) ? `${v}` : v.toFixed(1);
}
function fmtFactor(f: Factor): string {
  const v = typeof f.value === 'number' && f.unit === 'pips' ? `${fmt(f.value)} marks` : f.unit === 'pct' ? `${f.value}%` : `${f.value}`;
  return f.of !== undefined ? `${v} of ${f.of}` : v;
}
