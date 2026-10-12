import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `.py` imports are the file's text, like esbuild's `.py` text loader (src/support/bundledScripts.ts).
  plugins: [
    {
      name: 'python-as-text',
      transform: (code, id) => (id.endsWith('.py') ? { code: `export default ${JSON.stringify(code)};`, map: null } : undefined),
    },
  ],
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
