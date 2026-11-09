//! NEP-245 core, metadata and enumeration methods
//! (https://github.com/near/NEPs/blob/master/neps/nep-0245.md, verified 2026-11-09).
//!
//! Not implemented, on purpose: `mt_transfer_call` / `mt_batch_transfer_call` / `mt_resolve_transfer`
//! (no receiver contracts in the game) and approvals (any non-null `approval` is rejected). Both are
//! disclosed in contracts/goods/README.md.

use near_sdk::json_types::U128;
use near_sdk::{AccountId, env, near, require};

use crate::events::{MtEvent, MtTransferLog};
use crate::*;

#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct Token {
    pub token_id: TokenId,
    /// Always null: these are fungible-style multi tokens without a single owner.
    pub owner_id: Option<AccountId>,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct MTContractMetadata {
    pub spec: String,
    pub name: String,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct MTBaseTokenMetadata {
    pub name: String,
    pub id: String,
    pub symbol: Option<String>,
    pub icon: Option<String>,
    pub decimals: Option<String>,
    pub base_uri: Option<String>,
    pub reference: Option<String>,
    pub copies: Option<u64>,
    pub reference_hash: Option<String>,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq, Default)]
pub struct MTTokenMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    pub media: Option<String>,
    pub media_hash: Option<String>,
    pub issued_at: Option<String>,
    pub expires_at: Option<String>,
    pub starts_at: Option<String>,
    pub updated_at: Option<String>,
    pub extra: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct MTTokenMetadataAll {
    pub base: MTBaseTokenMetadata,
    pub token: MTTokenMetadata,
}

type Approval = (AccountId, u64);

#[near]
impl Goods {
    // ------------------------------------------------------------ core: change methods

    /// Standard transfer by the token owner. Needs exactly 1 yoctoNEAR (NEP-245). The receiver must be
    /// registered (see lib.rs on storage).
    #[payable]
    pub fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        amount: U128,
        approval: Option<Approval>,
        memo: Option<String>,
    ) {
        self.mt_batch_transfer(receiver_id, vec![token_id], vec![amount], approval.map(|a| vec![Some(a)]), memo)
    }

    #[payable]
    pub fn mt_batch_transfer(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<TokenId>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Option<Approval>>>,
        memo: Option<String>,
    ) {
        near_sdk::assert_one_yocto();
        self.assert_not_paused();
        check_lists(&token_ids, &amounts);
        if let Some(a) = &approvals {
            require!(a.len() == token_ids.len(), "ERR_LENGTH_MISMATCH: approvals");
            require!(a.iter().all(Option::is_none), "ERR_APPROVALS_NOT_SUPPORTED");
        }
        require!(self.registered.contains(&receiver_id), "ERR_RECEIVER_NOT_REGISTERED");
        let sender = env::predecessor_account_id();
        for (t, a) in token_ids.iter().zip(&amounts) {
            self.internal_transfer(&sender, &receiver_id, t, a.0);
        }
        MtEvent::MtTransfer(vec![MtTransferLog {
            authorized_id: None,
            old_owner_id: sender,
            new_owner_id: receiver_id,
            token_ids,
            amounts,
            memo,
        }])
        .emit();
    }

    // ------------------------------------------------------------ core: views

    pub fn mt_token(&self, token_ids: Vec<TokenId>) -> Vec<Option<Token>> {
        token_ids
            .into_iter()
            .map(|t| self.tokens.get(&t).is_some().then_some(Token { token_id: t, owner_id: None }))
            .collect()
    }

    pub fn mt_balance_of(&self, account_id: AccountId, token_id: TokenId) -> U128 {
        U128(self.balance(&account_id, &token_id))
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<TokenId>) -> Vec<U128> {
        token_ids.iter().map(|t| U128(self.balance(&account_id, t))).collect()
    }

    pub fn mt_supply(&self, token_id: TokenId) -> Option<U128> {
        self.tokens.get(&token_id).map(|i| U128(i.supply))
    }

    pub fn mt_batch_supply(&self, token_ids: Vec<TokenId>) -> Vec<Option<U128>> {
        token_ids.iter().map(|t| self.tokens.get(t).map(|i| U128(i.supply))).collect()
    }

    // ------------------------------------------------------------ metadata extension

    pub fn mt_metadata_contract(&self) -> MTContractMetadata {
        MTContractMetadata { spec: "mt-1.0.0".into(), name: "Saltmarket goods".into() }
    }

    pub fn mt_metadata_base_by_token_id(&self, token_ids: Vec<TokenId>) -> Vec<MTBaseTokenMetadata> {
        token_ids.iter().map(|t| self.base_metadata(t)).collect()
    }

    pub fn mt_metadata_token_by_token_id(&self, token_ids: Vec<TokenId>) -> Vec<MTTokenMetadata> {
        token_ids.iter().map(|t| self.token_metadata(t)).collect()
    }

    pub fn mt_metadata_token_all(&self, token_ids: Vec<TokenId>) -> Vec<MTTokenMetadataAll> {
        token_ids
            .iter()
            .map(|t| MTTokenMetadataAll { base: self.base_metadata(t), token: self.token_metadata(t) })
            .collect()
    }

    // ------------------------------------------------------------ enumeration extension

    pub fn mt_tokens(&self, from_index: Option<U128>, limit: Option<u32>) -> Vec<Token> {
        let from = from_index.map(|i| i.0 as usize).unwrap_or(0);
        self.tokens
            .keys()
            .skip(from)
            .take(limit.map(|l| l as usize).unwrap_or(usize::MAX))
            .map(|t| Token { token_id: t.clone(), owner_id: None })
            .collect()
    }
}

impl Goods {
    fn base_metadata(&self, token_id: &str) -> MTBaseTokenMetadata {
        let i = self.tokens.get(token_id).unwrap_or_else(|| env::panic_str(&format!("ERR_UNKNOWN_TOKEN: {token_id}")));
        MTBaseTokenMetadata {
            name: i.name.clone(),
            id: token_id.to_string(),
            symbol: Some(i.symbol.clone()),
            icon: None,
            decimals: Some(i.decimals.to_string()),
            base_uri: None,
            reference: None,
            copies: None,
            reference_hash: None,
        }
    }

    fn token_metadata(&self, token_id: &str) -> MTTokenMetadata {
        let i = self.tokens.get(token_id).unwrap_or_else(|| env::panic_str(&format!("ERR_UNKNOWN_TOKEN: {token_id}")));
        MTTokenMetadata { title: Some(i.name.clone()), ..Default::default() }
    }
}
