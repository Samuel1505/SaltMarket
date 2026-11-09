# FRONTEND_HANDOFF.md: building `apps/web` end to end

For the frontend owner (and their Claude Code session). This doc covers everything the web client needs from the backend: how to run it, what to build, how data flows, every endpoint and message with **real payloads captured from the server**, and the acceptance checklist.

Sources of truth:
- [`packages/shared/src/protocol.ts`](../packages/shared/src/protocol.ts) defines every message as a zod schema. If this doc and that file disagree, the file wins.
- [`docs/FRONTEND.md`](FRONTEND.md) covers design system and motion (Emil Kowalski skills).
- [`CLAUDE.md`](../CLAUDE.md) §3 and §9 hold the vocabulary, accessibility, and safety rules.

The backend owner keeps this doc current. Ask for protocol changes; don't edit `packages/shared`, `apps/server`, or `packages/sim` yourself.

---

## 0. Ten-line summary

1. `git checkout -b frontend/web origin/backend/foundation`, then `pnpm install`.
2. Run a backend: `pnpm dev:mock` (scripted, best for building screens) or `pnpm dev` (the real economy, offline). Both serve the same API on `http://127.0.0.1:3000`.
3. Create `apps/web` (Vite + React + TS). Depend on `@saltmarket/shared` (`workspace:*`) and import schemas from `@saltmarket/shared/protocol` and helpers from `@saltmarket/shared/client`.
4. Boot: log in (`POST /api/auth/login`), open `ws://…/ws?token=…`, wait for `hello` then `snapshot`, keep the world in a store, run `applyDelta` on every `delta`, `applyFeed` on every `feed`.
5. Every action is a WS message with a `cmdId`. The server answers each with exactly one `ack`; show its `message` as a toast.
6. Money is integer **pips** (100 pips = 1 mark). Display with `formatMarks`. Never do float maths on money.
7. Required by the track: a reasoning tooltip on every merchant price and card, "Watch a week", Invest on closed merchants, Storm in the judge panel, and the Ledger drawer.
8. Player-facing text must never say wallet, token, gas, mint, tx, address, NEAR, or blockchain. Only the judge panel and Ledger drawer may.
9. Social login is Privy: `@privy-io/react-auth`, then send `getAccessToken()` as `credential`.
10. Done = the acceptance checklist (§10) passes against `pnpm dev` and the live testnet server.

---

## 1. Setup

```bash
git fetch origin
git checkout -b frontend/web origin/backend/foundation   # the backend lives here; branch off it
pnpm install
pnpm dev:mock        # terminal 1: scripted world (ship docks ~50 s in, storm ~3.5 min, a closed merchant)
# or: pnpm dev       # real economy on an offline ledger (fresh world in data/world.json)
```

Create the web app inside the workspace (`apps/*` is already a workspace glob):

```bash
pnpm create vite apps/web --template react-ts
pnpm --filter web add @saltmarket/shared@workspace:* zod
```

Use a **Vite proxy** so the browser talks to one origin (no CORS questions, and the same code works in production behind one host):

```ts
// apps/web/vite.config.ts
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://127.0.0.1:3000', '/healthz': 'http://127.0.0.1:3000', '/ws': { target: 'ws://127.0.0.1:3000', ws: true } } },
});
```

(The server also allows cross-origin requests, so a direct `http://127.0.0.1:3000` also works.)

**Environment for the web app** (`apps/web/.env.local`, gitignored):
```
VITE_PRIVY_APP_ID=<Privy App ID: ask the backend owner; it is public, not a secret>
```
The Privy **App secret** stays on the server only. Never put it in the web app.

**Backend modes you will meet**

