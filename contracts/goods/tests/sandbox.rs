//! Integration tests on a local NEAR sandbox node (near-sandbox + near-api, the framework the
//! `cargo near new` template and the NEAR agent skill recommend; docs/NEAR_INTEGRATION.md §10).
//! These exercise what unit tests cannot: real deploy + `#[private]` init, 1-yocto enforcement,
//! storage paid by the contract, atomic revert of a failed batch, real gas numbers.
//!
//! Run: `cargo test --test sandbox -- --nocapture` (downloads the sandbox binary on first run).

use std::sync::Arc;

use near_api::{AccountId, Contract, NearGas, NearToken, NetworkConfig, Signer};
use near_sdk::serde_json::{Value, json};

const TGAS_300: u64 = 300;

struct Env {
    _sandbox: near_sandbox::Sandbox,
    net: NetworkConfig,
    signer: Arc<Signer>,
    contract: Contract,
    authority: AccountId,
}

async fn create(sandbox: &near_sandbox::Sandbox, name: &str) -> testresult::TestResult<AccountId> {
    let id: AccountId = name.parse()?;
    sandbox.create_account(id.clone()).initial_balance(NearToken::from_near(20)).send().await?;
    Ok(id)
}

impl Env {
    /// Calls `method` as `who` with `yocto` attached. Returns Ok(logs, gas, return json) or Err(error text).
    async fn call(
        &self,
        who: &AccountId,
        method: &str,
        args: Value,
        yocto: u128,
    ) -> Result<(Vec<String>, NearGas, Value), String> {
        let r = self
            .contract
            .call_function(method, args)
            .transaction()
            .deposit(NearToken::from_yoctonear(yocto))
            .gas(NearGas::from_tgas(TGAS_300))
            .with_signer(who.clone(), self.signer.clone())
            .send_to(&self.net)
            .await
            .map_err(|e| format!("send error: {e:?}"))?;
        match r.into_result() {
            Ok(ok) => {
                let logs = ok.logs().into_iter().map(String::from).collect();
                let gas = ok.total_gas_burnt;
                let v = ok.json::<Value>().unwrap_or(Value::Null);
                Ok((logs, gas, v))
            }
            Err(e) => Err(format!("{e:?}")),
        }
    }

    async fn ok(&self, who: &AccountId, method: &str, args: Value, yocto: u128) -> (Vec<String>, NearGas, Value) {
        self.call(who, method, args, yocto).await.unwrap_or_else(|e| panic!("{method} failed: {e}"))
    }

    async fn fails(&self, who: &AccountId, method: &str, args: Value, yocto: u128, expect: &str) {
        match self.call(who, method, args, yocto).await {
            Ok(_) => panic!("{method} should have failed with {expect}"),
            Err(e) => assert!(e.contains(expect), "{method}: expected {expect:?}, got {e}"),
        }
    }

    async fn view(&self, method: &str, args: Value) -> Value {
        self.contract.call_function(method, args).read_only().fetch_from(&self.net).await.unwrap().data
    }

    async fn bal(&self, a: &AccountId, t: &str) -> u128 {
        self.view("mt_balance_of", json!({"account_id": a, "token_id": t})).await.as_str().unwrap().parse().unwrap()
    }

    async fn settle(&self, b: Value) -> Result<(Vec<String>, NearGas, Value), String> {
        self.call(&self.authority, "settle", json!({ "batch": b }), 0).await
    }
}

fn u(v: &Value) -> u128 {
    v.as_str().unwrap().parse().unwrap()
}

const TOKENS: [&str; 7] = ["marks", "fish", "salt", "timber", "barrel", "cured_fish", "hall_license"];

