// Read-only market observations used by NPCs, rules, views, and metrics.
import { ECONOMY, GOODS, type Good } from '@saltmarket/shared/config';
import type { WorldState } from './types.js';

/** Median trade price of a good over the last `ticks` ticks; falls back to the anchor. */
export function medianPrice(s: WorldState, good: Good, ticks = 48): number {
  const from = s.tick - ticks;
  const ps: number[] = [];
  for (const t of s.trades) if (t.good === good && t.tick > from) for (let i = 0; i < Math.min(t.qty, 5); i++) ps.push(t.price);
  if (ps.length === 0) {
    const h = s.history[good];
    for (let i = h.length - 1; i >= 0; i--) { const m = h[i]!.median; if (m !== null) return m; }
    return ECONOMY.goods[good].anchor;
  }
  ps.sort((a, b) => a - b);
  return ps[Math.floor(ps.length / 2)]!;
}

export function lastPrice(s: WorldState, good: Good): number | null {
  for (let i = s.trades.length - 1; i >= 0; i--) if (s.trades[i]!.good === good) return s.trades[i]!.price;
  return null;
}

export function soldBy(s: WorldState, seller: string, good: Good, ticks = 24): number {
  const from = s.tick - ticks;
  let n = 0;
  for (const t of s.trades) if (t.seller === seller && t.good === good && t.tick > from) n += t.qty;
  return n;
}

export function volume(s: WorldState, good: Good, ticks = 24, venueId?: string): { qty: number; pips: number } {
  const from = s.tick - ticks;
  let qty = 0;
  let pips = 0;
  for (const t of s.trades) if (t.good === good && t.tick > from && (!venueId || t.venueId === venueId)) { qty += t.qty; pips += t.qty * t.price; }
  return { qty, pips };
}

/** Goods currently offered for sale across all venues. */
export function listedSupply(s: WorldState, good: Good): number {
  let n = 0;
  for (const o of Object.values(s.orders)) if (o.side === 'sell' && o.good === good) n += o.qty;
  return n;
}

export function marksSupply(s: WorldState): number {
  return s.supply.genesis + s.supply.minted - s.supply.burned;
}

/** Burned ÷ minted over the trailing `days` complete days, or null when nothing was minted. */
export function burnMintRatio(s: WorldState, days = 5): number | null {
  const today = Math.floor(s.tick / 24);
  let m = 0;
  let b = 0;
  for (const d of s.daily) if (d.day < today && d.day >= today - days) { m += d.minted; b += d.burned; }
  return m === 0 ? null : b / m;
}

export function goodsAt(s: WorldState): Good[] {
  return [...GOODS];
}
