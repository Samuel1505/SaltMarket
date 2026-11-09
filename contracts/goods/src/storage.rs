//! Storage. The contract pays for storage from its own balance; the authority keeps it funded and
//! players never see a deposit. NEP-145 `storage_deposit` / `storage_balance_of` /
//! `storage_balance_bounds` exist so wallets and other tools can register an account by paying for it
//! themselves. `storage_withdraw` / `storage_unregister` are not implemented: registration is
//! permanent and the fixed fee is not refundable (disclosed in README.md).

use near_sdk::json_types::U128;
use near_sdk::{AccountId, NearToken, env, near, require};

use crate::*;

/// Bytes one account can occupy at most: a registration entry plus one balance entry per default token,
/// each with the runtime's 40-byte per-record overhead and a 64-char account id. The tests check that
/// real usage stays under this figure.
pub const ACCOUNT_STORAGE_BYTES: u64 = 1_250;

#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct StorageBalance {
    pub total: U128,
    pub available: U128,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct StorageBalanceBounds {
    pub min: U128,
    pub max: Option<U128>,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct StorageReport {
    pub storage_usage_bytes: u64,
    pub locked_for_storage: U128,
    pub account_balance: U128,
    /// Balance not locked by storage: what is left to pay for new accounts and balances.
    pub free_balance: U128,
    pub bytes_per_account: u64,
    /// Rough count of further accounts the current free balance can pay for.
    pub accounts_affordable: u64,
}

fn account_fee() -> NearToken {
    env::storage_byte_cost().saturating_mul(ACCOUNT_STORAGE_BYTES as u128)
}

#[near]
impl Goods {
    /// NEP-145. Anyone may register `account_id` (default: the caller) by attaching at least
    /// `storage_balance_bounds().min`. Any excess, or the whole deposit if already registered, is
    /// refunded.
    #[payable]
    pub fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        let _ = registration_only; // fixed-size registration: there is never an "available" balance
        let payer = env::predecessor_account_id();
        let account = account_id.unwrap_or_else(|| payer.clone());
        let deposit = env::attached_deposit();
        if self.registered.contains(&account) {
            refund(payer, deposit);
        } else {
            let fee = account_fee();
            require!(deposit >= fee, format!("ERR_DEPOSIT_TOO_SMALL: need {} yoctoNEAR", fee.as_yoctonear()));
            self.internal_register(&account);
            refund(payer, deposit.saturating_sub(fee));
        }
        self.storage_balance()
    }

    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        let fee = U128(account_fee().as_yoctonear());
        StorageBalanceBounds { min: fee, max: Some(fee) }
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.registered.contains(&account_id).then(|| self.storage_balance())
    }

    /// For the Ledger drawer and the server's balance monitor.
    pub fn storage_report(&self) -> StorageReport {
        let usage = env::storage_usage();
        let locked = env::storage_byte_cost().saturating_mul(usage as u128);
        let balance = env::account_balance();
        let free = balance.saturating_sub(locked);
        let fee = account_fee().as_yoctonear().max(1);
        StorageReport {
            storage_usage_bytes: usage,
            locked_for_storage: U128(locked.as_yoctonear()),
            account_balance: U128(balance.as_yoctonear()),
            free_balance: U128(free.as_yoctonear()),
            bytes_per_account: ACCOUNT_STORAGE_BYTES,
            accounts_affordable: (free.as_yoctonear() / fee) as u64,
        }
    }
}

impl Goods {
    fn storage_balance(&self) -> StorageBalance {
        StorageBalance { total: U128(account_fee().as_yoctonear()), available: U128(0) }
    }
}