#[tokio::test]
async fn goods_contract_on_sandbox() -> testresult::TestResult<()> {
    let wasm = std::fs::read(cargo_near_build::build_with_cli(Default::default())?)?;
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let signer = Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?)?;

    let authority = create(&sandbox, "authority.sandbox").await?;
    let goods = create(&sandbox, "goods.sandbox").await?;
    let alice = create(&sandbox, "alice.sandbox").await?;
    let bob = create(&sandbox, "bob.sandbox").await?;
    let mallory = create(&sandbox, "mallory.sandbox").await?;
    let carol: AccountId = "carol.sandbox".parse()?; // never created onchain: balances don't need it
    let long: AccountId = format!("{}.sandbox", "p".repeat(56)).parse()?; // 64 chars, the max

    // ---- deploy without init, then prove init is #[private]
    Contract::deploy(goods.clone())
        .use_code(wasm)
        .without_init_call()
        .with_signer(signer.clone())
        .send_to(&net)
        .await?
        .assert_success();
    let env = Env { _sandbox: sandbox, net, signer, contract: Contract(goods.clone()), authority: authority.clone() };
    env.fails(&mallory, "new", json!({"authority": mallory}), 0, "is private").await;
    env.ok(&goods, "new", json!({"authority": authority}), 0).await;
    let status = env.view("get_status", json!({})).await;
    assert_eq!(status["authority"], authority.as_str());
    assert_eq!(status["token_ids"], json!(TOKENS));
    println!("[deploy] ok, private init enforced");

    // ---- genesis mint through settle
    let (logs, gas, res) = env
        .settle(json!({"batch_id": "0-6", "mints": [
            {"account_id": alice, "token_id": "marks", "amount": "30000"},
            {"account_id": alice, "token_id": "fish", "amount": "10"},
            {"account_id": bob, "token_id": "marks", "amount": "20000"},
            {"account_id": bob, "token_id": "hall_license", "amount": "1"},
        ]}))
        .await?;
    assert_eq!(res["applied"], true);
    assert_eq!(res["complete"], true);
    assert!(
        logs[0].starts_with(r#"EVENT_JSON:{"standard":"nep245","version":"1.0.0","event":"mt_mint""#),
        "{}",
        logs[0]
    );
    assert_eq!(env.bal(&alice, "marks").await, 30_000);
    assert_eq!(u(&env.view("mt_supply", json!({"token_id": "marks"})).await), 50_000);
    println!("[genesis] 4 mints, gas burnt {} Tgas", gas.as_tgas());

    // ---- storage: the contract pays; one max-length account with all 7 tokens fits the fixed fee
    let before = env.view("storage_report", json!({})).await;
    let mints: Vec<Value> = TOKENS.iter().map(|t| json!({"account_id": long, "token_id": t, "amount": "5"})).collect();
    env.settle(json!({"batch_id": "6-12", "mints": mints})).await?;
    let after = env.view("storage_report", json!({})).await;
    let used = after["storage_usage_bytes"].as_u64().unwrap() - before["storage_usage_bytes"].as_u64().unwrap();
    let budget = after["bytes_per_account"].as_u64().unwrap();
    println!("[storage] 64-char account with 7 balances: {used} bytes (budget {budget})");
    assert!(used <= budget, "per-account storage {used} > budget {budget}");
    let min = u(&env.view("storage_balance_bounds", json!({})).await["min"]);
    println!(
        "[storage] registration fee {min} yocto; contract can still pay for ~{} accounts",
        after["accounts_affordable"]
    );

    // ---- non-authority is rejected
    for (m, a) in [
        (
            "settle",
            json!({"batch": {"batch_id": "12-18", "mints": [{"account_id": mallory, "token_id": "marks", "amount": "999"}]}}),
        ),
        ("mt_mint", json!({"owner_id": mallory, "token_ids": ["marks"], "amounts": ["999"]})),
        ("mt_burn", json!({"owner_id": alice, "token_ids": ["marks"], "amounts": ["1"]})),
        ("pause", json!({})),
        ("register_accounts", json!({"account_ids": [mallory]})),
    ] {
        env.fails(&mallory, m, a, 0, "ERR_NOT_AUTHORITY").await;
    }
    println!("[auth] non-authority settle/mint/burn/pause/register rejected");

    // ---- standard transfers
    let t = |to: &AccountId, n: &str| json!({"receiver_id": to, "token_id": "fish", "amount": n});
    env.fails(&alice, "mt_transfer", t(&bob, "3"), 0, "exactly 1 yoctoNEAR").await;
    let (logs, ..) = env.ok(&alice, "mt_transfer", t(&bob, "3"), 1).await;
    assert!(logs[0].contains(r#""event":"mt_transfer""#));
    env.fails(&alice, "mt_transfer", t(&mallory, "1"), 1, "ERR_RECEIVER_NOT_REGISTERED").await;
    env.fails(&mallory, "storage_deposit", json!({}), min - 1, "ERR_DEPOSIT_TOO_SMALL").await;
    env.ok(&mallory, "storage_deposit", json!({}), min).await;
    env.ok(&alice, "mt_transfer", t(&mallory, "1"), 1).await;
    env.ok(
        &alice,
        "mt_batch_transfer",
        json!({"receiver_id": bob, "token_ids": ["fish", "marks"], "amounts": ["2", "500"]}),
        1,
    )
    .await;
    env.fails(
        &alice,
        "mt_batch_transfer",
        json!({"receiver_id": bob, "token_ids": ["fish", "marks"], "amounts": ["2"]}),
        1,
        "ERR_LENGTH_MISMATCH",
    )
    .await;
    assert_eq!(
        (env.bal(&alice, "fish").await, env.bal(&bob, "fish").await, env.bal(&mallory, "fish").await),
        (4, 5, 1)
    );
    let bb = env.view("mt_batch_balance_of", json!({"account_id": bob, "token_ids": ["fish", "marks"]})).await;
    assert_eq!(bb, json!(["5", "20500"]));
    println!("[transfer] mt_transfer / mt_batch_transfer / 1 yocto / registration ok");

    // ---- idempotency: replaying a batch id changes nothing
    let b3 = json!({"batch_id": "12-18",
        "mints": [{"account_id": carol, "token_id": "salt", "amount": "4"}],
        "transfers": [{"sender_id": bob, "receiver_id": alice, "token_id": "marks", "amount": "100"}],
        "burns": [{"account_id": carol, "token_id": "salt", "amount": "1"}]});
    let (_, gas3, r1) = env.settle(b3.clone()).await?;
    assert_eq!(r1["applied"], true);
    let snap = (env.bal(&alice, "marks").await, env.bal(&bob, "marks").await, env.bal(&carol, "salt").await);
    let (logs, _, r2) = env.settle(b3.clone()).await?;
    assert_eq!(r2["applied"], false);
    assert!(logs.is_empty(), "a replay emits no events");
    assert_eq!(snap, (env.bal(&alice, "marks").await, env.bal(&bob, "marks").await, env.bal(&carol, "salt").await));
    assert_eq!(snap, (30_000 - 500 + 100, 20_500 - 100, 3));
    println!(
        "[idempotency] replay of 12-18 -> applied=false, balances unchanged (first apply {} Tgas)",
        gas3.as_tgas()
    );

    // ---- a failing batch reverts atomically (its mint does not stick) and the cursor does not move
    let bad = json!({"batch_id": "18-24",
        "mints": [{"account_id": carol, "token_id": "fish", "amount": "5"}],
        "transfers": [{"sender_id": bob, "receiver_id": alice, "token_id": "marks", "amount": "1000000000"}]});
    let e = env.settle(bad).await.unwrap_err();
    assert!(e.contains("ERR_INSUFFICIENT_BALANCE"), "{e}");
    assert_eq!(env.bal(&carol, "fish").await, 0);
    assert_eq!(env.view("settlement_cursor", json!({})).await["last_tick_to"], 18);
    let e = env.settle(json!({"batch_id": "24-30"})).await.unwrap_err();
    assert!(e.contains("ERR_GAP"), "{e}");
    println!("[atomic] failed batch reverted, gap rejected");

    // ---- pause
    env.ok(&authority, "pause", json!({}), 0).await; // no deposit: works with a function-call key
    env.fails(&alice, "mt_transfer", t(&bob, "1"), 1, "ERR_PAUSED").await;
    let e = env.settle(json!({"batch_id": "18-24"})).await.unwrap_err();
    assert!(e.contains("ERR_PAUSED"), "{e}");
    env.fails(&authority, "unpause", json!({}), 0, "exactly 1 yoctoNEAR").await;
    env.ok(&authority, "unpause", json!({}), 1).await;
    env.ok(&alice, "mt_transfer", t(&bob, "1"), 1).await;
    println!("[pause] pause blocks transfers and settle; unpause needs 1 yocto");

    // ---- realistic settlement window: 25 accounts, 75 ops, mixed kinds
    let names: Vec<String> = (0..25).map(|i| format!("p-{i:06}.saltmarket.sandbox")).collect();
    let mut mints = vec![];
    let mut transfers = vec![];
    let mut burns = vec![];
    for (i, n) in names.iter().enumerate() {
        mints.push(json!({"account_id": n, "token_id": "marks", "amount": "10000"}));
        transfers
            .push(json!({"sender_id": n, "receiver_id": names[(i + 1) % 25], "token_id": "marks", "amount": "2500"}));
        burns.push(json!({"account_id": n, "token_id": "marks", "amount": "100"}));
    }
    let (logs, gas, _) =
        env.settle(json!({"batch_id": "18-24", "mints": mints, "transfers": transfers, "burns": burns})).await?;
    let log_bytes: usize = logs.iter().map(String::len).sum();
    println!(
        "[limits] 75-op batch: gas burnt {} Tgas, {} logs, {} log bytes (max 16384)",
        gas.as_tgas(),
        logs.len(),
        log_bytes
    );
    assert!(gas.as_tgas() < 150, "75-op batch used {} Tgas", gas.as_tgas());

    // ---- authority rotation (two steps)
    env.ok(&authority, "propose_authority", json!({"new_authority": bob}), 1).await;
    env.fails(&mallory, "accept_authority", json!({}), 1, "ERR_NOT_PENDING_AUTHORITY").await;
    env.ok(&bob, "accept_authority", json!({}), 1).await;
    env.fails(&authority, "settle", json!({"batch": {"batch_id": "24-30"}}), 0, "ERR_NOT_AUTHORITY").await;
    env.ok(&bob, "settle", json!({"batch": {"batch_id": "24-30"}}), 0).await;
    assert_eq!(env.view("get_status", json!({})).await["authority"], bob.as_str());
    println!("[rotation] authority -> bob; old authority rejected");

    // ---- conservation: per token, sum of balances == supply == minted - burned
    let mut holders: Vec<String> =
        vec![alice.to_string(), bob.to_string(), mallory.to_string(), carol.to_string(), long.to_string()];
    holders.extend(names);
    for tkn in TOKENS {
        let mut sum = 0u128;
        for h in &holders {
            sum += env.bal(&h.parse()?, tkn).await;
        }
        let st = env.view("token_stats", json!({"token_id": tkn})).await;
        assert_eq!(sum, u(&st["supply"]), "{tkn}: sum of balances != supply");
        assert_eq!(u(&st["supply"]), u(&st["minted"]) - u(&st["burned"]), "{tkn}");
    }
    println!("[conservation] sum(balances) == supply == minted - burned for all 7 tokens");
    Ok(())
}
