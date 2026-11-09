//! Unit tests (near-sdk `unit-testing` mock). Integration tests against a real sandbox node live in
//! tests/sandbox.rs.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::{VMContextBuilder, get_logs};
use near_sdk::{AccountId, NearToken, testing_env};

use crate::storage::ACCOUNT_STORAGE_BYTES;
use crate::*;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn authority() -> AccountId {
    acc("authority.testnet")
}
fn contract_id() -> AccountId {
    acc("goods.authority.testnet")
}

fn ctx(predecessor: &AccountId, deposit: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(contract_id())
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor.clone())
        .account_balance(NearToken::from_near(50))
        .attached_deposit(NearToken::from_yoctonear(deposit));
    testing_env!(b.build());
}

fn setup() -> Goods {
    ctx(&contract_id(), 0);
    let c = Goods::new(authority());
    ctx(&authority(), 0);
    c
}

fn mint(a: &str, t: &str, n: u128) -> MintOp {
    MintOp { account_id: acc(a), token_id: t.into(), amount: U128(n) }
}
fn xfer(f: &str, r: &str, t: &str, n: u128) -> TransferOp {
    TransferOp { sender_id: acc(f), receiver_id: acc(r), token_id: t.into(), amount: U128(n) }
}
fn burn(a: &str, t: &str, n: u128) -> BurnOp {
    BurnOp { account_id: acc(a), token_id: t.into(), amount: U128(n) }
}
fn batch(id: &str, mints: Vec<MintOp>, transfers: Vec<TransferOp>, burns: Vec<BurnOp>) -> SettlementBatch {
    SettlementBatch { batch_id: id.into(), part: None, parts: None, mints, transfers, burns }
}
fn bal(c: &Goods, a: &str, t: &str) -> u128 {
    c.mt_balance_of(acc(a), t.into()).0
}

const FISHER: &str = "npc-fisher-1.authority.testnet";
const SMOKE: &str = "npc-smokehouse.authority.testnet";
const PLAYER: &str = "p-abc123.authority.testnet";

fn genesis(c: &mut Goods) {
    c.settle(batch(
        "0-6",
        vec![
            mint(FISHER, "marks", 30_000),
            mint(SMOKE, "marks", 50_000),
            mint(PLAYER, "marks", 30_000),
            mint(FISHER, "fish", 10),
        ],
        vec![],
        vec![],
    ));
}

// ------------------------------------------------------------------ init + metadata

#[test]
fn init_has_the_seven_game_tokens() {
    let c = setup();
    let s = c.get_status();
    assert_eq!(s.authority, authority());
    assert!(!s.paused);
    assert_eq!(s.token_ids, vec!["marks", "fish", "salt", "timber", "barrel", "cured_fish", "hall_license"]);
    assert_eq!(c.mt_supply("fish".into()), Some(U128(0)));
    assert_eq!(c.mt_supply("iron".into()), None);
    assert_eq!(c.mt_metadata_contract().spec, "mt-1.0.0");
    let m = c.mt_metadata_base_by_token_id(vec!["marks".into(), "fish".into()]);
    assert_eq!(m[0].decimals.as_deref(), Some("2"));
    assert_eq!(m[1].decimals.as_deref(), Some("0"));
    assert_eq!(c.mt_tokens(Some(U128(5)), Some(10)).len(), 2);
    assert_eq!(c.mt_token(vec!["salt".into(), "iron".into()])[1], None);
}

// `#[private]` on `new` is enforced by the wasm entry point, so it is tested in tests/sandbox.rs.

// ------------------------------------------------------------------ genesis + mint/burn

#[test]
fn genesis_settle_mints_and_registers() {
    let mut c = setup();
    genesis(&mut c);
    assert_eq!(bal(&c, FISHER, "marks"), 30_000);
    assert_eq!(bal(&c, FISHER, "fish"), 10);
    assert_eq!(c.mt_supply("marks".into()), Some(U128(110_000)));
    assert!(c.is_registered(acc(PLAYER)));
    assert_eq!(c.get_status().registered_accounts, 3);
    let st = c.token_stats("marks".into()).unwrap();
    assert_eq!((st.minted.0, st.burned.0), (110_000, 0));
}

