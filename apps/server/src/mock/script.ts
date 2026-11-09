// Pure, tick-driven script for the mock world. Prices and the ship schedule are functions of the tick
// and the list of shock intervals, so price history, live quotes, and time-lapse frames always agree.
// Mock only: the real economy lives in packages/sim.
import { ECONOMY, GOODS, type Good } from '@saltmarket/shared/config';

export type ShockKind = 'storm' | 'fair_winds' | 'salt_glut' | 'flood';
export type Interval = { id: string; kind: ShockKind; start: number; end: number; good?: Good };

/** Mock world starts on day 5 so sparklines have history; the first ship docks 20 ticks (~50 s) in. */
export const MOCK_START_TICK = 120;
/** Scripted storm, ~3.5 minutes into a fresh mock world, repeating every 15 minutes. */
export const SCRIPTED_STORM_OFFSET = 84;
export const SCRIPTED_STORM_EVERY = 360;

const TAU = Math.PI * 2;

/** Multiplier from one shock on one good at tick t (1 = no effect). */
function shockFactor(iv: Interval, good: Good, t: number): number {
  if (t < iv.start) return 1;
  const during = t < iv.end;
  const ramp = (ticks: number) => Math.min(1, (t - iv.start + 1) / ticks);
  const decay = (tau: number) => Math.exp(-(t - iv.end) / tau);
  const shape = (amp: number, rampTicks: number, tau: number) => 1 + amp * (during ? ramp(rampTicks) : decay(tau));
  switch (iv.kind) {
    case 'storm':
      if (good === 'fish') return shape(0.55, 6, 30);
      if (good === 'cured_fish') return t < iv.start + 12 ? 1 : shape(0.2, 12, 40);
      return 1;
    case 'salt_glut':
      return good === 'salt' ? shape(-0.35, 4, 20) : 1;
    case 'flood':
      return good === (iv.good ?? 'timber') ? shape(-0.4, 3, 24) : 1;
    case 'fair_winds':
      return good === 'cured_fish' ? shape(0.15, 6, 24) : 1;
  }
}

/** Reference price of a good at tick t, in pips. */
export function priceAt(good: Good, t: number, intervals: readonly Interval[]): number {
  const i = GOODS.indexOf(good);
  const anchor = ECONOMY.goods[good].anchor;
  const wave = 1 + 0.05 * Math.sin((TAU * t) / (30 + i * 9)) + 0.025 * Math.sin((TAU * t) / (7 + i * 2) + i);
  let f = wave;
  for (const iv of intervals) f *= shockFactor(iv, good, t);
  return Math.max(1, Math.round(anchor * f));
}

/** Synthetic traded volume for a good over one tick. */
export function volumeAt(good: Good, t: number): number {
  const i = GOODS.indexOf(good);
  return Math.max(0, Math.round(3 + 2 * Math.sin((TAU * t) / (13 + i * 3) + i)));
}

export type ShipPhase = { docked: boolean; visit: number; arrivalTick: number; departureTick: number; ticksToArrival: number; ticksToDeparture: number };

/** Ship schedule relative to the world's start tick. */
export function shipPhase(t: number, startTick: number): ShipPhase {
  const { firstArrivalTick, everyTicks, dockTicks } = ECONOMY.captain;
  const rel = t - startTick - firstArrivalTick;
  if (rel < 0) {
    const arrival = startTick + firstArrivalTick;
    return { docked: false, visit: -1, arrivalTick: arrival, departureTick: arrival + dockTicks, ticksToArrival: arrival - t, ticksToDeparture: 0 };
  }
  const visit = Math.floor(rel / everyTicks);
  const arrival = startTick + firstArrivalTick + visit * everyTicks;
  const departure = arrival + dockTicks;
  if (t < departure) return { docked: true, visit, arrivalTick: arrival, departureTick: departure, ticksToArrival: 0, ticksToDeparture: departure - t };
  const next = arrival + everyTicks;
  return { docked: false, visit, arrivalTick: next, departureTick: next + dockTicks, ticksToArrival: next - t, ticksToDeparture: 0 };
}

/** Scripted storms between two ticks (inclusive start). */
export function scriptedStorms(startTick: number, upTo: number): Interval[] {
  const out: Interval[] = [];
  for (let s = startTick + SCRIPTED_STORM_OFFSET; s <= upTo; s += SCRIPTED_STORM_EVERY) {
    out.push({ id: `storm-${s}`, kind: 'storm', start: s, end: s + 24 });
  }
  return out;
}

/** Small seeded PRNG (mulberry32) so the mock is repeatable. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export const pct = (bps: number): number => Math.round(Math.abs(bps) / 100);
