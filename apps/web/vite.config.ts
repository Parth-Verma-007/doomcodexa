import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],

  server: {
    port: 5173,
    strictPort: true,
    watch: {
      // The Playwright scripts live inside the project root but are never
      // imported by the app. Without this, saving one triggers a full page
      // reload — in the middle of the run that script is driving, which looks
      // exactly like a flaky test.
      ignored: ['**/e2e/**'],
    },
  },

  build: {
    target: 'es2022',
    sourcemap: true,
    // No manualChunks. The route components are lazily imported (see App.tsx),
    // so Rollup already splits Monaco, xterm and Yjs behind the /p/:id route.
    //
    // An earlier version did force a `monaco` chunk, and it actively hurt:
    // Rollup placed Vite's `__vitePreload` helper in that chunk, which made the
    // entry chunk statically import it, which put a 4MB module and a 130KB
    // stylesheet back on the landing page's critical path — the exact thing the
    // manual chunking was meant to prevent (§13).
    chunkSizeWarningLimit: 2500,
  },

  optimizeDeps: {
    include: ['monaco-editor', 'yjs', 'y-protocols/awareness'],
  },

  worker: {
    format: 'es',
  },
});
