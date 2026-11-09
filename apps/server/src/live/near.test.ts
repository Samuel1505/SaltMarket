// The live server settling through NearLedger to a model of the goods contract (no network).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GOODS } from '@saltmarket/shared/config';
import { ModelContract, NearLedger, type TokenId } from '@saltmarket/chain';
import { SimBackend } from './simBackend.js';

const flush = () => new Promise((r) => setTimeout(r, 40));
const cfg = { network: 'testnet', rpcUrl: 'unused', contractId: 'goods.samuelowen.testnet', authorityId: 'samuelowen.testnet', privateKey: 'unused' };

async function mismatches(b: SimBackend, l: NearLedger): Promise<string[]> {
  const w = b.world();
  const want = new Map<string, bigint>();
  const add = (k: string, v: number) => want.set(k, (want.get(k) ?? 0n) + BigInt(v));
  for (const a of Object.values(w.accounts)) { add(`${a.id}|marks`, a.marks); for (const g of GOODS) add(`${a.id}|${g}`, a.inv[g]); }
  for (const o of Object.values(w.orders)) add(o.side === 'buy' ? `${o.owner}|marks` : `${o.owner}|${o.good}`, o.side === 'buy' ? o.qty * o.price : o.qty);
  for (const h of Object.values(w.halls)) add(`${h.ownerId}|hall_license`, 1);
  const bad: string[] = [];
  for (const [k, v] of want) { const [a, t] = k.split('|') as [string, TokenId]; const got = await l.balanceOf(a, t); if (got !== v) bad.push(`${k}: chain ${got} sim ${v}`); }
  return bad;
}
function play(b: SimBackend, pid: string, n: number) {
  for (let i = 0; i < n; i++) { b.step(); b.command(pid, { t: 'gather', cmdId: `g${i}`, node: 'pier' }); if (i % 5 === 0) b.command(pid, { t: 'sell', cmdId: `s${i}`, good: 'fish', qty: 1, venueId: 'harbor' }); }
}

describe('live server → NearLedger → goods contract (model)', () => {
  it('every balance on chain matches the sim after 2 game days, including across a restart', async () => {
    const chain = new ModelContract();
    const path = join(mkdtempSync(join(tmpdir(), 'saltmarket-near-')), 'world.json');
    const b1 = new SimBackend({ seed: 11, ledger: new NearLedger(cfg, chain), snapshotPath: path, strictInvariants: true, settleEveryTicks: 6 });
    await b1.ready;
    const s = b1.login('guest', 'P');
    if (!s.ok) throw new Error('login');
    play(b1, s.data.playerId, 30);
    await flush();
    expect(await mismatches(b1, new NearLedger(cfg, chain))).toEqual([]);
    b1.saveSnapshot();
    const l2 = new NearLedger(cfg, chain);
    const b2 = new SimBackend({ seed: 11, ledger: l2, snapshotPath: path, strictInvariants: true, settleEveryTicks: 6 });
    await b2.ready;
    expect(b2.ledgerProblem()).toBeNull();
    play(b2, s.data.playerId, 18);
    await flush();
    expect(await mismatches(b2, l2)).toEqual([]);
    expect(chain.calls.every((c) => c.mints.length + c.transfers.length + c.burns.length > 0)).toBe(true); // no empty txs (C6)
  });

  it('refuses to settle a fresh world onto a contract that already has settlements', async () => {
    const chain = new ModelContract();
    await chain.settle({ batch_id: '0-6', mints: [], transfers: [], burns: [] }); // a stray test batch
    const b = new SimBackend({ seed: 12, ledger: new NearLedger(cfg, chain), strictInvariants: true });
    await b.ready;
    expect(b.ledgerProblem()).toContain('never settled');
    for (let i = 0; i < 12; i++) b.step();
    await flush();
    expect(chain.calls.length).toBe(1); // nothing sent
    expect(b.health().ledger.health).toBe('degraded');
  });

  it('a fatal contract error stops settlement and is shown; it is not retried forever', async () => {
    const chain = new ModelContract();
    const l = new NearLedger(cfg, chain);
    const b = new SimBackend({ seed: 13, ledger: l, strictInvariants: true });
    await b.ready;
    for (let i = 0; i < 6; i++) b.step();
    await flush();
    chain.bal.clear(); // the chain "loses" balances → the next batch's debits are impossible
    const s = b.login('guest', 'Q');
    if (!s.ok) throw new Error('login');
    for (let i = 0; i < 12; i++) { b.step(); b.command(s.data.playerId, { t: 'gather', cmdId: `g${i}`, node: 'pier' }); }
    await flush();
    expect(b.ledgerProblem()).toMatch(/stuck at .*ERR_INSUFFICIENT_BALANCE/);
    const sent = chain.calls.length;
    await flush();
    expect(chain.calls.length).toBe(sent);
    expect(b.judgeLedger(5).settlements.some((x) => x.error?.includes('needs a human'))).toBe(true);
  });
});
