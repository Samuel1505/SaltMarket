// pnpm demo:seed [--seed 42] [--days 3] [--out data/world.json] [--force]
// Builds a demo world for the judge video / live demo (TESTING_AND_DEMO §5) and writes it as the server's
// JSON snapshot. Two clearly labeled demo accounts each own an Exchange Hall and trade for real during a
// short warm-up, so both Halls earn fees from genuine trades. Their only head start is a logged grant of
// marks for the license (a mint, so conservation holds). Prints their login tokens (local file only).
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { addPlayer, applyCommand, assertInvariants, createWorld, grantMarks, step, type Command, type SimEvent, type WorldState } from '@saltmarket/sim';
import { arg } from './args.js';

const seed = arg('seed', 42);
const days = arg('days', 3);
const outIdx = process.argv.indexOf('--out');
const out = outIdx >= 0 ? process.argv[outIdx + 1]! : 'data/world.json';
if (existsSync(out) && !process.argv.includes('--force')) {
  console.error(`${out} exists. Re-run with --force to replace it (the current world will be lost).`);
  process.exit(1);
}

const DEMO = [
  { id: 'demo-ada', name: 'Demo · Ada', hall: "Ada's Exchange (demo)", feeBps: 100 },
  { id: 'demo-bram', name: 'Demo · Bram', hall: "Bram's Exchange (demo)", feeBps: 400 },
] as const;

const s: WorldState = createWorld(seed);
const ev: SimEvent[] = [];
const halls: Record<string, string> = {};
for (const d of DEMO) {
  addPlayer(s, d.id, d.name);
  grantMarks(s, d.id, 25000); // demo grant: 300 start + 250 → can afford the 400-mark license
  const r = applyCommand(s, d.id, { t: 'buyHall', name: d.hall }, ev);
  if (!r.ok || r.result?.kind !== 'hall_bought') throw new Error(`could not buy hall: ${r.message}`);
  halls[d.id] = r.result.hallId;
  applyCommand(s, d.id, { t: 'setHallFee', hallId: r.result.hallId, bps: d.feeBps }, ev);
}
const otherHall = (id: string) => halls[id === 'demo-ada' ? 'demo-bram' : 'demo-ada']!;

for (let t = 0; t < days * 24; t++) {
  step(s);
  for (const [i, d] of DEMO.entries()) {
    const cmds: Command[] = [
      { t: 'gather', node: (['pier', 'pans', 'grove'] as const)[(s.tick + i) % 3]! },
      { t: 'craft', recipe: 'craft_barrel' },
      { t: 'craft', recipe: 'cure_fish' },
    ];
    const cured = s.accounts[d.id]!.inv.cured_fish;
    // Sell cured fish to the ship through the *other* demo Hall, so each Hall earns fees from a real trade.
    if (cured > 0 && s.ship.docked) cmds.push({ t: 'list', good: 'cured_fish', qty: cured, pricePips: Math.round(s.ship.ceiling * 0.95), venueId: otherHall(d.id) });
    for (const c of cmds) applyCommand(s, d.id, c, ev);
  }
  assertInvariants(s);
}

const tokens: Record<string, string> = {};
console.log(`Demo world: seed ${seed}, ${days} days of warm-up, now at tick ${s.tick}\n`);
let ok = true;
for (const d of DEMO) {
  const h = s.halls[halls[d.id]!]!;
  const trades = s.trades.filter((t) => t.venueId === h.id);
  const npcs = Object.values(s.npcs).filter((n) => n.venueId === h.id).map((n) => s.accounts[n.id]!.name);
  console.log(`${h.name}  owner ${d.name}  fee ${h.feeBps / 100}%  trades ${trades.length}  fee income ${(h.feeIncomeTotal / 100).toFixed(2)} marks  merchants trading here: ${npcs.join(', ') || 'none'}`);
  if (trades.length === 0 || h.feeIncomeTotal === 0) ok = false;
  const token = randomUUID();
  tokens[token] = d.id;
  console.log(`  sign in as ${d.name}: use token ${token}`);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(`${out}.tmp`, JSON.stringify({ world: s, tokens }));
renameSync(`${out}.tmp`, out);
console.log(`\nWrote ${out}. Start the server with: JUDGE_MODE=1 SNAPSHOT_PATH=${out} pnpm dev`);
if (!ok) { console.error('\nWARNING: a demo Hall has no real trades or fee income yet; increase --days.'); process.exit(1); }
