import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const SERVER = process.env.SALTMARKET_SERVER ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
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
