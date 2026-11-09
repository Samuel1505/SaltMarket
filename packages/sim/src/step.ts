// One tick of the world (ARCHITECTURE §3.2). Deterministic: no clock, no ambient randomness, no I/O.
// Mutates the given state in place for speed; clone first (structuredClone) for sandboxes.
import { ECONOMY, GOODS } from '@saltmarket/shared/config';
import { createGood } from './ledger.js';
import { captainBuys, shipArrives, shipDeparts } from './captain.js';
import { dailyBoundary } from './daily.js';
import { rescueDue, tickEvents } from './events.js';
import { listedSupply } from './metrics.js';
import { runNpc } from './npcs/agent.js';
import type { Job, SimEvent, WorldState } from './types.js';

const E = ECONOMY;
const TPD = E.time.ticksPerDay;

function completeJobs(s: WorldState, owner: string, jobs: Job[], ev: SimEvent[], isPlayer: boolean): Job[] {
  const left: Job[] = [];
  for (const j of jobs) {
    if (j.done > s.tick) { left.push(j); continue; }
    for (const [g, q] of Object.entries(E.recipes[j.recipe].out)) createGood(s, owner, g as never, q);
    if (isPlayer) ev.push({ kind: 'craft', text: j.recipe === 'cure_fish' ? 'Your batch is cured: +4 cured fish.' : 'Your barrel is ready: +1 barrel.', notable: false, accountId: owner, private: true });
  }
  return left;
}

export function step(s: WorldState): SimEvent[] {
  const ev: SimEvent[] = [];
  s.tick += 1;
  // 1. Scheduled events and fee changes.
  for (const h of Object.values(s.halls)) h.feeBps = h.nextFeeBps;
  tickEvents(s, ev);
  shipArrives(s, ev);
  // 3. NPCs observe → decide → guard → act.
  for (const npc of Object.values(s.npcs)) runNpc(s, npc, ev);
  // 4. Crafting completions.
  for (const p of Object.values(s.players)) p.jobs = completeJobs(s, p.id, p.jobs, ev, true);
  for (const n of Object.values(s.npcs)) n.jobs = completeJobs(s, n.id, n.jobs, ev, false);
  // 5–6. Captain buys while docked, then may sail.
  captainBuys(s);
  shipDeparts(s, ev);
  rescueDue(s, ev);
  // 7. Daily boundary.
  if (s.tick % TPD === 0) dailyBoundary(s, ev);
  // 8. Metrics: 6-tick price buckets, listed-supply average, trade log trimming.
  if (s.tick % 6 === 0) {
    for (const g of GOODS) {
      const ts = s.trades.filter((t) => t.good === g && t.tick > s.tick - 6);
      const ps = ts.flatMap((t) => Array(Math.min(t.qty, 5)).fill(t.price) as number[]).sort((a, b) => a - b);
      const h = s.history[g];
      h.push({ tick: s.tick, median: ps.length ? ps[Math.floor(ps.length / 2)]! : null, last: ts.length ? ts[ts.length - 1]!.price : null, volume: ts.reduce((n, t) => n + t.qty, 0) });
      if (h.length > 30 * 4) h.shift();
    }
  }
  for (const g of GOODS) s.listedEma[g] += (listedSupply(s, g) - s.listedEma[g]) / 48;
  if (s.trades.length && s.trades[0]!.tick <= s.tick - 7 * TPD) s.trades = s.trades.filter((t) => t.tick > s.tick - 7 * TPD);
  return ev;
}