| Mode | Command | `serverMode` in `hello` | Notes |
| --- | --- | --- | --- |
| Mock | `pnpm dev:mock` | `mock` | Scripted, repeating story; accepts any social `credential`; judge routes on |
| Live, offline ledger | `pnpm dev` | `live` | Real economy; judge routes only with `JUDGE_MODE=1 pnpm dev` |
| Live, testnet | `LEDGER=near JUDGE_MODE=1 pnpm --filter @saltmarket/server start` (backend owner's machine) | `live` | Settles to NEAR testnet; this is the demo server |

Your code must not branch on the mode. It's the same protocol everywhere (both servers pass one conformance test suite).

---

## 2. What to build, mapped to how we're judged

The track is judged on the game loop and on visibly living NPC economics. These screens and elements are **required** (✱ = an explicit track requirement):

| Screen / element | Data | Why it matters |
| --- | --- | --- |
| **Top bar**: purse, day/hour, ship countdown | `me.marksPips`, `clock`, `ship` | Core loop |
| **Gather** buttons (Pier/Pans/Grove) with cooldown ring and "+2 fish" pop ✱ | `nodes[]`, `me.gather`, ack `gathered` | R1: players gather materials |
| **Market panel**: price board per good with ▲/▼ and why-line, best buy/sell, Sell/Buy/List dialog, venue selector | `quotes[]`, `offers[]`, `venues[]` | Core loop; R3/R4 prices from stock and demand |
| **Reasoning tooltip on every merchant price and card** ✱ | `offer.reason`, `npc.reasoning`, `GET /api/npcs/:id/explain` | R9 |
| **Stall panel**: inventory, Craft barrel / Cure fish with progress, rent, upgrade | `me.inventory`, `me.stall`, `catalog.recipes` | Core loop |
| **Ship**: docked/away, ceiling, filled/volume | `ship` | The demand engine |
| **NPC cards**: name, title, status, purse, headline reason, last 5 decisions; **Invest** when closed ✱ | `npcs[]` | R2, R5 |
| **Event feed + toasts** (storm, closure, reopen, ship) | `feed` | Legibility |
| **Exchange Halls**: buy a license, set fee, see fee income; rival Halls | `venues[]`, `me.hallIds`, acks | R12: player-owned markets |
| **"Watch a week"** time-lapse panel ✱ | WS `timelapse` frames | R10 |
| **Judge panel** (`?judge=1`): Storm / Fair Winds / Salt Glut / Force broke, speed | `POST /api/dev/event`, `/api/dev/speed` | The demo |
| **Ledger drawer** (`?judge=1`): settlements, tx hashes, balances sim vs chain, "stuck" banner | `GET /api/judge/ledger` | R6/R14: on-chain, but invisible to players |
| Leaderboard | `GET /api/leaderboard` | Nice to have |

Detailed guidance per feature is in §7.

---

## 3. Data flow (the part to get right first)

```
login (REST) ─► token ─► WebSocket /ws?token=…
                             │
     hello ─► snapshot ─► store.world = snapshot.world
                             │
   every ~2.5 s:  tick ─► delta ─► store.world = applyDelta(world, changes)
                          feed  ─► store.feed  = applyFeed(feed, items)
   on your action: send {t, cmdId,…} ─► ack (exactly one) ─► toast(ack.message)
                                     └► delta (immediately, your new purse/inventory) + feed
```

Rules:
- **Use the helpers.** `import { applyDelta, applyFeed, formatMarks, formatBps, gatherReadyIn, shipTimers, quoteFor, offersFor, npcAction, trendGlyph, cmd } from '@saltmarket/shared/client'`. They're tested, and they encode which fields replace and which upsert (by which key).
- **Validate incoming messages** with `ServerMessage.safeParse(JSON.parse(e.data))`. **Ignore unknown `t`** and unknown fields (newer servers may add them).
- **No optimistic trades.** Render purse and inventory from the server (the `delta` that follows your `ack` arrives immediately). Optimistic UI is only for button pressed and disabled states.
- **Clock.** Interpolate smoothly between ticks with `clock.realMsPerTick`, but compute game logic (cooldowns, timers) from `clock.tick` and the helpers.
- **Reconnect.** On close, reconnect with backoff (1 s, 2 s, 4 s, max 15 s). The server sends a fresh `hello` and `snapshot`; replace the world. Show a gentle "Reconnecting…" banner.
- **Session.** Keep the session token in `localStorage` (wrapped in try/catch). If the WS `hello` comes back with `playerId: null`, the token is no longer valid: log in again.
- **Spectators.** A socket without a token gets everything but `me: null`, and every command is refused with `UNAUTHORIZED`. Use this for "Watch the town" before sign-in.

A minimal store (Zustand shown; any store works):

```ts
import { create } from 'zustand';
import { ServerMessage, type WorldSnapshot, type FeedItem, type ClientMessage } from '@saltmarket/shared/protocol';
import { applyDelta, applyFeed } from '@saltmarket/shared/client';

type Ack = Extract<ServerMessage, { t: 'ack' }>;
type S = { world: WorldSnapshot | null; feed: FeedItem[]; pending: Map<string, (a: Ack) => void>; ws?: WebSocket };
export const useGame = create<S>(() => ({ world: null, feed: [], pending: new Map() }));

export function connect(token: string | null) {
  const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws${token ? `?token=${token}` : ''}`);
  ws.onmessage = (e) => {
    const r = ServerMessage.safeParse(JSON.parse(e.data));
    if (!r.success) return;                       // unknown or newer message: ignore
    const m = r.data;
    const s = useGame.getState();
    if (m.t === 'snapshot') useGame.setState({ world: m.world, feed: m.world.feed });
    else if (m.t === 'delta' && s.world) useGame.setState({ world: applyDelta(s.world, m.changes) });
    else if (m.t === 'feed') useGame.setState({ feed: applyFeed(s.feed, m.items) });
    else if (m.t === 'ack') { s.pending.get(m.cmdId)?.(m); s.pending.delete(m.cmdId); }
  };
  useGame.setState({ ws });
}

