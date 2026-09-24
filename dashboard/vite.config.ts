import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Served by the control plane at /dashboard/. In dev, the API is proxied.
export default defineConfig({
  plugins: [react()],
  base: '/dashboard/',
  server: {
    port: 5180,
    proxy: {
      '/v1': { target: process.env.GHOST_API ?? 'http://127.0.0.1:8080', ws: true },
    },
  },
  build: { target: 'es2022', outDir: 'dist' },
  test: { environment: 'jsdom', globals: true, setupFiles: ['src/test-setup.ts'] },
});
