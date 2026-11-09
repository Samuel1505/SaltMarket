// NearLedger: settles the server's batches to the NEP-245 goods contract on NEAR (ARCHITECTURE §5,
// NEAR_INTEGRATION §7, contracts/goods/README.md). near-api-js 7.4.0 API verified from the package source
// (Account(accountId, provider, privateKey), callFunctionRaw → RpcTransactionResponse, throws on Failure;
// JsonRpcProvider.callFunction for views). See NEAR_INTEGRATION.md §10.
import { Account, getTransactionLastResult, JsonRpcProvider, teraToGas, type KeyPairString } from 'near-api-js';
import { classifyError, deltasToOps, LedgerError, mapAccountId, splitParts, type ContractBatch } from './ops.js';
import type { LedgerAdapter, LedgerStatus, Receipt, SettlementBatch, TokenId } from './index.js';

export type SettleResult = { batch_id: string; part: number; applied: boolean; complete: boolean; last_tick_to: number | null };
export type Cursor = { last_tick_to: number | null; last_batch_id: string | null; in_progress: unknown; batches_applied: number };
export type StorageReport = { accounts_affordable: number; free_balance: string; storage_usage_bytes: number };

/** The contract calls NearLedger needs. Injectable so tests can run against a model of the contract. */
export interface GoodsContract {
  settle(batch: ContractBatch): Promise<{ result: SettleResult; txHash: string }>;
  cursor(): Promise<Cursor>;
  batchBalanceOf(accountId: string, tokenIds: TokenId[]): Promise<string[]>;
  storageReport(): Promise<StorageReport>;
}

export type NearConfig = {
  network: string; // 'testnet'
  rpcUrl: string;
  contractId: string;
  authorityId: string;
  /** Function-call key scoped to the contract (REQUESTS C7). Never logged. */
  privateKey: string;
  settleGasTgas?: number;
  /** Explorer URL templates with "{id}", e.g. from NEAR_EXPLORER_TX_URL. Unset → no links (C9). */
  explorerTx?: string;
  explorerAccount?: string;
};

/** Real contract over JSON-RPC. */
export class RpcGoodsContract implements GoodsContract {
  private readonly provider: JsonRpcProvider;
  private readonly account: Account;
  constructor(private readonly cfg: NearConfig) {
    this.provider = new JsonRpcProvider({ url: cfg.rpcUrl });
    this.account = new Account(cfg.authorityId, this.provider, cfg.privateKey as KeyPairString);
  }
  async settle(batch: ContractBatch) {
    const outcome = await this.account.callFunctionRaw({
      contractId: this.cfg.contractId, methodName: 'settle', args: { batch }, gas: teraToGas(this.cfg.settleGasTgas ?? 100),
    });
    const result = getTransactionLastResult(outcome) as SettleResult;
    return { result, txHash: outcome.transaction_outcome.id };
  }
  cursor() {
    return this.provider.callFunction({ contractId: this.cfg.contractId, method: 'settlement_cursor', args: {} }) as Promise<Cursor>;
  }
  batchBalanceOf(accountId: string, tokenIds: TokenId[]) {
    return this.provider.callFunction({ contractId: this.cfg.contractId, method: 'mt_batch_balance_of', args: { account_id: accountId, token_ids: tokenIds } }) as Promise<string[]>;
  }
  storageReport() {
    return this.provider.callFunction({ contractId: this.cfg.contractId, method: 'storage_report', args: {} }) as Promise<StorageReport>;
  }
}

export class NearLedger implements LedgerAdapter {
  private health: LedgerStatus['health'] = 'ok';
  private lastError: string | null = null;
  private lastStorageCheck = 0;
  readonly contract: GoodsContract;

  constructor(private readonly cfg: NearConfig, contract?: GoodsContract, private readonly log: (m: string) => void = () => {}) {
    this.contract = contract ?? new RpcGoodsContract(cfg);
  }

  /** C3: the on-chain account id for a sim account. */
  accountId(simId: string): string {
    return mapAccountId(simId, this.cfg.authorityId);
  }

  status(): LedgerStatus {
    return { mode: 'near', health: this.health, network: this.cfg.network, contractId: this.cfg.contractId };
  }

  lastProblem(): string | null {
    return this.lastError;
  }

  /**
   * Convert net deltas to mints/transfers/burns (C1), split into parts if large (C5), send the parts in order.
   * A part the contract already applied returns applied:false and is skipped, so retries are safe.
   * Throws LedgerError with kind 'retryable' or 'fatal' (C4).
   */
  async settle(batch: SettlementBatch): Promise<Receipt> {
    const parts = splitParts(batch.batchId, deltasToOps(batch, (id) => this.accountId(id)));
    let applied = false;
    let txHash = '';
    try {
      for (const p of parts) {
        const { result, txHash: h } = await this.contract.settle(p);
        txHash = h;
        applied = applied || result.applied;
      }
    } catch (err) {
      const e = classifyError(err);
      // ERR_BATCH_TOO_LARGE on a single part: split further and retry once.
      if (e.code === 'ERR_BATCH_TOO_LARGE' && parts.length === 1) return this.settleSplit(batch, 40);
      this.health = e.kind === 'fatal' ? 'degraded' : 'offline';
      this.lastError = `${batch.batchId}: ${e.code}`;
      throw e;
    }
    this.health = 'ok';
    this.lastError = null;
    void this.checkStorage();
    return { batchId: batch.batchId, txHash, applied };
  }

  private async settleSplit(batch: SettlementBatch, maxOps: number): Promise<Receipt> {
    let applied = false;
    let txHash = '';
    for (const p of splitParts(batch.batchId, deltasToOps(batch, (id) => this.accountId(id)), maxOps)) {
      const { result, txHash: h } = await this.contract.settle(p).catch((err: unknown) => { throw classifyError(err); });
      txHash = h;
      applied = applied || result.applied;
    }
    return { batchId: batch.batchId, txHash, applied };
  }

  async balanceOf(account: string, token: TokenId): Promise<bigint> {
    const [v] = await this.contract.batchBalanceOf(this.accountId(account), [token]);
    return BigInt(v ?? '0');
  }

  /** The contract's settlement cursor: the tickTo of the last batch it applied (null if none). */
  async cursorTick(): Promise<number | null> {
    return (await this.contract.cursor()).last_tick_to;
  }

  explorerUrl(kind: 'tx' | 'account', id: string): string | null {
    const t = kind === 'tx' ? this.cfg.explorerTx : this.cfg.explorerAccount;
    if (!t) return null;
    return t.replace('{id}', encodeURIComponent(kind === 'account' && !id.includes('.') ? this.accountId(id) : id));
  }

  /** C7: warn when the contract can pay for fewer than ~100 more accounts. At most every 10 minutes. */
  private async checkStorage(): Promise<void> {
    if (Date.now() - this.lastStorageCheck < 600_000) return;
    this.lastStorageCheck = Date.now();
    try {
      const r = await this.contract.storageReport();
      if (r.accounts_affordable < 100) {
        this.health = 'degraded';
        this.log(`ledger: contract can pay for only ${r.accounts_affordable} more accounts; top up ${this.cfg.contractId}`);
      }
    } catch { /* monitoring only */ }
  }
}

export { LedgerError };
