# CLAUDE.md — Saltmarket

You are Claude Code, working with a human on **Saltmarket**, an entry for **NEAR HACKATHON** (Games With Real Economies track). Read this file fully at the start of every session. It is the source of truth for *what we are building, how we work, and what you must never do*. Deeper detail lives in `/docs` (see the Doc Map).

---

## 1. What we are building (30-second version)

**Saltmarket** is a small, browser-playable harbor-town trading game. The player runs a market stall, buys raw goods, turns them into more valuable goods, and sells them to **NPC merchants and other players**. The town's economy is the gameplay: there is no combat and no puzzle layer. If you removed the economy, there would be no game.

Three things make it special, and all three must be visible in the demo:

1. **NPCs are real economic actors.** Each NPC (fisherman, salt-panner, woodcutter, cooper, smokehouse, ship captain) has its own wallet, a budget, a decision rule, and a human-readable *reasoning line* ("Salt is scarce, raising my price 12%").
2. **Players own markets.** Any player can buy an **Exchange Hall** license, set a fee, and earn a cut of every trade that routes through it. Rival halls compete on fees.
3. **The economy evolves without a dev patch.** Prices, production, and NPC strategy shift on their own. The demo centerpiece is a **Storm** event that cuts fish supply and lets judges watch the whole town react.

NEAR is **invisible plumbing**: ownership and settlement happen onchain, but players sign in with a social login and press "Buy" and "Sell". No seed phrases, gas prompts, or wallet pop-ups in the player experience.

> The track brief, verbatim: *"Build NPCs with wallets, player-owned markets and economies that evolve without a dev patch. Judged on the game loop, not the token — bonus if players never notice the chain."*

## 2. Hackathon facts you must respect

| Fact | Value |
| --- | --- |
| Event | NEAR HACKATHON, https://nearhackathon.com |
| Live rules file | https://nearhackathon.com/HACKATHON.md (**re-read before submitting**; dates and rules can change) |
| Development ends (submission deadline) | **2026-11-14T23:59:00Z** |
| Judging starts | 2026-11-16T00:00:00Z |
| Results by | 2026-11-18T23:59:00Z |
| Submission | One per team, POST to `https://nearhackathon.com/api/applications`; cannot be edited |
| Tracks we target | `games` (primary); `agents` and `swarms` only if the features genuinely exist |

**The jury includes AI judges.** The repository must be public by the deadline, and the README must be readable by a machine: what the product is, the problem it solves, and "do X → see Y" steps. No marketing language. See `docs/SUBMISSION.md`.

**Judged on the game loop, not the token.** Every decision should be weighed against: *does this make the loop clearer, more fun, or the economy more visibly alive?* If not, it is lower priority than something that does.

### Official track requirements (from the organizers; full matrix in `docs/TRACK_BRIEF.md`)

- Players **gather materials** and trade with NPC merchants.
- Each merchant is an agent with its **own wallet and inventory**, and sets prices from its **stock and recent demand**. If players flood the market with a good, it gets cheap.
- If a merchant **goes broke, it closes its shop until someone invests** in it.
- Items are **NEP-245 multi tokens**: one contract holds every item type.
- **Social or email login.** No seed phrases, wallet popups, or gas prompts in the normal game loop.
- **Merchant pricing rules live in one readable file** (`packages/sim/src/pricing/merchant-rules.ts`), and a merchant's **reasoning is shown in a tooltip**.
- A **fast-forward mode** that simulates a week of trading in a minute ("Watch a week" time-lapse sandbox) so judges can watch the economy move.
- The **game loop is designed on paper first** (`docs/GAME_LOOP.md`) and shown before any code.

## 3. Non-negotiable rules (safety and workflow)

These come from the hackathon's own agent instructions plus common sense. Do not bypass them, even if asked casually mid-task. If the human really wants an exception, ask for an explicit, unambiguous confirmation in the current conversation.

**Never do these without the human's explicit confirmation:**
- Send the hackathon submission (print the full JSON payload first and wait for a "yes").
- Post anything on X or any other network on the human's behalf.
- Make the repository public, push, or force-push. (Local commits are fine.)
- Sign transactions with a mainnet key, spend real tokens, or deploy anything to mainnet.
- Create, invent, or guess a NEAR payout account. The team creates it in a wallet themselves.

