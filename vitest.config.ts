import { defineConfig } from 'vitest/config';

const projects = [
  'packages/shared/vitest.config.ts',
  'packages/core/vitest.config.ts',
  'packages/mcp-ticktick/vitest.config.ts',
  'packages/web/vitest.config.ts',
  'suites/vitest.config.ts',
];

// The knowledge-neo4j project spins up a real Neo4j container via
// testcontainers (docker required) and must never run as part of the
// default `npm test`. Vitest runs every project listed here whenever a
// bare `vitest run` executes, regardless of `--project` filters — those
// only narrow which of the *discovered* projects run — so the only way to
// keep it out of the default run while still making it selectable by name
// is to gate its discovery behind an explicit opt-in env var, set by
// `npm run test:knowledge` (see package.json).
if (process.env.RAVEN_TEST_KNOWLEDGE === '1') {
  projects.push('packages/core/vitest.knowledge.config.ts');
}

export default defineConfig({
  test: { projects },
});
