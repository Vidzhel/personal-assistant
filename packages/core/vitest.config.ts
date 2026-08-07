import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { KNOWLEDGE_NEO4J_TEST_FILES } from './vitest.knowledge.config.ts';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    // These spin up a real Neo4j container via testcontainers — see
    // vitest.knowledge.config.ts / `npm run test:knowledge`.
    exclude: KNOWLEDGE_NEO4J_TEST_FILES,
    // Structural test-env safety net — deletes any credential env var by
    // prefix scan before each test file's module graph loads. Defense in
    // depth on top of config.ts's own VITEST/NODE_ENV guard. See
    // src/__tests__/setup/env-guard.ts for the incident this backstops.
    setupFiles: ['./src/__tests__/setup/env-guard.ts'],
  },
  resolve: {
    alias: {
      '@raven/shared': resolve(__dirname, '../shared/src/index.ts'),
    },
  },
});
