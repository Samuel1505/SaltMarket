//! Events. NEP-245 events (`standard: "nep245"`, `version: "1.0.0"`) for every balance change, plus
//! a small `saltmarket` event family for settlement and admin actions so the Ledger drawer can show
//! "batch 120-126 applied" without parsing every transfer.
//!
//! Settlement groups its NEP-245 events (one `mt_mint` log, one `mt_transfer` log, one `mt_burn`
//! log, each with many `data` entries) because a receipt may emit at most 100 logs and 16 KiB of log
//! text in total (live testnet limits, docs/NEAR_INTEGRATION.md §10).

use near_sdk::json_types::U128;
use near_sdk::serde::Serialize;
use near_sdk::{near, AccountId, AsNep297Event};

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(crate = "near_sdk::serde")]
pub struct MtMintLog {
    pub owner_id: AccountId,
    pub token_ids: Vec<String>,
    pub amounts: Vec<U128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memo: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(crate = "near_sdk::serde")]
pub struct MtBurnLog {
    pub owner_id: AccountId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authorized_id: Option<AccountId>,
    pub token_ids: Vec<String>,
    pub amounts: Vec<U128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memo: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(crate = "near_sdk::serde")]
pub struct MtTransferLog {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authorized_id: Option<AccountId>,
    pub old_owner_id: AccountId,
    pub new_owner_id: AccountId,
    pub token_ids: Vec<String>,
    pub amounts: Vec<U128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memo: Option<String>,
}

#[near(event_json(standard = "nep245"))]
pub enum MtEvent {
    #[event_version("1.0.0")]
    MtMint(Vec<MtMintLog>),
    #[event_version("1.0.0")]
    MtBurn(Vec<MtBurnLog>),
    #[event_version("1.0.0")]
    MtTransfer(Vec<MtTransferLog>),
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(crate = "near_sdk::serde")]
pub struct SettleLog {
    pub batch_id: String,
    pub part: u32,
    pub parts: u32,
    pub mints: u32,
    pub transfers: u32,
    pub burns: u32,
    /// True once the last part of the batch has landed and the cursor moved to `tick_to`.
    pub complete: bool,
}

#[near(event_json(standard = "saltmarket"))]
pub enum GameEvent {
    #[event_version("1.0.0")]
    Settle(SettleLog),
    #[event_version("1.0.0")]
    Paused { by: AccountId },
    #[event_version("1.0.0")]
    Unpaused { by: AccountId },
    #[event_version("1.0.0")]
    AuthorityProposed { current: AccountId, proposed: Option<AccountId> },
    #[event_version("1.0.0")]
    AuthorityChanged { old: AccountId, new: AccountId },
    #[event_version("1.0.0")]
    TokenAdded { token_id: String },
    #[event_version("1.0.0")]
    CursorReset { last_tick_to: Option<u64>, by: AccountId },
}

impl MtEvent {
    /// The exact `EVENT_JSON:{...}` line `emit()` would log. Settlement measures these before
    /// logging so an oversized batch fails with a clear error instead of a runtime log-limit error.
    pub fn log_line(&self) -> String {
        self.to_nep297_event().to_event_log()
    }
}

impl GameEvent {
    pub fn log_line(&self) -> String {
        self.to_nep297_event().to_event_log()
    }
}

/// Groups mint/burn entries by owner and transfer entries by (old, new) owner, keeping first-seen
/// order, so one settlement emits one log per event kind.
pub fn push_owner_entry(
    entries: &mut Vec<(AccountId, Vec<String>, Vec<U128>)>,
    owner: &AccountId,
    token_id: &str,
    amount: u128,
) {
    match entries.iter_mut().find(|(o, _, _)| o == owner) {
        Some((_, t, a)) => {
            t.push(token_id.to_string());
            a.push(U128(amount));
        }
        None => entries.push((owner.clone(), vec![token_id.to_string()], vec![U128(amount)])),
    }
}

pub fn push_pair_entry(
    entries: &mut Vec<(AccountId, AccountId, Vec<String>, Vec<U128>)>,
    from: &AccountId,
    to: &AccountId,
    token_id: &str,
    amount: u128,
) {
    match entries.iter_mut().find(|(f, r, _, _)| f == from && r == to) {
        Some((_, _, t, a)) => {
            t.push(token_id.to_string());
            a.push(U128(amount));
        }
        None => entries.push((from.clone(), to.clone(), vec![token_id.to_string()], vec![U128(amount)])),
    }
}
