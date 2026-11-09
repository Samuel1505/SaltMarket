// pnpm sim:tune [--seeds 10] [--days 30] [--bots 0]
// Runs ECONOMY §11 stability checks over many seeds and prints PASS/FAIL per check plus medians.
import { GOODS } from '@saltmarket/shared/config';
import { arg } from './args.js';
import { runSeed, verdict } from './tune-lib.js';

const seeds = arg('seeds', 10);
const days = arg('days', 30);
const bots = arg('bots', 0);
const reports = Array.from({ length: seeds }, (_, i) => runSeed(i + 1, days, bots));
const r0 = reports[0]!;
console.log(`seeds=${seeds} days=${days} bots=${bots}\nseed 1 daily medians (marks):`);
for (const g of GOODS) console.log(`  ${g.padEnd(10)} ${r0.medians[g].map((p) => (p / 100).toFixed(0).padStart(3)).join('')}`);
console.log(`  ceilings   ${r0.ceilings.map((c) => (c / 100).toFixed(0)).join(' ')}`);
console.log(`  fills      ${r0.fills.join(' ')}`);
console.log(`  closures   ${reports.map((r) => r.closures).join(' ')}`);
const v = verdict(reports);
console.log(v.lines.join('\n'));
process.exit(v.pass ? 0 : 1);
