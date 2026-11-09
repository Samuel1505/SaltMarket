// pnpm sim:storm --seed 42 [--day 10]
// Runs the Storm scenario (docs/TESTING_AND_DEMO.md §4) and prints the town's response. Exits non-zero if expectations fail.
import { arg } from './args.js';
import { stormScenario } from './scenarios.js';

const r = stormScenario(arg('seed', 42), arg('day', 10));
console.log(`${r.name}\n`);
for (const l of r.table) console.log(l);
console.log('');
for (const c of r.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.text}`);
process.exit(r.checks.every((c) => c.ok) ? 0 : 1);
