# contracts/goods: Saltmarket NEP-245 multi-token

One contract holds every game asset as a NEP-245 token id: `marks` (currency, amounts in **pips**; 1 mark = 100 pips, so `decimals = 2`), `fish`, `salt`, `timber`, `barrel`, `cured_fish`, `hall_license`. These ids match `TokenId` in `packages/chain` and `GOODS` in `packages/shared/src/config/economy.ts`.

The game runs off-chain. This contract is the ledger: the server settles net balance changes in idempotent batches every few ticks, and anyone can verify balances and NEP-245 events on testnet.

## Build and test

```bash
cd contracts/goods
cargo near build non-reproducible-wasm     # -> target/near/goods.wasm (+ goods_abi.json)
cargo test --lib                           # 44 unit tests (near-sdk mock), ~3 s
cargo test --test sandbox -- --nocapture   # 1 end-to-end scenario on a local sandbox node, ~45 s
```

The first sandbox run downloads the `near-sandbox` node binary (~71 MB) from S3, which can be slow or stall. To reuse a binary you already have, set `NEAR_SANDBOX_BIN_PATH` to its path. From the repo root, `pnpm contracts:build` and `pnpm contracts:test` run the same commands.

Toolchain: Rust 1.93.0 (pinned in `rust-toolchain.toml` by `cargo near new`), cargo-near 0.22.0, near-sdk 5.29.1. Tests use **near-sandbox + near-api**, the framework the current `cargo near new` template and the NEAR agent skill recommend. Sources are in `docs/NEAR_INTEGRATION.md` §10.

## Roles

| Role | Who | Can |
| --- | --- | --- |
| authority | the game server account | `settle`, `mt_mint`, `mt_burn`, `register_accounts`, `pause` (**no deposit**, so a function-call key scoped to this contract is enough); `unpause`, `propose_authority`, `add_token`, `reset_settlement_cursor` (**exactly 1 yoctoNEAR**, which needs a full-access key) |
| pending authority | named by `propose_authority` | `accept_authority` (1 yocto) |
| token holder | any account | `mt_transfer`, `mt_batch_transfer` (1 yocto, as NEP-245 requires) |
| anyone | | views; `storage_deposit` (pays for a registration) |

Why the split: the server signs settlements with a **function-call key** that can only call this contract and cannot attach deposits. If that key leaks, an attacker can settle or pause, but cannot unpause, rotate the authority, or move NEAR out of the account.

> **Custody, stated plainly:** the authority can move any balance through `settle` and `mt_burn`. Player and NPC accounts are custodial ledger entries the server operates. That's the MVP model in `docs/NEAR_INTEGRATION.md` §4.2 A and §5.2, and it should be disclosed in the top-level README.

## Public methods

**NEP-245 core** (signatures from the spec, verified 2026-11-09)

| Method | Kind | Notes |
| --- | --- | --- |
| `mt_transfer(receiver_id, token_id, amount, approval?, memo?)` | change, 1 yocto | receiver must be registered; `approval` must be null |
| `mt_batch_transfer(receiver_id, token_ids, amounts, approvals?, memo?)` | change, 1 yocto | panics on length mismatch; ≤ 100 items |
| `mt_balance_of(account_id, token_id) -> U128` | view | |
| `mt_batch_balance_of(account_id, token_ids) -> U128[]` | view | |
| `mt_supply(token_id) -> U128?`, `mt_batch_supply(token_ids)` | view | null for unknown ids |
| `mt_token(token_ids) -> Token?[]` | view | `owner_id` is always null (fungible-style tokens) |

**NEP-245 metadata and enumeration extensions:** `mt_metadata_contract()` (`spec: "mt-1.0.0"`), `mt_metadata_base_by_token_id`, `mt_metadata_token_by_token_id`, `mt_metadata_token_all`, `mt_tokens(from_index?, limit?)`.

**NEP-145 storage (subset):** `storage_deposit(account_id?, registration_only?)` (payable), `storage_balance_of(account_id)`, `storage_balance_bounds()` (min = max = 0.0125 NEAR).

**Game**

| Method | Kind | Notes |
| --- | --- | --- |
| `new(authority)` | init, `#[private]` | callable only by the contract account itself, in the deploy transaction |
| `settle(batch) -> SettleResult` | authority | see "Settlement" below |
| `mt_mint(owner_id, token_ids, amounts, memo?)` / `mt_burn(...)` | authority | for genesis and manual fixes. Normal play goes through `settle`, which is idempotent. These two are not. |
| `register_accounts(account_ids) -> u32` | authority | contract pays; returns how many were new |
| `pause()` / `unpause()` | authority | pause blocks transfers, mint, burn, and settle; views keep working |
| `propose_authority(new_authority?)` / `accept_authority()` | authority / pending | two steps, so a typo can't lock the contract |
| `add_token(token_id, name, symbol, decimals)` | authority, 1 yocto | a new good without a redeploy |
| `reset_settlement_cursor(last_tick_to?)` | authority, 1 yocto, **paused only** | recovery after a server-side ledger reset |
| `get_status()`, `settlement_cursor()`, `token_stats(token_id)`, `is_registered(account_id)`, `storage_report()` | view | `token_stats` returns `supply`, `minted`, `burned`; `storage_report` is for the Ledger drawer and balance monitoring |

