// Test model of contracts/goods settle() (contiguous, idempotent, mints → transfers → burns, ordered parts).
// Used by the chain and server tests; NOT a ledger to run the game on.
import type { ContractBatch } from './ops.js';
import type { GoodsContract, SettleResult } from './near.js';
import type { TokenId } from './index.js';

/** A model of contracts/goods settle(): contiguous, idempotent, mints → transfers → burns, ordered parts. */
export class ModelContract implements GoodsContract {
  bal = new Map<string, bigint>();
  cursorTo: number | null = null;
  inProgress: { id: string; next: number; parts: number } | null = null;
  calls: ContractBatch[] = [];
  private panic(code: string): never { throw new Error(`Smart contract panicked: ${code}`); }
  async settle(b: ContractBatch) {
    this.calls.push(b);
    const [from, to] = b.batch_id.split('-').map(Number) as [number, number];
    const part = b.part ?? 0; const parts = b.parts ?? 1;
    const done = (applied: boolean, complete: boolean): { result: SettleResult; txHash: string } => ({ result: { batch_id: b.batch_id, part, applied, complete, last_tick_to: this.cursorTo }, txHash: `tx${this.calls.length}` });
    if (this.cursorTo !== null && to <= this.cursorTo) return done(false, true);
    if (this.inProgress && this.inProgress.id !== b.batch_id) this.panic('ERR_BATCH_IN_PROGRESS');
    if (this.inProgress && part < this.inProgress.next) return done(false, false);
    if (this.inProgress && part !== this.inProgress.next) this.panic('ERR_PART_OUT_OF_ORDER');
    if (!this.inProgress && part !== 0) this.panic('ERR_PART_OUT_OF_ORDER');
    if (this.cursorTo !== null && from !== this.cursorTo) this.panic(from > this.cursorTo ? 'ERR_GAP' : 'ERR_OVERLAP');
    if (b.mints.length + b.transfers.length + b.burns.length > 150) this.panic('ERR_BATCH_TOO_LARGE');
    const next = new Map(this.bal);
    const k = (a: string, t: string) => `${a}|${t}`;
    const sub = (key: string, n: bigint) => { const v = (next.get(key) ?? 0n) - n; if (v < 0n) this.panic('ERR_INSUFFICIENT_BALANCE'); next.set(key, v); };
    for (const m of b.mints) { if (BigInt(m.amount) <= 0n) this.panic('ERR_ZERO_AMOUNT'); next.set(k(m.account_id, m.token_id), (next.get(k(m.account_id, m.token_id)) ?? 0n) + BigInt(m.amount)); }
    for (const t of b.transfers) { if (t.sender_id === t.receiver_id) this.panic('ERR_SELF_TRANSFER'); sub(k(t.sender_id, t.token_id), BigInt(t.amount)); next.set(k(t.receiver_id, t.token_id), (next.get(k(t.receiver_id, t.token_id)) ?? 0n) + BigInt(t.amount)); }
    for (const x of b.burns) sub(k(x.account_id, x.token_id), BigInt(x.amount));
    this.bal = next;
    if (part + 1 < parts) { this.inProgress = { id: b.batch_id, next: part + 1, parts }; return done(true, false); }
    this.inProgress = null;
    this.cursorTo = to;
    return done(true, true);
  }
  async cursor() { return { last_tick_to: this.cursorTo, last_batch_id: null, in_progress: this.inProgress, batches_applied: 0 }; }
  async batchBalanceOf(a: string, ts: TokenId[]) { return ts.map((t) => (this.bal.get(`${a}|${t}`) ?? 0n).toString()); }
  async storageReport() { return { accounts_affordable: 500, free_balance: '0', storage_usage_bytes: 0 }; }
}

