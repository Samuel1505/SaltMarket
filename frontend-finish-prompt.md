Finish the Saltmarket frontend and make it look genuinely good. Today is Nov 12. The deadline is Nov 14 23:59 UTC, and we want to submit by **12:00 UTC on Nov 14**. The backend and the NEAR ledger are done and live, so you only build the UI.

**Order of work:**
1. A quick palette and font swap in the token file only (about 45 minutes).
2. All the missing screens.
3. Layout polish, last.

Where things stand (I checked your branch on Nov 12 against the real economy): sign-in, gather, Harbor Market sell/buy, merchant cards with reasoning, and Invest all work. The first trade takes about 7 s, with no console errors. Missing: crafting and the stall, selling to the Captain, the Storm/judge panel, Watch a week, Exchange Halls, the Ledger drawer, the feed and the leaderboard. Those missing pieces are most of what the judges score. That's why they come before the layout polish, and why the look change up front is kept to a cheap token swap.

## Setup (about 10 minutes)

1. Read CLAUDE.md, docs/FRONTEND_HANDOFF.md (its §7 is the feature guide and §10 is the acceptance checklist), docs/FRONTEND.md, docs/FRONTEND_NOTES.md, docs/TRACK_BRIEF.md and packages/shared/src/protocol.ts. Then read your own status in CLAUDE.md §11.
2. Emil Kowalski's skills are already installed in ~/.claude/skills. Re-read emil-design-eng/SKILL.md before any UI code. Use animate, review-animations and break-ui as described in docs/FRONTEND.md §3.
3. Work only in apps/web. If you need a protocol or server change, write it up as a request. You may make two changes outside apps/web:
   - make root `pnpm dev` start the web app as well as the server;
   - add `apps/web/src/**/*.test.ts` to the root vitest include.
4. **Which server to develop against. This matters.** Port 3000 on this machine is the LIVE testnet demo server: its world is tied to the deployed contract, and every trade there settles on chain. Never point the web app at it, and never touch ~/Desktop/dev/saltmarket-backend. Run your own real sim, with judge routes, on a separate port and a separate world file:

   ```
   PORT=3100 JUDGE_MODE=1 SNAPSHOT_PATH=/tmp/sm-web/world.json pnpm --filter @saltmarket/server dev
   SALTMARKET_SERVER=http://127.0.0.1:3100 pnpm --filter @saltmarket/web dev
   ```

   Delete that world.json whenever you want a fresh town. `pnpm dev:mock` (with `PORT=3100`) is still there if you need scripted data, such as a ledger in `near` mode. When you change root `pnpm dev`, keep these ports configurable.

## Step 1: palette and font swap (about 45 minutes, token file only)

Change only `apps/web/src/styles/tokens.css`, plus the one import line the font needs. The guard test already keeps every colour in that file, so this restyles the whole app at once. Don't touch layout or components in this step.

Direction: **calm, premium "harbor at dusk"**. You choose the exact values; this is the brief.

- **Colour:**
  - `color-scheme: dark` with a deep blue-grey background.
  - Two or three surface steps just above it.
  - Warm paper-white text with a muted secondary.
  - One gold accent for marks.
  - Soft teal for up, muted coral for down.
  - Hairline borders a little lighter than the surface.
  - Check contrast (body text at least 4.5:1). ▲/▼ always go with the colour.
- **Surfaces:** replace the heavy shadow tokens with subtle layered depth (a faint top highlight and a soft low shadow) and keep the borders crisp.
- **Type:**
  - One sans family, self-hosted through an npm package such as `@fontsource-variable/inter`. No CDN: the demo must run offline.
  - Tabular numerals stay on for every number.
  - Nudge the type scale up so key numbers (purse, prices, ceiling) read large and confident.

Timebox: 45 minutes. When it's done, screenshot the Town view at 1440 and 390 px (see the screenshot loop) and fix anything the swap broke, such as unreadable text or a colour that no longer fits. Then commit and move on. Spacing and layout wait for Step 3.

## Step 2: build the missing screens (in this order, in the new palette)

Build function first. Keep each screen clean and tidy, but leave the deeper layout polish for Step 3.

1. **Stall and Captain.**
   - Stall panel: inventory, Craft barrel, Cure fish (6 fish + 3 salt + 1 barrel → 4 cured fish) with progress bars, upgrade and rent.
   - Selling cured fish to the Captain, with the moment the ship docks and a sale confirmation.
   - Acceptance: a fresh guest can go gather → craft → cure → sell to the docked Captain without instructions.
2. **Judge panel** (only with `?judge=1`): Storm, Fair Winds, Salt Glut, Force merchant broke (pick the merchant), and speed/pause. Place it so the Storm moment reads well on screen: banner, fish ▲ with "storm cut the catch", reasons changing on the cards.
3. **Watch a week.** A time-lapse panel that streams:
   - price lines for every good
   - merchants' cash and open/closed state
   - the Captain's ceiling
   - a scrolling feed of reasoning lines

   Let the user add shocks (a storm on day N, or close a merchant). Show the summary at `done`. Keep the charts calm: no per-tick animation. The live town must stay unchanged.
