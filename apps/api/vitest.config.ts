import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Mongo-backed suites share one in-memory server; running files in parallel
    // would have them clobber each other's collections.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    setupFiles: ['src/test/setup.ts'],
  },
});
