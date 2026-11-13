import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { farmbotSeed } from './scripts/vite-plugin-farmbot-seed.mjs';

// Relative base so the built dist/ works on Cloudflare Pages (and any static sub-path).
// Two entries: the desk-fan app at dist/index.html and the FarmBot screen at
// dist/farmbot/index.html. The FarmBot seed is copied next to its entry.
export default defineConfig({
  base: './',
  plugins: [react(), farmbotSeed()],
  build: {
    rollupOptions: {
      input: {
        index: 'index.html',
        farmbot: 'farmbot/index.html',
      },
    },
  },
});