**Never do these at all:**
- Commit secrets, private keys, seed phrases, `.env` files, or the submission payload (it contains personal data). Keys live in environment variables only. Keep `.env*` in `.gitignore` from the first commit.
- Fill in placeholders for fields the human must decide (project name, lead name, email, team size, NEAR account, links, consent). Ask.
- Invent NEAR contract addresses, endpoints, SDK versions, or API shapes. **Verify in docs first** (Section 7).
- Let the game's core loop depend on a paid API, an LLM call, or a live chain being reachable. The demo must run offline-first (see Section 6).

**Default workflow:**
- **Two builders, split paths:** the human you are working with owns only part of the repo (see `docs/TEAM_SPLIT.md`). Work only in their paths; write up requests for changes in the other person's area instead of editing it. Keep `packages/shared/src/protocol.ts` additive.
- **Frontend uses Emil Kowalski's skills (human's choice):** after the human approves installing them (`npx skills@latest add emilkowalski/skills`), read the relevant `SKILL.md` before writing any UI or animation code, use design tokens for all colors, spacing, durations, and easing, and run `review-animations` and `break-ui` on UI changes. Details in `docs/FRONTEND.md`.
- **Loop on paper first (organizers' explicit instruction):** before writing any code, present `docs/GAME_LOOP.md` (30 s / 5 min / session loops) to the human, get approval or edits, and record `Loop approved: <date>` in the Status block. Only then start Phase 0.
- Work in small, reviewable steps. Commit locally with clear messages (`sim: add spoilage tick`, `contracts: add mt mint authority`).
- Before large changes, state your plan in a few lines and proceed unless the human objects.
- Keep this file's **Status** section (Section 11) current at the end of each work session.
- When blocked on a decision only the human can make, ask one specific question with a recommended default.

## 4. Tech stack (defaults chosen; change only with the human's OK)

| Layer | Choice | Why |
| --- | --- | --- |
| Language | TypeScript (strict) everywhere except contracts | One language for sim, server, and web; shareable types |
| Package manager | pnpm workspaces | Monorepo with shared packages |
| Simulation | `packages/sim`: pure, deterministic TS, no I/O | Testable headless; reproducible demos via seeded RNG |
| Server | Node + Fastify + WebSocket (`@fastify/websocket`) | Authoritative game state, tick loop, relayer |
| Persistence | SQLite (`better-sqlite3`): event log + snapshots | Zero-ops; replayable |
| Web | Vite + React + TypeScript, lightweight SVG/Canvas charts, **tokenized design system following Emil Kowalski's design-engineering skills** (see `docs/FRONTEND.md`) | Fast to build; polished, restrained motion; simple browser demo |
| Contracts | Rust + `near-sdk-rs`, NEP-245 multi-token | The hint list in the track names NEP-245 |
| Chain access | `near-api-js` (verify current package and API in docs) | Behind our own `LedgerAdapter` interface |
| Tests | Vitest (TS), `cargo test` / near-workspaces (contracts), Playwright (one e2e smoke) | See `docs/TESTING_AND_DEMO.md` |

If the human states a different stack or experience level, update this table and adapt the docs.

## 5. Repository layout (target)

```
saltmarket/
├── CLAUDE.md                     # this file
├── README.md                     # judge-facing; "do X → see Y" (written late, see SUBMISSION.md)
├── docs/                         # deep-dive docs (see Doc Map)
├── packages/
│   ├── shared/                   # types, zod schemas, constants (goods, recipes, config)
│   ├── sim/                      # deterministic economy engine + NPC agents (pure TS)
│   └── chain/                    # LedgerAdapter interface, MemoryLedger, NearLedger
├── apps/
│   ├── server/                   # Fastify, tick loop, WS API, relayer, persistence
│   └── web/                      # Vite + React client
├── contracts/
│   └── goods/                    # Rust NEP-245 contract (goods + marks + hall licenses)
├── scripts/                      # headless sims, seed/tune tools, deploy helpers (testnet)
└── .env.example                  # names only, never values
```

## 6. Architecture principles (details in `docs/ARCHITECTURE.md`)

1. **Server-authoritative, deterministic simulation.** The sim is a pure function: `(state, inputs, seededRng) → (newState, events)`. No `Date.now()`, no `Math.random()`, no network calls inside `packages/sim`. Same seed + same inputs = same world.
2. **Chain is a ledger, not the game engine.** Matching, pricing, and NPC logic run off-chain. The chain holds ownership and balances and receives batched settlements. The game must **never block on the chain**: settlement is write-behind via a queue.
3. **`LedgerAdapter` is the seam.** `MemoryLedger` (dev/tests/offline demo) and `NearLedger` (testnet) implement the same interface. The UI and sim do not know which is active.
4. **Money is integer minor units.** 1 mark = 100 pips. Never use floating point for balances. Onchain amounts are decimal strings (u128).
5. **Conservation is an invariant.** Total marks = initial + minted − burned. Every sink and faucet is an explicit, logged event. A property test enforces this (see `docs/ECONOMY.md`).
6. **NPC decisions are explainable.** Every NPC action produces a structured `reason` object and a short English string. If you add a behavior, add its reasoning text.
7. **Degrade gracefully.** If the chain is down, the game keeps running on `MemoryLedger`, and a hidden status indicator shows "ledger: offline, queued N".

8. **Merchant pricing lives in one file.** All merchant price/quantity decisions are made in `packages/sim/src/pricing/merchant-rules.ts` (declarative, heavily commented). No pricing logic elsewhere. The tooltip text is generated from the same file.
9. **Fast-forward never touches the live world.** "Watch a week" runs a cloned sandbox (168 ticks streamed in about 60 s) on a `MemoryLedger`; see `docs/ARCHITECTURE.md` §3.5.

## 7. NEAR rules (read before touching anything chain-related)

- **Verify before you build.** Fetch and read the current docs: https://docs.near.org/ (accounts, access keys, meta transactions / NEP-366, multi-token NEP-245, `near-sdk-rs`, `near-api-js`), and for optional features https://docs.near-intents.org/. Record what you verified (versions, method names, links) in the "Verified facts" table in `docs/NEAR_INTEGRATION.md`. Do not rely on memory; the ecosystem changes.
- **Read the organizers' starting points first:** the NEP-245 standard (https://github.com/near/NEPs/blob/master/neps/nep-0245.md), the near-dapp agent skill (https://github.com/near/agent-skills/tree/main/skills/near-dapp), and NEAR Intents basics (https://docs.near-intents.org/getting-started/what-are-intents). Record what you learn in `docs/NEAR_INTEGRATION.md` §10.
- **Testnet only by default.** All development and demo-prep happens on NEAR testnet. Mainnet is only for the team's prize payout *address* (which the human supplies) and requires explicit confirmation for any signing.
- **Keys:** game authority key, relayer key, and any NPC function-call keys come from env vars. Never log them. Never hardcode them.
- **Invisible chain:** the default UI shows no hashes, addresses, or gas. A "Ledger" drawer exists for judges (opt-in via footer link or `?judge=1`) showing recent settlements with explorer links. This keeps "players never notice the chain" true while still letting judges verify the onchain claim.

## 8. Doc map (read in this order when starting fresh)

| Doc | Read it when you need to... |
| --- | --- |
| `docs/TEAM_SPLIT.md` | Know who owns which paths (backend/contract vs. frontend/integration), the protocol contract, the mock server, and checkpoints |
| `docs/TRACK_BRIEF.md` | See the organizers' official track page and the requirement-by-requirement compliance matrix (**the scoring lens**) |
| `docs/GAME_LOOP.md` | See the 30-second / 5-minute / session loop and the time-lapse spec (**must be approved by the human before any code**) |
| `docs/PROJECT_OVERVIEW.md` | Understand goals, judging lens, scope, and risks |
| `docs/GAME_DESIGN.md` | Understand the player experience, loop, roles, UI screens |
| `docs/ECONOMY.md` | Implement goods, recipes, prices, fees, sinks/faucets, formulas, config values |
| `docs/NPC_AGENTS.md` | Implement NPC archetypes, decision rules, reasoning log, policy guard, optional LLM mode |
| `docs/FRONTEND.md` | Build `apps/web`: Emil Kowalski skills workflow, design tokens, motion rules, game-specific UI patterns |
| `docs/ARCHITECTURE.md` | Implement the tick loop, server, API/WS messages, state, persistence |
| `docs/NEAR_INTEGRATION.md` | Implement contracts, accounts, social login, gasless relayer, batched settlement |
| `docs/BUILD_PLAN.md` | Know what to build next, in what order, with what acceptance criteria and cut list |
| `docs/TESTING_AND_DEMO.md` | Write tests and build/rehearse the demo and the Storm scenario |
| `docs/SUBMISSION.md` | Prepare the public repo, README, demo post, and the final submission payload |

If a doc and this file disagree, **this file wins**; then tell the human and fix the doc.

## 9. Coding conventions

- TypeScript `strict: true`, no `any` without a comment explaining why. Prefer `zod` schemas at all boundaries (WS messages, config, persisted events) and infer types from them.
- Small pure functions in `packages/sim`; one file per concern (`market.ts`, `production.ts`, `spoilage.ts`, `events.ts`, `npcs/<archetype>.ts`).
- All tunable numbers live in **one** config module: `packages/shared/src/config/economy.ts`. No magic numbers in logic.
- Name things in domain language: `Stall`, `ExchangeHall`, `Order`, `Trade`, `Tick`, `Mark`, `Pip`, `Venue`, `Reasoning`.
- Errors: sim returns typed results (`{ok:false, code:'INSUFFICIENT_FUNDS'}`) rather than throwing for expected failures.
- Comments explain *why*, not *what*. Every economy formula gets a one-line comment pointing at its section in `docs/ECONOMY.md`.
- Keep the UI readable: plain language, no jargon like "mint", "wallet", "gas", "tx" in player-facing text. (Judge drawer excepted.)
- Frontend motion and styling: tokens only (no inline durations/easing), animate `transform`/`opacity`, CSS transitions for re-triggerable UI, respect `prefers-reduced-motion`. See `docs/FRONTEND.md`.
- Accessibility basics: keyboard-operable controls, sufficient contrast, no information conveyed by color alone (price up/down also shown with ▲/▼).

## 10. Commands (create these in Phase 0; keep this list in sync with `package.json`)

```bash
pnpm install                 # install all workspaces
pnpm dev                     # server + web with MemoryLedger (offline-first)
pnpm dev:chain               # server + web with NearLedger on testnet (needs .env)
pnpm sim:headless --seed 42 --days 30     # run the economy with no UI, print metrics
pnpm sim:storm --seed 42                   # run the Storm scenario and print the response report
pnpm sim:week --seed 42 --storm-day 3        # simulate a week (168 ticks) headless and print the story table
pnpm test                    # unit + property + scenario tests
pnpm typecheck && pnpm lint
pnpm contracts:build         # build the Rust contract (wasm)
pnpm contracts:test          # contract tests
pnpm e2e                     # Playwright smoke test
```

## 11. Status (update this at the end of every session)

One section per person (docs/TEAM_SPLIT.md §4). Each session edits only its own section.

### Status — backend

```
Loop approved:    2026-11-09
  Approved changes: first trade is gather → sell (~60 s); first ship docks ~50 s into a fresh world
  (tick 20); gather cooldown 10 s (4 ticks); Smokehouse sells at most ~half the Captain's order per
  visit (8 of 16); SQLite replaced by in-memory state + JSON snapshot; closure events are
  MERCHANT_CLOSED / MERCHANT_REOPENED / MERCHANT_RESCUED.
Phase:            1–2 in progress (thin slice live). Branch backend/foundation pushed (private repo).
Last session:     2026-11-09
What works:       protocol v0.1.0; pnpm dev:mock; real sim behind the same endpoints (pnpm dev, MemoryLedger,
                  JSON snapshot in data/world.json). Sim: seeded RNG, ledger helpers, gather, Harbor + Hall
                  markets, tax/fees, crafting, spoilage, daily sinks, Captain (Smokehouse cap 8), all six NPC
                  types via merchant-rules.ts + spending guard, closure/invest/rescue, Storm/flood/force_broke,
                  time-lapse sandbox. Invariants (mark + good conservation, no negatives, determinism) checked
                  every tick and every command; shared conformance suite passes on mock AND live (30 tests).
                  Judge routes gated by JUDGE_MODE=1 on live (mock: on unless JUDGE_MODE=0).
In progress:      —
Next up:          Economy tuning (ECONOMY §11): raw goods sit at the 0.5× clamp and the Captain ceiling pins
                  at 90 — producers oversupply and only the Smokehouse feeds the ship. Then sim:storm /
                  sim:week reports, Storm-scenario test, Hall competition test, NearLedger (Phase 4).
Known issues:     Economy untuned (see above). History endpoint returns all venues combined (venueId: null).
                  Docs still mention SQLite and old event names (doc-update request pending with the human).
Open questions for the human:
  - NEAR testnet account to use as the game authority? (human creates; never invent)
  - Social login: who owns widget vs. server verification? (TEAM_SPLIT §7)
```

### Status — frontend

```
(frontend owner's session maintains this section)
```

## 12. Things to ask the human early

1. Their comfort with Rust/contracts (affects how much we lean on the off-chain ledger first).
2. Whether they want the optional LLM-powered NPC "advisor" mode or strictly deterministic NPCs.
3. Art direction preference (default: cozy, minimal 2D, text-forward, no external asset dependencies).
4. Which extra tracks they want listed (`agents`, `swarms`) once we know what is built.

## 13. Definition of "done" for the hackathon

- A judge can open the repo, run one command (or open a hosted demo), and within 60 seconds buy, craft, sell, and see an NPC explain a price change.
- The Storm button visibly triggers a multi-actor response that the economy absorbs on its own.
- At least one player-owned Exchange Hall earns fees from real trades.
- A merchant can go broke, close, and be reopened by a player's investment.
- "Watch a week" shows a full week of trading in about a minute, and every merchant price has a reasoning tooltip.
- Every row of the compliance matrix in `docs/TRACK_BRIEF.md` is DONE (or consciously cut and disclosed).
- NPC and player balances are mirrored on NEAR testnet and verifiable from the Ledger drawer.
- README is judge-ready; repo is public before 2026-11-14T23:59Z; demo post is live; submission sent only after human confirmation.

## 14. Backend → frontend interface (read this if you work in `apps/web`)

Maintained by the backend owner's session. The source of truth is `packages/shared/src/protocol.ts` (currently **v0.1.0**); this section is the short version. If they disagree, the file wins.

**Import and versioning**
- Import schemas and types from `@saltmarket/shared/protocol` (zod schemas with inferred TS types). Economy constants, if you need them, are in `@saltmarket/shared/config`, but prefer the `catalog` the server sends in the snapshot so the UI never hardcodes numbers.
- Changes are additive only (new fields, new message types). Additive change → minor version bump. A breaking change bumps the major version and the backend owner tells you first.
- Ignore unknown fields (zod strips them) and unknown WS message types. Error codes, reason codes, feed kinds, and event kinds are plain strings so new values never break the client; render unknown ones generically. Known values are exported as `ERROR_CODES`, `REASON_CODES`, `FEED_KINDS`, `EVENT_KINDS`.

**Money and vocabulary**
- All money is integer **pips** (1 mark = 100 pips); fields end in `Pips`. Rates end in `Bps` (100 bps = 1%). The client formats marks.
- Player-facing payloads contain no chain vocabulary. Chain data appears only in the `Judge*` schemas (judge mode only).

**REST** (paths in `ROUTES`)
- Success: `{ ok: true, data }`. Failure: `{ ok: false, code, message }`; `message` is friendly and can be shown to players as-is.
- `POST /api/auth/login` `{ provider: 'guest', displayName? }` → `Session { token, playerId, displayName, provider }`. Send `Authorization: Bearer <token>` on later requests.
- `GET /api/world` → `WorldSnapshot` (`me` is null without a token). `GET /api/npcs`, `GET /api/npcs/:id/explain` (tooltip payload), `GET /api/market/:good/history?days=5&venueId=` (sparklines), `GET /api/leaderboard`, `POST /api/timelapse`, `GET /healthz` (no envelope).
- Judge only (`JUDGE_MODE=1` on the server and `?judge=1` on the client): `POST /api/dev/event` `{ kind: 'storm' | 'fair_winds' | 'salt_glut' | 'force_broke', npcId? }`, `POST /api/dev/speed` `{ speed?, paused? }`, `GET /api/judge/ledger`.

**WebSocket** (`/ws?token=<token>`; without a token the socket is a read-only spectator and commands get `UNAUTHORIZED`)
- On connect the server sends `hello`, then a full `snapshot`. Then a stream of `tick`, `delta`, `feed`, `ack`, `timelapse`, `error`, `pong`. After a reconnect expect a fresh `snapshot` (or call `GET /api/world`).
- Every client message has a client-generated `cmdId` (≤ 64 chars). Each one gets exactly one `ack { cmdId, ok, code?, message, result? }`. Show `message` as the toast in both success and failure. On success, `result` is structured (`trade`, `listed`, `cancelled`, `gathered`, `craft_started`, `stall_upgraded`, `hall_bought`, `hall_fee_set`, `invested`, `timelapse`, `none`), for UI like "+2 fish".
- Client messages: `buy`, `sell`, `list`, `bid`, `cancel`, `craft`, `upgradeStall`, `buyHall`, `setHallFee`, `gather`, `invest`, `timelapse`, `subscribe` (optional; everything is sent by default), `ping`.
- Render trades from acks and deltas, not optimistically. Optimistic UI is fine for button states only.

**Applying a `delta`** (`{ t: 'delta', tick, changes }`)
- `clock`, `me`, `ship`, `town`, `events`: replace wholesale when present.
- `venues` (key `id`), `quotes` (key `venueId:good`), `npcs` (key `id`), `nodes` (key `id`), `offers` (key `id`): upsert.
- `removedOfferIds`: delete those offers.
- Feed items arrive separately as `{ t: 'feed', items }`, newest first; `notable: true` means toast-worthy, `mine: true` concerns the signed-in player, `repeat` is the ×N collapse count.

**Market model (decided 2026-11-09)**
- Harbor Market: merchants post **buy offers** (Smokehouse buys fish and salt, Cooper buys timber, etc.) and sellers post asks. `sell` = sell now into the best buy offer (optional `minPricePips`); `buy` = buy now from the best ask (optional `maxPricePips`); `list` = post your own resting ask. This is what makes the gather → sell first trade work in about 60 s.
- Exchange Halls (`hall-<n>`): order books; `bid` posts a resting buy offer (halls only). Venue fees are in `Venue.feeBps`, `taxBps`, `frictionBps`.
- `Quote` = top of book + trend per venue/good, with an optional `trendReason` for price tooltips ("Fish ▲ 12%: storm reduced the catch").

**Tooltips and NPC cards (track requirement)**
- `NpcCard.reasoning` is the current headline: `text` (one line), `detail` (key factors, e.g. "Stock 3 of 14, sold 9 in the last day, margin 16%"), and structured `factors`. `recent` holds the last 5 decisions. Merchant `Offer`s carry their own `reason`.
- `status: 'closed'` comes with `closed { investMinPips, investMaxPips, rescueInTicks }`: show "Closed: needs investment" and the Invest action only then. `investor` is present while someone holds a stake.
- `GET /api/npcs/:id/explain` returns the full tooltip, including per-good price reasons and `rulesFile` (the path to the one readable rules file, for judges).

**Gameplay values the UI shows**
- Gather: `me.gather.readyAtTick` (can gather when `clock.tick >= readyAtTick`), `gatheredToday` / `dailyCap` (counts units). Nodes give `yieldNow` (2, 1 or 0) and `gatherers24h` (crowding).
- Ship: `ship.status`, `ticksToArrival` / `ticksToDeparture`, `ceilingPips`, `volume` / `filled`. In a fresh world the first ship docks at about 50 s (tick 20).
- Clock: interpolate with `clock.realMsPerTick` and `speed`, but never drive game logic from the client clock.
- Closure feed kinds: `MERCHANT_CLOSED`, `MERCHANT_REOPENED`, `MERCHANT_RESCUED`.

**Time-lapse ("Watch a week")**
- Start with WS `{ t: 'timelapse', action: 'start', days?, wallSeconds?, shocks? }` or `POST /api/timelapse`. Frames arrive on your socket as `timelapse` messages with `phase: 'started' | 'frame' | 'done' | 'stopped'`; a frame comes every 6 game ticks, about 60 s for 168 ticks. `done` includes a `summary`. It never changes the live world.
- Shocks: `{ kind: 'storm', day }`, `{ kind: 'flood', good, qty, day }`, `{ kind: 'close_merchant', npcId?, day, investDay? }`.

**Running the server**
- `pnpm dev` runs the **real sim** (MemoryLedger, offline) on the same endpoints; judge routes there need `JUDGE_MODE=1 pnpm dev`. World persists to `data/world.json` (delete it for a fresh world). `pnpm dev:mock` stays available as a fallback.
- `GET /api/market/:good/history` on the live server returns all venues combined (`venueId: null`).

**Mock server**
- Run: `pnpm dev:mock` → http://127.0.0.1:3000 (override with `PORT`, `HOST`). Judge routes are on in mock unless `JUDGE_MODE=0`. The mock world starts on day 5 (tick 120) so sparklines have history; the first ship docks at tick 140 (~50 s), a storm hits at tick 204 (~3.5 min) and repeats every 15 min; Ludo the salt-panner starts closed (invest to reopen, or the Town Fund rescues him after 5 game days).
- `pnpm dev:mock` serves scripted, protocol-valid data on the same endpoints (ticking clock, price changes, NPC reasoning, one closed merchant, a Storm, a ship arrival, feed items, plausible acks and errors). Switching to the real sim later needs no client changes. Target: real sim behind the same endpoints by the evening of Nov 10.
- Need a protocol change? Write a request to the backend owner (what and why); don't edit `packages/shared`.