4. **Exchange Halls.** Buy a license, set the fee, see volume and fee income, and compare fees across halls. Invest on closed merchants, with payout lines.
5. **Ledger drawer** (judge mode): recent settlements from `/api/judge/ledger`. Show the mode and health, and "ledger: stuck at <batchId>" when degraded. Show explorer links only when `explorerUrl` is present; otherwise hide them, don't break.
6. **Feed and toasts.** Rate-limit the toasts and collapse repeats to "×3". Also a price flash with ▲/▼ and a simple leaderboard.

## Step 3: layout polish (last; start no later than Nov 13 afternoon)

- **Layout:**
  - Top bar: purse, day and time, ship countdown.
  - Left: your stall and the gather nodes.
  - Centre: the market board.
  - Right: merchant cards.
  - Bottom: the event feed.
  - At 390 px, stack into tabs with no horizontal scroll.
- **Spacing and hierarchy:**
  - Generous, consistent spacing from the spacing tokens.
  - One radius scale.
  - A clear heading, label and value hierarchy.
  - Columns and number baselines aligned.
- **Primitives:** make Button, Card, Badge, Meter and the popover feel finished. Nothing should look like a default browser control.
- **Motion:** every pressable control gets press feedback from the motion tokens. Popover reasoning on every merchant price. Respect prefers-reduced-motion.
- **Known bug:** the sale toast overlaps the merchant column at 1280 px.

## The screenshot loop (mandatory; this is how we avoid another ugly result)

Do this after the Step 1 swap, after each screen in Step 2, and on every screen in Step 3:

1. Use Playwright (a chromium build is cached on this machine) to screenshot the Town view, plus the screen you just built, at **1440, 1280 and 390 px**, against your 3100 server with a real game state (gathered goods, a docked ship, one closed merchant, a storm on).
2. **Open the PNGs with your Read tool and look at them.** Check them against this list:
   - misaligned columns or baselines
   - text that wraps or truncates badly
   - inconsistent spacing or radii
   - more than one accent colour competing
   - low contrast
   - empty or ugly states
   - anything overlapping
   - anything that looks like a default browser control
3. Fix what you find and screenshot again. Move on only when you would show it to a judge.
4. Then run break-ui on the new component: long names, 7-digit marks, empty inventory, a closed merchant, 20 toasts at once, 0 and 50 players. Run review-animations on any motion you changed.

## Cut order (decided now; apply it without asking)

If you are behind schedule, cut from the top of this list down:

1. Leaderboard
2. Toast polish (rate-limiting and "×3" collapse; a plain toast is enough)
3. Price flash (keep the ▲/▼ glyph)
4. Halls comparison view (keep buy, set fee and income)
5. Step 3 extras beyond the layout grid, spacing and the 390 px tabs (primitive refinements, extra motion)

**Never cut:**
- the Step 1 palette and font swap
- stall and crafting
- Captain sale
- Storm button
- Watch a week
- buying a Hall and setting its fee
- Ledger drawer
- reasoning popovers
- the 390 px layout

## Schedule (UTC)

| When | Goal |
| --- | --- |
| Nov 12 tonight | Setup, Step 1 palette and font swap (45 min), then Stall and Captain sale and the judge panel with Storm. Commit. |
| Nov 13 morning | Watch a week, Halls and Invest, Ledger drawer, feed. |
| Nov 13 afternoon and evening | Step 3 layout polish, with the screenshot loop on every screen. Test Privy login against your local real server: the same player after a reload and after a server restart. If Privy fails, guest login stays and you write it in your status. |
| Nov 14 by 10:00 | Bug fixes only. Fill the README's "frontend owner" sections. Clean-clone test: fresh clone → `pnpm install` → `pnpm dev` → play the first trade. |
| Nov 14 12:00 | We submit. |

If a block runs over by more than 2 hours, apply the cut order instead of letting the schedule slip.

## Rules

- **Tokens and motion:** tokens only (no inline durations, easing or colours). Animate transform and opacity only. Use CSS transitions for anything that re-triggers.
- **Chain words:** no chain vocabulary in player-facing text. Only `?judge=1` and the Ledger drawer may show it; the guard test enforces this.
- **Trade display:** render trades from acks and deltas, not optimistically.
- **Commits and pushes:**
  - Commit locally in small steps on `frontend/web`, staging only apps/web (plus the two root changes allowed above).
  - Other sessions use this checkout, so don't switch branches or run `git add -A`.
  - Don't push without my say-so.
- **Off limits:** don't touch the live server (port 3000), its data, ~/Desktop/dev/saltmarket-backend or the deployed contract.

## At the end of each session, give me

- Screenshots of the Town view at 1440 and 390 px, plus the screen you built, as full file paths.
- What works, checked against the docs/FRONTEND_HANDOFF.md §10 checklist.
- What is next, and anything you cut.
- Your updated frontend status in CLAUDE.md §11.

Start with Setup, then Step 1.
