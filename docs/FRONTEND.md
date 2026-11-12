# FRONTEND.md — Saltmarket (Emil Kowalski design-engineering approach)

How we build `apps/web`. The human wants the frontend built with **Emil Kowalski's UI skills and design-system pattern**: tokenized motion and styling, restrained purposeful animation, and polish in the small details. This file says how to apply that to a game UI. Product behavior lives in `GAME_DESIGN.md` and `GAME_LOOP.md`; data and API live in `ARCHITECTURE.md`.

> Credit: the skills are by Emil Kowalski (https://github.com/emilkowalski/skills, MIT per the skill catalog listing; his course is at animations.dev / aiforui.dev). We apply them; we do not copy their text into this repo.

---

## 1. Source of truth and precedence

1. **The installed skill files win on motion and polish decisions** (easing, duration, which properties to animate, when *not* to animate). Read the relevant `SKILL.md` before writing or reviewing any UI or animation code.
2. **This file wins on game-specific choices** (what to animate in a trading game, how tooltips and drawers map to our screens).
3. **`CLAUDE.md` wins over both** (safety rules, vocabulary rules, offline-first).
4. If the skill and this file seem to conflict, tell the human and propose a resolution. Do not silently pick one.

## 2. Install and verify (do in Phase 0, before any UI code)

Ask the human to approve installing third-party skill files into the project/agent environment. The repository README documents:

```bash
npx skills@latest add emilkowalski/skills
```

His own site also documents a shorter variant (`npx skills add emilkowalski/skill`) and says a more thorough skill set is part of a paid course. **Use the open repo** (`emilkowalski/skills`); do not buy anything or create accounts without the human's say-so.

After install:
- [ ] List the installed skills and **record the exact names and commit/version** in the "Verified facts" table (§10).
- [ ] Read `emil-design-eng/SKILL.md` fully. Summarize its rules in your own words in `docs/FRONTEND_NOTES.md` (create it) so later sessions don't need to re-derive them.
- [ ] If the install fails or the skill names differ from §3, adapt §3 to what actually exists. Do not invent skills.

## 3. Which skill to use when

Names below are from the repository's published list at the time of writing; confirm against what you installed.

| Skill | Use it for in Saltmarket |
| --- | --- |
| `emil-design-eng` | **Always on** for any component, layout, or animation decision. The main skill: mostly animation, plus design advice |
| `animate` | Building a specific animation from scratch (picks curve, duration, properties): Gather button feedback, price-change flash, storm banner |
| `prototype` | Comparing 2–3 variants of a key piece (Market panel layout, NPC card, ship countdown) with a switcher before committing |
| `pick-ui-library` | **Before adding any UI dependency** (toast, drawer, tooltip, select, charts). Do not hand-roll these or install unvetted packages |
| `ask-sonner` | Event-feed toasts if we use Sonner (setup, styling, fixes) |
| `apple-design` | Fluid, interruptible motion principles for drawers and gestures |
| `find-animation-opportunities` | After core screens exist: find where motion genuinely helps **and where not to animate** |
| `review-animations` | Strict review of motion code. Run at the end of Phase 3, Phase 5, and before submission |
| `improve-animations` | Audit all animations and produce prioritized fix plans (Phase 5 polish) |
| `break-ui` | Stress the UI with worst-case data: long display names, huge numbers, empty lists, 0 stock, 20 simultaneous toasts |

Workflow per UI task: **read skill → build → run `review-animations` on the diff → run `break-ui` on the new component → commit.**

## 4. The design-system pattern: tokens first, components second

Core idea from the skill: **all curves and durations are shared design tokens**; never hand-type near-identical cubic-beziers or durations inline.

### 4.1 File layout
```
apps/web/src/
├── styles/
│   ├── tokens.css          # CSS variables: color, type, space, radius, shadow, motion
│   ├── tokens.motion.ts    # same motion tokens for JS/spring use (single source; generate CSS from it or keep in sync with a test)
│   └── base.css            # reset, typography, focus ring, reduced-motion rules
├── ui/                     # primitives: Button, Tooltip, Drawer, Toast, Card, Stat, Badge, Tabs, Sparkline
├── features/               # game components built from primitives: StallPanel, MarketPanel, NpcCard...
└── lib/
```

### 4.2 Token categories (starting values; reconcile with the skill's recommendations)

| Category | Tokens |
| --- | --- |
| Color | `--bg`, `--surface`, `--surface-raised`, `--border`, `--text`, `--text-muted`, `--accent` (marks/gold), `--up`, `--down`, `--warn`, `--closed`; light and dark themes |
| Type | One sans family + tabular numerals for all prices (`font-variant-numeric: tabular-nums`) so changing numbers don't jitter |
| Space / radius | 4-px scale (`--space-1..8`), 3 radii (`--radius-sm/md/lg`) |
| Elevation | Prefer **solid borders and subtle layered shadows** over heavy semi-transparent shadows (the skill specifically calls out this class of mistake; follow its guidance) |
| Motion duration | `--dur-press` 120ms, `--dur-tooltip` 150ms, `--dur-dropdown` 200ms, `--dur-drawer` 300ms, `--dur-page` ≤ 300ms |
| Motion easing | `--ease-out` (default for entering/most UI), `--ease-in-out` (on-screen movement), `--ease-spring` (drag/gesture only). Exact curves come from the skill |

Duration budgets reflect the skill's published review rules: press feedback ~100–160 ms, tooltips/small popovers ~125–200 ms, dropdowns/selects ~150–250 ms, modals/drawers ~200–500 ms; keep UI motion generally **under 300 ms**.

### 4.3 Hard rules
- **No inline durations or easing curves** outside tokens. Add a lint or test that greps for raw `cubic-bezier(` and `ms` literals in component CSS.
- **Animate `transform` and `opacity`** only (plus `clip-path` where the skill says so). No animating width/height/top/left.
- **Use CSS transitions, not `@keyframes`, for dynamic UI** that can be re-triggered rapidly (toasts, toggles, price flashes), so motion is interruptible and retargets smoothly.
- **Springs** only for drag with momentum, interruptible gestures, and deliberately decorative moments (e.g., ship arrival).
- **Press feedback** on every pressable control (Buy, Sell, Gather, Cure, Invest) using `--dur-press`.
- **Honor `prefers-reduced-motion`:** replace movement with instant or opacity-only changes; the economy must be fully readable without motion.
- Components expose states explicitly: default, hover, pressed, focus-visible, disabled, loading, error, empty.

## 5. Game-specific UI patterns

| Element | Pattern |
| --- | --- |
| **Price numbers** | Tabular numerals. On change, a short color flash (`--up`/`--down`) via a CSS transition plus ▲/▼ glyph (never color alone). Throttle: do not re-animate if the value changed less than the rounding unit; batch updates per tick |
| **Sparklines** | Static SVG paths; animate only on first draw or when a new day closes, not every tick |
| **Reasoning tooltips (required by the track)** | Tooltip budget ~150 ms. First open has a small delay; moving between adjacent tooltips opens the next instantly (no repeated delay). Content: reason text + key factors from `explain()`. Must work on tap for touch. Keyboard focusable |
| **NPC cards** | Open/closed state is visually distinct (`--closed`); the **Invest** call to action appears only when closed; investor payouts show as a small ledger-free line ("Maren paid you 12 marks") |
| **Event feed** | Toasts for notable events only (storm, closure, reopening, ship docked); collapse repeats ("×3"); cap visible toasts; full history lives in the feed panel |
| **Drawers** | NPC detail, Hall screen, and the **Judge/Ledger drawer** use a vetted drawer primitive (see `pick-ui-library`) with interruptible, gesture-friendly motion |
| **Gather button** | Cooldown shown as a ring/progress via `transform`; press feedback; disabled state is clear; yield shown as a brief "+2 fish" pop (opacity/transform) |
| **Ship countdown / arrival** | Quiet countdown; the arrival is the one decorative moment allowed a spring |
| **Storm** | Subtle full-bleed tint and a banner; no screen shake. Must not reduce legibility of prices |
| **Time-lapse panel** | Mostly chart redraws; keep chrome motion minimal so the data is the show. Use CSS transitions for toggles; no keyframes on rapidly updating elements |
| **Leaderboard** | Rank changes animate position via transform, only when ranks change |

**What not to animate** (use `find-animation-opportunities` to confirm): every-tick number updates, list re-sorts on each tick, anything triggered dozens of times per minute, and high-frequency repeated actions where motion becomes friction.

## 6. Vocabulary and tone (from `CLAUDE.md` §9)

Player-facing copy uses *marks, stall, purse, buy, sell, ship, gather, invest*. Never: wallet, token, gas, mint, tx, address, NEAR, blockchain. Only the opt-in Judge panel may show chain terms. Add a test that scans `apps/web/src` for forbidden words outside `features/judge/`.

## 7. Accessibility and performance

- Contrast meets WCAG AA; visible `:focus-visible` rings; full keyboard operation of core actions.
- Hit targets ≥ 40 px on touch; layouts verified at ~380 px width (mobile) and desktop.
- Performance budget: 10 NPC cards + market panel updating each tick must hold 60 fps on a mid laptop. Use memoized selectors, batch WS deltas per animation frame, avoid re-rendering the whole tree on each tick.
- No layout shift on number changes (tabular numerals, fixed-width stat slots).

## 8. Build order for the frontend (maps to `BUILD_PLAN.md` Phase 3 and 5)

1. Install skills; write `FRONTEND_NOTES.md`; create `tokens.css` and `tokens.motion.ts`.
2. Primitives in `ui/`: Button (with press feedback), Card, Stat (tabular numerals + ▲/▼), Tooltip, Badge, Tabs, Drawer, Toast.
3. Town view skeleton with static data; verify at mobile and desktop widths.
4. Market panel + price flash + sparklines.
5. NPC cards + reasoning tooltips (required) + closed/invest state.
6. Stall panel, Gather button + cooldown ring, craft progress.
7. Event feed + toasts (rate-limited).
8. Hall screen, leaderboard, Judge panel, Ledger drawer, time-lapse panel.
9. Polish pass: `find-animation-opportunities`, `review-animations`, `improve-animations`, `break-ui`.

## 9. Acceptance checklist

- [ ] Skills installed; versions recorded (§10); `FRONTEND_NOTES.md` exists.
- [ ] Zero inline easing/duration literals in components (lint/test passes).
- [ ] Every pressable control has press feedback; every tooltip meets the timing budget and works on tap and keyboard.
- [ ] `prefers-reduced-motion` verified: the whole game remains understandable.
- [ ] `break-ui` pass done on: long display names, 7-digit marks, empty inventory, closed merchant, 20 toasts, 0 players, 50 players.
- [ ] `review-animations` run before the Phase 3 and Phase 5 gates and before submission; findings fixed or consciously waived.
- [ ] No forbidden vocabulary in player-facing copy.
- [ ] Screenshots/video for README captured from the polished UI.

## 10. Verified facts (fill in as you verify; keep dates)

| Topic | What was verified | Source URL | Date |
| --- | --- | --- | --- |
| Skills installed (names, version/commit) | `npx skills@latest add emilkowalski/skills -g -a claude-code` → `~/.claude/skills/`: animate (fe46ac6), animate-expo (6874701), animation-performance (a0261dd), animation-vocabulary (d495657), apple-design (cd509ae), ask-sonner (aeca3db), break-ui (f2a3441), choreograph (a3766de), emil-design-eng (e79b9cc), find-animation-opportunities (e644388), gestures (d30dfa5), improve-animations (d3ce6f3), mobile-native (fdad6e6), pick-ui-library (370e197), prototype (34cd3a3), remove-animations (e1d0608), review-animations (bede4e1), write-swift (bdefda3). Hashes are skill-folder hashes from `~/.agents/.skill-lock.json`. All §3 skills exist; extra: animation-performance, choreograph, gestures, mobile-native, remove-animations | https://github.com/emilkowalski/skills | 2026-11-12 |
| Skill license and attribution requirements | Not verified from the repo LICENSE yet (installed copies carry no license file); FRONTEND.md header says MIT per the catalog. Check before submission | https://github.com/emilkowalski/skills | 2026-11-12 |
| Recommended easing curves and duration rules from `emil-design-eng` | ease-out `cubic-bezier(0.23, 1, 0.32, 1)`, ease-in-out `cubic-bezier(0.77, 0, 0.175, 1)`, drawer `cubic-bezier(0.32, 0.72, 0, 1)`; press 100–160 ms, tooltip 125–200 ms, dropdown 150–250 ms, drawer 200–500 ms, UI < 300 ms. Summary in `docs/FRONTEND_NOTES.md` | `~/.claude/skills/emil-design-eng/SKILL.md` | 2026-11-12 |
| UI library choices from `pick-ui-library` (toast, drawer, tooltip, charts) | state: zustand 5.1; primitives (popover, drawer, dialog): `@base-ui/react` 1.9.0 (renamed from `@base-ui-components/react`); toasts: sonner 2.0.8; classNames: clsx 2.1. Charts (later): recharts (static) / Liveline (streaming). Reasoning tooltip uses base-ui **Popover** with `openOnHover` because Tooltip does not open on tap | `~/.claude/skills/pick-ui-library/SKILL.md`; base-ui docs bundled in the package | 2026-11-12 |
