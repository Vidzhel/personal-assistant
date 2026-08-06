import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRaven, type RavenInstance } from '../raven.ts';
import type { AppConfig } from '../config.ts';
import type { AgentBackend } from '../agent-manager/agent-backend.ts';

/**
 * E2E boot test over the real composition root: no mocked SDK, no mocked
 * database — just a temp dir, a fake agent backend, and Neo4j genuinely
 * absent (there is no local Neo4j in this test environment). Exercises the
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

function buildTestConfig(): AppConfig {
  return {
    ANTHROPIC_API_KEY: '',
    CLAUDE_MODEL: 'claude-sonnet-4-6',
    RAVEN_PORT: 0,
    RAVEN_TIMEZONE: 'UTC',
    RAVEN_DIGEST_TIME: '08:00',
    RAVEN_MAX_CONCURRENT_AGENTS: 3,
    RAVEN_AGENT_MAX_TURNS: 25,
    RAVEN_MAX_BUDGET_USD_PER_DAY: 5,
    DATABASE_PATH: './data/raven.db',
    SESSION_PATH: './data/sessions',
    LOG_LEVEL: 'info',
    // No Neo4j runs in this test environment — deliberately left at the
    // default, unreachable address so the resilience path is exercised.
    NEO4J_URI: 'bolt://localhost:7687',
    NEO4J_USER: 'neo4j',
    NEO4J_PASSWORD: 'ravenpassword',
    RAVEN_SESSION_IDLE_TIMEOUT_MS: 1_800_000,
    RAVEN_SESSION_COMPACTION_THRESHOLD: 40,
    RAVEN_CONSOLIDATION_CRON: '0 3 * * 0',
    RAVEN_AUTO_RETROSPECTIVE_ENABLED: true,
  };
}

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
    const dbPath = join(tmpDir, 'test.db');

    raven = await createRaven(buildTestConfig(), {
      dbPath,
      dataDir: tmpDir,
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

    // No Neo4j reachable in this environment -> knowledge engine degrades.
    expect(body.knowledge).toBe('unavailable');
    // skipSuites: true -> no real services were started, whatever suites
    // declare services-wise (count is environment-dependent, not asserted).
    expect(body.services.loaded).toBe(0);
    expect(typeof body.services.configured).toBe('number');
    expect(body.subsystems).toBeDefined();

    await raven.stop();
    raven = undefined; // already stopped — afterEach must not double-stop
  });
});
