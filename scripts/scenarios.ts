// Scenario tests from docs/TESTING_AND_DEMO.md §3–4, as pure functions returning a report and checks.
// Used by `pnpm sim:storm` and scripts/scenarios.test.ts.
import { GOODS, type Good } from '@saltmarket/shared/config';
import {
  addPlayer, applyCommand, assertInvariants, createWorld, forceBroke, grantMarks, medianPrice, scheduleEvent, step,
  type SimEvent, type WorldState,
} from '@saltmarket/sim';

export type Check = { ok: boolean; text: string };
export type Scenario = { name: string; checks: Check[]; table: string[] };
const TPD = 24;
const mk = (p: number) => (p / 100).toFixed(1);
const check = (ok: boolean, text: string): Check => ({ ok, text });

function runTicks(s: WorldState, n: number, on?: (ev: SimEvent[]) => void): void {
  for (let i = 0; i < n; i++) { const ev = step(s); assertInvariants(s); on?.(ev); }
}
/** Median trade price over [from, to). */
function medianBetween(s: WorldState, good: Good, from: number, to: number, log: { tick: number; good: Good; price: number; qty: number }[]): number | null {
  const ps = log.filter((t) => t.good === good && t.tick >= from && t.tick < to).flatMap((t) => Array(Math.min(t.qty, 5)).fill(t.price) as number[]).sort((a, b) => a - b);
  void s;
  return ps.length ? ps[Math.floor(ps.length / 2)]! : null;
}
const bestFishAsk = (s: WorldState) => Object.values(s.orders).filter((o) => o.good === 'fish' && o.side === 'sell').reduce((m, o) => Math.min(m, o.price), Infinity);
const med = (xs: number[]) => { const a = xs.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)]! : 0; };
const fishAsk = (s: WorldState) => {
  const ps = ['fisher-1', 'fisher-2', 'fisher-3'].map((id) => s.orders[`${id}:fish:sell`]?.price).filter((p): p is number => p !== undefined);
  return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 0;
};

/** §4: the Storm. Fish catch collapses on stormDay; the town reacts and recovers on its own. */
export function stormScenario(seed = 42, stormDay = 10): Scenario {
  const s = createWorld(seed);
  const trades: { tick: number; good: Good; price: number; qty: number }[] = [];
  const record = () => { for (const t of s.trades) if (t.tick === s.tick) trades.push({ tick: t.tick, good: t.good, price: t.price, qty: t.qty }); };
  const board0: number[] = [];
  runTicks(s, stormDay * TPD, () => { record(); if (s.tick > (stormDay - 2) * TPD) board0.push(bestFishAsk(s)); });
  const t0 = s.tick + 1; // storm starts
  const baseline = medianBetween(s, 'fish', t0 - 2 * TPD, t0, trades) ?? medianPrice(s, 'fish');
  const baseAsk = fishAsk(s);
  const boardBefore: number[] = [];
  // (sampled below) the board price: the cheapest fish anyone is selling, hour by hour
  const ceilBefore = s.ship.ceiling;
  scheduleEvent(s, 'storm', t0);
  let stormReason = false; let maxAskEarly = 0; let smokehousePaused = false; let ceilingRaised = false; let unfilledVisit = false;
  const fishBought = { before: trades.filter((t) => t.good === 'fish' && t.tick >= t0 - TPD).reduce((n, t) => n + t.qty, 0), during: 0 };
  const lines: string[] = [];
  const boardDuring: number[] = [];
  void boardBefore;
  for (let h = 0; h < 7 * TPD; h++) {
    let ev: SimEvent[] = [];
    runTicks(s, 1, (e) => { ev = e; record(); });
    const rel = s.tick - t0;
    if (rel < 2 * TPD) boardDuring.push(bestFishAsk(s));
    if (rel <= 6) {
      maxAskEarly = Math.max(maxAskEarly, fishAsk(s));
      if (['fisher-1', 'fisher-2', 'fisher-3'].some((id) => s.npcs[id]!.reasoning.code === 'STORM_SUPPLY_CUT')) stormReason = true;
    }
    if (rel < 2 * TPD && (s.npcs.smokehouse!.reasoning.code === 'MARGIN_NEGATIVE_PAUSE_BUY' || s.npcs.smokehouse!.status === 'paused')) smokehousePaused = true;
    if (rel < TPD) fishBought.during += s.trades.filter((t) => t.tick === s.tick && t.good === 'fish').reduce((n, t) => n + t.qty, 0);
    for (const e of ev) {
      if (e.kind === 'ship_departed' && rel < 4 * TPD && /with (\d+) of (\d+)/.test(e.text)) { const [, a, b] = /with (\d+) of (\d+)/.exec(e.text)!; if (Number(a) < Number(b)) unfilledVisit = true; }
      if (e.kind === 'captain_ceiling' && rel < 4 * TPD && s.ship.ceiling > ceilBefore) ceilingRaised = true;
      if (e.kind === 'ship_departed') lines.push(`  tick +${rel}: ${e.text} Ceiling now ${mk(s.ship.ceiling)}.`);
    }
    if (rel % TPD === TPD - 1) {
      const d = Math.floor(rel / TPD) + 1;
      const med = medianBetween(s, 'fish', s.tick - TPD + 1, s.tick + 1, trades);
      lines.push(`day +${d}  fish ${med === null ? '  -  ' : mk(med).padStart(5)}  (${med === null ? '' : `${Math.round((med / baseline - 1) * 100)}%`})  ceiling ${mk(s.ship.ceiling)}  smokehouse: ${s.npcs.smokehouse!.reasoning.text}`);
    }
  }
  const dayMed = (d: number) => medianBetween(s, 'fish', t0 + (d - 1) * TPD, t0 + d * TPD, trades);
  const boardBase = med(board0);
  const boardPeak = Math.max(med(boardDuring.slice(0, TPD)), med(boardDuring.slice(TPD)));
  const day6 = dayMed(6) ?? dayMed(7) ?? medianPrice(s, 'fish');
  const table = [`seed ${seed}, storm on day ${stormDay}; pre-storm fish median ${mk(baseline)} marks, fisherman ask ${mk(baseAsk)}`, ...lines];
  return {
    name: 'Storm (TESTING §4)', table,
    checks: [
      check(stormReason, 'ticks +1..+6: fishermen give the storm as their reason'),
      check(maxAskEarly >= baseAsk * 1.15, `ticks +1..+6: fish asks up ≥ 15% (${Math.round((maxAskEarly / baseAsk - 1) * 100)}%)`),
      check(boardPeak >= boardBase * 1.3, `day +1..+2: the board price of fish (cheapest ask, hourly median) is up ≥ 30% (${Math.round((boardPeak / boardBase - 1) * 100)}%; few fish trade while the Smokehouse pauses)`),
      check(smokehousePaused || fishBought.during < fishBought.before, `day +1: Smokehouse pauses or buys less fish (${fishBought.during} vs ${fishBought.before})`),
      check(unfilledVisit && ceilingRaised, `day +1..+4: a ship visit goes short and the Captain raises his ceiling (${mk(ceilBefore)} → ${mk(s.ship.ceiling)})`),
      check(Math.abs(day6 / baseline - 1) <= 0.2, `by day +6: fish median within ±20% of baseline (${Math.round((day6 / baseline - 1) * 100)}%)`),
    ],
  };
}