/** send(cmd({ t: 'gather', node: 'pier' })) → resolves with the ack */
export function send(m: ClientMessage): Promise<Ack> {
  const s = useGame.getState();
  return new Promise((resolve) => { s.pending.set(m.cmdId, resolve); s.ws?.send(JSON.stringify(m)); });
}
```

---

## 4. Signing in

### Guest (always available; use it first)
```http
POST /api/auth/login   {"provider":"guest","displayName":"Mira"}
→ {"ok":true,"data":{"token":"<session token>","playerId":"p-41cd9be1","displayName":"Mira","provider":"guest"}}
```

### Social / email (Privy)
Verified against `@privy-io/react-auth` 3.51.x types: `PrivyProvider` takes `appId` and `config.loginMethods`; `usePrivy()` returns `ready`, `authenticated`, `login()`, `logout()`, and `getAccessToken(): Promise<string | null>`. (3.51.3 was released Nov 5. If pnpm refuses it as too new, pin 3.51.1.)

```tsx
import { PrivyProvider, usePrivy } from '@privy-io/react-auth';

<PrivyProvider appId={import.meta.env.VITE_PRIVY_APP_ID} config={{ loginMethods: ['email', 'google'] }}>
  <App />
</PrivyProvider>

function SignIn() {
  const { ready, authenticated, login, getAccessToken } = usePrivy();
  // 1) Privy modal  2) exchange Privy's token for a game session
  async function enter() {
    if (!authenticated) return login();
    const credential = await getAccessToken();
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'social', credential, displayName }) }).then((x) => x.json());
    if (r.ok) connect(r.data.token);
    else if (r.code === 'SOCIAL_UNAVAILABLE') showGuestOnly();       // server not configured: offer guest
    else toast(r.message);                                             // BAD_CREDENTIAL: ask to sign in again
  }
}
```
- The same Privy user always gets the same player, also after server restarts.
- The game doesn't use Privy's embedded wallet. Never show wallet wording. If Privy's modal offers a wallet option, turn it off in the Privy dashboard or `config`.
- Login methods (email, Google, …) must also be enabled in the Privy dashboard.

---

## 5. REST endpoints

Every response is `{ ok: true, data }` or `{ ok: false, code, message }`. `message` is friendly and can be shown to players as is. Send `Authorization: Bearer <token>` where you have one. Paths are exported as `ROUTES`.

| Call | Returns | Notes |
| --- | --- | --- |
| `POST /api/auth/login` | `Session` | §4 |
| `GET /api/world` | `WorldSnapshot` | Same as the WS `snapshot`; useful for resync |
| `GET /api/npcs` | `{ npcs }` | |
| `GET /api/npcs/:id/explain` | `Explain` | Tooltip payload; includes `rulesFile` |
| `GET /api/market/:good/history?days=5&venueId=` | `MarketHistory` | 6-tick buckets, oldest first; omit `venueId` for all venues |
| `GET /api/leaderboard` | `Leaderboard` | `isMe` marks your rows |
| `POST /api/timelapse` | `{ timelapseId, totalTicks }` | Frames stream over your WS (or use the WS message) |
| `GET /healthz` | `Health` (no envelope) | |
| `POST /api/dev/event` `{kind, npcId?}` | `{ message }` | Judge only; `kind`: `storm`, `fair_winds`, `salt_glut`, `force_broke` |
| `POST /api/dev/speed` `{speed?, paused?}` | `{ message }` | Judge only; speed 1–64 |
| `GET /api/judge/ledger?limit=20` | `JudgeLedger` | Judge only |

Judge-only routes return `403 JUDGE_ONLY` unless the server runs with `JUDGE_MODE=1`. Show the judge panel only with `?judge=1` in the page URL.

---

## 6. WebSocket messages, with real payloads

### Server → client
```jsonc
{"t":"hello","protocolVersion":"0.2.0","serverMode":"mock","playerId":"p-41cd9be1"}
{"t":"snapshot","world":{ /* protocolVersion, serverMode, clock, catalog, me, venues, quotes, offers, nodes, npcs, ship, events, feed, town */ }}
{"t":"tick","tick":121,"day":5,"hour":1}
{"t":"delta","tick":121,"changes":{ /* clock (always) + me, venues, quotes, offers, removedOfferIds, nodes, npcs, ship, events, town */ }}
{"t":"feed","items":[{"kind":"trade","text":"Sold 2 fish to Old Pell's Smokehouse for 18.4 marks","notable":false,"good":"fish","id":"f-3","tick":120,"repeat":1,"mine":true}]}
{"t":"ack","cmdId":"c1","ok":true,"message":"+2 fish","result":{"kind":"gathered","node":"pier","good":"fish","qty":2,"readyAtTick":124}}
{"t":"ack","cmdId":"c2","ok":false,"code":"COOLDOWN","message":"You're still catching your breath. Ready again in 10 s."}
{"t":"ack","cmdId":"c3","ok":true,"message":"Sold 2 fish to Old Pell's Smokehouse for 18.4 marks","result":{"kind":"trade","side":"sell","good":"fish","qty":2,"avgPricePips":938,"totalPips":1838,"taxPips":38,"feePips":0,"counterparties":["Old Pell's Smokehouse"]}}
{"t":"timelapse","timelapseId":"tl-4","phase":"started"|"frame"|"done"|"stopped","totalTicks":168,"frame":{…},"summary":["…"]}
{"t":"error","code":"BAD_REQUEST","message":"That message was not understood."}   // only when there is no cmdId to ack
{"t":"pong","cmdId":"p1"}
```

### Client → server (build with `cmd({...})`, which adds `cmdId`)
```ts
cmd({ t: 'gather', node: 'pier' | 'pans' | 'grove' })
cmd({ t: 'sell', good, qty, venueId: 'harbor', minPricePips? })   // sell now into the best buy offer
cmd({ t: 'buy',  good, qty, venueId, maxPricePips? })             // buy now from the best sell offer
cmd({ t: 'list', good, qty, pricePips, venueId })                 // post your own sell offer
cmd({ t: 'bid',  good, qty, pricePips, venueId: 'hall-…' })       // standing buy offer, Halls only
cmd({ t: 'cancel', orderId })
cmd({ t: 'craft', recipe: 'craft_barrel' | 'cure_fish' })
cmd({ t: 'upgradeStall' })
cmd({ t: 'buyHall', name? })   cmd({ t: 'setHallFee', hallId, bps })   // 0–500 bps
cmd({ t: 'invest', npcId, amountPips })                            // only closed merchants; catalog.investMin/MaxPips
cmd({ t: 'timelapse', action: 'start' | 'stop', days?, wallSeconds?, shocks? })
cmd({ t: 'ping' })
```

### Shapes you will render most (real examples)
```jsonc
// me
{"playerId":"p-41cd9be1","displayName":"Mira","marksPips":30000,"inventory":{"fish":5,"salt":2,"timber":0,"barrel":0,"cured_fish":0},
 "stall":{"level":1,"maxLevel":2,"craftSlots":1,"crafting":[],"upgradeCostPips":25000,"rentPerDayPips":1500,"rentGraceDaysLeft":3,"arrearsPips":0,"shuttered":false},
 "gather":{"readyAtTick":120,"gatheredToday":0,"dailyCap":12},"openOrders":[],"hallIds":[],"investments":[],"netWorthPips":36330}
