import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { KNOWLEDGE_NEO4J_TEST_FILES } from './vitest.knowledge.config.ts';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    // These spin up a real Neo4j container via testcontainers — see
    // vitest.knowledge.config.ts / `npm run test:knowledge`.
    exclude: KNOWLEDGE_NEO4J_TEST_FILES,
  },
  resolve: {
    alias: {
      '@raven/shared': resolve(__dirname, '../shared/src/index.ts'),
    },
  },
});