/** §3.5: a trader dumps 200 timber in one day; timber gets cheap, bids drop, woodcutters cut back, prices recover. */
export function floodScenario(seed = 42, day = 10): Scenario {
  const s = createWorld(seed);
  const trades: { tick: number; good: Good; price: number; qty: number }[] = [];
  const record = () => { for (const t of s.trades) if (t.tick === s.tick) trades.push({ tick: t.tick, good: t.good, price: t.price, qty: t.qty }); };
  runTicks(s, day * TPD, record);
  const t0 = s.tick + 1;
  const baseline = medianBetween(s, 'timber', t0 - 2 * TPD, t0, trades) ?? medianPrice(s, 'timber');
  const woodBefore = s.goods.created.timber;
  runTicks(s, 2 * TPD, record); // two calm days for an output baseline
  const baseOutput = s.goods.created.timber - woodBefore;
  const t1 = s.tick + 1;
  scheduleEvent(s, 'flood', t1, { good: 'timber', qty: 200 });
  let glutReason = false;
  const created0 = s.goods.created.timber;
  runTicks(s, 2 * TPD, (ev) => { record(); if (ev.some((e) => e.text.includes('flooding in'))) glutReason = true; if (s.npcs.cooper!.reasoning.code === 'MARKET_GLUT_LOWER_BID') glutReason = true; });
  const floodOutput = s.goods.created.timber - created0 - 200;
  const dayAfter = medianBetween(s, 'timber', t1, t1 + TPD, trades) ?? baseline;
  runTicks(s, 4 * TPD, record);
  const recovered = medianBetween(s, 'timber', s.tick - TPD, s.tick + 1, trades) ?? medianPrice(s, 'timber');
  return {
    name: 'Flood (TESTING §3.5)',
    table: [`seed ${seed}; timber baseline ${mk(baseline)}, flood day ${mk(dayAfter)}, 5 days later ${mk(recovered)}; woodcutter output ${baseOutput} → ${floodOutput} over the 2 flood days vs 2 days before`],
    checks: [
      check(dayAfter <= baseline * 0.75, `timber median falls ≥ 25% within a day (${Math.round((dayAfter / baseline - 1) * 100)}%)`),
      check(glutReason, 'a merchant explains it is lowering its bid because of the glut'),
      check(floodOutput < baseOutput, `woodcutters produce less over the 2 days after the flood (${floodOutput} vs ${baseOutput})`),
      check(Math.abs(recovered / baseline - 1) <= 0.2, `timber back within ±20% of baseline within 5 days (${Math.round((recovered / baseline - 1) * 100)}%)`),
    ],
  };
}