// quote (one per venue × good): the price board
{"venueId":"harbor","good":"fish","bestBidPips":938,"bestBidQty":8,"bestAskPips":1050,"bestAskQty":10,"lastPips":1020,"median2dPips":993,"change24hBps":-29,"trend":"flat","volume24h":69}
// (when the price moved ≥ 3%, also: "trendReason":"Fish ▲ 40%: storm cut the catch")
// offer (merchant offers carry their own tooltip reason)
{"id":"fisher-1:harbor:fish:sell","venueId":"harbor","good":"fish","side":"sell","pricePips":1050,"qty":10,
 "owner":{"kind":"npc","id":"fisher-1","name":"Oskar","isMe":false},
 "reason":{"code":"STEADY","text":"Fair catch today. Holding near 10.2 marks.","detail":"Stock 10 of 12, Price change (24h) 0%, Margin 10%",
           "factors":[{"key":"stock","label":"Stock","value":10,"unit":"count","of":12}, …],"tick":120},"createdTick":120}
// a closed merchant (show "Closed: needs investment" + Invest)
{"id":"salt-2","name":"Ludo","title":"Salt-panner","status":"closed","purse":{"pips":400,"trend":"down"},
 "reasoning":{"code":"SHOP_CLOSED_BROKE","text":"Out of cash after a slow week. Closing until someone backs me.","detail":"Purse 4 marks, Days short of cash 3",…},
 "closed":{"sinceTick":120,"investMinPips":15000,"investMaxPips":60000,"rescueInTicks":120}, …}
