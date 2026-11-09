// Server entry.
//   pnpm dev       → live sim on MemoryLedger (offline-first). Judge routes only with JUDGE_MODE=1.
//   pnpm dev:mock  → scripted protocol-valid data (TEAM_SPLIT §3). Judge routes on unless JUDGE_MODE=0.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { MemoryLedger, NearLedger, type LedgerAdapter } from '@saltmarket/chain';
import { buildApp } from './app.js';
import type { GameBackend } from './backend.js';
import { SimBackend } from './live/simBackend.js';
import { MockBackend } from './mock/mockBackend.js';

const mock = process.argv.includes('--mock');
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const seed = Number(process.env.SEED ?? 42);
const judge = mock ? process.env.JUDGE_MODE !== '0' : process.env.JUDGE_MODE === '1';

const ledgerMode = process.env.LEDGER ?? 'memory';

/** LEDGER=near: settle to the goods contract (REQUESTS C7). The key comes from env or a key file; never logged. */
function nearLedger(): NearLedger {
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) { console.error(`LEDGER=near needs ${k} (see .env.example)`); process.exit(1); }
    return v;
  };
  let key = process.env.NEAR_AUTHORITY_KEY;
  if (!key && process.env.NEAR_AUTHORITY_KEY_FILE) {
    // near-cli keychain file: { "account_id", "public_key", "private_key" }
    const file = process.env.NEAR_AUTHORITY_KEY_FILE.replace(/^~/, homedir());
    key = (JSON.parse(readFileSync(file, 'utf8')) as { private_key?: string }).private_key;
  }
  if (!key || !key.startsWith('ed25519:')) { console.error('LEDGER=near needs NEAR_AUTHORITY_KEY or NEAR_AUTHORITY_KEY_FILE (an ed25519 function-call key)'); process.exit(1); }
  return new NearLedger({
    network: process.env.NEAR_NETWORK ?? 'testnet',
    rpcUrl: need('NEAR_RPC_URL'),
    contractId: need('NEAR_CONTRACT_ID'),
    authorityId: need('NEAR_AUTHORITY_ID'),
    privateKey: key,
    settleGasTgas: Number(process.env.NEAR_SETTLE_GAS_TGAS ?? 100),
    ...(process.env.NEAR_EXPLORER_TX_URL ? { explorerTx: process.env.NEAR_EXPLORER_TX_URL } : {}),
    ...(process.env.NEAR_EXPLORER_ACCOUNT_URL ? { explorerAccount: process.env.NEAR_EXPLORER_ACCOUNT_URL } : {}),
  }, undefined, (m) => console.log(m));
}
if (!mock && ledgerMode !== 'memory' && ledgerMode !== 'near') {
  console.error(`LEDGER must be memory or near (got ${ledgerMode})`);
  process.exit(1);
}

let live: SimBackend | null = null;
let backend: GameBackend;
if (mock) backend = new MockBackend({ seed });
else {
  const ledger: LedgerAdapter = ledgerMode === 'near' ? nearLedger() : new MemoryLedger();
  // On NEAR, settle once per game day by default to keep transactions (and gas allowance) modest.
  const settleEveryTicks = Number(process.env.SETTLE_EVERY_TICKS ?? (ledgerMode === 'near' ? 24 : 6));
  live = new SimBackend({ seed, ledger, settleEveryTicks, snapshotPath: process.env.SNAPSHOT_PATH ?? 'data/world.json', log: (m) => console.log(m) });
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
console.log(`saltmarket ${mock ? 'MOCK' : 'live'} server on http://${host}:${port}  (ws: /ws, judge routes: ${judge ? 'on' : 'off'}, seed ${seed}, ledger: ${mock ? 'none' : ledgerMode})`);