/** §3.3: two player Halls, 4% and 1%. Merchants move volume to the cheaper Hall; its owner out-earns the other. */
export function hallScenario(seed = 42): Scenario {
  const s = createWorld(seed);
  const ev: SimEvent[] = [];
  for (const [id, name, fee] of [['hall-owner-a', 'Ada', 400], ['hall-owner-b', 'Bram', 100]] as const) {
    addPlayer(s, id, name);
    grantMarks(s, id, 20000);
    applyCommand(s, id, { t: 'buyHall', name: `${name}'s Exchange` }, ev);
    const hall = Object.values(s.halls).find((h) => h.ownerId === id)!;
    applyCommand(s, id, { t: 'setHallFee', hallId: hall.id, bps: fee }, ev);
  }
  runTicks(s, 3 * TPD);
  const [a, b] = Object.values(s.halls);
  const vol = (hallId: string) => s.trades.filter((t) => t.venueId === hallId).reduce((n, t) => n + t.qty * t.price, 0);
  const movers = Object.values(s.npcs).filter((n) => n.venueId === b!.id).map((n) => s.accounts[n.id]!.name);
  return {
    name: 'Hall competition (TESTING §3.3)',
    table: [`${a!.name} ${a!.feeBps / 100}%: volume ${mk(vol(a!.id))} marks, fee income ${mk(a!.feeIncomeTotal)}`, `${b!.name} ${b!.feeBps / 100}%: volume ${mk(vol(b!.id))} marks, fee income ${mk(b!.feeIncomeTotal)}; merchants trading there: ${movers.join(', ') || 'none'}`],
    checks: [
      check(movers.length > 0, `within 3 days merchants move their stalls to the cheaper Hall (${movers.length})`),
      check(vol(b!.id) > vol(a!.id), 'the 1% Hall carries more volume than the 4% Hall'),
      check(b!.feeIncomeTotal > a!.feeIncomeTotal, `the cheaper Hall's owner earns more (${mk(b!.feeIncomeTotal)} vs ${mk(a!.feeIncomeTotal)} marks)`),
    ],
  };
}

/** §3.4: closure, investment, and rescue. */
export function closureScenario(seed = 42): Scenario {
  // Case A: a player invests.
  const s = createWorld(seed);
  runTicks(s, 2 * TPD);
  const ev: SimEvent[] = [];
  addPlayer(s, 'inv', 'Investor');
  forceBroke(s, 'cooper', ev);
  const closedAt = s.tick;
  let tradedWhileClosed = false;
  runTicks(s, TPD, () => { if (s.trades.some((t) => t.tick === s.tick && (t.buyer === 'cooper' || t.seller === 'cooper'))) tradedWhileClosed = true; });
  const r = applyCommand(s, 'inv', { t: 'invest', npcId: 'cooper', amountPips: 20000 }, ev);
  runTicks(s, 10 * TPD);
  const stake = s.npcs.cooper!.investor;
  const paid = stake?.paidOut ?? 25000;
  // Case B: nobody invests.
  const s2 = createWorld(seed);
  runTicks(s2, 2 * TPD);
  forceBroke(s2, 'smokehouse', ev);
  let rescued = false;
  runTicks(s2, 5 * TPD + 1, (e) => { if (e.some((x) => x.kind === 'MERCHANT_RESCUED')) rescued = true; });
  return {
    name: 'Closure, investment, rescue (TESTING §3.4)',
    table: [`Case A: Cooper closed at tick ${closedAt}; invest → ${r.message}; paid out ${mk(paid)} of a ${mk(25000)} cap`, `Case B: Smokehouse ${rescued ? 'rescued by the Town Fund' : 'NOT rescued'} after 5 days`],
    checks: [
      check(ev.some((e) => e.kind === 'MERCHANT_CLOSED'), 'MERCHANT_CLOSED appears in the feed'),
      check(!tradedWhileClosed, 'a closed merchant never buys or sells'),
      check(r.ok && s.npcs.cooper!.status !== 'closed', 'an investment reopens the merchant'),
      check(paid <= 25000, 'investor payouts never exceed 125% of principal'),
      check(rescued && s2.npcs.smokehouse!.status !== 'closed', 'with no investor, the Town Fund rescues it after 5 days (MERCHANT_RESCUED)'),
    ],
  };
}

export const ALL = [stormScenario, floodScenario, hallScenario, closureScenario];
void GOODS;
