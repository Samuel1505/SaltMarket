import { describe, expect, it } from 'vitest';
import { MemoryLedger } from './index.js';

describe('MemoryLedger', () => {
  it('applies batches once (idempotent by batchId) and rejects negatives atomically', async () => {
    const l = new MemoryLedger();
    const b = { batchId: '0-6', tickFrom: 0, tickTo: 6, deltas: [{ account: 'a', token: 'marks' as const, delta: 500n }] };
    expect((await l.settle(b)).applied).toBe(true);
    expect((await l.settle(b)).applied).toBe(false);
    expect(await l.balanceOf('a', 'marks')).toBe(500n);
    await expect(l.settle({ batchId: '6-12', tickFrom: 6, tickTo: 12, deltas: [{ account: 'a', token: 'marks', delta: 100n }, { account: 'b', token: 'fish', delta: -1n }] })).rejects.toThrow();
    expect(await l.balanceOf('a', 'marks')).toBe(500n);
  });
});
