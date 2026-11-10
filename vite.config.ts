import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the built dist/ works on Cloudflare Pages (and any static sub-path).
export default defineConfig({
  base: './',
  plugins: [react()],
});
