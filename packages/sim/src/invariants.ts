// Invariants (ECONOMY §10, TESTING §2), checked after every tick in dev and tests.
import { ECONOMY, GOODS } from '@saltmarket/shared/config';
import type { WorldState } from './types.js';

export function checkInvariants(s: WorldState): string[] {
  const bad: string[] = [];
  // 1. Mark conservation: balances + buy-order escrow = genesis + minted − burned.
  let marks = 0;
  for (const a of Object.values(s.accounts)) {
    marks += a.marks;
    if (!Number.isInteger(a.marks) || a.marks < 0) bad.push(`account ${a.id} marks ${a.marks}`);
    for (const g of GOODS) if (!Number.isInteger(a.inv[g]) || a.inv[g] < 0) bad.push(`account ${a.id} ${g} ${a.inv[g]}`);
  }
  for (const o of Object.values(s.orders)) {
    if (o.qty <= 0 || !Number.isInteger(o.qty) || o.price <= 0 || !Number.isInteger(o.price)) bad.push(`order ${o.id} qty ${o.qty} price ${o.price}`);
    if (o.side === 'buy') marks += o.qty * o.price;
  }
  const expected = s.supply.genesis + s.supply.minted - s.supply.burned;
  if (marks !== expected) bad.push(`mark conservation: have ${marks}, expected ${expected}`);
  // 2. Good conservation per good: inventories + sell escrow = initial + created − destroyed.
  for (const g of GOODS) {
    let n = 0;
    for (const a of Object.values(s.accounts)) n += a.inv[g];
    for (const o of Object.values(s.orders)) if (o.side === 'sell' && o.good === g) n += o.qty;
    const exp = s.goods.initial[g] + s.goods.created[g] - s.goods.destroyed[g];
    if (n !== exp) bad.push(`good conservation ${g}: have ${n}, expected ${exp}`);
  }
  // 6. Hall fee bound. 7. Captain ceiling bounds.
  for (const h of Object.values(s.halls)) if (h.feeBps < 0 || h.feeBps > ECONOMY.fees.hallFeeMaxBps) bad.push(`hall ${h.id} fee ${h.feeBps}`);
  if (s.ship.ceiling < ECONOMY.captain.minCeiling || s.ship.ceiling > ECONOMY.captain.maxCeiling) bad.push(`captain ceiling ${s.ship.ceiling}`);
  for (const t of s.trades) if (t.buyer === 'captain' && t.price > ECONOMY.captain.maxCeiling) bad.push(`captain overpaid ${t.price}`);
  return bad;
}

export function assertInvariants(s: WorldState): void {
  const bad = checkInvariants(s);
  if (bad.length) throw new Error(`invariants failed at tick ${s.tick}:\n  ${bad.join('\n  ')}`);
}

/** FNV-1a over the canonical JSON of the world: same seed + same inputs ⇒ same hash (determinism). */
export function stateHash(s: WorldState): string {
  const str = JSON.stringify(s);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
