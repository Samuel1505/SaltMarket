// Venues and trading: resting orders with escrow, trade execution with tax and hall fees,
// and taking the best resting orders (ECONOMY §6). Price decisions are NOT made here.
import { ECONOMY, type Good } from '@saltmarket/shared/config';
import { acct, burn, destroyGood, mint, moveGood, nextId, transfer } from './ledger.js';
import { CAPTAIN, HARBOR, TOWN_FUND, type Order, type WorldState } from './types.js';

const E = ECONOMY;

export const venueExists = (s: WorldState, id: string): boolean => id === HARBOR || id in s.halls;
export const feeBpsOf = (s: WorldState, venueId: string): number => s.halls[venueId]?.feeBps ?? 0;

export type Fill = { qty: number; price: number; counterparty: string; tax: number; fee: number };

/** Move value for one trade. buyer pays qty × price; the seller gets that minus harbor tax and hall fee. */
export function executeTrade(
  s: WorldState,
  t: { buyer: string; seller: string; good: Good; qty: number; price: number; venueId: string; buyEscrow?: boolean; sellEscrow?: boolean },
): Fill {
  const gross = t.qty * t.price;
  const tax = Math.floor((gross * E.fees.harborTaxBps) / 10000);
  const fee = Math.floor((gross * feeBpsOf(s, t.venueId)) / 10000);
  // The Captain pays with newly minted marks (the economy's demand faucet, ECONOMY §5/§7).
  if (t.buyer === CAPTAIN) mint(s, CAPTAIN, gross);
  if (!t.buyEscrow) transfer(s, t.buyer, t.seller, gross);
  else acct(s, t.seller).marks += gross; // escrowed marks were already taken from the buyer
  transfer(s, t.seller, TOWN_FUND, tax);
  const hall = s.halls[t.venueId];
  if (hall && fee > 0) {
    transfer(s, t.seller, hall.ownerId, fee);
    hall.feeIncomeTotal += fee;
  }
  if (!t.sellEscrow) moveGood(s, t.seller, t.buyer, t.good, t.qty);
  else acct(s, t.buyer).inv[t.good] += t.qty; // escrowed goods were already taken from the seller
  // Cured fish bought by the ship leaves town.
  if (t.buyer === CAPTAIN) destroyGood(s, CAPTAIN, t.good, t.qty);
  s.trades.push({ tick: s.tick, venueId: t.venueId, good: t.good, qty: t.qty, price: t.price, buyer: t.buyer, seller: t.seller });
  return { qty: t.qty, price: t.price, counterparty: t.buyer === t.seller ? '' : t.buyer, tax, fee };
}

/** Post a resting order, escrowing goods (sell) or marks (buy). Hall orders match immediately if they cross. */
export function placeOrder(s: WorldState, o: Omit<Order, 'id' | 'tick'> & { id?: string }): Order | null {
  const a = acct(s, o.owner);
  if (o.qty <= 0 || o.price <= 0) return null;
  if (o.side === 'sell') {
    if (a.inv[o.good] < o.qty) return null;
    a.inv[o.good] -= o.qty;
  } else {
    if (a.marks < o.qty * o.price) return null;
    a.marks -= o.qty * o.price;
  }
  const order: Order = { ...o, id: o.id ?? nextId(s, 'o'), tick: s.tick };
  s.orders[order.id] = order;
  if (order.venueId !== HARBOR) matchCrossing(s, order);
  return s.orders[order.id] ?? null;
}

/** Return escrow and remove the order. */
export function cancelOrder(s: WorldState, id: string): boolean {
  const o = s.orders[id];
  if (!o) return false;
  const a = acct(s, o.owner);
  if (o.side === 'sell') a.inv[o.good] += o.qty;
  else a.marks += o.qty * o.price;
  delete s.orders[id];
  return true;
}

export function cancelAllOf(s: WorldState, owner: string): void {
  for (const o of Object.values(s.orders)) if (o.owner === owner) cancelOrder(s, o.id);
}

/** Resting orders on one side for a good, best first (price, then time). */
export function book(s: WorldState, venueId: string | 'any', good: Good, side: 'buy' | 'sell'): Order[] {
  return Object.values(s.orders)
    .filter((o) => o.good === good && o.side === side && (venueId === 'any' || o.venueId === venueId))
    .sort((a, b) => (side === 'sell' ? a.price - b.price : b.price - a.price) || a.tick - b.tick || a.id.localeCompare(b.id));
}

/** Same owner, or an owner's own accounts, can't trade with each other (ECONOMY §6.4). */
const sameOwner = (a: string, b: string) => a === b;

