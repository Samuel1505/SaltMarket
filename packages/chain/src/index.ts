// LedgerAdapter seam (ARCHITECTURE §5). MemoryLedger runs offline; NearLedger (testnet) comes later
// behind the same interface. Amounts are bigint (onchain u128); token ids match the NEP-245 contract.

export type TokenId = 'marks' | 'fish' | 'salt' | 'timber' | 'barrel' | 'cured_fish' | 'hall_license';
export type Delta = { account: string; token: TokenId; delta: bigint };
export type SettlementBatch = { batchId: string; tickFrom: number; tickTo: number; deltas: Delta[] };
export type Receipt = { batchId: string; txHash: string; applied: boolean };
export type LedgerStatus = { mode: 'memory' | 'near'; health: 'ok' | 'degraded' | 'offline'; network: string | null; contractId: string | null };

export interface LedgerAdapter {
  status(): LedgerStatus;
  /** Apply a batch of net deltas. Must be idempotent by batchId (a retry never double-applies). */
  settle(batch: SettlementBatch): Promise<Receipt>;
  balanceOf(account: string, token: TokenId): Promise<bigint>;
  /** Optional: several tokens of one account in a single read (fewer RPC calls). */
  balancesOf?(account: string, tokens: TokenId[]): Promise<bigint[]>;
  explorerUrl(kind: 'tx' | 'account', id: string): string | null;
  /**
   * Optional: bring an in-process ledger back to the server's last confirmed state after a restart.
   * A real chain keeps its own state and does not implement this (the server reads it instead).
   */
  restore?(confirmed: Map<string, bigint>, lastTickTo: number): void;
  /** Optional: the ledger's own settlement cursor (tickTo of the last applied batch, null if none). */
  cursorTick?(): Promise<number | null>;
}

/** In-process ledger for dev, tests, and the offline demo. Fake but well-formed receipts. */
export class MemoryLedger implements LedgerAdapter {
  private readonly balances = new Map<string, bigint>();
  private readonly applied = new Map<string, Receipt>();

  status(): LedgerStatus {
    return { mode: 'memory', health: 'ok', network: null, contractId: null };
  }

  async settle(batch: SettlementBatch): Promise<Receipt> {
    const prior = this.applied.get(batch.batchId);
    if (prior) return { ...prior, applied: false };
    // Validate first so a batch applies atomically or not at all.
    const next = new Map<string, bigint>();
    for (const d of batch.deltas) {
      const k = `${d.account}|${d.token}`;
      const v = (next.get(k) ?? this.balances.get(k) ?? 0n) + d.delta;
      if (v < 0n) throw new Error(`batch ${batch.batchId} would make ${k} negative`);
      next.set(k, v);
    }
    for (const [k, v] of next) this.balances.set(k, v);
    const receipt = { batchId: batch.batchId, txHash: `mem-${hash(batch.batchId)}`, applied: true };
    this.applied.set(batch.batchId, receipt);
    return receipt;
  }

  async balanceOf(account: string, token: TokenId): Promise<bigint> {
    return this.balances.get(`${account}|${token}`) ?? 0n;
  }

  explorerUrl(): string | null {
    return null;
  }

  /** After a process restart this ledger is empty; reload the confirmed balances. No-op if it still has state. */
  restore(confirmed: Map<string, bigint>): void {
    if (this.applied.size > 0 || this.balances.size > 0) return;
    for (const [k, v] of confirmed) if (v !== 0n) this.balances.set(k, v);
  }
}

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export * from './ops.js';
export * from './near.js';
export { ModelContract } from './model.js';
