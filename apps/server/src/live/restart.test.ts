// REQUESTS C2: a restart must neither re-send balances already settled nor lose unconfirmed batches.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GOODS } from '@saltmarket/shared/config';
import { MemoryLedger, type LedgerAdapter, type Receipt, type SettlementBatch, type TokenId } from '@saltmarket/chain';
import { SimBackend } from './simBackend.js';

const flush = () => new Promise((r) => setTimeout(r, 30));
const snapPath = () => join(mkdtempSync(join(tmpdir(), 'saltmarket-')), 'world.json');

/** Records every batch it receives and forwards to an inner ledger (or hangs, to simulate a lost confirmation). */
class SpyLedger implements LedgerAdapter {
  batches: SettlementBatch[] = [];
  hang = false;
  constructor(readonly inner: MemoryLedger) {}
  status() { return this.inner.status(); }
  explorerUrl() { return null; }
  balanceOf(a: string, t: TokenId) { return this.inner.balanceOf(a, t); }
  settle(b: SettlementBatch): Promise<Receipt> {
    this.batches.push(b);
    return this.hang ? new Promise<Receipt>(() => {}) : this.inner.settle(b);
  }
  restore(c: Map<string, bigint>) { this.inner.restore(c); }
}

/** Every owned balance in the sim (incl. order escrow and hall licenses) equals the ledger. */
async function mismatches(b: SimBackend, ledger: LedgerAdapter): Promise<string[]> {
  const w = b.world();
  const want = new Map<string, bigint>();
  const add = (k: string, v: number) => want.set(k, (want.get(k) ?? 0n) + BigInt(v));
  for (const a of Object.values(w.accounts)) { add(`${a.id}|marks`, a.marks); for (const g of GOODS) add(`${a.id}|${g}`, a.inv[g]); }
  for (const o of Object.values(w.orders)) add(o.side === 'buy' ? `${o.owner}|marks` : `${o.owner}|${o.good}`, o.side === 'buy' ? o.qty * o.price : o.qty);
  for (const h of Object.values(w.halls)) add(`${h.ownerId}|hall_license`, 1);
  const bad: string[] = [];
  for (const [k, v] of want) { const [acc, tok] = k.split('|') as [string, TokenId]; const got = await ledger.balanceOf(acc, tok); if (got !== v) bad.push(`${k}: ledger ${got}, sim ${v}`); }
  return bad;
}

function play(b: SimBackend, pid: string, ticks: number) {
  for (let i = 0; i < ticks; i++) {
    b.step();
    b.command(pid, { t: 'gather', cmdId: `g${i}`, node: 'pier' });
    if (i % 5 === 0) b.command(pid, { t: 'sell', cmdId: `s${i}`, good: 'fish', qty: 1, venueId: 'harbor' });
  }
}

describe('settlement survives a restart (REQUESTS C2)', () => {
  it('the chain kept its state: the first batch after restart carries only new changes, no re-mint', async () => {
    const path = snapPath();
    const chain = new SpyLedger(new MemoryLedger());
    const b1 = new SimBackend({ seed: 5, ledger: chain, snapshotPath: path, strictInvariants: true });
    const s = b1.login('guest', 'P');
    if (!s.ok) throw new Error('login');
    play(b1, s.data.playerId, 30); // batches 0-6 … 24-30
    await flush();
    b1.saveSnapshot();
    const genesisMarks = chain.batches[0]!.deltas.filter((d) => d.token === 'marks' && d.delta > 0n).reduce((n, d) => n + d.delta, 0n);
    const sent = chain.batches.length;

    const b2 = new SimBackend({ seed: 5, ledger: chain, snapshotPath: path, strictInvariants: true }); // same chain
    play(b2, s.data.playerId, 30);
    await flush();
    const after = chain.batches.slice(sent);
    expect(after[0]!.tickFrom).toBe(30); // contiguous with the last batch before the restart
    const firstMinted = after[0]!.deltas.filter((d) => d.token === 'marks' && d.delta > 0n).reduce((n, d) => n + d.delta, 0n);
    expect(firstMinted < genesisMarks / 4n).toBe(true); // a re-mint would be ≥ the whole money supply
    expect(await mismatches(b2, chain)).toEqual([]);
    expect(b2.judgeLedger(5).settlements[0]?.status).toBe('settled');
  });

  it('a process restart with a fresh MemoryLedger: it is restored to the confirmed state and stays in sync', async () => {
    const path = snapPath();
    const b1 = new SimBackend({ seed: 6, ledger: new MemoryLedger(), snapshotPath: path, strictInvariants: true });
    const s = b1.login('guest', 'P');
    if (!s.ok) throw new Error('login');
    play(b1, s.data.playerId, 30);
    await flush();
    b1.saveSnapshot();
    const fresh = new MemoryLedger();
    const b2 = new SimBackend({ seed: 6, ledger: fresh, snapshotPath: path, strictInvariants: true });
    play(b2, s.data.playerId, 30);
    await flush();
    expect(await mismatches(b2, fresh)).toEqual([]);
    expect(b2.judgeLedger(10).settlements.every((x) => x.status === 'settled')).toBe(true);
  });

  it('unconfirmed batches are persisted and re-sent in order after a restart', async () => {
    const path = snapPath();
    const chain = new SpyLedger(new MemoryLedger());
    const b1 = new SimBackend({ seed: 7, ledger: chain, snapshotPath: path, strictInvariants: true });
    const s = b1.login('guest', 'P');
    if (!s.ok) throw new Error('login');
    play(b1, s.data.playerId, 12); // 0-6, 6-12 confirmed
    await flush();
    chain.hang = true; // confirmations for the next batches never arrive (crash before they land)
    play(b1, s.data.playerId, 12); // 12-18 in flight, 18-24 queued behind it
    await flush();
    expect(b1.health().ledger.queueDepth).toBe(2);
    b1.saveSnapshot();
    chain.hang = false;
    const b2 = new SimBackend({ seed: 7, ledger: chain, snapshotPath: path, strictInvariants: true });
    await flush(); // pending batches are re-sent on boot
    play(b2, s.data.playerId, 12);
    await flush();
    const ids = chain.batches.map((b) => b.batchId);
    expect(ids.slice(-4)).toEqual(['12-18', '18-24', '24-30', '30-36']);
    expect(await mismatches(b2, chain)).toEqual([]);
    expect(b2.health().ledger.queueDepth).toBe(0);
  });

  it('stops (does not build on a wrong base) if the ledger already had a batch it was never sent', async () => {
    const ledger = new MemoryLedger();
    await ledger.settle({ batchId: '0-6', tickFrom: 0, tickTo: 6, deltas: [] }); // a stray test settlement
    const b = new SimBackend({ seed: 8, ledger, strictInvariants: true });
    for (let i = 0; i < 12; i++) b.step();
    await flush();
    const j = b.judgeLedger(5);
    expect(j.health).toBe('degraded');
    expect(j.settlements.find((x) => x.batchId === '0-6')?.error).toContain('ALREADY_APPLIED');
    expect(j.queueDepth).toBe(2); // 0-6 and 6-12 held back, nothing built on top
  });
});
