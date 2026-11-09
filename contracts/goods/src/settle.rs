//! Idempotent batch settlement (docs/NEAR_INTEGRATION.md §7).
//!
//! The server settles every few ticks with a batch id `"{tickFrom}-{tickTo}"` (apps/server, see
//! `SettlementBatch` in packages/chain). Rules, checked in this order:
//!
//! 1. **Replay is a no-op.** If `tickTo <= cursor.last_tick_to`, or this is an already-applied part of
//!    the batch in progress, nothing changes and the call returns `applied: false`. A retry after a lost
//!    RPC response is therefore always safe.
//! 2. **Batches are contiguous.** A new batch must start where the last one ended
//!    (`tickFrom == last_tick_to`; the very first batch may start anywhere). The server sends *net
//!    deltas*, so a skipped window would silently corrupt balances; the contract refuses
//!    (`ERR_GAP`) and the server's retry loop delivers the missing batch first.
//! 3. **Parts.** A window too big for one receipt (16 KiB of logs) can be split into `parts`
//!    transactions with the same `batch_id`; part `k` is applied only after part `k-1`. The cursor moves
//!    to `tickTo` when the last part lands.
//! 4. **Order inside a part: mints, then transfers, then burns.** Every debit is checked, so no balance
//!    can go negative; if any op fails the whole part reverts and nothing is applied.

use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId};

use crate::events::{
    push_owner_entry, push_pair_entry, GameEvent, MtBurnLog, MtEvent, MtMintLog, MtTransferLog, SettleLog,
};
use crate::*;

