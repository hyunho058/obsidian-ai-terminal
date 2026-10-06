import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL('./tests/mocks/obsidian.ts', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    testTimeout: 20_000,
    // Python suites are run separately by scripts/test-python.mjs.
  },
});