// node, ship, hall venue
{"id":"pier","name":"Pier","good":"fish","stock":30,"cap":40,"regenPerDay":20,"yieldNow":2,"gatherers24h":0}
{"captainNpcId":"captain","name":"the Gull","status":"away","ticksToArrival":20,"ticksToDeparture":0,"ceilingPips":5000,"volume":16,"filled":0}
{"id":"hall-1","kind":"hall","name":"Gull's Rest Exchange","ownerName":"Wren","ownerIsMe":false,"feeBps":300,"taxBps":200,"frictionBps":0,"volume24hPips":342825,"feeIncome24hPips":10285,"feeIncomeTotalPips":184000}
```

### Error codes (`ack.code` / REST `code`)
Treat codes as strings: new ones may appear. Known codes (exported as `ERROR_CODES`): `BAD_REQUEST, UNAUTHORIZED, NOT_FOUND, INSUFFICIENT_FUNDS, INSUFFICIENT_GOODS, NO_BUYER, NO_SELLER, COOLDOWN, DAILY_CAP, NODE_DEPLETED, CRAFT_BUSY, STALL_SHUTTERED, SELF_TRADE, NOT_HALL_OWNER, FEE_OUT_OF_RANGE, MERCHANT_OPEN, MERCHANT_HAS_INVESTOR, INVEST_OUT_OF_RANGE, MAX_UPGRADE, RATE_LIMITED, TIMELAPSE_BUSY, JUDGE_ONLY, VERSION_MISMATCH, SOCIAL_UNAVAILABLE, BAD_CREDENTIAL, INTERNAL`. **Always show `message`.** Use `code` only to choose behaviour (e.g. `COOLDOWN` → keep the button disabled; `UNAUTHORIZED` → sign in).

---

## 7. Feature guide

**Gather.**
- Three buttons, one per node. Disable while `gatherReadyIn(world) > 0`, show a cooldown ring (10 s at normal speed), and show `"+N fish"` from the ack.
- Show node fullness (`stock/cap`). `yieldNow` is 2, 1, or 0 (0 = "picked clean, refills overnight").
- Show `me.gather.gatheredToday / dailyCap`; the cap counts units.

**Sell / buy (Harbor Market).**
- Sell = sell now to the best buy offer (merchants post buy offers here; the Captain's offer appears while the ship is docked).
- Buy = buy now from the cheapest sell offer. The Harbor allows **one purchase per hour per player**; a second one returns `RATE_LIMITED` with a friendly message.
- Show the price you'll get: `offersFor(world, 'harbor', good, 'buy')[0]`. The harbor tax is 2% (`catalog.harborTaxBps`); the ack's `result` has the exact `totalPips`, `taxPips`, and `feePips`.

**List / bid / cancel.** List posts your own sell offer. Bid (Halls only) posts a standing buy offer. Your open offers are in `me.openOrders`; cancel by `orderId`.

**Craft.**
- Recipes come from `catalog.recipes`: barrel = 3 timber, 3 ticks; cure = 6 fish + 3 salt + 1 barrel → 4 cured fish, 6 ticks.
- Progress comes from `me.stall.crafting[]` (`startedTick`, `doneTick`) against `clock.tick`.
- `craftSlots` is 1, or 2 after an upgrade.

**Ship.**
- Countdown via `shipTimers(world)`. While docked, show "Captain buys cured fish up to X marks", with `filled/volume`.
- The ship's arrival is the one decorative moment allowed a spring animation (FRONTEND.md).

**Merchant tooltips ✱.**
- On hover, tap, or keyboard focus of any merchant price or card: show `reason.text` (bold) plus `reason.detail` (one muted line).
- For the full tooltip call `GET /api/npcs/:id/explain`. It returns a reason per good and side, and `rulesFile`; link that in the judge panel ("Read the rules").
- `factors[]` are structured if you'd rather render chips: `unit` is `pips`, `pct`, `count`, `ticks`, or `text`; `of` = "3 of 14".
- **Never convey direction by colour alone**: use `trendGlyph()` (▲ ▼ –), or the ▲/▼ already in `quote.trendReason`.

**NPC cards.**
- Show status badge, purse, the headline `reasoning.text`, and the last 5 `recent` decisions (show `×N` when `repeat > 1`).
- When `npcAction(npc) === 'invest'`, show **Invest**. The amount must be between `closed.investMinPips` and `closed.investMaxPips`. Show "Rescued by the Town Fund in X s" from `closed.rescueInTicks`.
- `npc.investor.isMe` → "You backed this shop: paid X of Y".

**Halls.**
- "Open an Exchange Hall" costs `catalog.hallLicensePips` (400 marks).
- The owner sees a fee slider from 0 to `catalog.hallFeeMaxBps` (0–5%) and fee income (`venues[].feeIncome24hPips`, `feeIncomeTotalPips`).
- Everyone sees a venue selector with each venue's fee. Merchants move to the cheapest Hall the next day.

**Feed and toasts.**
- The feed panel shows everything. Toast only `notable: true` items (storm, closures, reopenings, ship) and the player's own acks; cap the number of visible toasts.
- Collapse repeats with `repeat`. Lifecycle kinds are `MERCHANT_CLOSED`, `MERCHANT_REOPENED`, and `MERCHANT_RESCUED`; unknown kinds render as plain lines.

**Events.** `events[]` lists active shocks (`label`, `description`, `endsTick`). For a storm, use a subtle tint plus a banner, no screen shake, and keep prices legible.

**"Watch a week" ✱.**
- Start: `cmd({ t: 'timelapse', action: 'start', shocks: [{ kind: 'storm', day: 2 }] })`. Optional shocks: `flood` (a good, qty, day) and `close_merchant` (day, investDay?).
- The server sends 28 frames over about 60 s (`frame.prices`, `volume`, `merchants[]` with status, `captainCeilingPips`, `marksSupplyPips`, `burnMintRatio`, `events`, `notes[]` = reason lines to scroll), then `phase: 'done'` with `summary[]`.
- It runs on a copy of the town; the live town keeps going. One time-lapse per player at a time (`TIMELAPSE_BUSY`).
- Draw price lines for the 5 goods plus the ceiling. Let the data be the motion.

**Judge panel (`?judge=1`).**
- Buttons call `POST /api/dev/event` with `storm`, `fair_winds`, `salt_glut`, or `force_broke` (plus an optional `npcId`), and speed control calls `POST /api/dev/speed`.
- Show the rules-file path. "Force broke" on the Cooper, then Invest, is the closure demo.

**Ledger drawer (`?judge=1`).** Real response from the live testnet server:
```jsonc
{"mode":"near","health":"ok","network":"testnet","contractId":"goods.samuelowen.testnet","queueDepth":0,"lastSettledTick":432,
 "settlements":[{"batchId":"408-432","tickFrom":408,"tickTo":432,"status":"settled","deltaCount":20,"attempts":1,"txHash":"6pLuWSgi2BMnVHU571Rns3eiRuucLdrFeUnom5fPfjUx"}, …],
 "accounts":[{"ownerKind":"townfund","ownerName":"Town Fund","accountId":"townfund.samuelowen.testnet","marksPips":120751,"ledgerMarksPips":120398}, …],
 "reconciliation":{"tick":432,"mismatches":0}}
