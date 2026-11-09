import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the dist/ folder works under any GitHub Pages sub-path.
export default defineConfig({
  base: './',
  plugins: [react()],
});
