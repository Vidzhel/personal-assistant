import { vi } from 'vitest';

// The default suite must not discover a developer's real graph on localhost.
// Clearing environment credentials is insufficient: several composition tests
// provide a literal URI/password in their AppConfig. Replace this external
// boundary before test modules load; SQLite, files, and Raven wiring stay real.
// The opt-in knowledge-neo4j project does not load this setup file and uses
// testcontainers. Individual unit tests can still supply their own client mocks.
vi.mock('../../knowledge-engine/neo4j-client.ts', () => ({
  createNeo4jClient: () => {
    throw new Error('Real Neo4j is disabled in the default suite; use npm run test:knowledge');
  },
}));
