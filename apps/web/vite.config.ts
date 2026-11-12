import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Follows the server's PORT so `PORT=3100 pnpm dev` points both at the same place; SALTMARKET_SERVER overrides.
const SERVER = process.env.SALTMARKET_SERVER ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;

export default defineConfig({
  plugins: [react()],
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
