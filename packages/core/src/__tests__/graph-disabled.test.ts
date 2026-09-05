import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRaven, type RavenInstance } from '../raven.ts';
import { createNeo4jClient } from '../knowledge-engine/neo4j-client.ts';
import { buildTestConfig, createRavenTestFixture } from './fixtures/raven-fixture.ts';
import type { AgentBackend } from '../agent-manager/agent-backend.ts';

vi.mock('../knowledge-engine/neo4j-client.ts', () => ({
  createNeo4jClient: vi.fn(() => {
    throw new Error('Unexpected driver creation in graph-off test');
  }),
}));

const fakeBackend: AgentBackend = async () => ({
  sessionId: 'fake-session',
  result: 'ok',
  success: true,
  errors: [],
});

describe('graph disabled composition', () => {
  let raven: RavenInstance | undefined;
  let root: string | undefined;
  afterEach(async () => {
    await raven?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('boots the composition and background services with zero graph client construction', async () => {
    root = mkdtempSync(join(tmpdir(), 'raven-no-graph-'));
    raven = await createRaven(
      { ...buildTestConfig(), NEO4J_ENABLED: false },
      {
        ...createRavenTestFixture(root),
        agentBackend: fakeBackend,
      },
    );
    expect(raven.db).toBeDefined();
    expect(raven.eventBus).toBeDefined();
    expect(createNeo4jClient).not.toHaveBeenCalled();
    await raven.stop();
    raven = undefined;
    expect(createNeo4jClient).not.toHaveBeenCalled();
  });
});
