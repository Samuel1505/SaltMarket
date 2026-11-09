// Server entry.
//   pnpm dev       → live sim on MemoryLedger (offline-first). Judge routes only with JUDGE_MODE=1.
//   pnpm dev:mock  → scripted protocol-valid data (TEAM_SPLIT §3). Judge routes on unless JUDGE_MODE=0.
import { MemoryLedger } from '@saltmarket/chain';
import { buildApp } from './app.js';
import type { GameBackend } from './backend.js';
import { SimBackend } from './live/simBackend.js';
import { MockBackend } from './mock/mockBackend.js';

const mock = process.argv.includes('--mock');
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const seed = Number(process.env.SEED ?? 42);
const judge = mock ? process.env.JUDGE_MODE !== '0' : process.env.JUDGE_MODE === '1';

if (!mock && (process.env.LEDGER ?? 'memory') !== 'memory') {
  console.error('LEDGER=near is not available yet; running needs LEDGER=memory (the default).');
  process.exit(1);
}

let live: SimBackend | null = null;
let backend: GameBackend;
if (mock) backend = new MockBackend({ seed });
else {
  live = new SimBackend({ seed, ledger: new MemoryLedger(), snapshotPath: process.env.SNAPSHOT_PATH ?? 'data/world.json', log: (m) => console.log(m) });
  backend = live;
}

const { app } = await buildApp(backend, { judge, autoTick: true, validateOutgoing: 'log', logger: { level: process.env.LOG_LEVEL ?? 'info' } as never });
const shutdown = async () => {
  live?.saveSnapshot();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
await app.listen({ port, host });
console.log(`saltmarket ${mock ? 'MOCK' : 'live'} server on http://${host}:${port}  (ws: /ws, judge routes: ${judge ? 'on' : 'off'}, seed ${seed})`);