/// Ops in one part (mints + transfers + burns). Keeps gas low; the log budget is checked separately.
pub const MAX_OPS_PER_PART: usize = 150;
/// Parts per batch.
pub const MAX_PARTS: u32 = 64;
/// Live testnet `max_total_log_length` (docs/NEAR_INTEGRATION.md §10).
pub const MAX_TOTAL_LOG_BYTES: usize = 16_384;

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct MintOp {
    pub account_id: AccountId,
    pub token_id: TokenId,
    pub amount: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct TransferOp {
    pub sender_id: AccountId,
    pub receiver_id: AccountId,
    pub token_id: TokenId,
    pub amount: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct BurnOp {
    pub account_id: AccountId,
    pub token_id: TokenId,
    pub amount: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SettlementBatch {
    /// `"{tickFrom}-{tickTo}"`, decimal, no leading zeros, tickFrom < tickTo.
    pub batch_id: String,
    /// 0-based part index; default 0.
    pub part: Option<u32>,
    /// Total parts; default 1.
    pub parts: Option<u32>,
    #[serde(default)]
    pub mints: Vec<MintOp>,
    #[serde(default)]
    pub transfers: Vec<TransferOp>,
    #[serde(default)]
    pub burns: Vec<BurnOp>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SettleResult {
    pub batch_id: String,
    pub part: u32,
    /// false = this batch/part was already applied; nothing changed.
    pub applied: bool,
    /// true once every part of the batch is in and the cursor points at its `tickTo`.
    pub complete: bool,
    pub last_tick_to: Option<u64>,
}

/// Parses `"{from}-{to}"`. Rejects anything that would not round-trip, so one window has exactly one id.
pub fn parse_batch_id(id: &str) -> Option<(u64, u64)> {
    let (a, b) = id.split_once('-')?;
    let from: u64 = a.parse().ok()?;
    let to: u64 = b.parse().ok()?;
    (from < to && format!("{from}-{to}") == id).then_some((from, to))
}

enum Decision {
    Replay,
    Apply,
}

#[near]
impl Goods {
    /// Apply one settlement batch (or one part of it). Authority only, no deposit (function-call key
    /// friendly). Returns `applied: false` for a replay instead of failing, so retries are harmless.
    pub fn settle(&mut self, batch: SettlementBatch) -> SettleResult {
        self.assert_authority();
        self.assert_not_paused();

        let (tick_from, tick_to) = parse_batch_id(&batch.batch_id)
            .unwrap_or_else(|| env::panic_str("ERR_BAD_BATCH_ID: expected \"{tickFrom}-{tickTo}\""));
        let part = batch.part.unwrap_or(0);
        let parts = batch.parts.unwrap_or(1);
        require!(parts >= 1 && parts <= MAX_PARTS, "ERR_BAD_PARTS");
        require!(part < parts, "ERR_BAD_PART");

        let result = |s: &Self, applied: bool| SettleResult {
            batch_id: batch.batch_id.clone(),
            part,
            applied,
            complete: s.cursor.last_tick_to == Some(tick_to) && s.cursor.in_progress.is_none(),
            last_tick_to: s.cursor.last_tick_to,
        };

        match self.decide(&batch.batch_id, tick_from, tick_to, part, parts) {
            Decision::Replay => return result(self, false),
            Decision::Apply => {}
        }

        let n_ops = batch.mints.len() + batch.transfers.len() + batch.burns.len();
        require!(n_ops <= MAX_OPS_PER_PART, "ERR_BATCH_TOO_LARGE: too many ops, split into parts");

        let authority = env::predecessor_account_id();
        let memo = Some(format!("settle {}#{}", batch.batch_id, part));
        let mut mint_log = Vec::new();
        let mut transfer_log = Vec::new();
        let mut burn_log = Vec::new();

        // 1. Mints first, so every credit lands before any debit.
        for op in &batch.mints {
            self.internal_register(&op.account_id);
            self.internal_mint(&op.account_id, &op.token_id, op.amount.0);
            push_owner_entry(&mut mint_log, &op.account_id, &op.token_id, op.amount.0);
        }
        // 2. Transfers. Debits are checked; a shortfall reverts the whole part.
        for op in &batch.transfers {
            self.internal_register(&op.receiver_id);
            self.internal_transfer(&op.sender_id, &op.receiver_id, &op.token_id, op.amount.0);
            push_pair_entry(&mut transfer_log, &op.sender_id, &op.receiver_id, &op.token_id, op.amount.0);
        }
        // 3. Burns last.
        for op in &batch.burns {
            self.internal_burn(&op.account_id, &op.token_id, op.amount.0);
            push_owner_entry(&mut burn_log, &op.account_id, &op.token_id, op.amount.0);
        }

        // Advance the cursor.
        let complete = part + 1 == parts;
        if complete {
            self.cursor.last_tick_to = Some(tick_to);
            self.cursor.last_batch_id = Some(batch.batch_id.clone());
            self.cursor.in_progress = None;
            self.cursor.batches_applied += 1;
        } else {
            self.cursor.in_progress = Some(InProgress {
                batch_id: batch.batch_id.clone(),
                tick_from,
                tick_to,
                next_part: part + 1,
                parts,
            });
        }

        // Events: at most four log lines, measured against the receipt's log budget before logging.
        let mut lines = Vec::with_capacity(4);
        if !mint_log.is_empty() {
            let data = mint_log
                .into_iter()
                .map(|(owner_id, token_ids, amounts)| MtMintLog { owner_id, token_ids, amounts, memo: memo.clone() })
                .collect();
            lines.push(MtEvent::MtMint(data).log_line());
        }
        if !transfer_log.is_empty() {
            let data = transfer_log
                .into_iter()
                .map(|(old_owner_id, new_owner_id, token_ids, amounts)| MtTransferLog {
                    authorized_id: Some(authority.clone()),
                    old_owner_id,
                    new_owner_id,
                    token_ids,
                    amounts,
                    memo: memo.clone(),
                })
                .collect();
            lines.push(MtEvent::MtTransfer(data).log_line());
        }
        if !burn_log.is_empty() {
            let data = burn_log
                .into_iter()
                .map(|(owner_id, token_ids, amounts)| MtBurnLog {
                    owner_id,
                    authorized_id: Some(authority.clone()),
                    token_ids,
                    amounts,
                    memo: memo.clone(),
                })
                .collect();
            lines.push(MtEvent::MtBurn(data).log_line());
        }
        lines.push(
            GameEvent::Settle(SettleLog {
                batch_id: batch.batch_id.clone(),
                part,
                parts,
                mints: batch.mints.len() as u32,
                transfers: batch.transfers.len() as u32,
                burns: batch.burns.len() as u32,
                complete,
            })
            .log_line(),
        );
        let total: usize = lines.iter().map(String::len).sum();
        require!(
            total <= MAX_TOTAL_LOG_BYTES,
            format!("ERR_BATCH_TOO_LARGE: events need {total} bytes of logs (max {MAX_TOTAL_LOG_BYTES}), split into parts")
        );
        for l in &lines {
            env::log_str(l);
        }

        result(self, true)
    }
}

impl Goods {
    fn decide(&self, batch_id: &str, tick_from: u64, tick_to: u64, part: u32, parts: u32) -> Decision {
        let c = &self.cursor;
        if let Some(ip) = &c.in_progress {
            if ip.batch_id == batch_id {
                require!(ip.parts == parts, "ERR_PARTS_MISMATCH");
                if part < ip.next_part {
                    return Decision::Replay;
                }
                require!(part == ip.next_part, format!("ERR_PART_OUT_OF_ORDER: expected part {}", ip.next_part));
                return Decision::Apply;
            }
            // An older, finished batch is still a harmless replay; anything else waits.
            if c.last_tick_to.is_some_and(|w| tick_to <= w) {
                return Decision::Replay;
            }
            env::panic_str(&format!("ERR_BATCH_IN_PROGRESS: finish {} first", ip.batch_id));
        }
        if let Some(w) = c.last_tick_to {
            if tick_to <= w {
                return Decision::Replay;
            }
            require!(tick_from >= w, format!("ERR_OVERLAP: batch starts at {tick_from}, cursor is at {w}"));
            require!(tick_from == w, format!("ERR_GAP: expected a batch starting at tick {w}"));
        }
        require!(part == 0, "ERR_PART_OUT_OF_ORDER: expected part 0");
        Decision::Apply
    }
}
