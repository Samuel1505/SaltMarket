// Stability checks from docs/ECONOMY.md §11, over many seeds. Shared by `pnpm sim:tune` and the scenario tests.
import { ECONOMY, GOODS, type Good } from '@saltmarket/shared/config';
import { addPlayer, applyCommand, assertInvariants, createWorld, marksSupply, medianPrice, step, type Command, type SimEvent, type WorldState } from '@saltmarket/sim';

export type SeedReport = {
  seed: number;
  /** Longest run of days a good's daily median sat at a clamp edge (0.5× or 2.5× anchor), outside storms. */
  maxClampDwell: Record<Good, number>;
  /** Longest run of visits the Captain ceiling sat at a bound. */
  ceilingPinnedVisits: number;
  /** Rolling 5-day burn/mint ratios from day 5 on. */
  burnMint: number[];
  /** Total marks supply change, day 5 → last day. */
  supplyChange: number;
  closures: number;
  medians: Record<Good, number[]>;
  ceilings: number[];
  fills: string[];
};

/** Naive scripted players (ECONOMY §11 step 2): gather, sell raw, craft barrels, cure, sell to the ship. */
export function botTurn(s: WorldState, id: string, b: number, ev: SimEvent[]): void {
  const cmds: Command[] = [
    { t: 'gather', node: (['pier', 'pans', 'grove'] as const)[(s.tick + b) % 3]! },
    { t: 'craft', recipe: 'craft_barrel' },
    { t: 'craft', recipe: 'cure_fish' },
  ];
  if (s.ship.docked) cmds.push({ t: 'sell', good: 'cured_fish', qty: 4, venueId: 'harbor' });
  if (b === 3) cmds.push({ t: 'sell', good: 'fish', qty: 2, venueId: 'harbor' }); // a raw-goods seller
  for (const c of cmds) applyCommand(s, id, c, ev);
}

export function runSeed(seed: number, days: number, bots: number, opts: { stormDay?: number; check?: boolean } = {}): SeedReport {
  const s = createWorld(seed);
  for (let b = 0; b < bots; b++) addPlayer(s, `bot-${b}`, `Bot ${b}`);
  const medians = Object.fromEntries(GOODS.map((g) => [g, [] as number[]])) as Record<Good, number[]>;
  const stormDays = new Set<number>();
  const ceilings: number[] = [];
  const fills: string[] = [];
  let closures = 0;
  let supplyDay5 = 0;
  let lastVisit = -1;
  for (let d = 1; d <= days; d++) {
    if (d === opts.stormDay) { s.events.push({ id: `storm-${s.tick + 1}`, kind: 'storm', start: s.tick + 1, end: s.tick + 25 }); }
    for (let i = 0; i < 24; i++) {
      const ev = step(s);
      for (let b = 0; b < bots; b++) botTurn(s, `bot-${b}`, b, ev);
      if (opts.check !== false) assertInvariants(s);
      closures += ev.filter((e) => e.kind === 'MERCHANT_CLOSED').length;
      if (s.ship.visit !== lastVisit && !s.ship.docked && s.ship.visit > 0) { lastVisit = s.ship.visit; ceilings.push(s.ship.ceiling); }
      if (s.events.some((e) => e.kind === 'storm' && e.start <= s.tick && s.tick < e.end + 72)) stormDays.add(d);
    }
    for (const g of GOODS) medians[g].push(medianPrice(s, g, 24));
    if (d === 5) supplyDay5 = marksSupply(s);
    fills.push(`${s.ship.filled}/${s.ship.volume}`);
  }
  const maxClampDwell = Object.fromEntries(GOODS.map((g) => {
    const a = ECONOMY.goods[g].anchor;
    let run = 0; let best = 0;
    medians[g].forEach((m, i) => {
      const atEdge = m <= Math.round(a * ECONOMY.pricing.askClampAnchor[0] * 1.03) || m >= Math.round(a * ECONOMY.pricing.askClampAnchor[1] * 0.97);
      run = atEdge && !stormDays.has(i + 1) ? run + 1 : 0;
      best = Math.max(best, run);
    });
    return [g, best];
  })) as Record<Good, number>;
  let pin = 0; let pinBest = 0;
  for (const c of ceilings) { pin = c <= ECONOMY.captain.minCeiling || c >= ECONOMY.captain.maxCeiling ? pin + 1 : 0; pinBest = Math.max(pinBest, pin); }
  const burnMint: number[] = [];
  for (let d = 5; d + 5 <= days; d++) {
    const w = s.daily.filter((x) => x.day >= d && x.day < d + 5);
    const m = w.reduce((n, x) => n + x.minted, 0);
    const b = w.reduce((n, x) => n + x.burned, 0);
    if (m > 0) burnMint.push(b / m);
  }
  return { seed, maxClampDwell, ceilingPinnedVisits: pinBest, burnMint, supplyChange: supplyDay5 ? marksSupply(s) / supplyDay5 - 1 : 0, closures, medians, ceilings, fills };
}

export type Verdict = { pass: boolean; lines: string[] };
export function verdict(reports: SeedReport[]): Verdict {
  const lines: string[] = [];
  let pass = true;
  const worstClamp = Math.max(...reports.flatMap((r) => Object.values(r.maxClampDwell)));
  const bm = reports.flatMap((r) => r.burnMint);
  const inBand = bm.filter((x) => x >= 0.85 && x <= 1.1).length / Math.max(1, bm.length);
  const supply = reports.map((r) => r.supplyChange);
  const pinned = Math.max(...reports.map((r) => r.ceilingPinnedVisits));
  const chk = (ok: boolean, text: string) => { if (!ok) pass = false; lines.push(`${ok ? 'PASS' : 'FAIL'}  ${text}`); };
  chk(worstClamp <= 3, `no price at a clamp edge > 3 days outside storms (worst ${worstClamp} days)`);
  chk(inBand >= 0.8, `burn/mint 0.85–1.10 after day 5 in ≥80% of 5-day windows (${Math.round(inBand * 100)}%, range ${Math.min(...bm).toFixed(2)}–${Math.max(...bm).toFixed(2)})`);
  chk(supply.every((x) => Math.abs(x) <= 0.3), `marks supply within ±30% days 5→end (range ${(Math.min(...supply) * 100).toFixed(0)}% to ${(Math.max(...supply) * 100).toFixed(0)}%)`);
  chk(pinned <= 3, `Captain ceiling not pinned at a bound > 3 visits in a row (worst ${pinned})`);
  return { pass, lines };
}
