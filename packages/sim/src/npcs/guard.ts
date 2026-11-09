// Policy guard between an NPC's decision and its purse (NPC_AGENTS §6). Pure; every cut is explained.
import { ECONOMY, type Archetype, type Good } from '@saltmarket/shared/config';
import { buysOf, sellsOf } from '../pricing/merchant-rules.js';
import type { Npc, WorldState } from '../types.js';

const E = ECONOMY;

export type Policy = { maxSpendPerDay: number; maxSpendPerTrade: number; cashFloor: number; allowedGoodsBuy: Good[]; allowedGoodsSell: Good[]; maxOrderQty: number };

export function policyFor(archetype: Exclude<Archetype, 'captain'>): Policy {
  const cfg = E.npcs[archetype];
  const p = E.npcPolicy;
  return {
    maxSpendPerDay: Math.round(cfg.startCash * p.maxSpendPerDayOfStartCash),
    maxSpendPerTrade: Math.round(cfg.startCash * p.maxSpendPerTradeOfStartCash),
    cashFloor: p.cashFloorDays * (E.sinks.npcLivingCostPerDay + cfg.upkeepPerDay),
    allowedGoodsBuy: buysOf(archetype),
    allowedGoodsSell: sellsOf(archetype),
    maxOrderQty: p.maxOrderQty,
  };
}

export type GuardResult = { ok: true; qty: number; budget: number } | { ok: false; why: string };

/** Clamp an intended purchase to the policy. Returns how many units at most, and the spend budget. */
export function guardBuy(s: WorldState, npc: Npc, good: Good, qty: number, price: number): GuardResult {
  if (npc.archetype === 'captain') return { ok: false, why: 'captain buys by its own rule' };
  const pol = policyFor(npc.archetype);
  if (!pol.allowedGoodsBuy.includes(good)) return { ok: false, why: `not allowed to buy ${good}` };
  const cash = s.accounts[npc.id]!.marks;
  const budget = Math.min(pol.maxSpendPerTrade, pol.maxSpendPerDay - npc.spentToday, cash - pol.cashFloor);
  if (budget <= 0 || price <= 0) return { ok: false, why: budget <= 0 ? 'spend limit or cash floor reached' : 'no price' };
  const n = Math.min(qty, pol.maxOrderQty, Math.floor(budget / price));
  return n > 0 ? { ok: true, qty: n, budget } : { ok: false, why: 'budget too small' };
}

export function guardSell(npc: Npc, good: Good, qty: number): number {
  if (npc.archetype === 'captain') return 0;
  const pol = policyFor(npc.archetype);
  return pol.allowedGoodsSell.includes(good) ? Math.min(qty, pol.maxOrderQty) : 0;
}
