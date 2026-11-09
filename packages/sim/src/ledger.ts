// Every creation, destruction, and movement of marks or goods goes through these helpers, so the
// conservation invariants (ECONOMY §10) hold by construction and are checked after every tick.
import type { Good } from '@saltmarket/shared/config';
import type { Account, Inv, WorldState } from './types.js';

export const emptyInv = (): Inv => ({ fish: 0, salt: 0, timber: 0, barrel: 0, cured_fish: 0 });

function today(s: WorldState) {
  const day = Math.floor(s.tick / 24);
  let d = s.daily[s.daily.length - 1];
  if (!d || d.day !== day) {
    d = { day, minted: 0, burned: 0 };
    s.daily.push(d);
    if (s.daily.length > 60) s.daily.shift();
  }
  return d;
}

export function acct(s: WorldState, id: string): Account {
  const a = s.accounts[id];
  if (!a) throw new Error(`unknown account ${id}`);
  return a;
}

/** Faucet: create marks (Captain payments, new-player grants). */
export function mint(s: WorldState, to: string, pips: number): void {
  if (pips <= 0) return;
  acct(s, to).marks += pips;
  s.supply.minted += pips;
  today(s).minted += pips;
}

/** Sink: destroy marks (rent, upkeep, licenses, demurrage, Town Fund cap). Returns what was burned. */
export function burn(s: WorldState, from: string, pips: number): number {
  const a = acct(s, from);
  const amt = Math.max(0, Math.min(a.marks, pips));
  a.marks -= amt;
  s.supply.burned += amt;
  today(s).burned += amt;
  return amt;
}

/** Recycle: move marks between accounts. Caller checks funds. */
export function transfer(s: WorldState, from: string, to: string, pips: number): void {
  if (pips <= 0) return;
  const a = acct(s, from);
  if (a.marks < pips) throw new Error(`transfer overdraws ${from}`);
  a.marks -= pips;
  acct(s, to).marks += pips;
}

export function createGood(s: WorldState, to: string, good: Good, qty: number): void {
  if (qty <= 0) return;
  acct(s, to).inv[good] += qty;
  s.goods.created[good] += qty;
}

export function destroyGood(s: WorldState, from: string, good: Good, qty: number): number {
  const a = acct(s, from);
  const n = Math.max(0, Math.min(a.inv[good], qty));
  a.inv[good] -= n;
  s.goods.destroyed[good] += n;
  return n;
}

export function moveGood(s: WorldState, from: string, to: string, good: Good, qty: number): void {
  if (qty <= 0) return;
  const a = acct(s, from);
  if (a.inv[good] < qty) throw new Error(`moveGood overdraws ${from} ${good}`);
  a.inv[good] -= qty;
  acct(s, to).inv[good] += qty;
}

export const nextId = (s: WorldState, prefix: string): string => `${prefix}-${++s.seq}`;
