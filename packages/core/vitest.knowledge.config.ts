import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// These integration tests spin up a real Neo4j container via testcontainers
// (docker required) instead of mocking the graph store. They're excluded
// from the default `npm test` project (see vitest.config.ts's `exclude`)
// and only run via `npm run test:knowledge`.
export const KNOWLEDGE_NEO4J_TEST_FILES = [
  'src/__tests__/knowledge-api.test.ts',
  'src/__tests__/knowledge-chunking.test.ts',
  'src/__tests__/knowledge-clustering.test.ts',
  'src/__tests__/knowledge-embeddings.test.ts',
  'src/__tests__/knowledge-retrieval.test.ts',
  'src/__tests__/knowledge-store.test.ts',
];

export default defineConfig({
  test: {
    name: 'knowledge-neo4j',
    include: KNOWLEDGE_NEO4J_TEST_FILES,
    // Container pull + startup is slow on a cold cache.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      '@raven/shared': resolve(import.meta.dirname, '../shared/src/index.ts'),
    },
  },
});
