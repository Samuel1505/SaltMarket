# NEAR_INTEGRATION.md — Saltmarket

How Saltmarket uses NEAR, kept deliberately **invisible** to players. This document describes the *intended* design and lists what must be **verified in official docs before implementation**. Do not treat any method name, package version, or address here as confirmed until it appears in the "Verified facts" table (§10).

---

## 0. Ground rules

1. **Verify first.** Before implementing each section, read the current official docs (https://docs.near.org/) and record the verified facts in §10 with links and dates. Names below (e.g., `mt_batch_transfer`) are from the standards as we understand them and must be confirmed.
2. **Testnet by default.** All development uses NEAR testnet. Mainnet is only for the human-supplied prize payout account, and any mainnet signing requires explicit human confirmation (see `CLAUDE.md` §3).
3. **Never invent accounts, contract IDs, or keys.** The human supplies the authority account. You may propose names for sub-accounts under it (e.g., `fisher-1.<authority>`), but creating accounts on a network requires the human's approval and key setup.
4. **The game never waits on the chain.** If NEAR is slow or down, the game runs on `MemoryLedger` and the settlement queue catches up later.
5. **No keys in the repo.** Env vars only.

### Organizers' starting points (read first, then record findings in §10)

- NEP-245 multi token standard: https://github.com/near/NEPs/blob/master/neps/nep-0245.md
- near-dapp agent skill: https://github.com/near/agent-skills/tree/main/skills/near-dapp (guidance for building NEAR dapps; read it before writing contract or client integration code)
- What are intents: https://docs.near-intents.org/getting-started/what-are-intents

## 1. What goes onchain vs. off-chain

| Concern | Where | Why |
| --- | --- | --- |
| Matching, pricing, NPC decisions, ticks | Off-chain (sim) | Speed, determinism, cost |
| Balances of marks and goods | Onchain (NEP-245 contract), settled in batches | Real ownership; verifiable |
| Hall licenses (ownership of a venue) | Onchain (token id `hall_license`) | Player-owned markets |
| Account identity for players | Onchain account created behind social login | "Players own things" without crypto UX |
| NPC wallets | Onchain sub-accounts | "NPCs with wallets" |
| Fees and tax flows | Settled as transfers to Hall owner / Town Fund accounts | Visible fee income |
| Event feed, price history | Off-chain (server memory + JSON snapshot) | Not needed onchain |

Be honest about this split in the README: **off-chain matching with onchain settlement and ownership**, batched.

## 2. Contract: `goods` (NEP-245 multi-token)

One Rust contract (`contracts/goods`) implementing the multi-token standard (NEP-245), holding all game assets as token ids:

| Token id | Meaning |
| --- | --- |
| `marks` | Currency (pips as the smallest unit) |
| `fish`, `salt`, `timber`, `barrel`, `cured_fish` | Goods |
| `hall_license` | Venue right (supply controlled by the authority; one per Hall) |

### 2.1 Required functionality
- **Standard NEP-245 methods** for transfer, batch transfer, balance queries, and token metadata (verify exact names and signatures in the standard and in `near-sdk-rs` docs).
- **Authority-controlled mint and burn** for the game server account (`mint(account, token_id, amount)`, `burn(account, token_id, amount)`): needed for genesis, production, captain payments, spoilage, and sinks. Restricted to an `authority` account set at init.
- **Batch settlement helper (optional):** a single method that applies many net deltas atomically (`settle(batch)`) to reduce transaction count. If the standard `mt_batch_transfer` plus mint/burn is sufficient, skip this.
- **Owner/authority rotation** and a pause switch (for demo safety).
- **Storage:** handle storage deposits properly (verify the registration/storage-management pattern for the multi-token standard and for `near-sdk-rs`). Pre-pay storage from the authority/relayer for player and NPC accounts so players never see a deposit prompt.

### 2.2 Non-goals
- No marketplace logic in the contract. No AMM. No governance. No tokenomics beyond the above.

### 2.3 Tests
- `near-workspaces` (or the current recommended framework; verify) tests: genesis mint, batch transfer, authority-only mint/burn, rejection of non-authority mint, balance queries, storage deposit flow.
- Property: sum of balances per token = minted − burned.

## 3. Account topology

```
<authority>.testnet                      # human-created; owns the goods contract + acts as game authority
├── goods.<authority>.testnet            # (or the authority itself hosts the contract; decide with human)
├── townfund.<authority>.testnet         # Town Fund
├── captain.<authority>.testnet          # Ship Captain treasury (mint recipient/spender)
├── npc-fisher-1.<authority>.testnet     # NPC sub-accounts (one per NPC)
├── npc-fisher-2.<authority>.testnet
├── ...
└── p-<shortid>.<authority>.testnet      # player accounts (created at first login)
```

- **Sub-accounts** make NPC wallets real, cheap to create, and clearly grouped under the game's authority.
- Naming must satisfy NEAR account id rules (lowercase alphanumerics with `-`/`_` separators, length limits; verify). The hackathon's `nearAddress` regex for the payout account is in `SUBMISSION.md`; payout is a **separate mainnet account chosen by the human**.
- Account creation is a server-side admin flow behind `LedgerAdapter.ensureAccount`.

## 4. NPC wallets and spending limits

### 4.1 Wallet per NPC
Each NPC has its own sub-account; its balances are mirrored via batched settlement. The Judge drawer links each NPC to its account on a testnet explorer (verify the current explorer URL).

### 4.2 Operation model
The server operates NPC sub-accounts. Two options; pick the simplest that works:
- **A. Settlement-only (MVP):** NPC balances change only through authority-signed batch settlements; NPC "keys" are not used for trades. Simple and robust.
- **B. Function-call keys (stretch, enables the `security` track):** each NPC sub-account gets a **function-call access key** restricted to the goods contract and specific methods with a gas allowance, used by the server to execute that NPC's own transfers. Combined with the sim's policy guard, this is defense-in-depth ("give AI money without giving it the keys to everything").

### 4.3 What to claim publicly
Only claim spending limits, function-call keys, or sub-account isolation in the README **if implemented and demonstrable**. A demonstrable version: a script that attempts an over-limit NPC transfer and shows it rejected (by guard and/or by key permissions).

## 5. Social login (players never see a wallet)

### 5.1 Requirements
- One-click sign-in with a **social or email** identity (the track requires social or email login; **no seed phrases, no wallet popups, no gas prompts** in the normal game loop).
- On first login, a NEAR account is created or derived and funded for storage; the player never sees seed phrases, addresses, or approval pop-ups.
- Server maps session → `playerId` → ledger account.

### 5.2 Implementation approach
- Define an `AuthProvider` interface in `apps/server`:
  ```ts
  interface AuthProvider {
    begin(req): Promise<LoginChallenge | Session>;
    complete(req): Promise<Session>;       // returns { playerId, displayName }
  }
  ```
- Implementations: `GuestAuth` (anonymous session, instant, for dev and the guaranteed demo fallback) and `SocialLoginAuth` (real provider).
- **Provider choice is open:** research current NEAR-ecosystem options for social/embedded-wallet login (check https://docs.near.org/ and the hackathon's ecosystem list in `HACKATHON.md`), pick the one with the least integration risk, and record it in §10. Ask the human before adding paid services or creating third-party accounts.
- **Custody model (be honest):** for the MVP, the server may custody player ledger accounts on their behalf ("embedded/custodial wallet"). State this plainly in the README. Do not claim self-custody unless implemented.

## 6. Gasless play (relayer)

- Players never pay gas. All transactions are paid by the **relayer/authority**.
- **MVP:** since the server submits settlements itself, gas is naturally server-paid; no player signing needed.
- **Stretch:** meta transactions (delegate actions, NEP-366; verify) so a player-held or provider-held key can sign an intent that the relayer submits. Only do this if social login provides a signer and time allows.
- Relayer account funding: the human funds testnet accounts via the official testnet faucet/tools; do not automate scraping faucets.
- Guard the relayer: rate limits per player, per-day gas budget, and an allowlist of contract methods.

## 7. Settlement details

- Input: net deltas per `(account, token)` for the window (see `ARCHITECTURE.md` §5.1).
- Build batches that respect gas and size limits (verify current limits; split into multiple transactions when needed).
- **Idempotency:** each batch has a deterministic `batchId` (`tickFrom-tickTo`); store it in the settlements table, and include it in the call (e.g., as a memo or via a contract-side "last settled batch" guard) so retries cannot double-apply. Design this explicitly; it is the main correctness risk.
- **Ordering:** apply burns/transfers/mints such that no intermediate negative balance occurs (net deltas make this easy; apply mints first, then transfers, then burns).
- **Reconciliation:** daily job compares sim vs ledger balances; mismatches are logged and surfaced in the Judge panel.

## 8. Optional: NEAR Intents cash-in/cash-out

- Listed in the track hints; **optional and last priority**.
- If attempted: read https://docs.near-intents.org/ first; scope it to a single "cash out marks → stablecoin" or "cash in" demo flow in the Judge panel only. The core loop must never depend on it.
- Skip entirely if Phase 4 is behind schedule (see `BUILD_PLAN.md` cut list).

## 9. Security checklist

- [ ] No secrets in git history, logs, client bundle, or error messages.
- [ ] Authority and relayer keys only from env; `.env*` in `.gitignore`.
- [ ] Contract mint/burn restricted to authority; tests prove non-authority calls fail.
- [ ] Relayer rate-limited and method-allowlisted.
- [ ] Batch idempotency verified by a retry test.
- [ ] Pause switch tested.
- [ ] Mainnet signing never occurs without explicit human confirmation.
- [ ] README honestly states custody model and the off-chain-matching/onchain-settlement split.

## 10. Verified facts (fill in as you verify; keep dates)

Verified 2026-11-09 by the contract session. "Local" means checked against the installed tool or downloaded crate source; "live" means a read-only RPC query against testnet.

| Topic | What was verified | Source URL | Date |
| --- | --- | --- | --- |
| NEP-245 method names/signatures | Status **Final**, requires NEP-297. Core change methods: `mt_transfer(receiver_id, token_id, amount, approval: [owner_id, approval_id]\|null, memo\|null)`, `mt_batch_transfer(receiver_id, token_ids[], amounts[], approvals[]\|null, memo\|null)`, `mt_transfer_call(..., msg)`, `mt_batch_transfer_call(..., msg)`; all need **exactly 1 yoctoNEAR** attached; batch must panic on length mismatch. Views: `mt_token(token_ids[]) -> (Token\|null)[]`, `mt_balance_of(account_id, token_id) -> string`, `mt_batch_balance_of(account_id, token_ids[]) -> string[]`, `mt_supply(token_id) -> string\|null`, `mt_batch_supply(token_ids[]) -> (string\|null)[]`. Callback `mt_resolve_transfer`, receiver `mt_on_transfer`. `Token { token_id, owner_id\|null }`. Amounts are u128 as base-10 strings. Events: `standard: "nep245"`, `version: "1.0.0"`, `mt_mint {owner_id, token_ids, amounts, memo?}`, `mt_burn {owner_id, authorized_id?, token_ids, amounts, memo?}`, `mt_transfer {authorized_id?, old_owner_id, new_owner_id, token_ids, amounts, memo?}`; `data` is an array. Metadata ext (marked "proposed, subject to change"): `mt_metadata_contract() -> {spec: "mt-1.0.0", name}`, `mt_metadata_token_all`, `mt_metadata_token_by_token_id`, `mt_metadata_base_by_token_id`, `mt_metadata_base_by_metadata_id`. Enumeration ext: `mt_tokens(from_index, limit)`, `mt_tokens_for_owner(...)`. Spec says an MT contract account "should not have any access keys". | https://github.com/near/NEPs/blob/master/neps/nep-0245.md, `.../nep-0245/Metadata.md`, `.../nep-0245/Enumeration.md` | 2026-11-09 |
| `near-sdk-rs` version and multi-token support/helper crates | crates.io latest `near-sdk 5.30.1` (needs rust 1.95); `cargo near new` (cargo-near 0.22.0) generates `near-sdk = "5.29"` + `rust-toolchain 1.93.0`, which resolves to **5.29.1**. Idioms: `#[near(contract_state)]`, `#[near]` impl, `#[near(serializers=[json,borsh])]`, `#[near(event_json(standard=...))]` + `#[event_version]` (serde `tag="event", content="data"`), `near_sdk::store::{LookupMap, IterableMap, LookupSet}` with unique byte prefixes, `assert_one_yocto()`. **`near-contract-standards` 5.29.1 has no multi-token module** (only FT, NFT, storage_management, upgrade), so NEP-245 is hand-written. | crates.io; local crate source in `~/.cargo/registry`; https://github.com/near/agent-skills/tree/main/skills/near-smart-contracts | 2026-11-09 |
| Contract build + test framework | Build: `cargo near build non-reproducible-wasm` (local help; `--no-release` for debug). Integration tests: **near-sandbox + near-api** (the agent skill: near-api "replaces near-workspaces-rs for tests"); generator pins `near-sandbox 0.3.12`, `near-api 0.8`, `cargo-near-build 0.11.0`, `testresult 0.4.1`, `tokio 1`. Unit tests: `near-sdk` feature `unit-testing`. (crates.io latest: near-sandbox 0.4.0, near-api 0.8.7, near-workspaces 0.24.0; not used.) | `cargo near new`, `cargo near --help` (local), agent skill `near-smart-contracts/rules/testing-integration-tests.md` | 2026-11-09 |
| `near-api-js` current package name/API | **near-api-js 7.4.0** (single package; `@near-js/*` are superseded). Verified from the installed package source: `new JsonRpcProvider({ url })`; views `provider.callFunction({ contractId, method, args })` → parsed JSON; signing `new Account(accountId, provider, 'ed25519:…')`, `account.callFunctionRaw({ contractId, methodName, args, gas, deposit })` → `RpcTransactionResponse` (tx hash = `transaction_outcome.id`), **throws** a parsed `ContractExecutionError`/`ActionExecutionError` on any Failure; `getTransactionLastResult(outcome)` decodes the return value; `teraToGas(n)`. Nonce collisions are retried internally. Read-only calls checked live against `goods.samuelowen.testnet` (`pnpm near:check`). | npm `near-api-js@7.4.0` README + `lib/index.js`; https://docs.near.org/tools/near-api | 2026-11-09 |
| Storage management pattern for multi-tokens | NEP-245 does **not** define storage; it says to track storage changes and points to **NEP-145** (`storage_deposit(account_id?, registration_only?) payable`, `storage_withdraw(amount?)` 1 yocto, `storage_unregister(force?)` 1 yocto, `storage_balance_bounds()`, `storage_balance_of(account_id)`). Storage price **1e19 yocto per byte** (1 NEAR per 100 kB), live value confirmed. Contracts pay for their own storage from their account balance. | https://github.com/near/NEPs/blob/master/neps/nep-0145.md, https://docs.near.org/protocol/storage/storage-staking.md, live `EXPERIMENTAL_protocol_config` | 2026-11-09 |
| Sub-account creation rules/costs | Account ids 2–64 chars, `a-z 0-9 . - _`. Only the parent can create its sub-accounts; the parent has no control over a sub-account after creation. An account can hold 770 bytes without staking. | https://docs.near.org/protocol/accounts-contracts/account-id.md, storage-staking.md | 2026-11-09 |
| Function-call access keys (allowance, method scoping) | FC keys: one `receiver_id`, optional `method_names` (empty = all), optional gas `allowance` (unset = unlimited; exhausted = key unusable; can't be changed). FC keys **cannot attach a deposit**, which is why 1-yocto methods require a full-access key. | https://docs.near.org/protocol/access-keys.md, https://docs.near.org/smart-contracts/security/one_yocto | 2026-11-09 |
| Meta transactions / delegate actions (NEP-366) | **Not used.** The server signs every settlement with its own function-call key and pays the gas, so players never sign or pay (§6 MVP). Not verified further. | — | 2026-11-09 |
| Social/embedded login option chosen + integration steps | **Privy.** docs.near.org lists NEAR Connect (wallet modal; no social login), Privy, NEAR Auth (Auth0 + MPC; mainnet needs approved credentials) and points to Web3Auth. On Privy: "This should be the preferred way for applications that want to abstract away the wallet and provide a Web2-like experience". Client: `@privy-io/react-auth`, login methods (email, Google…) set in the Privy dashboard; send `getAccessToken()` to the server. Server: verify the access token as an **ES256 JWT, `iss` = `privy.io`, `aud` = Privy app id, `sub` = user's Privy DID**, key from Dashboard → Configuration → App settings (jose example in Privy docs). Implemented in `apps/server/src/auth.ts`: `PRIVY_APP_ID` + `PRIVY_VERIFICATION_KEY` (local jose check), or `PRIVY_APP_ID` + `PRIVY_APP_SECRET` via `@privy-io/node` 0.38.0 when the dashboard shows no key. From the SDK source: `new PrivyClient({ appId, appSecret, jwtVerificationKey? })`, `utils().auth().verifyAccessToken(token: string)` (a plain string, unlike the docs' object form) → `{ app_id, user_id, issuer, … }`; it fetches the key from `{api}/v1/apps/{appId}/jwks.json` and requires header `typ: JWT`, alg ES256 (so the docs' "Ed25519" remark is wrong). Pricing not stated on those pages. Custody: the server holds the game ledger accounts (custodial); Privy's embedded wallet is not used for settlement. | https://docs.near.org/web3-apps/concepts/web-login, https://docs.near.org/web3-apps/tutorials/privy.md, https://docs.near.org/web3-apps/tutorials/near-auth.md, https://docs.privy.io/authentication/user-authentication/access-tokens | 2026-11-09 |
| Testnet RPC endpoint and explorer URL (+ https://docs.near.org/protocol/network/networks.md) | RPC: `https://test.rpc.fastnear.com` (used for the live query), `https://near-testnet.drpc.org`, `https://archival-rpc.testnet.near.org` (rate-limited). Explorer: the Networks page lists **`https://testnet.nearblocks.io`** for testnet (backend session, 2026-11-09). The transaction/account URL patterns are **not documented** there, so the server only links when `NEAR_EXPLORER_TX_URL` / `NEAR_EXPLORER_ACCOUNT_URL` templates are set after a manual check. | https://docs.near.org/api/rpc/providers.md, https://docs.near.org/api/rpc/introduction | 2026-11-09 |
| Gas/size limits for batch calls | **Live testnet (protocol 88):** `max_total_prepaid_gas` = 1 PGas (1000 Tgas) per tx; `max_transaction_size` = 1.5 MiB; `max_arguments_length` = 4 MiB; `max_actions_per_receipt` = 100; **`max_number_logs` = 100 and `max_total_log_length` = 16 KiB per receipt**. The log limit binds first: a settlement must group its NEP-245 events, and big windows must be split (see §7 and `contracts/goods/README.md`). `docs.near.org/smart-contracts/anatomy/environment` still says 300 Tgas; that page is stale. | live `EXPERIMENTAL_protocol_config` on test.rpc.fastnear.com; https://docs.near.org/protocol/transactions/transaction-anatomy.md | 2026-11-09 |
| near-cli-rs syntax (create account, deploy) | Verified from local `--help` (near-cli-rs 0.30.1, cargo-near 0.22.0): `near account create-account sponsor-by-faucet-service <id>.testnet autogenerate-new-keypair save-to-keychain network-config testnet create`; `cargo near deploy build-non-reproducible-wasm <contract-id> with-init-call <fn> json-args '<json>' prepaid-gas '<gas>' attached-deposit '<amt>' network-config testnet sign-with-keychain send`. | local `--help`, agent skill `near-cli-rs/SKILL.md` | 2026-11-09 |

### 10.1 Mismatches between this doc and what was verified (2026-11-09)

1. **Gas:** the per-tx limit is 1 PGas, not 300 Tgas. The real batch limit is **16 KiB of logs per receipt** (and 100 logs).
2. **No ready-made NEP-245 in `near-contract-standards`.** The contract implements the standard itself.
3. **Testing:** the current recommendation is near-sandbox + near-api, not near-workspaces (§2.3).
4. **Settlement input shape:** `SettlementBatch` in `packages/chain` carries *net deltas* per (account, token). The contract's `settle` takes explicit `mints`, `transfers`, `burns` (applied in that order), so `NearLedger` has to convert. See `contracts/goods/REQUESTS.md`.
5. **Account ids:** sim ids (`npc-fisher-1`, `p-…`, `townfund`) are not NEAR account ids; `NearLedger` must map them (e.g. `<id>.<authority>.testnet`). The contract doesn't need those accounts to exist to hold balances; actually creating them is a separate step.

## 11. Failure and fallback matrix

| Failure | Behavior |
| --- | --- |
| RPC down or slow | Game continues on `MemoryLedger`; queue retries with backoff; status shows "ledger: queued N" in Judge panel |
| Batch tx fails (gas/size) | Split batch; retry; log |
| Social login provider fails | Fall back to `GuestAuth` (feature flag) |
| Account creation fails | Player plays with a pending ledger account; created lazily at next settlement |
| Contract bug found late | Pause switch; fall back to `MemoryLedger` for the demo; document honestly |