/** Fill a newly posted hall order against crossing resting orders at the resting price. */
function matchCrossing(s: WorldState, taker: Order): void {
  const opp = book(s, taker.venueId, taker.good, taker.side === 'buy' ? 'sell' : 'buy');
  for (const r of opp) {
    if (taker.qty === 0) break;
    if (sameOwner(r.owner, taker.owner)) continue;
    if (taker.side === 'buy' ? r.price > taker.price : r.price < taker.price) break;
    const qty = Math.min(r.qty, taker.qty);
    if (taker.side === 'buy') {
      // Taker escrowed at its own (higher) limit; refund the difference.
      acct(s, taker.owner).marks += qty * (taker.price - r.price);
      executeTrade(s, { buyer: taker.owner, seller: r.owner, good: r.good, qty, price: r.price, venueId: r.venueId, buyEscrow: true, sellEscrow: true });
    } else {
      executeTrade(s, { buyer: r.owner, seller: taker.owner, good: r.good, qty, price: r.price, venueId: r.venueId, buyEscrow: true, sellEscrow: true });
    }
    r.qty -= qty;
    taker.qty -= qty;
    if (r.qty === 0) delete s.orders[r.id];
  }
  if (taker.qty === 0) delete s.orders[taker.id];
}

export type TakeResult = { qty: number; gross: number; tax: number; fee: number; counterparties: string[] };

/**
 * Buy now: take the cheapest resting sell orders at a venue up to maxPrice.
 * Harbor friction: an actor completes at most one purchase per tick there (ECONOMY §6.1).
 */
export function takeAsks(s: WorldState, buyer: string, venueId: string | 'any', good: Good, qty: number, maxPrice: number, budget: number): TakeResult {
  const res: TakeResult = { qty: 0, gross: 0, tax: 0, fee: 0, counterparties: [] };
  let spend = budget;
  const harborUsed = new Set<string>();
  for (const o of book(s, venueId, good, 'sell')) {
    if (res.qty >= qty || o.price > maxPrice) break;
    if (sameOwner(o.owner, buyer)) continue;
    if (o.venueId === HARBOR) {
      if (harborUsed.has(buyer)) continue;
      harborUsed.add(buyer);
    }
    const n = Math.min(o.qty, qty - res.qty, Math.floor(spend / o.price));
    if (n <= 0) break;
    const f = executeTrade(s, { buyer, seller: o.owner, good, qty: n, price: o.price, venueId: o.venueId, sellEscrow: true });
    spend -= n * o.price;
    o.qty -= n;
    if (o.qty === 0) delete s.orders[o.id];
    res.qty += n; res.gross += n * o.price; res.tax += f.tax; res.fee += f.fee;
    if (!res.counterparties.includes(o.owner)) res.counterparties.push(o.owner);
  }
  return res;
}

/** The Captain's standing demand while docked, offered to sellers at the Harbor Market at his ceiling. */
export function captainBid(s: WorldState): { price: number; qty: number } | null {
  const sh = s.ship;
  if (!sh.docked) return null;
  const qty = sh.volume - sh.filled;
  return qty > 0 ? { price: sh.ceiling, qty } : null;
}

/** Sell now: hit the best buy orders (and the Captain's demand, at the harbor) down to minPrice. */
export function hitBids(s: WorldState, seller: string, venueId: string, good: Good, qty: number, minPrice: number): TakeResult {
  const res: TakeResult = { qty: 0, gross: 0, tax: 0, fee: 0, counterparties: [] };
  type Cand = { kind: 'order'; o: Order } | { kind: 'captain'; price: number; qty: number };
  const cands: Cand[] = book(s, venueId, good, 'buy').map((o) => ({ kind: 'order' as const, o }));
  const cap = good === 'cured_fish' && venueId === HARBOR ? captainBid(s) : null;
  if (cap) cands.push({ kind: 'captain', ...cap });
  cands.sort((a, b) => (b.kind === 'order' ? b.o.price : b.price) - (a.kind === 'order' ? a.o.price : a.price));
  for (const c of cands) {
    if (res.qty >= qty) break;
    const price = c.kind === 'order' ? c.o.price : c.price;
    if (price < minPrice) break;
    const owner = c.kind === 'order' ? c.o.owner : CAPTAIN;
    if (sameOwner(owner, seller)) continue;
    const avail = c.kind === 'order' ? c.o.qty : c.qty;
    const n = Math.min(avail, qty - res.qty);
    if (n <= 0) continue;
    const f = executeTrade(s, { buyer: owner, seller, good, qty: n, price, venueId, buyEscrow: c.kind === 'order' });
    if (c.kind === 'order') {
      c.o.qty -= n;
      if (c.o.qty === 0) delete s.orders[c.o.id];
    } else {
      s.ship.filled += n;
      if (s.ship.filled >= s.ship.volume && s.ship.filledAtTick === null) s.ship.filledAtTick = s.tick;
    }
    res.qty += n; res.gross += n * price; res.tax += f.tax; res.fee += f.fee;
    if (!res.counterparties.includes(owner)) res.counterparties.push(owner);
  }
  return res;
}

/** Hall license is a sink (ECONOMY §5). */
export function buyHallLicense(s: WorldState, owner: string): number {
  return burn(s, owner, E.sinks.hallLicense);
}
