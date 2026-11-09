//! Saltmarket `goods`: one NEP-245 multi-token contract that holds every game asset.
//!
//! Token ids (must match `TokenId` in packages/chain and `GOODS` in packages/shared/src/config):
//! `marks` (currency, amounts in pips: 1 mark = 100 pips), `fish`, `salt`, `timber`, `barrel`,
//! `cured_fish`, `hall_license`.
//!
//! Roles:
//! - `authority`: the game server. Mints, burns, settles batches, registers accounts. The settlement
//!   methods take **no deposit**, so the server can call them with a function-call access key scoped to
//!   this contract (it can then never move NEAR out of the authority account).
//! - Admin actions that unpause, rotate the authority, add a token, or reset the settlement cursor need
//!   **exactly 1 yoctoNEAR**, which only a full-access key can attach (docs.near.org one_yocto). A leaked
//!   server key can still `pause`, which is the safe direction.
//!
//! Storage: the contract account pays for all storage from its own NEAR balance, which the authority
//! keeps topped up. Players never attach a deposit. To stop strangers from making the contract pay for
//! junk accounts, a direct `mt_transfer` only goes to *registered* accounts. Settlement and minting
//! register recipients automatically; `storage_deposit` (NEP-145) lets anyone register an account by
//! paying for it themselves.
//!
//! Design notes and the settlement contract with the server: contracts/goods/README.md.

use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupMap, LookupSet};
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};

mod mt_core;
pub mod events;
mod settle;
mod storage;

pub use settle::{BurnOp, MintOp, SettleResult, SettlementBatch, TransferOp};

use events::GameEvent;

pub type TokenId = String;

/// Genesis token set: (id, display name, symbol, decimals). `marks` has 2 decimals because amounts
/// are pips (ECONOMY: 1 mark = 100 pips); goods and licenses are whole units.
pub const DEFAULT_TOKENS: [(&str, &str, &str, u8); 7] = [
    ("marks", "Marks", "MRK", 2),
    ("fish", "Fish", "FISH", 0),
    ("salt", "Salt", "SALT", 0),
    ("timber", "Timber", "TMBR", 0),
    ("barrel", "Barrel", "BRL", 0),
    ("cured_fish", "Cured fish", "CURE", 0),
    ("hall_license", "Exchange Hall license", "HALL", 0),
];

/// Upper bound on token ids in one `mt_batch_transfer`, mint or burn call, and on accounts in one
/// `register_accounts` call. Keeps a single call well inside gas and log limits.
pub const MAX_ITEMS_PER_CALL: usize = 100;

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct TokenInfo {
    pub name: String,
    pub symbol: String,
    pub decimals: u8,
    pub supply: u128,
    pub minted: u128,
    pub burned: u128,
}

/// Where settlement is up to. Batches are contiguous tick windows `tickFrom-tickTo`; the cursor is the
/// `tickTo` of the last fully applied batch. See settle.rs for the rules.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Cursor {
    pub last_tick_to: Option<u64>,
    pub last_batch_id: Option<String>,
    pub in_progress: Option<InProgress>,
    pub batches_applied: u64,
}

