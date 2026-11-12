# Saltmarket

Saltmarket is a browser trading game set in a harbor town. The town's economy is the game: NPC merchants each have their own wallet, set prices from their own stock and recent demand, and explain every price change in plain English. NEAR holds ownership and balances, out of the player's sight.

Built at NEAR HACKATHON for the **Games With Real Economies** track (`games`).

<!-- DRAFT (backend owner, 2026-11-09). Sections marked "frontend owner" are filled in when apps/web is merged.
     Every command and expected output below was run on the backend branch; re-check on a clean clone before submitting. -->

## Problem and idea

In most games, prices are numbers a designer types into a spreadsheet and patches later. Saltmarket's prices come from agents with wallets reacting to supply and demand. Players gather, cure fish, and sell to NPC merchants and a visiting ship captain. They can also own a market (an Exchange Hall that earns fees) or reopen a broke merchant by investing in it. Shocks such as a storm hit the town, and it adapts on its own, with no developer intervention.

## What you can do

- **Trade with NPC merchants that have wallets.** Ten NPCs (3 fishermen, 2 salt-panners, 2 woodcutters, a Cooper, a Smokehouse, and the ship Captain) each hold their own marks and goods, set their own prices, and explain each decision ("Storm kept the boats in. Stock is low, raising my price 40%.").
- **Own a market.** Buy an Exchange Hall license and set its fee (0–5%). Merchants move their stalls to the cheapest venue, so rival Halls compete on fees.
- **Watch the economy evolve with no patch.** Sinks (rent, upkeep, demurrage, licenses) balance the one faucet (the Captain's purchases). Supply responds to price. The Captain adjusts both his price ceiling and his order size from how each visit went.
- **Gather, cure, and sell.** Gather fish, salt, and timber at shared nodes. Craft barrels, cure fish (6 fish + 3 salt + 1 barrel → 4 cured fish), and sell to merchants or the Captain. If players flood a good, it gets cheap.
- **Reopen broke merchants.** A merchant that runs out of cash closes until a player invests (repaid at 25% of daily profit, up to 125% of principal). If nobody invests within 5 game days, the Town Fund rescues it.
- **Read the pricing rules.** Every merchant pricing rule is in one readable file, [`packages/sim/src/pricing/merchant-rules.ts`](packages/sim/src/pricing/merchant-rules.ts). The tooltip text comes from the same file.
- **"Watch a week".** Seven game days of trading play in about a minute, on a copy of the town, with optional storm, flood, and closure toggles.
- **Never see the chain.** Players sign in with a guest or social/email login (Privy) and never see a wallet, seed phrase, or gas prompt. The server signs and pays for every settlement.

## How NEAR is used

- **One NEP-245 multi-token contract** ([`contracts/goods`](contracts/goods)) holds marks, all five goods, and Hall licenses as token ids. On testnet it is deployed at `goods.samuelowen.testnet`.
- **Settlement.** Matching, pricing, and NPC decisions run off-chain in a deterministic simulation. Every game day the server sends the net balance changes as one idempotent `settle` call (mints, then transfers, then burns), and batches must be contiguous. Saved state includes the settlement cursor, so a restart never re-sends balances.
- **Accounts.** Each sim account maps to an id under the authority, e.g. `fisher-1.samuelowen.testnet`. On the contract these are balance entries; they are not separately created NEAR accounts.
- **Keys and gas.** The server signs with a function-call key limited to the contract's `settle`, `pause`, `register_accounts`, `mt_mint`, and `mt_burn`, with a gas allowance. That key can't unpause, rotate the authority, or move NEAR. Players never sign or pay.
- **Custody, stated plainly.** Player and NPC balances are custodial ledger entries operated by the server. Privy is used only to identify the player; its embedded wallet is not used for game assets.
- **Testnet only.** Nothing runs on mainnet.

## Try it in 60 seconds

```bash
pnpm install
pnpm dev          # real economy (offline ledger) on :3000 + the game in the browser at http://127.0.0.1:5173
```

Ports are configurable: `PORT=3100 pnpm dev` moves the server and points the web app at it; `WEB_PORT` moves the web app.

**In the browser** (open http://127.0.0.1:5173/?judge=1 to get the judge controls; for these the server must run with `JUDGE_MODE=1 pnpm dev`):

| Do | See |
| --- | --- |
| Type a name, press **Play as guest** | Your stall opens with a purse of 300 marks; the top bar shows the purse, the town clock and the ship countdown |
| Press **Gather fish**, then **Sell 1** on the Fish row | "+2 fish", then a toast like "Sold 1 fish to Old Pell's Smokehouse for 8.6 marks"; the purse goes up |
| Hover, tap or Tab to any price or merchant quote | A popover with the merchant's reason ("Storm kept the boats in. Stock is low, raising my price 23%."), its factors (stock, margin, demand) and a link to `merchant-rules.ts` |
| Gather 3 timber → **Craft barrel**; gather 6 fish + 3 salt → **Cure fish** | Progress bars, then 4 cured fish in your stall |
| When the ship docks, press **Sell 4 cured fish to Captain Maren** | The sale confirmation and about 180 marks more in your purse |
| Judge strip → **Storm** | A storm banner; fishermen raise their asks and say why ("Storm kept the boats in…"), the Harbor news feed explains each move, and once fish trades the price row shows ▲ with "storm cut the catch" |
| Judge strip → pick the Cooper → **Force broke**, then **Invest** on her card | "Closed: needs investment" → the shop reopens; your stake and payouts appear under "Shops you back" |
| **Exchange Halls** → **Buy license**, move the fee slider to 1% | Your Hall appears in the comparison with its fee, volume and fee income; merchants move to the cheapest venue the next day |
| **Watch a week** → keep "Storm on day 2" → **Watch a week** | Seven game days in about 60 s on a copy of the town: price lines per good, the Captain's ceiling, merchant purses and open/closed state, the reasons scrolling, then a summary. The live town is unchanged |
| Judge strip → **Ledger** | Settlement batches with status and transaction hashes, balances in the game vs last settled, reconciliation mismatches (mode `memory` offline, `near` on the testnet server) |

Everything also works at phone width (bottom tabs: Stall / Market / Merchants / News). Players never see chain words; only the judge strip and Ledger drawer use them.

**Without a browser:**

1. `curl -s localhost:3000/healthz` → see `{"ok":true,…,"serverMode":"live",…}`.
2. `curl -s -X POST localhost:3000/api/auth/login -H 'content-type: application/json' -d '{"provider":"guest"}'` → see `{"ok":true,"data":{"token":"…","playerId":"p-…"}}`.
3. `curl -s localhost:3000/api/npcs/fisher-2/explain` → see Brina's current reason line, its factors, and `"rulesFile":"packages/sim/src/pricing/merchant-rules.ts"`.
4. Restart with `JUDGE_MODE=1 pnpm dev`, then `curl -s -X POST localhost:3000/api/dev/event -H 'content-type: application/json' -d '{"kind":"storm"}'` → see `"Storm starts next hour."`. Fish prices and merchant reasons change over the next ticks. Without `JUDGE_MODE=1` the same call returns `403 JUDGE_ONLY`.

## Verify the economy yourself

Each of these runs the real simulation with no UI, checks the invariants (mark and good conservation, no negative balances) after every tick, and exits non-zero on failure.

| Do | See |
| --- | --- |
| `pnpm sim:storm --seed 42` | The Storm response, with all six checks `PASS`: fish asks up 40% within 6 ticks; the Smokehouse pauses fish buying (0 vs 19); the next ship leaves with 12 of 16 and the Captain raises his ceiling; fish back within ±20% by day 6 |
| `pnpm sim:week --seed 42 --storm-day 3` | A day-by-day story of a week with a storm on day 3, ending `invariants: ok (checked every frame)` |
| `pnpm sim:tune --seeds 10` | Stability checks over 10 seeds × 30 days with no players: no price stuck at a limit; burn/mint 0.86–1.16 in 99% of 5-day windows; money supply −4% to +14% |
| `pnpm sim:headless --seed 42 --days 30` | A 30-day table of prices, money supply, minted vs burned, and the Captain's ceiling and fill |
| `pnpm test` | 52 tests: protocol conformance (the mock and live servers pass the same suite), invariants, determinism, Storm, flood, Hall competition, closure/invest/rescue, settlement across restarts, NearLedger against a contract model, social-login token checks |

Tuning history, one lever at a time: [`docs/TUNING_LOG.md`](docs/TUNING_LOG.md).

## Verify on-chain

- `pnpm near:check --contract goods.samuelowen.testnet --authority samuelowen.testnet` reads the contract's status, settlement cursor, and storage. It signs nothing.
- The Ledger drawer (`?judge=1`, or `GET /api/judge/ledger` on a `JUDGE_MODE=1` server) lists recent settlement batches, their status, and per-account balances in the sim vs on the ledger.

- First live settlement (demo world, batch `72-96`, 33 balance changes): tx `3P2frBFCJFAVwQJ1gZKWsdsTXiPf4TwttEjMcmLgqZQf` on testnet (explorer: https://testnet.nearblocks.io). After it, every sim balance matched the contract (reconciliation: 0 mismatches).

## Architecture in brief

```
browser ──REST/WS──► server (Fastify) ──► sim (pure, seeded, deterministic)
                         │
                         └── settlement queue ──► LedgerAdapter: MemoryLedger (offline) | NearLedger (testnet)
                                                                  └──► NEP-245 goods contract
```

More detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/ECONOMY.md`](docs/ECONOMY.md), [`docs/NPC_AGENTS.md`](docs/NPC_AGENTS.md), [`docs/NEAR_INTEGRATION.md`](docs/NEAR_INTEGRATION.md), [`contracts/goods/README.md`](contracts/goods/README.md).

## Tracks

- `games`: every feature above.
<!-- team lead decides whether to add agents/swarms (see docs/PROJECT_OVERVIEW.md §6); list only what is demonstrable -->

## Limitations

- Custodial: the server operates all ledger accounts.
- NPC wallets are balance entries on the goods contract. They are not individually created NEAR accounts, and they have no per-NPC function-call keys. The spending limits are enforced in the simulation's policy guard.
- Matching runs off-chain; the chain receives one net settlement per game day.
- With five always-on bot players gathering for free, the money supply grows faster than the sinks remove it. The NPC-only economy passes every stability check.
- The Captain's reaction to a Storm (a short visit, then a higher ceiling) depends on where the storm falls in his 2-day schedule. It happens on the demo seed (42) and in 2 of 10 seeds.

## Run locally

Requires Node ≥ 22 and pnpm 11. Copy `.env.example` to `.env` (names only in the example; never commit values).

| Mode | Command | Needs |
| --- | --- | --- |
| Offline (default) | `pnpm dev` | nothing |
| Mock data for UI work | `pnpm dev:mock` | nothing |
| Testnet settlement | `pnpm dev:chain` | `NEAR_RPC_URL`, `NEAR_CONTRACT_ID`, `NEAR_AUTHORITY_ID`, and `NEAR_AUTHORITY_KEY_FILE` (path to the function-call key file) |
| Social login | set `PRIVY_APP_ID`, `PRIVY_VERIFICATION_KEY` | a Privy app |
| Demo world | `pnpm demo:seed` | writes `data/world.json` with two labeled demo Hall owners |

## License and credits

<!-- license: team decides (docs/SUBMISSION.md §6) -->
