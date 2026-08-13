import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    server: {
      deps: {
        // vite 5.4 mis-resolves node:sqlite (node ≥22 builtin) to bare "sqlite";
        // externalize both spellings so node resolves the import natively
        external: ['node:sqlite', 'sqlite'],
      },
    },
  },
});