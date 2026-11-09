// Turning the server's net deltas into the goods contract's settle() arguments (contracts/goods/README.md,
// REQUESTS C1, C3, C4, C5). Pure functions, unit-tested against a model of the contract's rules.
import type { SettlementBatch, TokenId } from './index.js';

export type MintOp = { account_id: string; token_id: TokenId; amount: string };
export type TransferOp = { sender_id: string; receiver_id: string; token_id: TokenId; amount: string };
export type BurnOp = MintOp;
export type ContractBatch = { batch_id: string; part?: number; parts?: number; mints: MintOp[]; transfers: TransferOp[]; burns: BurnOp[] };

/**
 * C1: per token, pair receivers with senders into transfers; leftovers are net mints (creation) or burns (sinks).
 * An account only ever sends what it net-lost, so with mints → transfers → burns no balance goes negative.
 */
export function deltasToOps(batch: SettlementBatch, mapId: (simId: string) => string): Omit<ContractBatch, 'batch_id'> {
  const out: Omit<ContractBatch, 'batch_id'> = { mints: [], transfers: [], burns: [] };
  const byToken = new Map<TokenId, { account: string; delta: bigint }[]>();
  for (const d of batch.deltas) {
    if (d.delta === 0n) continue;
    const list = byToken.get(d.token) ?? [];
    list.push({ account: mapId(d.account), delta: d.delta });
    byToken.set(d.token, list);
  }
  for (const token of [...byToken.keys()].sort()) {
    const list = byToken.get(token)!.sort((a, b) => a.account.localeCompare(b.account));
    const pos = list.filter((x) => x.delta > 0n).map((x) => ({ ...x }));
    const neg = list.filter((x) => x.delta < 0n).map((x) => ({ ...x }));
    while (pos.length && neg.length) {
      const p = pos[0]!;
      const q = neg[0]!;
      const n = p.delta < -q.delta ? p.delta : -q.delta;
      out.transfers.push({ sender_id: q.account, receiver_id: p.account, token_id: token, amount: n.toString() });
      p.delta -= n;
      q.delta += n;
      if (p.delta === 0n) pos.shift();
      if (q.delta === 0n) neg.shift();
    }
    for (const p of pos) out.mints.push({ account_id: p.account, token_id: token, amount: p.delta.toString() });
    for (const q of neg) out.burns.push({ account_id: q.account, token_id: token, amount: (-q.delta).toString() });
  }
  return out;
}

/** C5: split into parts of at most `maxOps` ops: mints in the early parts, transfers in the middle, burns last. */
export function splitParts(batchId: string, ops: Omit<ContractBatch, 'batch_id'>, maxOps = 90): ContractBatch[] {
  const seq: ({ k: 'm'; op: MintOp } | { k: 't'; op: TransferOp } | { k: 'b'; op: BurnOp })[] = [
    ...ops.mints.map((op) => ({ k: 'm' as const, op })),
    ...ops.transfers.map((op) => ({ k: 't' as const, op })),
    ...ops.burns.map((op) => ({ k: 'b' as const, op })),
  ];
  const chunks: typeof seq[] = [];
  for (let i = 0; i < seq.length; i += maxOps) chunks.push(seq.slice(i, i + maxOps));
  if (chunks.length === 0) chunks.push([]);
  return chunks.map((c, part) => ({
    batch_id: batchId,
    ...(chunks.length > 1 ? { part, parts: chunks.length } : {}),
    mints: c.filter((x) => x.k === 'm').map((x) => x.op as MintOp),
    transfers: c.filter((x) => x.k === 't').map((x) => x.op as TransferOp),
    burns: c.filter((x) => x.k === 'b').map((x) => x.op as BurnOp),
  }));
}

const VALID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/**
 * C3: sim ids → NEAR account ids under the authority, e.g. "fisher-1" → "fisher-1.samuelowen.testnet".
 * Lowercases, replaces anything outside [a-z0-9-_] with "-", and shortens (with a stable hash) to fit 64 chars.
 */
export function mapAccountId(simId: string, authority: string): string {
  let local = simId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').replace(/[-_]{2,}/g, '-') || 'x';
  const room = 64 - authority.length - 1;
  if (room < 2) throw new Error(`authority id too long to hold sub-ids: ${authority}`);
  if (local.length > room) local = `${local.slice(0, Math.max(1, room - 9))}-${fnv(simId)}`.slice(0, room);
  const id = `${local}.${authority}`;
  if (!VALID.test(id) || id.length > 64) throw new Error(`cannot map ${simId} to a valid account id`);
  return id;
}

export type LedgerErrorKind = 'retryable' | 'fatal';
/** C4: errors the contract (or the network) can return, and whether a retry can ever help. */
export const RETRYABLE_CODES = new Set(['ERR_GAP', 'ERR_BATCH_IN_PROGRESS', 'ERR_PAUSED', 'ERR_PART_OUT_OF_ORDER']);

export class LedgerError extends Error {
  constructor(readonly code: string, readonly kind: LedgerErrorKind, message: string) {
    super(message);
  }
}

/** Find the contract's ERR_* code in any error shape; no code means a network/RPC problem (retryable). */
export function classifyError(err: unknown): LedgerError {
  if (err instanceof LedgerError) return err;
  let text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  try { text += ` ${JSON.stringify(err, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}`; } catch { /* circular: message is enough */ }
  const code = /\bERR_[A-Z_]+/.exec(text)?.[0];
  if (!code) return new LedgerError('NETWORK', 'retryable', text.slice(0, 300));
  return new LedgerError(code, RETRYABLE_CODES.has(code) ? 'retryable' : 'fatal', text.slice(0, 300));
}

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