All amounts are u128 as decimal strings (`"12500"`). Errors are `ERR_*` codes in the panic message.

## Settlement

```jsonc
// settle({ "batch": ... })
{
  "batch_id": "120-126",          // "{tickFrom}-{tickTo}", same as the server's SettlementBatch.batchId
  "part": 0, "parts": 1,          // optional; for windows too big for one transaction
  "mints":     [{ "account_id": "p-abc.<authority>.testnet", "token_id": "fish",  "amount": "2" }],
  "transfers": [{ "sender_id": "...", "receiver_id": "...", "token_id": "marks", "amount": "1450" }],
  "burns":     [{ "account_id": "...", "token_id": "cured_fish", "amount": "1" }]
}
// -> { "batch_id": "120-126", "part": 0, "applied": true, "complete": true, "last_tick_to": 126 }
```

Rules:

1. **Idempotent.** If `tickTo` ≤ the cursor, or the part was already applied, the call returns `applied: false` and changes nothing (no events). A retry after a lost RPC response is always safe. The tests replay with different content to prove the stored cursor decides, not the payload.
2. **Contiguous.** A new batch must start at the cursor (`tickFrom == last_tick_to`; the first batch may start anywhere). The server sends *net deltas*, so a skipped window would silently corrupt balances. `ERR_GAP` is retryable: the server delivers the missing batch first and then retries this one. Overlaps fail with `ERR_OVERLAP`.
3. **Order: mints, then transfers, then burns.** Every debit is checked. If any op would make a balance negative, the whole call reverts (`ERR_INSUFFICIENT_BALANCE`) and the cursor doesn't move. The sandbox test shows a failed batch's mint does not stick.
4. **Parts.** `parts > 1` splits one window across transactions with the same `batch_id`. Part *k* applies only after part *k−1*; the cursor moves when the last part lands; no other batch can start in between (`ERR_BATCH_IN_PROGRESS`).
5. **Events.** Each settle emits at most four logs: one grouped `mt_mint`, one `mt_transfer`, and one `mt_burn` (NEP-245, memo `"settle <batchId>#<part>"`, `authorized_id` = authority), plus `{"standard":"saltmarket","event":"settle"}` with op counts.

### Limits (measured)

| | Value | Source |
| --- | --- | --- |
| Gas per tx | 1 PGas max | live testnet protocol config |
| Logs per receipt | 100 lines, **16 KiB total** | live testnet protocol config (enforced by the near-sdk mock too) |
| Realistic window: 25 accounts, 75 ops (25 mints, 25 transfers, 25 burns) | **17 Tgas**, 4 logs, **11.5 KiB** | sandbox test |
| Ops per part | ≤ 150 (`MAX_OPS_PER_PART`) | contract |
| Max-length (64-char) account holding all 7 tokens | 1,060 bytes; fee covers 1,250 | sandbox test |

**The log budget is the real limit, not gas.** About 100 ops per part with realistic account names. If the events would exceed 16 KiB, `settle` fails up front with `ERR_BATCH_TOO_LARGE: events need N bytes…` and the server splits the window into parts.

## Storage: why players never see a deposit

The contract account pays for all storage from its own NEAR balance, and the authority keeps it funded (`storage_report().accounts_affordable` shows the headroom; 20 NEAR covers about 1,400 accounts). `settle` and `mt_mint` register recipients automatically. Players never sign anything, so they never attach anything.

To stop anyone from making the contract pay for junk accounts, a direct `mt_transfer` only goes to a **registered** account. Accounts get registered by settlement, by `register_accounts`, or by someone paying `storage_deposit`.

## Not implemented (on purpose; disclose)

- `mt_transfer_call` / `mt_batch_transfer_call` / `mt_resolve_transfer`: no receiving contracts exist in the game.
- Approvals (NEP-245 approval extension): a non-null `approval` is rejected.
- `mt_tokens_for_owner`, `mt_metadata_base_by_metadata_id`.
- NEP-145 `storage_withdraw` / `storage_unregister`: registration is permanent; the fee is fixed and not refundable.

## Deploy to testnet (NOT done; waiting for the human's go-ahead)

Commands were checked against local `--help` for near-cli-rs 0.30.1 and cargo-near 0.22.0. Replace `$AUTHORITY` with the account **you** create; no account name is chosen here. Keys go into the OS keychain (`save-to-keychain` / `sign-with-keychain`), never into git, `.env`, or chat.

