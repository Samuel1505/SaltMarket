# FRONTEND_NOTES.md: emil-design-eng, in our words

Summary of the rules in `emil-design-eng/SKILL.md` (emilkowalski/skills, folder hash `e79b9cc03e`, installed 2026-11-12), written down so later sessions don't need to re-read the skill. The skill text is not copied here. How we apply each rule is in `apps/web/src/styles/tokens.css` and `tokens.motion.ts`.

## Should it animate at all?
- Decide by how often the player sees it. Things seen 100+ times a day (keyboard actions, toggles) never animate. Things seen tens of times a day (hover, list navigation) get little or no motion. Occasional things (drawers, toasts, popovers) get standard motion. Rare moments (first gather, ship arrival) may get some delight.
- Never animate keyboard-initiated actions.
- Every animation needs a purpose: spatial consistency, state change, explanation, press feedback, or avoiding a jarring jump. "Looks cool" is not enough for something seen often.
- **Saltmarket:** no motion on per-tick numbers, list re-sorts or meters. Motion goes on press feedback, the "+N good" pop, popovers, toasts, and the ship arrival only.

## Easing
- Entering or exiting: **ease-out**. Moving on screen: **ease-in-out**. Hover and color: `ease`. Constant progress: `linear`. **Never ease-in** for UI.
- Built-in CSS curves are too weak. Use these exact curves:
  - `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`
  - `--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1)`
  - `--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1)` (iOS-like sheet)

## Duration budgets
| Element | Budget | Our token |
| --- | --- | --- |
| Button press | 100–160 ms | `--dur-press` 120 ms |
| Tooltip / small popover | 125–200 ms | `--dur-tooltip` 150 ms |
| Dropdown / select | 150–250 ms | `--dur-dropdown` 200 ms |
| Modal / drawer | 200–500 ms | `--dur-drawer` 300 ms |
| UI in general | under 300 ms | test fails above 300 ms |

Exit can be faster than enter. Where the user is deciding, motion can be slow; where the system is responding, it should be fast.

## Components
- Pressables scale to 0.95–0.98 on `:active` (we use 0.97) with a fast transition.
- Never enter from `scale(0)`. Start at about 0.95 with opacity 0.
- Popovers scale from their trigger (`transform-origin: var(--transform-origin)`). Modals stay centered.
- Tooltips get a delay on the first open; adjacent ones open instantly, with no animation.
- Use CSS **transitions, not keyframes**, for anything that can be re-triggered (toasts, pops, toggles), because transitions retarget mid-flight. Use `@starting-style` (or a `data-mounted` attribute) for enter states.
- A `blur(2px)` can hide a crossfade that looks like two objects swapping.
- Prefer percentage translates (`translateY(100%)`) over pixel offsets.

## Springs
- Use springs only for drags with momentum, interruptible gestures, and decorative "alive" moments. Apple-style parameters are `{ duration: 0.5, bounce: 0.2 }`. Keep bounce between 0.1 and 0.3, and avoid it in most UI.
- **Saltmarket:** the ship arrival only.

## Performance
- Animate only `transform` and `opacity` (plus `clip-path` for reveals). Never width, height, padding or margin.
- Changing a CSS variable on a parent restyles every child, so set `transform` directly on the element.
- CSS and WAAPI run off the main thread, while rAF and JS-driven motion drop frames under load. We use WAAPI for the gather cooldown bar.
- Keep blur under 20 px.

## Accessibility
- Reduced motion means gentler motion, not none: keep opacity and color, remove movement and scale. Our `--press-scale` becomes 1, and pops and popovers fade without moving.
- Gate hover effects behind `@media (hover: hover) and (pointer: fine)`.

## Reviews
- Reviews of UI code use one table with Before / After / Why columns.
- Look at motion again the next day, in slow motion and frame by frame.
- Review checklist: no `transition: all`, no `scale(0)`, no ease-in, origin-aware popovers, no keyboard-triggered animation, nothing over 300 ms, hover gated, transitions rather than keyframes for re-triggered UI, exit faster than enter, small stagger (30–80 ms).
