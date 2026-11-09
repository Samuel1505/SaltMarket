# Requests from the contract session to the TypeScript side

These are changes in paths the contract session does not edit: `packages/chain`, `apps/server`, and the root `package.json`. Each says what to change and why. The contract is in `contracts/goods` (see its README for the `settle` format).

| # | Status (2026-11-09) |
| --- | --- |
| C1 | open (NearLedger) |
| C2 | **done** in `backend/foundation` e28617a |
| C3 | open (NearLedger) |
| C4 | open (NearLedger); updated after C2, see below |
| C5, C6 | open (nice to have / decide) |
| C7 | open; the testnet key and `.env` values exist (README "Deployments") |
| C8 | **done** in `backend/foundation` e28617a |
| C9 | open |

## C1. NearLedger: convert net deltas into mints / transfers / burns (needed)

`SettlementBatch.deltas` is a list of net `{account, token, delta}`. The contract's `settle` takes explicit `mints`, `transfers`, `burns` and applies them in that order (no negative intermediate balances, correct `minted`/`burned` totals, readable NEP-245 events). Suggested conversion, per token:

```ts
// pos: deltas > 0 (receivers), neg: deltas < 0 (senders), both sorted by account for determinism
// Pair them greedily into transfers; whatever is left over is a mint (net creation) or a burn (net sink).
while (pos.length && neg.length) {
  const n = min(pos[0].delta, -neg[0].delta);
  transfers.push({ sender_id: neg[0].account, receiver_id: pos[0].account, token_id, amount: String(n) });
  pos[0].delta -= n; neg[0].delta += n;
  if (pos[0].delta === 0n) pos.shift();
  if (neg[0].delta === 0n) neg.shift();
}
for (const p of pos) mints.push({ account_id: p.account, token_id, amount: String(p.delta) });
for (const q of neg) burns.push({ account_id: q.account, token_id, amount: String(-q.delta) });
```

Pairing only ever *transfers* what an account loses, so it cannot debit more than the account's net loss. Since the delta is applied on top of the last settled balance (which is ≥ the loss), no step goes negative.

## C2. Persist `lastSettled` across restarts (DONE, e28617a)

> Done: the snapshot stores `lastSettled`, `lastSettledTick` and unconfirmed batches; each batch starts at the stored cursor; batches go out one at a time; re-sends after boot are marked; a first send that comes back `applied: false` stops settlement and marks the ledger degraded. The contract session reviewed it against the contract's cursor rules. Remaining caveat: a snapshot without a `ledger` section (older files, `pnpm demo:seed` output) settles every balance in its first batch, so it may only ever meet a **fresh** contract, never `goods.samuelowen.testnet` once that has been used. Against a used contract it would get `applied: false` (stops) or `ERR_GAP` (see C4); neither double-mints.

`SimBackend.lastSettled` starts empty on every boot, but the world reloads from `data/world.json`. The first batch after a restart therefore re-sends **every balance as a positive delta**, and the chain would mint the whole economy a second time. The ticks are still contiguous, so the contract cannot tell this apart from a real batch.

Fix (either one): save `lastSettled` (and the settlements queue) in the snapshot, or on boot with `NearLedger`, seed `lastSettled` from `mt_batch_balance_of` for every known account, then settle from the contract's `settlement_cursor().last_tick_to`.

## C3. Account id mapping (needed)

Sim ids (`npc-fisher-1`, `p-…`, `townfund`, `captain`) are not valid NEAR account ids on their own. Map them in `NearLedger`, e.g. `${simId}.${NEAR_AUTHORITY_ID}` (2–64 chars, `a-z 0-9 - _ .`; check the length for player ids). Balances don't need the accounts to exist on chain. Creating real sub-accounts for NPC wallets is a separate `ensureAccount` step.

## C4. Read the result and classify errors (needed)

- `settle` returns `{ applied, complete, last_tick_to }`. Map `applied` to `Receipt.applied`. `applied: false` on a batch the server has never sent successfully is an alarm, not a success (it usually means C2 or a fresh world against an old contract).
- **Retryable:** RPC and timeout errors, `ERR_PAUSED` (an operator paused the contract; retry with backoff until unpaused).
- **Not retryable; stop and show it (needs a person):** `ERR_GAP`, `ERR_OVERLAP`, `ERR_BATCH_IN_PROGRESS`, `ERR_INSUFFICIENT_BALANCE`, `ERR_BAD_*`, `ERR_UNKNOWN_TOKEN`, `ERR_NOT_AUTHORITY`, `ERR_BATCH_TOO_LARGE` (until C5 exists). Since C2, batches go out strictly in order, so `ERR_GAP` can no longer mean "an earlier batch is still on its way". It means the server's cursor and the contract's cursor disagree, e.g. an old snapshot against a used contract. Show it in the Judge panel ("ledger: stuck at 120-126: ERR_…").
- On boot with NearLedger, compare `settlement_cursor().last_tick_to` with the server's cursor (the `tickFrom` of the first pending batch, or `lastSettledTick` if nothing is pending) before sending anything. If they differ, mark the ledger degraded right away instead of finding out from the first failed batch. If `in_progress` is non-null, a split batch (C5) was interrupted: resume from `next_part`.

## C5. Split big windows into parts (nice to have)

One part fits about 100 ops with realistic names (log budget: 16 KiB per receipt; a 75-op window measured 11.5 KiB and 17 Tgas). If a window has more than ~90 ops, or `settle` fails with `ERR_BATCH_TOO_LARGE`, send it as `parts` transactions with the same `batch_id`, `part` = 0..n-1. Put all mints in the early parts, transfers in the middle, burns last.

## C6. Empty windows (decide)

The contract accepts an empty batch and just moves the cursor (about 1–3 Tgas). Either keep sending them, which is simplest, or skip empty windows and let the next non-empty batch cover the whole span (`tickFrom` = last settled `tickTo`). The second option means `batchId` no longer always spans exactly `SETTLE_EVERY` ticks.

## C7. Keys and env (needed for Phase 4)

Sign `settle` with a **function-call key** on the authority account scoped to `goods.<authority>` and `settle,pause,register_accounts,mt_mint,mt_burn` (command in `contracts/goods/README.md`). It needs no deposit. Suggested env names: `NEAR_NETWORK`, `NEAR_RPC_URL`, `NEAR_CONTRACT_ID`, `NEAR_AUTHORITY_ID`, `NEAR_AUTHORITY_KEY` (values only in local `.env`). Also watch `storage_report().accounts_affordable` and alert when it drops below about 100.

## C8. Root scripts (DONE, e28617a)

> Verified 2026-11-09: `pnpm contracts:test` run from `backend/foundation` e28617a passes (44 unit + 1 sandbox scenario, 57 s on a warm build). **First-run caveat:** the sandbox test downloads the `near-sandbox` node binary (2.13.4, ~71 MB) from S3 into the build folder. That download can stall, which is the likely cause of the 5-minute timeout seen on a fresh copy. To reuse an existing binary, set `NEAR_SANDBOX_BIN_PATH=/path/to/near-sandbox` (supported by near-sandbox 0.3.16).

Add to the root `package.json`:

```json
"contracts:build": "cd contracts/goods && cargo near build non-reproducible-wasm",
"contracts:test": "cd contracts/goods && cargo test --lib && cargo test --test sandbox"
```

## C9. Explorer URL (open)

The docs only list `https://nearblocks.io` (mainnet and testnet). A testnet-specific explorer URL for `explorerUrl()` is not confirmed yet, so verify it before wiring the Ledger drawer links.
