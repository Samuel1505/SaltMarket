// Project rule lint (CLAUDE.md §6): the sim must stay pure and deterministic.
// Fails if packages/sim source uses wall-clock time, ambient randomness, or I/O.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bMath\.random\s*\(/, 'Math.random() — use the seeded Rng'],
  [/\bDate\.now\s*\(/, 'Date.now() — use the tick'],
  [/\bnew Date\s*\(/, 'new Date() — use the tick'],
  [/from ['"]node:/, 'node: imports — the sim has no I/O'],
  [/\bfetch\s*\(/, 'fetch() — the sim has no network'],
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

const problems: string[] = [];
for (const file of walk('packages/sim/src')) {
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
    for (const [re, why] of FORBIDDEN) if (re.test(line)) problems.push(`${file}:${i + 1}  ${why}`);
  });
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('lint-rules: ok');