#[test]
fn authority_mint_and_burn() {
    let mut c = setup();
    c.mt_mint(acc(PLAYER), vec!["salt".into(), "timber".into()], vec![U128(5), U128(7)], None);
    c.mt_burn(acc(PLAYER), vec!["salt".into()], vec![U128(2)], Some("spoilage".into()));
    assert_eq!(bal(&c, PLAYER, "salt"), 3);
    let st = c.token_stats("salt".into()).unwrap();
    assert_eq!((st.supply.0, st.minted.0, st.burned.0), (3, 5, 2));
}

#[test]
#[should_panic(expected = "ERR_NOT_AUTHORITY")]
fn non_authority_mint_rejected() {
    let mut c = setup();
    ctx(&acc(PLAYER), 0);
    c.mt_mint(acc(PLAYER), vec!["marks".into()], vec![U128(1_000_000)], None);
}

#[test]
#[should_panic(expected = "ERR_NOT_AUTHORITY")]
fn non_authority_burn_rejected() {
    let mut c = setup();
    genesis(&mut c);
    ctx(&acc(PLAYER), 0);
    c.mt_burn(acc(FISHER), vec!["marks".into()], vec![U128(1)], None);
}

#[test]
#[should_panic(expected = "ERR_NOT_AUTHORITY")]
fn non_authority_settle_rejected() {
    let mut c = setup();
    ctx(&acc(PLAYER), 0);
    c.settle(batch("0-6", vec![mint(PLAYER, "marks", 1)], vec![], vec![]));
}

#[test]
#[should_panic(expected = "ERR_INSUFFICIENT_BALANCE")]
fn burn_more_than_balance_rejected() {
    let mut c = setup();
    genesis(&mut c);
    c.mt_burn(acc(FISHER), vec!["fish".into()], vec![U128(11)], None);
}

#[test]
#[should_panic(expected = "ERR_UNKNOWN_TOKEN")]
fn unknown_token_rejected() {
    let mut c = setup();
    c.mt_mint(acc(PLAYER), vec!["iron".into()], vec![U128(1)], None);
}

// ------------------------------------------------------------------ standard transfers

