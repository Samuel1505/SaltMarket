import { describe, expect, it } from 'vitest';
import { MemoryLedger } from '@saltmarket/chain';
import { WorldDelta, WorldSnapshot } from '@saltmarket/shared/protocol';
import { conformanceSuite } from '../conformance.js';
import { SimBackend } from './simBackend.js';

// The real server must pass exactly the same protocol tests as the mock.
conformanceSuite('live sim', (o) => new SimBackend({ seed: 42, ledger: new MemoryLedger(), strictInvariants: true, timelapseFrameMs: o.timelapseFrameMs }));

describe('live sim backend', () => {
  it('stays protocol-valid and settles to the ledger with zero reconciliation mismatches', async () => {
    const ledger = new MemoryLedger();
    const b = new SimBackend({ seed: 3, ledger, strictInvariants: true });
    const s = b.login('guest', 'P');
    if (!s.ok) throw new Error('login');
    for (let i = 0; i < 48; i++) {
      b.step();
      b.command(s.data.playerId, { t: 'gather', cmdId: `g${i}`, node: 'pier' });
      if (i % 6 === 0) b.command(s.data.playerId, { t: 'sell', cmdId: `s${i}`, good: 'fish', qty: 1, venueId: 'harbor' });
      WorldDelta.parse(b.deltaFor(s.data.playerId));
    }
    WorldSnapshot.parse(b.snapshot(s.data.playerId));
    const h = b.history('fish', 2, 'harbor');
    expect(h.ok && h.data.venueId).toBe('harbor');
    expect(h.ok && h.data.points.some((p) => p.volume > 0)).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    const j = b.judgeLedger(10);
    expect(j.settlements[0]?.status).toBe('settled');
    expect(j.reconciliation.tick).toBe(48);
    expect(j.reconciliation.mismatches).toBe(0);
    const w = b.world();
    expect(await ledger.balanceOf(s.data.playerId, 'marks')).toBe(BigInt(w.accounts[s.data.playerId]!.marks + Object.values(w.orders).filter((o) => o.owner === s.data.playerId && o.side === 'buy').reduce((n, o) => n + o.qty * o.price, 0)));
  });
});
