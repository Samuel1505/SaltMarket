// pnpm sim:week --seed 42 [--storm-day 3] [--flood-day N] [--close-day N --invest-day M] [--warmup 5]
// Headless "Watch a week": the same sandbox the time-lapse panel streams, printed as a story table.
// Exits non-zero if any invariant fails.
import { GOODS } from '@saltmarket/shared/config';
import { checkInvariants, createWorld, step, Timelapse, type Shock } from '@saltmarket/sim';
import { arg } from './args.js';

const seed = arg('seed', 42);
const warmup = arg('warmup', 5); // days of normal trading first, so the week starts from a lived-in town
const shocks: Shock[] = [];
const storm = arg('storm-day', -1);
const flood = arg('flood-day', -1);
const close = arg('close-day', -1);
const invest = arg('invest-day', -1);
if (storm >= 0) shocks.push({ kind: 'storm', day: storm });
if (flood >= 0) shocks.push({ kind: 'flood', good: 'timber', qty: 200, day: flood });
if (close >= 0) shocks.push({ kind: 'close_merchant', day: close, ...(invest >= 0 ? { investDay: invest } : {}) });

const s = createWorld(seed);
for (let i = 0; i < warmup * 24; i++) step(s);
const tl = new Timelapse(s, shocks, 7);
const m = (p: number | null) => (p === null ? '   -' : (p / 100).toFixed(1).padStart(5));
console.log(`Watch a week  seed=${seed} warmup=${warmup}d shocks=${shocks.map((x) => `${x.kind}@day${x.day}`).join(', ') || 'none'}\n`);
console.log(['day', 'hr', ...GOODS.map((g) => g.slice(0, 6).padStart(6)), ' ceil', 'ship', 'closed'].join(' '));
let failed = false;
while (!tl.done) {
  const f = tl.next();
  const bad = checkInvariants(tl.world as never);
  if (bad.length) { console.error(`INVARIANT FAILURE: ${bad.join('; ')}`); failed = true; break; }
  if (f.hour % 12 === 0 || f.notes.length) {
    const closed = f.merchants.filter((x) => x.status === 'closed').map((x) => x.name).join(',') || '-';
    console.log([String(f.day + 1).padStart(3), String(f.hour).padStart(2), ...GOODS.map((g) => m(f.prices[g]).padStart(6)), m(f.captainCeilingPips), f.shipDocked ? 'dock' : '  - ', closed].join(' ') + (f.events.length ? `  [${f.events.join(',')}]` : ''));
    for (const n of f.notes) console.log(`         · ${n.name}: ${n.text}`);
  }
}
console.log('\nSummary:');
for (const l of tl.summary()) console.log(`  ${l}`);
console.log(failed ? '\ninvariants: FAILED' : '\ninvariants: ok (checked every frame)');
process.exit(failed ? 1 : 0);
