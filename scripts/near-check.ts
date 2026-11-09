// pnpm near:check [--rpc URL] [--contract ID] [--authority ID]
// Read-only health check of the goods contract: status, settlement cursor, storage. Signs nothing,
// so it is safe to run against the live testnet contract (it never moves the settlement cursor).
import { JsonRpcProvider } from 'near-api-js';
import { mapAccountId } from '@saltmarket/chain';

const flag = (name: string, env: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : process.env[env] ?? fallback;
  if (!v) { console.error(`missing --${name} (or ${env})`); process.exit(1); }
  return v;
};
const rpc = flag('rpc', 'NEAR_RPC_URL', 'https://test.rpc.fastnear.com');
const contractId = flag('contract', 'NEAR_CONTRACT_ID');
const authority = flag('authority', 'NEAR_AUTHORITY_ID');
const p = new JsonRpcProvider({ url: rpc });
const view = (method: string, args: Record<string, unknown> = {}) => p.callFunction({ contractId, method, args });

console.log(`contract ${contractId} via ${rpc}\n`);
console.log('get_status         ', JSON.stringify(await view('get_status')));
console.log('settlement_cursor  ', JSON.stringify(await view('settlement_cursor')));
console.log('storage_report     ', JSON.stringify(await view('storage_report')));
const tf = mapAccountId('townfund', authority);
console.log(`town fund (${tf}) marks:`, JSON.stringify(await view('mt_batch_balance_of', { account_id: tf, token_ids: ['marks'] })));
