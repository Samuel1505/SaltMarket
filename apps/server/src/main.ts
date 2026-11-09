// Server entry. `--mock` serves scripted protocol-valid data (TEAM_SPLIT.md §3).
import { buildApp } from './app.js';
import { MockBackend } from './mock/mockBackend.js';

const mock = process.argv.includes('--mock');
if (!mock) {
  console.error('Live sim is not wired yet (step 5). Use `pnpm dev:mock`.');
  process.exit(1);
}
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const judge = process.env.JUDGE_MODE !== '0'; // mock: judge routes on unless explicitly disabled
const { app } = await buildApp(new MockBackend({ seed: Number(process.env.SEED ?? 42) }), {
  judge, autoTick: true, validateOutgoing: 'log', logger: true,
});
await app.listen({ port, host });
console.log(`saltmarket mock server on http://${host}:${port}  (ws: /ws, judge routes: ${judge ? 'on' : 'off'})`);
