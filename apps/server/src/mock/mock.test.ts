import { describe, expect, it } from 'vitest';
import { WorldDelta, WorldSnapshot } from '@saltmarket/shared/protocol';
import { conformanceSuite } from '../conformance.js';
import { MockBackend } from './mockBackend.js';

describe('mock backend stays protocol-valid', () => {
  it('runs 400 ticks with valid snapshots, deltas and the scripted story', () => {
    const b = new MockBackend({ timelapseFrameMs: 1 });
    const s = b.login('guest', 'Tester');
    if (!s.ok) throw new Error('login');
    const pid = s.data.playerId;
    const kinds = new Set<string>();
    let docked = false;
    expect(b.snapshot(pid).npcs.some((n) => n.status === 'closed')).toBe(true);
    for (let i = 0; i < 400; i++) {
      b.step();
      WorldDelta.parse(b.deltaFor(pid));
      for (const f of b.feedFor(pid)) kinds.add(f.kind);
      if (b.snapshot(null).ship.status === 'docked') docked = true;
      if (i % 50 === 0) WorldSnapshot.parse(b.snapshot(pid));
    }
    expect(docked).toBe(true);
    for (const k of ['event_start', 'ship_docked', 'ship_departed', 'MERCHANT_RESCUED', 'npc_decision']) expect(kinds).toContain(k);
  });

  it('gives plausible acks: gather ok, then cooldown; sell; bad invest', () => {
    const b = new MockBackend();
    const s = b.login('guest');
    if (!s.ok) throw new Error('login');
    const pid = s.data.playerId;
    expect(b.command(pid, { t: 'gather', cmdId: '1', node: 'pier' }).ok).toBe(true);
    expect(b.command(pid, { t: 'gather', cmdId: '2', node: 'pier' }).code).toBe('COOLDOWN');
    const sold = b.command(pid, { t: 'sell', cmdId: '3', good: 'fish', qty: 2, venueId: 'harbor' });
    expect(sold.ok).toBe(true);
    expect(b.command(pid, { t: 'sell', cmdId: '4', good: 'cured_fish', qty: 1, venueId: 'harbor' }).code).toBe('INSUFFICIENT_GOODS');
    expect(b.command(pid, { t: 'invest', cmdId: '5', npcId: 'fisher-1', amountPips: 20000 }).code).toBe('MERCHANT_OPEN');
    expect(b.command(pid, { t: 'invest', cmdId: '6', npcId: 'salt-2', amountPips: 20000 }).ok).toBe(true);
  });
});

conformanceSuite('mock', (o) => new MockBackend({ timelapseFrameMs: o.timelapseFrameMs }));
