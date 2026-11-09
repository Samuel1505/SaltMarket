// Daily boundary (tick % 24 == 0): sinks, spoilage, rent, closures, investor payouts, regeneration (ECONOMY §5, §8.6).
import { ECONOMY, GATHER_NODES, ROSTER } from '@saltmarket/shared/config';
import { burn, destroyGood, transfer } from './ledger.js';
import { lowPriceReason, lowPriceRule, sellsOf, fmt } from './pricing/merchant-rules.js';
import { closeNpc, npcName, setReason } from './events.js';
import { medianPrice } from './metrics.js';
import { roundStochastic } from './rng.js';
import { TOWN_FUND, type SimEvent, type WorldState } from './types.js';

const E = ECONOMY;
const TPD = E.time.ticksPerDay;

export function dailyBoundary(s: WorldState, ev: SimEvent[]): void {
  // Spoilage (seeded stochastic rounding).
  for (const a of Object.values(s.accounts)) {
    for (const g of ['fish', 'cured_fish'] as const) {
      const n = roundStochastic(s, a.inv[g] * E.goods[g].spoilPerDay);
      if (n > 0) destroyGood(s, a.id, g, n);
    }
  }
  // Gather nodes regenerate; per-player daily counters reset.
  for (const n of GATHER_NODES) s.nodes[n] = Math.min(E.gather.nodes[n].cap, s.nodes[n] + E.gather.nodes[n].regenPerDay);
  for (const p of Object.values(s.players)) {
    p.gatheredToday = 0;
    p.pairTrades = {};
    if (s.tick - p.joinedTick < E.player.rentGraceDays * TPD) continue;
    const due = E.sinks.stallRentPerDay + p.arrears;
    const paid = burn(s, p.id, due);
    p.arrears = due - paid;
    ev.push(p.arrears > 0
      ? { kind: 'rent', text: `Couldn't pay all your rent. You owe ${fmt(p.arrears)} marks.`, notable: true, accountId: p.id, private: true }
      : { kind: 'rent', text: `Paid ${fmt(paid)} marks stall rent.`, notable: false, accountId: p.id, private: true });
  }
  // Merchants: living costs and upkeep, then closure checks, profit share, low-price rule.
  for (const npc of Object.values(s.npcs)) {
    if (npc.status === 'closed' || npc.archetype === 'captain') continue;
    const cfg = E.npcs[npc.archetype];
    burn(s, npc.id, E.sinks.npcLivingCostPerDay + cfg.upkeepPerDay);
    const a = s.accounts[npc.id]!;
    npc.brokeDays = a.marks < E.sinks.npcLivingCostPerDay ? npc.brokeDays + 1 : 0;
    const sellable = sellsOf(npc.archetype).reduce((n, g) => n + a.inv[g] + (s.orders[`${npc.id}:${g}:sell`]?.qty ?? 0), 0);
    if (npc.brokeDays >= E.merchants.closeAfterDaysBroke && sellable === 0) {
      closeNpc(s, npc, 'Out of cash and nothing left to sell. Closing until someone backs me.', ev);
      continue;
    }
    const escrow = Object.values(s.orders).filter((o) => o.owner === npc.id && o.side === 'buy').reduce((n, o) => n + o.qty * o.price, 0);
    const profit = a.marks + escrow - npc.dayStartMarks;
    const inv = npc.investor;
    if (inv && profit > 0) {
      const pay = Math.min(Math.round((profit * E.merchants.profitShareBps) / 10000), inv.cap - inv.paidOut, a.marks);
      if (pay > 0) {
        transfer(s, npc.id, inv.playerId, pay);
        inv.paidOut += pay;
        ev.push({ kind: 'investor_payout', text: `${npcName(npc.id)} paid you ${fmt(pay)} marks.`, notable: false, accountId: inv.playerId, private: true, npcId: npc.id });
      }
      if (inv.paidOut >= inv.cap) npc.investor = null;
    }
    npc.dayStartMarks = s.accounts[npc.id]!.marks + escrow;
    npc.spentToday = 0;
    const good = sellsOf(npc.archetype)[0];
    if (good) {
      const before = npc.prodPaused;
      const r = lowPriceRule(npc.archetype, medianPrice(s, good, TPD), good, npc.prodPaused, npc.lowPriceDays);
      npc.prodPaused = r.paused;
      npc.lowPriceDays = r.lowDays;
      if (before !== r.paused) setReason(s, npc, lowPriceReason(good, r.paused, s.tick), ev);
    }
  }
  // Demurrage on large cash piles (ECONOMY §5).
  for (const a of Object.values(s.accounts)) {
    if (a.kind !== 'player' && a.kind !== 'npc') continue;
    const over = a.marks - E.sinks.demurrage.thresholdPips;
    if (over > 0) burn(s, a.id, Math.floor((over * E.sinks.demurrage.bpsPerDay) / 10000));
  }
  // Town Fund: weekly burn above its cap.
  if (s.tick % (7 * TPD) === 0) {
    const tf = s.accounts[TOWN_FUND]!;
    if (tf.marks > E.townFund.balanceCap) burn(s, TOWN_FUND, tf.marks - E.townFund.balanceCap);
  }
  void ROSTER;
}