```
- List settlements newest first, with status and tx hash.
- Link a tx to the testnet explorer `https://testnet.nearblocks.io`. The server sends `explorerUrl` only once the URL pattern is confirmed, so a plain copyable hash is fine.
- Account rows show sim vs last-settled marks; they differ between daily batches, which is expected.
- **Stuck state:** when `health` is `degraded`, a settlement row has `error` like `"ERR_INSUFFICIENT_BALANCE (needs a human)"`. Show a banner: "Ledger stuck at <batchId>: <error>". `mode: "memory"` = offline ledger (normal in dev).
- This is the **only** place chain words are allowed.

**Leaderboard.** `netWorth[]` and `hallIncome[]` (rank, name, value, `isMe`), plus `town` totals.

---

## 8. Rules that judges notice

- **Vocabulary.** Player-facing text uses marks, purse, stall, buy, sell, gather, cure, ship, invest, Hall. It never uses wallet, token, gas, mint, tx, address, NEAR, blockchain, or crypto. Add a test that greps `apps/web/src` outside `features/judge/` for those words (FRONTEND.md §6).
- **Numbers.** Use tabular numerals for prices and the purse, and `formatMarks` everywhere. Fixed-width slots avoid layout shift.
- **Accessibility.** Every action is keyboard operable; tooltips open on focus and on tap; direction is never shown by colour alone; contrast is AA.
- **Motion.** Follow FRONTEND.md: tokens only, transform/opacity only, `prefers-reduced-motion`, no animation on every-tick numbers.
- **Never block on the chain.** Nothing in the player UI waits on settlement. There is no spinner for chain activity.