```bash
export AUTHORITY=<your-name>.testnet         # you choose it

# (a) authority account, funded by the testnet faucet service
near account create-account sponsor-by-faucet-service "$AUTHORITY" \
  autogenerate-new-keypair save-to-keychain network-config testnet create

# contract sub-account, funded by the authority. It pays all storage: the ~240 KB wasm locks ~2.4 NEAR,
# leaving room for ~200 accounts at 0.0125 NEAR each. Top up later with a plain transfer.
near account create-account fund-myself "goods.$AUTHORITY" '5 NEAR' \
  autogenerate-new-keypair save-to-keychain sign-as "$AUTHORITY" \
  network-config testnet sign-with-keychain send

# (b) build, deploy, and initialise in one transaction (init is #[private])
cd contracts/goods
cargo near deploy build-non-reproducible-wasm "goods.$AUTHORITY" \
  with-init-call new json-args "{\"authority\":\"$AUTHORITY\"}" \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-keychain send

# server key: function-call only, scoped to the contract's authority methods, 1 NEAR gas allowance
near account add-key "$AUTHORITY" grant-function-call-access \
  --allowance '1 NEAR' --contract-account-id "goods.$AUTHORITY" \
  --function-names settle,pause,register_accounts,mt_mint,mt_burn \
  autogenerate-new-keypair save-to-keychain network-config testnet sign-with-keychain send

# smoke check (read-only)
near contract call-function as-read-only "goods.$AUTHORITY" get_status json-args '{}' network-config testnet now
```

The server then needs, in its local `.env` only: `NEAR_NETWORK=testnet`, `NEAR_CONTRACT_ID=goods.$AUTHORITY`, `NEAR_AUTHORITY_ID=$AUTHORITY`, and the function-call key (exact env var names are the backend's call; see `REQUESTS.md`).

## Decisions (2026-11-09)

1. **Topology:** the contract is on `goods.samuelowen.testnet`; the authority is `samuelowen.testnet` (the account already exists).
2. **Contract account keys:** keep the full-access key on `goods.samuelowen.testnet` until Nov 14 so fixes can be redeployed, then decide whether to delete it.
3. **`repository` in Cargo.toml:** left as a TODO, to be filled in later.
4. **Fresh world = fresh contract.** If `data/world.json` is deleted, ticks restart at 0. Every batch then counts as a replay or fails (`ERR_OVERLAP`) against the old cursor. For a fresh world, deploy a new contract account (e.g. `goods2.samuelowen.testnet`) or pause, `reset_settlement_cursor`, and accept that old balances stay on chain.

## Deployments

| Network | Contract | Authority | Code sha256 | Deploy + init tx | Date |
| --- | --- | --- | --- | --- | --- |
| testnet | `goods.samuelowen.testnet` | `samuelowen.testnet` | `078100cd61dc9092f9d89bbcd2c7b11bc0218cbbeb00e0b6c0dbfc192ea47546` (commit 135a512) | `4UiHUPwVMqXAKtvSnXkZBNhtKC7z7pdtSQfz1AtRQxbT` | 2026-11-09 |

Account created in tx `FuVr65dQSy1mzWzZqHiu1n7w6862QRzta4xgQy95EWga` with 5 NEAR. After init, `storage_report` showed 2.41 NEAR locked by code and about 207 accounts affordable.

**Don't run test settlements against this contract.** The first `settle` sets the cursor, and the server's real first batch (`0-6`) would then be ignored as a replay. Use the sandbox tests for experiments. If a stray batch does land: `pause`, then `reset_settlement_cursor` (1 yocto), then `unpause`.

**Server signing key (testnet):** function-call key `ed25519:FAxxdMen8hfmhwYApHnSsdcDQHJYgKPTkgdMGYmuwVA9` on `samuelowen.testnet`. It can call only `goods.samuelowen.testnet` methods `settle, pause, register_accounts, mt_mint, mt_burn`, with a 1 NEAR gas allowance. Added in tx `88Qpa6bcvisdGVRXtJnZu6jFWUpnZBBvJrEzwEsQ6T4z`. The secret is only in the local legacy keychain file `~/.near-credentials/testnet/samuelowen.testnet/ed25519_FAxx….json`, outside the repo. For the server's local `.env` (values per REQUESTS.md C7):

```
NEAR_NETWORK=testnet
NEAR_RPC_URL=https://test.rpc.fastnear.com
NEAR_CONTRACT_ID=goods.samuelowen.testnet
NEAR_AUTHORITY_ID=samuelowen.testnet
NEAR_CREDENTIALS_FILE=/Users/mac/.near-credentials/testnet/samuelowen.testnet/ed25519_FAxxdMen8hfmhwYApHnSsdcDQHJYgKPTkgdMGYmuwVA9.json
```

**Key rotation (2026-11-11):** the first server key (`FAxxdMen…`, 1 NEAR allowance) ran low after about 1,000 batches. It was replaced by function-call key `ed25519:AoVsZZsb2djyKQXwHDwif3HpbmV4N1EUMFVJG3Yam15d` (15 NEAR allowance, same contract and methods; added in tx `2XisxQLvk3ZY3RXXtx6zjYjixuEVZHDouYz3Y9ELPqoZ`), and the old key was deleted in tx `C2YpimnnZfX31PwFfEkjZhjtVqq75xk1avnq1PJymjLT`. The server reads the new key through `NEAR_AUTHORITY_KEY_FILE`. A key's allowance can't be raised, so when it runs low, add a new key the same way and switch the file path. Run `dev:chain` only from the backend worktree whose `data/world.json` matches the contract's cursor.
