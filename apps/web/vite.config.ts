import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Follows the server's PORT so `PORT=3100 pnpm dev` points both at the same place; SALTMARKET_SERVER overrides.
const SERVER = process.env.SALTMARKET_SERVER ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;

// The Privy app id is public (not a secret). Read it from the repo's root .env so a fresh clone needs no
// extra apps/web/.env.local; only this one key is exposed to the bundle, never PRIVY_APP_SECRET.
const rootEnv = loadEnv('development', '../..', 'PRIVY_APP_ID');
const privyAppId = process.env.VITE_PRIVY_APP_ID ?? rootEnv.PRIVY_APP_ID ?? '';

export default defineConfig({
  plugins: [react()],
  define: { 'import.meta.env.VITE_PRIVY_APP_ID': JSON.stringify(privyAppId) },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.WEB_PORT ?? 5173),
    // One origin for the browser: no CORS questions, same code behind a single host in production.
    proxy: {
      '/api': SERVER,
      '/healthz': SERVER,
      '/ws': { target: SERVER.replace(/^http/, 'ws'), ws: true },
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
