import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Chaque cas lance un vrai script bash sur de vrais fichiers.
    testTimeout: 30_000,
  },
});
