// pnpm sim:headless --seed 42 --days 30 [--storm-day N]
// Runs the economy with no UI and prints a day-by-day table. Exits non-zero if any invariant fails.
import { GOODS } from '@saltmarket/shared/config';
import { burnMintRatio, checkInvariants, createWorld, marksSupply, medianPrice, scheduleEvent, step, volume } from '@saltmarket/sim';
import { arg } from './args.js';

const seed = arg('seed', 42);
const days = arg('days', 30);
const stormDay = arg('storm-day', -1);
const s = createWorld(seed);
const m = (p: number) => (p / 100).toFixed(1).padStart(6);
console.log(`Saltmarket headless  seed=${seed} days=${days}${stormDay >= 0 ? ` storm-day=${stormDay}` : ''}\n`);
console.log(['day', ...GOODS.map((g) => g.slice(0, 6).padStart(6)), ' vol', ' supply', ' minted', ' burned', ' b/m', 'ceil', 'fill', 'closed'].join(' '));
for (let d = 1; d <= days; d++) {
  if (d === stormDay) scheduleEvent(s, 'storm', s.tick + 1);
  for (let i = 0; i < 24; i++) {
    step(s);
    const bad = checkInvariants(s);
    if (bad.length) { console.error(`INVARIANT FAILURE at tick ${s.tick}:\n  ${bad.join('\n  ')}`); process.exit(1); }
  }
  const today = s.daily.find((x) => x.day === Math.floor(s.tick / 24) - 1) ?? { minted: 0, burned: 0 };
  const vol = GOODS.reduce((n, g) => n + volume(s, g).qty, 0);
  const closed = Object.values(s.npcs).filter((n) => n.status === 'closed').map((n) => n.id).join(',') || '-';
  const r = burnMintRatio(s);
  console.log([String(d).padStart(3), ...GOODS.map((g) => m(medianPrice(s, g, 24))), String(vol).padStart(4), m(marksSupply(s)).padStart(7), m(today.minted).padStart(7), m(today.burned).padStart(7), (r === null ? '  -' : r.toFixed(2)).padStart(4), m(s.ship.ceiling).slice(2), `${s.ship.filled}/${s.ship.volume}`.padStart(5), closed].join(' '));
}
console.log('\ninvariants: ok (checked every tick)');
