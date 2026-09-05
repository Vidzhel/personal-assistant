import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRaven, type RavenInstance } from '../raven.ts';
import { buildTestConfig, createRavenTestFixture } from './fixtures/raven-fixture.ts';
import type { AgentBackend } from '../agent-manager/agent-backend.ts';

/**
 * E2E boot test over the real composition root: real SQLite and files in a
 * temp dir, a fake agent backend, and an explicitly disabled graph. The
 * default suite's Neo4j guard remains a backstop against client creation. Exercises the
 * exact path production takes: createRaven -> start -> serve -> stop.
 *
 * The critical assertion isn't in any `expect()` — it's that this test file
 * exits at all. Every subsystem that starts a timer, interval, or watcher
 * must be stopped by `raven.stop()`, or vitest hangs waiting for the worker
 * to shut down.
 */

const fakeBackend: AgentBackend = async (opts) => {
  opts.onAssistantMessage('ok');
  return { sessionId: 'fake-session-1', result: 'ok', success: true, errors: [] };
};

describe('boot-smoke: createRaven over the real composition root', () => {
  let tmpDir: string | undefined;
  let raven: RavenInstance | undefined;

  afterEach(async () => {
    if (raven) await raven.stop();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    raven = undefined;
    tmpDir = undefined;
  });

  it('boots without Neo4j, serves health, and shuts down cleanly', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-boot-smoke-'));

    raven = await createRaven(buildTestConfig(), {
      ...createRavenTestFixture(tmpDir),
      agentBackend: fakeBackend,
      skipSuites: true,
    });

    expect(raven.eventBus).toBeDefined();
    expect(raven.db).toBeDefined();

    await raven.start();
    expect(raven.port).toBeGreaterThan(0);

    const res = await fetch(`http://localhost:${raven.port}/api/health`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      status: string;
      knowledge: string;
      services: { loaded: number; configured: number };
      subsystems: Record<string, unknown>;
    };

    // Graph disabled in the fixture -> knowledge remains unavailable.
    expect(body.knowledge).toBe('unavailable');
    // skipSuites: true -> no background services were started. The configured
    // count is environment-dependent, so only its type is asserted.
    expect(body.services.loaded).toBe(0);
    expect(typeof body.services.configured).toBe('number');
    expect(body.subsystems).toBeDefined();

    await raven.stop();
    raven = undefined; // already stopped — afterEach must not double-stop
  });
});
