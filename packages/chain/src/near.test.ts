import { describe, expect, it } from 'vitest';
import { classifyError, deltasToOps, LedgerError, mapAccountId, NearLedger, splitParts, type SettlementBatch, type TokenId } from './index.js';
import { ModelContract } from './model.js';

const AUTH = 'samuelowen.testnet';

function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }
const TOKENS: TokenId[] = ['marks', 'fish', 'salt'];
const ACCTS = ['townfund', 'captain', 'fisher-1', 'smokehouse', 'p-1a2b3c4d', 'demo-ada'];

describe('settlement ops (REQUESTS C1, C5)', () => {
  it('net deltas → mints/transfers/burns reproduce the target balances exactly, never going negative (200 random windows)', async () => {
    const r = rng(9);
    const model = new ModelContract();
    let prev = new Map<string, bigint>();
    for (let w = 0; w < 200; w++) {
      const next = new Map<string, bigint>();
      for (const a of ACCTS) for (const t of TOKENS) if (r() < 0.7) next.set(`${a}|${t}`, BigInt(Math.floor(r() * (t === 'marks' ? 100000 : 40))));
      const deltas: SettlementBatch['deltas'] = [];
      for (const key of new Set([...prev.keys(), ...next.keys()])) { const d = (next.get(key) ?? 0n) - (prev.get(key) ?? 0n); if (d !== 0n) { const [account, token] = key.split('|') as [string, TokenId]; deltas.push({ account, token, delta: d }); } }
      const ops = deltasToOps({ batchId: `${w * 6}-${w * 6 + 6}`, tickFrom: w * 6, tickTo: w * 6 + 6, deltas }, (id) => mapAccountId(id, AUTH));
      for (const p of splitParts(`${w * 6}-${w * 6 + 6}`, ops, 7)) await model.settle(p);
      for (const [key, v] of next) { const [a, t] = key.split('|') as [string, TokenId]; expect(model.bal.get(`${mapAccountId(a, AUTH)}|${t}`) ?? 0n).toBe(v); }
      prev = next;
    }
  });

  it('parts: mints first, transfers in the middle, burns last; each part ≤ maxOps', () => {
    const ops = { mints: Array.from({ length: 5 }, (_, i) => ({ account_id: `m${i}`, token_id: 'fish' as const, amount: '1' })), transfers: Array.from({ length: 5 }, (_, i) => ({ sender_id: `s${i}`, receiver_id: `r${i}`, token_id: 'fish' as const, amount: '1' })), burns: Array.from({ length: 5 }, (_, i) => ({ account_id: `b${i}`, token_id: 'fish' as const, amount: '1' })) };
    const parts = splitParts('0-6', ops, 4);
    expect(parts.map((p) => p.part)).toEqual([0, 1, 2, 3]);
    expect(parts.every((p) => p.parts === 4 && p.mints.length + p.transfers.length + p.burns.length <= 4)).toBe(true);
    const order = parts.flatMap((p) => [...p.mints.map(() => 'm'), ...p.transfers.map(() => 't'), ...p.burns.map(() => 'b')]).join('');
    expect(order).toBe('mmmmmtttttbbbbb');
    expect(splitParts('0-6', { mints: [], transfers: [], burns: [] })).toEqual([{ batch_id: '0-6', mints: [], transfers: [], burns: [] }]);
  });
});

describe('account ids (C3)', () => {
  it('maps sim ids to valid NEAR ids under the authority, deterministically', () => {
    expect(mapAccountId('fisher-1', AUTH)).toBe('fisher-1.samuelowen.testnet');
    expect(mapAccountId('p-1a2b3c4d', AUTH)).toBe('p-1a2b3c4d.samuelowen.testnet');
    expect(mapAccountId('Weird ID!!', AUTH)).toBe('weird-id.samuelowen.testnet');
    const long = mapAccountId('x'.repeat(80), AUTH);
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toBe(mapAccountId('x'.repeat(80), AUTH));
    expect(long).not.toBe(mapAccountId('x'.repeat(81), AUTH));
  });
});

describe('error classification (C4)', () => {
  it('retryable vs. needs-a-human', () => {
    expect(classifyError(new Error('Smart contract panicked: ERR_GAP')).kind).toBe('retryable');
    expect(classifyError({ kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: ERR_PAUSED' } } }).kind).toBe('retryable');
    const f = classifyError(new Error('Smart contract panicked: ERR_INSUFFICIENT_BALANCE'));
    expect([f.code, f.kind]).toEqual(['ERR_INSUFFICIENT_BALANCE', 'fatal']);
    expect(classifyError(new Error('fetch failed: ECONNRESET'))).toMatchObject({ code: 'NETWORK', kind: 'retryable' });
  });
});

describe('NearLedger against the contract model', () => {
  const mk = () => { const m = new ModelContract(); return { m, l: new NearLedger({ network: 'testnet', rpcUrl: 'x', contractId: 'goods.samuelowen.testnet', authorityId: AUTH, privateKey: 'unused' }, m) }; };
  const batch = (from: number, deltas: SettlementBatch['deltas']): SettlementBatch => ({ batchId: `${from}-${from + 6}`, tickFrom: from, tickTo: from + 6, deltas });

  it('settles, is idempotent on replay, and reads balances through the id mapping', async () => {
    const { m, l } = mk();
    expect((await l.settle(batch(0, [{ account: 'fisher-1', token: 'fish', delta: 10n }, { account: 'townfund', token: 'marks', delta: 500n }]))).applied).toBe(true);
    expect((await l.settle(batch(6, [{ account: 'fisher-1', token: 'fish', delta: -4n }, { account: 'smokehouse', token: 'fish', delta: 4n }]))).applied).toBe(true);
    expect(m.calls.at(-1)!.transfers).toEqual([{ sender_id: 'fisher-1.samuelowen.testnet', receiver_id: 'smokehouse.samuelowen.testnet', token_id: 'fish', amount: '4' }]);
    expect((await l.settle(batch(6, [{ account: 'fisher-1', token: 'fish', delta: -4n }]))).applied).toBe(false); // replay
    expect(await l.balanceOf('fisher-1', 'fish')).toBe(6n);
    expect(await l.cursorTick()).toBe(12);
    expect(l.status().health).toBe('ok');
  });

  it('a gap is retryable; an impossible debit is fatal and degrades health', async () => {
    const { l } = mk();
    await l.settle(batch(0, [{ account: 'fisher-1', token: 'fish', delta: 1n }]));
    await expect(l.settle(batch(12, []))).rejects.toMatchObject({ code: 'ERR_GAP', kind: 'retryable' });
    const e = await l.settle(batch(6, [{ account: 'fisher-1', token: 'fish', delta: -5n }])).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LedgerError);
    expect(e).toMatchObject({ code: 'ERR_INSUFFICIENT_BALANCE', kind: 'fatal' });
    expect(l.status().health).toBe('degraded');
  });

  it('a large window goes out as ordered parts and lands completely', async () => {
    const { m, l } = mk();
    const deltas = Array.from({ length: 200 }, (_, i) => ({ account: `p-${i.toString(16).padStart(8, '0')}`, token: 'marks' as const, delta: 100n }));
    await l.settle(batch(0, deltas));
    expect(m.calls.length).toBe(3); // 90 + 90 + 20
    expect(await m.cursor()).toMatchObject({ last_tick_to: 6, in_progress: null });
    expect(await l.balanceOf('p-000000c7', 'marks')).toBe(100n);
  });
});