#[test]
fn mt_transfer_and_batch_transfer() {
    let mut c = setup();
    genesis(&mut c);
    ctx(&acc(FISHER), 1);
    c.mt_transfer(acc(SMOKE), "fish".into(), U128(4), None, Some("sale".into()));
    assert_eq!((bal(&c, FISHER, "fish"), bal(&c, SMOKE, "fish")), (6, 4));

    let logs = get_logs();
    let ev: Value = serde_json::from_str(logs[0].strip_prefix("EVENT_JSON:").unwrap()).unwrap();
    assert_eq!(ev["standard"], "nep245");
    assert_eq!(ev["version"], "1.0.0");
    assert_eq!(ev["event"], "mt_transfer");
    assert_eq!(ev["data"][0]["old_owner_id"], FISHER);
    assert_eq!(ev["data"][0]["amounts"][0], "4");

    ctx(&acc(FISHER), 1);
    c.mt_batch_transfer(acc(PLAYER), vec!["fish".into(), "marks".into()], vec![U128(1), U128(500)], None, None);
    assert_eq!(bal(&c, PLAYER, "fish"), 1);
    assert_eq!(bal(&c, PLAYER, "marks"), 30_500);
    assert_eq!(c.mt_batch_balance_of(acc(FISHER), vec!["fish".into(), "marks".into()]), vec![U128(5), U128(29_500)]);
    // Transfers never change supply.
    assert_eq!(c.mt_supply("marks".into()), Some(U128(110_000)));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn mt_transfer_needs_one_yocto() {
    let mut c = setup();
    genesis(&mut c);
    ctx(&acc(FISHER), 0);
    c.mt_transfer(acc(SMOKE), "fish".into(), U128(1), None, None);
}

#[test]
#[should_panic(expected = "ERR_LENGTH_MISMATCH")]
fn batch_transfer_length_mismatch() {
    let mut c = setup();
    genesis(&mut c);
    ctx(&acc(FISHER), 1);
    c.mt_batch_transfer(acc(SMOKE), vec!["fish".into(), "marks".into()], vec![U128(1)], None, None);
}

#[test]
#[should_panic(expected = "ERR_RECEIVER_NOT_REGISTERED")]
fn transfer_to_unregistered_rejected() {
    let mut c = setup();
    genesis(&mut c);
    ctx(&acc(FISHER), 1);
    c.mt_transfer(acc("stranger.testnet"), "fish".into(), U128(1), None, None);
}

#[test]
#[should_panic(expected = "ERR_APPROVALS_NOT_SUPPORTED")]
fn approvals_rejected() {
    let mut c = setup();
    genesis(&mut c);
    ctx(&acc(FISHER), 1);
    c.mt_transfer(acc(SMOKE), "fish".into(), U128(1), Some((acc(FISHER), 1)), None);
}

#[test]
#[should_panic(expected = "ERR_INSUFFICIENT_BALANCE")]
fn transfer_more_than_balance_rejected() {
    let mut c = setup();
    genesis(&mut c);
    ctx(&acc(FISHER), 1);
    c.mt_transfer(acc(SMOKE), "fish".into(), U128(11), None, None);
}

// ------------------------------------------------------------------ storage

#[test]
fn storage_deposit_registers_and_bounds_are_fixed() {
    let mut c = setup();
    let b = c.storage_balance_bounds();
    let fee = 10u128.pow(19) * ACCOUNT_STORAGE_BYTES as u128;
    assert_eq!(b.min.0, fee);
    assert_eq!(b.max, Some(U128(fee)));
    assert_eq!(c.storage_balance_of(acc(PLAYER)), None);
    ctx(&acc("friend.testnet"), fee + 5);
    c.storage_deposit(Some(acc(PLAYER)), None);
    assert!(c.is_registered(acc(PLAYER)));
    assert_eq!(c.storage_balance_of(acc(PLAYER)).unwrap().total.0, fee);
}

#[test]
#[should_panic(expected = "ERR_DEPOSIT_TOO_SMALL")]
fn storage_deposit_too_small() {
    let mut c = setup();
    ctx(&acc(PLAYER), 1);
    c.storage_deposit(None, None);
}

#[test]
fn authority_registers_accounts_for_free() {
    let mut c = setup();
    assert_eq!(c.register_accounts(vec![acc(PLAYER), acc(SMOKE), acc(PLAYER)]), 2);
    assert_eq!(c.get_status().registered_accounts, 2);
}

// ------------------------------------------------------------------ pause + rotation

#[test]
fn pause_and_unpause() {
    let mut c = setup();
    c.pause(); // no deposit needed
    assert!(c.get_status().paused);
    ctx(&authority(), 1);
    c.unpause();
    assert!(!c.get_status().paused);
}

#[test]
#[should_panic(expected = "ERR_PAUSED")]
fn pause_blocks_transfers() {
    let mut c = setup();
    genesis(&mut c);
    c.pause();
    ctx(&acc(FISHER), 1);
    c.mt_transfer(acc(SMOKE), "fish".into(), U128(1), None, None);
}

#[test]
#[should_panic(expected = "ERR_PAUSED")]
fn pause_blocks_settle() {
    let mut c = setup();
    c.pause();
    genesis(&mut c);
}

#[test]
#[should_panic(expected = "ERR_PAUSED")]
fn pause_blocks_mint() {
    let mut c = setup();
    c.pause();
    c.mt_mint(acc(PLAYER), vec!["marks".into()], vec![U128(1)], None);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn unpause_needs_full_access_key() {
    let mut c = setup();
    c.pause();
    c.unpause(); // 0 deposit, as a function-call key would send
}

#[test]
#[should_panic(expected = "ERR_NOT_AUTHORITY")]
fn non_authority_cannot_pause() {
    let mut c = setup();
    ctx(&acc(PLAYER), 0);
    c.pause();
}

#[test]
fn authority_rotation_two_step() {
    let mut c = setup();
    let next = acc("authority2.testnet");
    ctx(&authority(), 1);
    c.propose_authority(Some(next.clone()));
    assert_eq!(c.get_status().authority, authority()); // not yet
    ctx(&next, 1);
    c.accept_authority();
    let s = c.get_status();
    assert_eq!((s.authority, s.pending_authority), (next.clone(), None));
    ctx(&next, 0);
    c.mt_mint(acc(PLAYER), vec!["marks".into()], vec![U128(1)], None);
}

#[test]
#[should_panic(expected = "ERR_NOT_AUTHORITY")]
fn old_authority_loses_power_after_rotation() {
    let mut c = setup();
    let next = acc("authority2.testnet");
    ctx(&authority(), 1);
    c.propose_authority(Some(next.clone()));
    ctx(&next, 1);
    c.accept_authority();
    ctx(&authority(), 0);
    c.mt_mint(acc(PLAYER), vec!["marks".into()], vec![U128(1)], None);
}

#[test]
#[should_panic(expected = "ERR_NOT_PENDING_AUTHORITY")]
fn stranger_cannot_accept_authority() {
    let mut c = setup();
    ctx(&authority(), 1);
    c.propose_authority(Some(acc("authority2.testnet")));
    ctx(&acc("mallory.testnet"), 1);
    c.accept_authority();
}

#[test]
fn add_token_without_redeploy() {
    let mut c = setup();
    ctx(&authority(), 1);
    c.add_token("rope".into(), "Rope".into(), "ROPE".into(), 0);
    assert_eq!(c.mt_supply("rope".into()), Some(U128(0)));
}

// ------------------------------------------------------------------ settlement: idempotency

#[test]
fn replaying_a_batch_changes_nothing() {
    let mut c = setup();
    genesis(&mut c);
    let b2 = batch(
        "6-12",
        vec![mint(FISHER, "fish", 2)],
        vec![xfer(FISHER, SMOKE, "fish", 5), xfer(SMOKE, FISHER, "marks", 900)],
        vec![],
    );
    let r = c.settle(b2.clone());
    assert!(r.applied && r.complete);
    let snapshot = |c: &Goods| {
        (
            bal(c, FISHER, "fish"),
            bal(c, SMOKE, "fish"),
            bal(c, FISHER, "marks"),
            bal(c, SMOKE, "marks"),
            c.mt_supply("fish".into()),
            c.settlement_cursor(),
        )
    };
    let before = snapshot(&c);
    let r2 = c.settle(b2.clone());
    assert!(!r2.applied);
    assert_eq!(snapshot(&c), before);
    // Even an older batch (the genesis one) is a no-op now.
    assert!(!c.settle(batch("0-6", vec![mint(PLAYER, "marks", 1)], vec![], vec![])).applied);
    assert_eq!(snapshot(&c), before);
    assert_eq!(c.settlement_cursor().batches_applied, 2);
    assert_eq!(c.settlement_cursor().last_batch_id.as_deref(), Some("6-12"));
}

#[test]
fn replay_with_different_content_is_still_a_noop() {
    let mut c = setup();
    genesis(&mut c);
    let r = c.settle(batch("0-6", vec![mint(PLAYER, "marks", 999_999)], vec![], vec![]));
    assert!(!r.applied);
    assert_eq!(bal(&c, PLAYER, "marks"), 30_000);
}

#[test]
#[should_panic(expected = "ERR_GAP: expected a batch starting at tick 6")]
fn gap_rejected() {
    let mut c = setup();
    genesis(&mut c);
    c.settle(batch("12-18", vec![], vec![], vec![]));
}

#[test]
#[should_panic(expected = "ERR_OVERLAP")]
fn overlap_rejected() {
    let mut c = setup();
    genesis(&mut c);
    c.settle(batch("3-9", vec![], vec![], vec![]));
}

#[test]
fn empty_batches_advance_the_cursor() {
    let mut c = setup();
    genesis(&mut c);
    assert!(c.settle(batch("6-12", vec![], vec![], vec![])).applied);
    assert_eq!(c.settlement_cursor().last_tick_to, Some(12));
}

#[test]
fn batch_id_parsing() {
    use crate::settle::parse_batch_id;
    assert_eq!(parse_batch_id("0-6"), Some((0, 6)));
    assert_eq!(parse_batch_id("120-126"), Some((120, 126)));
    for bad in ["06-12", "12-6", "6-6", "a-b", "6", "6-12-18", "-6-12", "6- 12", ""] {
        assert_eq!(parse_batch_id(bad), None, "{bad}");
    }
}

#[test]
#[should_panic(expected = "ERR_BAD_BATCH_ID")]
fn bad_batch_id_rejected() {
    let mut c = setup();
    c.settle(batch("06-12", vec![], vec![], vec![]));
}

// ------------------------------------------------------------------ settlement: parts

#[test]
fn multi_part_batch() {
    let mut c = setup();
    genesis(&mut c);
    let part = |p: u32, mints: Vec<MintOp>, burns: Vec<BurnOp>| SettlementBatch {
        batch_id: "6-12".into(),
        part: Some(p),
        parts: Some(2),
        mints,
        transfers: vec![],
        burns,
    };
    let r0 = c.settle(part(0, vec![mint(PLAYER, "salt", 3)], vec![]));
    assert!(r0.applied && !r0.complete);
    assert_eq!(c.settlement_cursor().last_tick_to, Some(6));
    // Replaying part 0 is a no-op.
    assert!(!c.settle(part(0, vec![mint(PLAYER, "salt", 3)], vec![])).applied);
    assert_eq!(bal(&c, PLAYER, "salt"), 3);
    let r1 = c.settle(part(1, vec![], vec![burn(PLAYER, "salt", 1)]));
    assert!(r1.applied && r1.complete);
    assert_eq!(bal(&c, PLAYER, "salt"), 2);
    assert_eq!(c.settlement_cursor().last_tick_to, Some(12));
    assert!(!c.settle(part(1, vec![], vec![burn(PLAYER, "salt", 1)])).applied);
}

#[test]
#[should_panic(expected = "ERR_PART_OUT_OF_ORDER")]
fn part_out_of_order_rejected() {
    let mut c = setup();
    genesis(&mut c);
    c.settle(SettlementBatch {
        batch_id: "6-12".into(),
        part: Some(1),
        parts: Some(2),
        mints: vec![],
        transfers: vec![],
        burns: vec![],
    });
}

#[test]
#[should_panic(expected = "ERR_BATCH_IN_PROGRESS")]
fn next_batch_waits_for_unfinished_parts() {
    let mut c = setup();
    genesis(&mut c);
    c.settle(SettlementBatch {
        batch_id: "6-12".into(),
        part: Some(0),
        parts: Some(2),
        mints: vec![],
        transfers: vec![],
        burns: vec![],
    });
    c.settle(batch("12-18", vec![], vec![], vec![]));
}

#[test]
fn cursor_reset_requires_pause_then_allows_a_fresh_start() {
    let mut c = setup();
    genesis(&mut c);
    c.pause();
    ctx(&authority(), 1);
    c.reset_settlement_cursor(Some(300));
    c.unpause();
    ctx(&authority(), 0);
    assert!(c.settle(batch("300-306", vec![], vec![], vec![])).applied);
}

// ------------------------------------------------------------------ settlement: ordering

#[test]
fn mints_then_transfers_then_burns() {
    // Credits arrive before debits: an account that starts at 0 can be minted to, pay onward, and have
    // the rest burned, all in one batch, without ever going negative.
    let mut c = setup();
    let b = batch(
        "0-6",
        vec![mint(PLAYER, "fish", 2)],        // gather: +2
        vec![xfer(PLAYER, SMOKE, "fish", 1)], // sell 1
        vec![burn(PLAYER, "fish", 1)],        // spoil 1
    );
    assert!(c.settle(b).applied);
    assert_eq!((bal(&c, PLAYER, "fish"), bal(&c, SMOKE, "fish")), (0, 1));
    assert_eq!(c.mt_supply("fish".into()), Some(U128(1)));

    let logs = get_logs();
    let kinds: Vec<String> = logs
        .iter()
        .map(|l| {
            serde_json::from_str::<Value>(l.strip_prefix("EVENT_JSON:").unwrap()).unwrap()["event"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    assert_eq!(kinds, vec!["mt_mint", "mt_transfer", "mt_burn", "settle"]);
}

#[test]
#[should_panic(expected = "ERR_INSUFFICIENT_BALANCE")]
fn a_debit_that_would_go_negative_fails_the_batch() {
    let mut c = setup();
    genesis(&mut c);
    c.settle(batch("6-12", vec![], vec![xfer(PLAYER, SMOKE, "marks", 30_001)], vec![]));
}

#[test]
fn settle_events_are_grouped() {
    let mut c = setup();
    genesis(&mut c);
    ctx(&authority(), 0); // fresh context: logs from genesis are dropped
    c.settle(batch(
        "6-12",
        vec![],
        vec![xfer(FISHER, SMOKE, "fish", 1), xfer(FISHER, SMOKE, "fish", 2), xfer(SMOKE, FISHER, "marks", 50)],
        vec![],
    ));
    let logs = get_logs();
    assert_eq!(logs.len(), 2);
    let ev: Value = serde_json::from_str(logs[0].strip_prefix("EVENT_JSON:").unwrap()).unwrap();
    let data = ev["data"].as_array().unwrap();
    assert_eq!(data.len(), 2, "two (from, to) pairs");
    assert_eq!(data[0]["token_ids"], serde_json::json!(["fish", "fish"]));
    assert_eq!(data[0]["authorized_id"], authority().as_str());
    assert_eq!(data[0]["memo"], "settle 6-12#0");
    let s: Value = serde_json::from_str(logs[1].strip_prefix("EVENT_JSON:").unwrap()).unwrap();
    assert_eq!(s["standard"], "saltmarket");
    assert_eq!(s["data"]["batch_id"], "6-12");
}

#[test]
#[should_panic(expected = "ERR_BATCH_TOO_LARGE: events need")]
fn oversized_events_fail_with_a_clear_error() {
    let mut c = setup();
    // 140 distinct 64-char owners: ~19 KiB of mt_mint log, over the 16 KiB receipt budget.
    let mints = (0..140).map(|i| mint(&format!("{:0>46}.authority.testnet", format!("p{i}")), "marks", 1)).collect();
    c.settle(batch("0-6", mints, vec![], vec![]));
}

#[test]
fn realistic_full_window_fits_in_one_part() {
    // ~25 accounts x 3 tokens = 75 net deltas, with realistic sub-account names.
    let mut c = setup();
    let names: Vec<String> = (0..25).map(|i| format!("p-{i:06}.saltmarket.testnet")).collect();
    let mints = names.iter().flat_map(|n| ["marks", "fish", "salt"].map(|t| mint(n, t, 1_000))).collect();
    let r = c.settle(batch("0-6", mints, vec![], vec![]));
    assert!(r.applied);
    let total: usize = get_logs().iter().map(String::len).sum();
    assert!(total < crate::settle::MAX_TOTAL_LOG_BYTES, "{total}");
}

// ------------------------------------------------------------------ conservation property

/// Seeded random batches (LCG, no deps). After every batch, for every token:
/// sum of balances == mt_supply == minted - burned.
#[test]
fn conservation_holds_over_random_batches() {
    let mut c = setup();
    let accounts: Vec<String> = (0..8).map(|i| format!("a{i}.authority.testnet")).collect();
    let tokens = ["marks", "fish", "salt", "timber", "barrel", "cured_fish", "hall_license"];
    let mut seed: u64 = 42;
    let mut rnd = |n: u64| {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (seed >> 33) % n
    };
    // Mirror of expected balances, to also check each individual balance.
    let mut mirror = std::collections::HashMap::<(String, String), u128>::new();
    for b in 0..200u64 {
        let mut mints = vec![];
        let mut transfers = vec![];
        let mut burns = vec![];
        let mut m = mirror.clone();
        for _ in 0..(1 + rnd(12)) {
            let a = accounts[rnd(8) as usize].clone();
            let t = tokens[rnd(7) as usize].to_string();
            match rnd(3) {
                0 => {
                    let n = 1 + rnd(1000) as u128;
                    mints.push(mint(&a, &t, n));
                    *m.entry((a, t)).or_default() += n;
                }
                1 => {
                    let r = accounts[rnd(8) as usize].clone();
                    let have = *m.get(&(a.clone(), t.clone())).unwrap_or(&0);
                    if r != a && have > 0 {
                        let n = 1 + rnd(have as u64) as u128;
                        transfers.push(xfer(&a, &r, &t, n));
                        *m.get_mut(&(a, t.clone())).unwrap() -= n;
                        *m.entry((r, t)).or_default() += n;
                    }
                }
                _ => {
                    let have = *m.get(&(a.clone(), t.clone())).unwrap_or(&0);
                    if have > 0 {
                        let n = 1 + rnd(have as u64) as u128;
                        burns.push(burn(&a, &t, n));
                        *m.get_mut(&(a, t)).unwrap() -= n;
                    }
                }
            }
        }
        // The mirror applied ops in generation order; the contract applies mints, transfers, burns.
        // Generation order never goes negative, so the contract's order (credits earlier) cannot either.
        mirror = m;
        let id = format!("{}-{}", b * 6, b * 6 + 6);
        ctx(&authority(), 0); // one transaction per batch (own log budget)
        assert!(c.settle(batch(&id, mints, transfers, burns)).applied);
        if b % 3 == 0 {
            assert!(!c.settle(batch(&id, vec![], vec![], vec![])).applied, "replay must be a no-op");
        }
        for t in tokens {
            let sum: u128 = accounts.iter().map(|a| bal(&c, a, t)).sum();
            let st = c.token_stats(t.into()).unwrap();
            assert_eq!(sum, st.supply.0, "batch {b} token {t}: sum of balances != supply");
            assert_eq!(st.supply.0, st.minted.0 - st.burned.0, "batch {b} token {t}");
        }
    }
    for ((a, t), v) in &mirror {
        assert_eq!(bal(&c, a, t), *v, "{a} {t}");
    }
}