/// A batch that was split into several parts (several transactions) and is not finished yet.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct InProgress {
    pub batch_id: String,
    pub tick_from: u64,
    pub tick_to: u64,
    pub next_part: u32,
    pub parts: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Goods {
    authority: AccountId,
    pending_authority: Option<AccountId>,
    paused: bool,
    tokens: IterableMap<TokenId, TokenInfo>,
    /// (token_id, account) -> balance. Zero balances are removed to free storage.
    balances: LookupMap<(TokenId, AccountId), u128>,
    registered: LookupSet<AccountId>,
    registered_count: u64,
    cursor: Cursor,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct ContractStatus {
    pub authority: AccountId,
    pub pending_authority: Option<AccountId>,
    pub paused: bool,
    pub registered_accounts: u64,
    pub token_ids: Vec<TokenId>,
    pub cursor: Cursor,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct TokenStats {
    pub token_id: TokenId,
    pub supply: U128,
    pub minted: U128,
    pub burned: U128,
}

#[near]
impl Goods {
    /// Initialise. `#[private]`: only the contract account itself can call this, i.e. in the same
    /// transaction as the deploy, so nobody can front-run initialisation.
    #[init]
    #[private]
    pub fn new(authority: AccountId) -> Self {
        let mut this = Self {
            authority,
            pending_authority: None,
            paused: false,
            tokens: IterableMap::new(b"t"),
            balances: LookupMap::new(b"b"),
            registered: LookupSet::new(b"r"),
            registered_count: 0,
            cursor: Cursor::default(),
        };
        for (id, name, symbol, decimals) in DEFAULT_TOKENS {
            this.insert_token(id, name, symbol, decimals);
        }
        this
    }

    // ---------------------------------------------------------------- admin

    /// Stop all balance changes (transfers, mint, burn, settle). Authority only, no deposit, so the
    /// server can trip it automatically.
    pub fn pause(&mut self) {
        self.assert_authority();
        if !self.paused {
            self.paused = true;
            GameEvent::Paused { by: env::predecessor_account_id() }.emit();
        }
    }

    /// Resume. Needs 1 yoctoNEAR (full-access key) so a leaked function-call key cannot undo a pause.
    #[payable]
    pub fn unpause(&mut self) {
        near_sdk::assert_one_yocto();
        self.assert_authority();
        if self.paused {
            self.paused = false;
            GameEvent::Unpaused { by: env::predecessor_account_id() }.emit();
        }
    }

    /// Step 1 of rotation: the current authority names its successor (`None` cancels).
    #[payable]
    pub fn propose_authority(&mut self, new_authority: Option<AccountId>) {
        near_sdk::assert_one_yocto();
        self.assert_authority();
        self.pending_authority = new_authority.clone();
        GameEvent::AuthorityProposed { current: self.authority.clone(), proposed: new_authority }.emit();
    }

    /// Step 2 of rotation: the proposed account accepts. Two steps so a typo cannot lock the contract.
    #[payable]
    pub fn accept_authority(&mut self) {
        near_sdk::assert_one_yocto();
        let caller = env::predecessor_account_id();
        require!(self.pending_authority.as_ref() == Some(&caller), "ERR_NOT_PENDING_AUTHORITY");
        let old = std::mem::replace(&mut self.authority, caller.clone());
        self.pending_authority = None;
        GameEvent::AuthorityChanged { old, new: caller }.emit();
    }

    /// Add a token id later without a redeploy (e.g. a new good in packages/shared).
    #[payable]
    pub fn add_token(&mut self, token_id: TokenId, name: String, symbol: String, decimals: u8) {
        near_sdk::assert_one_yocto();
        self.assert_authority();
        require!(
            !token_id.is_empty()
                && token_id.len() <= 32
                && token_id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'),
            "ERR_BAD_TOKEN_ID: use 1-32 chars of a-z, 0-9, _"
        );
        require!(self.tokens.get(&token_id).is_none(), "ERR_TOKEN_EXISTS");
        require!(name.len() <= 64 && symbol.len() <= 16, "ERR_METADATA_TOO_LONG");
        self.insert_token(&token_id, &name, &symbol, decimals);
        GameEvent::TokenAdded { token_id }.emit();
    }

    /// Recovery only: move the settlement cursor (e.g. after a server-side ledger reset). Must be paused,
    /// needs 1 yoctoNEAR, and is logged, so it is always a deliberate act.
    #[payable]
    pub fn reset_settlement_cursor(&mut self, last_tick_to: Option<u64>) {
        near_sdk::assert_one_yocto();
        self.assert_authority();
        require!(self.paused, "ERR_NOT_PAUSED: pause before resetting the cursor");
        self.cursor.last_tick_to = last_tick_to;
        self.cursor.last_batch_id = None;
        self.cursor.in_progress = None;
        GameEvent::CursorReset { last_tick_to, by: env::predecessor_account_id() }.emit();
    }

    /// Register accounts up front (the contract pays their storage). Settlement does this on its own;
    /// this is for accounts that should be able to *receive* a direct `mt_transfer` before they own
    /// anything.
    pub fn register_accounts(&mut self, account_ids: Vec<AccountId>) -> u32 {
        self.assert_authority();
        require!(account_ids.len() <= MAX_ITEMS_PER_CALL, "ERR_TOO_MANY_ITEMS");
        account_ids.iter().filter(|a| self.internal_register(a)).count() as u32
    }

    /// Authority-only mint (genesis, faucets). Prefer `settle` in normal play: it is idempotent.
    pub fn mt_mint(&mut self, owner_id: AccountId, token_ids: Vec<TokenId>, amounts: Vec<U128>, memo: Option<String>) {
        self.assert_authority();
        self.assert_not_paused();
        check_lists(&token_ids, &amounts);
        self.internal_register(&owner_id);
        for (t, a) in token_ids.iter().zip(&amounts) {
            self.internal_mint(&owner_id, t, a.0);
        }
        events::MtEvent::MtMint(vec![events::MtMintLog { owner_id, token_ids, amounts, memo }]).emit();
    }

    /// Authority-only burn (sinks, spoilage). Prefer `settle` in normal play: it is idempotent.
    pub fn mt_burn(&mut self, owner_id: AccountId, token_ids: Vec<TokenId>, amounts: Vec<U128>, memo: Option<String>) {
        self.assert_authority();
        self.assert_not_paused();
        check_lists(&token_ids, &amounts);
        for (t, a) in token_ids.iter().zip(&amounts) {
            self.internal_burn(&owner_id, t, a.0);
        }
        events::MtEvent::MtBurn(vec![events::MtBurnLog {
            owner_id,
            authorized_id: Some(env::predecessor_account_id()),
            token_ids,
            amounts,
            memo,
        }])
        .emit();
    }

    // ---------------------------------------------------------------- views

    pub fn get_status(&self) -> ContractStatus {
        ContractStatus {
            authority: self.authority.clone(),
            pending_authority: self.pending_authority.clone(),
            paused: self.paused,
            registered_accounts: self.registered_count,
            token_ids: self.tokens.keys().cloned().collect(),
            cursor: self.cursor.clone(),
        }
    }

    pub fn settlement_cursor(&self) -> Cursor {
        self.cursor.clone()
    }

    /// supply == minted - burned for every token (the conservation property tests check this).
    pub fn token_stats(&self, token_id: TokenId) -> Option<TokenStats> {
        self.tokens.get(&token_id).map(|i| TokenStats {
            token_id: token_id.clone(),
            supply: U128(i.supply),
            minted: U128(i.minted),
            burned: U128(i.burned),
        })
    }

    pub fn is_registered(&self, account_id: AccountId) -> bool {
        self.registered.contains(&account_id)
    }
}

// -------------------------------------------------------------------- internals

impl Goods {
    fn insert_token(&mut self, id: &str, name: &str, symbol: &str, decimals: u8) {
        self.tokens.insert(
            id.to_string(),
            TokenInfo { name: name.into(), symbol: symbol.into(), decimals, supply: 0, minted: 0, burned: 0 },
        );
    }

    pub(crate) fn assert_authority(&self) {
        require!(env::predecessor_account_id() == self.authority, "ERR_NOT_AUTHORITY");
    }

    pub(crate) fn assert_not_paused(&self) {
        require!(!self.paused, "ERR_PAUSED");
    }

    pub(crate) fn assert_token(&self, token_id: &str) {
        require!(self.tokens.get(token_id).is_some(), format!("ERR_UNKNOWN_TOKEN: {token_id}"));
    }

    /// Returns true if newly registered.
    pub(crate) fn internal_register(&mut self, account_id: &AccountId) -> bool {
        let added = self.registered.insert(account_id.clone());
        if added {
            self.registered_count += 1;
        }
        added
    }

    pub(crate) fn balance(&self, account_id: &AccountId, token_id: &str) -> u128 {
        self.balances.get(&(token_id.to_string(), account_id.clone())).copied().unwrap_or(0)
    }

    pub(crate) fn credit(&mut self, account_id: &AccountId, token_id: &str, amount: u128) {
        let key = (token_id.to_string(), account_id.clone());
        let old = self.balances.get(&key).copied().unwrap_or(0);
        let new = old.checked_add(amount).unwrap_or_else(|| env::panic_str("ERR_BALANCE_OVERFLOW"));
        self.balances.insert(key, new);
    }

    /// Never lets a balance go below zero: the whole call reverts instead.
    pub(crate) fn debit(&mut self, account_id: &AccountId, token_id: &str, amount: u128) {
        let key = (token_id.to_string(), account_id.clone());
        let old = self.balances.get(&key).copied().unwrap_or(0);
        if old < amount {
            env::panic_str(&format!(
                "ERR_INSUFFICIENT_BALANCE: {account_id} has {old} {token_id}, needs {amount}"
            ));
        }
        let new = old - amount;
        if new == 0 {
            self.balances.remove(&key);
        } else {
            self.balances.insert(key, new);
        }
    }

    pub(crate) fn internal_mint(&mut self, owner: &AccountId, token_id: &str, amount: u128) {
        require!(amount > 0, "ERR_ZERO_AMOUNT");
        self.assert_token(token_id);
        self.credit(owner, token_id, amount);
        let info = self.tokens.get_mut(token_id).unwrap();
        info.supply = info.supply.checked_add(amount).unwrap_or_else(|| env::panic_str("ERR_SUPPLY_OVERFLOW"));
        info.minted = info.minted.checked_add(amount).unwrap_or_else(|| env::panic_str("ERR_SUPPLY_OVERFLOW"));
    }

    pub(crate) fn internal_burn(&mut self, owner: &AccountId, token_id: &str, amount: u128) {
        require!(amount > 0, "ERR_ZERO_AMOUNT");
        self.assert_token(token_id);
        self.debit(owner, token_id, amount);
        let info = self.tokens.get_mut(token_id).unwrap();
        // supply >= any single balance, so this cannot underflow once debit succeeded.
        info.supply -= amount;
        info.burned = info.burned.checked_add(amount).unwrap_or_else(|| env::panic_str("ERR_SUPPLY_OVERFLOW"));
    }

    pub(crate) fn internal_transfer(&mut self, from: &AccountId, to: &AccountId, token_id: &str, amount: u128) {
        require!(amount > 0, "ERR_ZERO_AMOUNT");
        require!(from != to, "ERR_SELF_TRANSFER");
        self.assert_token(token_id);
        self.debit(from, token_id, amount);
        self.credit(to, token_id, amount);
    }
}

pub(crate) fn check_lists(token_ids: &[TokenId], amounts: &[U128]) {
    require!(!token_ids.is_empty(), "ERR_EMPTY");
    require!(token_ids.len() == amounts.len(), "ERR_LENGTH_MISMATCH: token_ids and amounts");
    require!(token_ids.len() <= MAX_ITEMS_PER_CALL, "ERR_TOO_MANY_ITEMS");
}

/// Used by storage.rs to refund over-deposits.
pub(crate) fn refund(to: AccountId, amount: NearToken) {
    if !amount.is_zero() {
        Promise::new(to).transfer(amount).detach();
    }
}

#[cfg(test)]
mod tests;