---

## 9. Test data and demo accounts

- **Mock** (`pnpm dev:mock`): the ship docks about 50 s after start, a storm hits at about 3.5 min and repeats every 15 min, and Ludo the salt-panner starts closed. Any social `credential` string works.
- **Live demo world** (backend owner's machine, `~/Desktop/dev/saltmarket-backend`): two labeled demo accounts, "Demo · Ada" (owns a 1% Hall) and "Demo · Bram" (4% Hall). Their login tokens are in that machine's `data/world.json` (`tokens`). Ask the backend owner rather than copying the file. To act as one, open the WS with `?token=<that token>` and use the same token as the REST bearer.
- **Your own fresh world:** `pnpm demo:seed --out data/world.json --force && JUDGE_MODE=1 pnpm dev`. That's offline, so it never touches the testnet contract.
- **Don't** run `demo:seed` or delete `data/world.json` in `~/Desktop/dev/saltmarket-backend`. The testnet contract is tied to that world.

---

## 10. Acceptance checklist (frontend "done")

Against `pnpm dev` (and once against the live testnet server):

- [ ] A new player (guest) completes **gather → sell** within about 60 s without instructions; the purse goes up, and the toast shows the server's message.
- [ ] Gather → craft barrel → cure → sell to the docked Captain works; the craft progress and ship countdown are right.
- [ ] Hover, tap, or focus **any merchant price or card** → a tooltip with the reason and factors. "Read the rules" shows `packages/sim/src/pricing/merchant-rules.ts`.
- [ ] Judge panel → Storm → a banner appears, fish ▲ with "storm cut the catch", fishermen's reasons change, and the Smokehouse pauses; within a few game days prices relax.
- [ ] Judge panel → Force broke (Cooper) → "Closed: needs investment" → Invest 150 marks → it reopens; the feed shows `MERCHANT_REOPENED`.
- [ ] Buy a Hall, set a 1% fee → merchants move there the next day; fee income grows.
- [ ] "Watch a week" with a storm on day 2 → 28 frames in about a minute, a readable chart, notes scrolling, then the summary; the live town is unchanged.
- [ ] Ledger drawer on the testnet server shows `mode: near`, settled batches with tx hashes, and reconciliation 0 mismatches.
- [ ] Privy email or Google login → the same player after a page reload and after a server restart.
- [ ] Kill the server → "Reconnecting…" → restart → the world resyncs with no reload.
- [ ] The vocabulary test passes; keyboard-only play works; it is readable at 380 px wide.
- [ ] No console errors; unknown message types are ignored safely.

Suggested Playwright smoke test (TESTING_AND_DEMO §1): guest login → gather → sell → open a tooltip → Storm (judge) → banner visible.

---

## 11. Getting changes

- Need a field, message, or endpoint? Write a request to the backend owner (what and why). Changes are additive and bump `PROTOCOL_VERSION`'s minor number; your client keeps working because it ignores unknown fields.
- Found a mismatch between this doc and the server? Trust `protocol.ts`, and tell the backend owner so the doc gets fixed.
