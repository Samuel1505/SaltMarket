import { describe, expect, it } from 'vitest';
import { applyCommand, assertInvariants, checkInvariants, createWorld, addPlayer, forceBroke, scheduleEvent, stateHash, step, type Command, type SimEvent, type WorldState } from './index.js';

function run(seed: number, days: number, bots: number, onTick?: (s: WorldState, ev: SimEvent[]) => void): WorldState {
  const s = createWorld(seed);
  for (let b = 0; b < bots; b++) addPlayer(s, `bot-${b}`, `Bot ${b}`);
  for (let i = 0; i < days * 24; i++) {
    const ev = step(s);
    assertInvariants(s);
    for (let b = 0; b < bots; b++) botTurn(s, `bot-${b}`, b, ev);
    onTick?.(s, ev);
  }
  return s;
}

/** Naive scripted players: gather, sell raw goods, craft barrels, cure, sell cured fish, list, cancel. */
function botTurn(s: WorldState, id: string, b: number, ev: SimEvent[]): void {
  const cmds: Command[] = [
    { t: 'gather', node: (['pier', 'pans', 'grove'] as const)[(s.tick + b) % 3]! },
    { t: 'craft', recipe: 'craft_barrel' },
    { t: 'craft', recipe: 'cure_fish' },
    { t: 'sell', good: 'cured_fish', qty: 4, venueId: 'harbor' },
  ];
  if (b % 2 === 0) cmds.push({ t: 'sell', good: 'fish', qty: 2, venueId: 'harbor' });
  else cmds.push({ t: 'buy', good: 'salt', qty: 1, venueId: 'harbor' });
  if (s.tick % 37 === b) cmds.push({ t: 'list', good: 'timber', qty: 1, pricePips: 900, venueId: 'harbor' });
  if (s.tick % 50 === b) for (const o of Object.values(s.orders)) if (o.owner === id) cmds.push({ t: 'cancel', orderId: o.id });
  for (const c of cmds) {
    applyCommand(s, id, c, ev);
    const bad = checkInvariants(s);
    if (bad.length) throw new Error(`after ${c.t} at tick ${s.tick}: ${bad.join('; ')}`);
  }
}

describe('sim invariants', () => {
  it('holds conservation and non-negativity over 30 days, NPCs only, several seeds', () => {
    for (const seed of [1, 2, 3, 42]) run(seed, 30, 0);
  });

  it('holds with 5 bot players, a storm, and a closure + investment', () => {
    let s0: WorldState | undefined;
    const s = run(42, 30, 5, (s, ev) => {
      s0 = s;
      if (s.tick === 24 * 3) scheduleEvent(s, 'storm', s.tick + 1);
      if (s.tick === 24 * 5) forceBroke(s, 'cooper', ev);
      if (s.tick === 24 * 6) {
        const r = applyCommand(s, 'bot-0', { t: 'invest', npcId: 'cooper', amountPips: 15000 }, ev);
        expect(r.ok || r.code === 'INSUFFICIENT_FUNDS').toBe(true);
      }
    });
    expect(s0).toBeDefined();
    expect(s.trades.length).toBeGreaterThan(0);
  });

  it('is deterministic: same seed + same inputs → same state hash', () => {
    expect(stateHash(run(7, 10, 3))).toBe(stateHash(run(7, 10, 3)));
    expect(stateHash(run(7, 10, 3))).not.toBe(stateHash(run(8, 10, 3)));
  });

  it('the thin slice works: gather → sell, and buy inputs → cure → sell to the ship', () => {
    const s = createWorld(42);
    addPlayer(s, 'p', 'P');
    const ev: SimEvent[] = [];
    for (let i = 0; i < 3; i++) step(s);
    expect(applyCommand(s, 'p', { t: 'gather', node: 'pier' }, ev)).toMatchObject({ ok: true, result: { kind: 'gathered', qty: 2 } });
    expect(applyCommand(s, 'p', { t: 'gather', node: 'pier' }, ev).code).toBe('COOLDOWN');
    const sold = applyCommand(s, 'p', { t: 'sell', good: 'fish', qty: 2, venueId: 'harbor' }, ev);
    expect(sold).toMatchObject({ ok: true, result: { kind: 'trade', side: 'sell' } });
    // Get inputs for one cure: 6 fish, 3 salt, 1 barrel (gather + buy).
    for (let i = 0; s.accounts.p!.inv.fish < 6 || s.accounts.p!.inv.salt < 3 || s.accounts.p!.inv.timber < 3; i++) {
      step(s);
      const node = s.accounts.p!.inv.fish < 6 ? 'pier' : s.accounts.p!.inv.salt < 3 ? 'pans' : 'grove';
      applyCommand(s, 'p', { t: 'gather', node }, ev);
      if (i > 200) throw new Error('could not gather inputs');
    }
    expect(applyCommand(s, 'p', { t: 'craft', recipe: 'craft_barrel' }, ev).ok).toBe(true);
    for (let i = 0; i < 3; i++) step(s);
    expect(s.accounts.p!.inv.barrel).toBe(1);
    expect(applyCommand(s, 'p', { t: 'craft', recipe: 'cure_fish' }, ev).ok).toBe(true);
    for (let i = 0; i < 6; i++) step(s);
    expect(s.accounts.p!.inv.cured_fish).toBeGreaterThanOrEqual(4);
    while (!s.ship.docked) step(s);
    const r = applyCommand(s, 'p', { t: 'sell', good: 'cured_fish', qty: 4, venueId: 'harbor' }, ev);
    expect(r).toMatchObject({ ok: true });
    expect(r.message).toContain('Captain Maren');
    assertInvariants(s);
  });

  it('first ship docks at tick 20 in a fresh world', () => {
    const s = createWorld(1);
    for (let i = 0; i < 20; i++) step(s);
    expect(s.ship.docked).toBe(true);
  });
});
