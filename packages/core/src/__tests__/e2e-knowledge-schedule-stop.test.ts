import { fakeConsolidationStorage } from './fixtures/knowledge-fixture.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import type { QueryResult } from 'neo4j-driver';
import type {
  AgentBackend,
  BackendOptions,
  BackendResult,
} from '../agent-manager/agent-backend.ts';
import { getDb } from '../db/database.ts';
import { createKnowledgeConsolidation } from '../knowledge-engine/knowledge-consolidation.ts';
import type { Neo4jClient } from '../knowledge-engine/neo4j-client.ts';
import type * as KnowledgeInitModule from '../knowledge-engine/initialize-knowledge.ts';
import { createRaven, type RavenInstance } from '../raven.ts';
import { buildTestConfig, createRavenTestFixture } from './fixtures/raven-fixture.ts';

const knowledgeHarness = vi.hoisted(() => ({
  consolidationStop: vi.fn(),
  graphRuntimeStop: vi.fn(),
  graphClose: vi.fn(),
  graphRun: vi.fn(),
  beforeGraphStop: null as { fire: unknown; budget: unknown } | null,
  order: [] as string[],
}));

vi.mock('../knowledge-engine/initialize-knowledge.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof KnowledgeInitModule>();
  return {
    ...actual,
    initializeKnowledge: async (
      deps: Parameters<typeof actual.initializeKnowledge>[0],
    ): Promise<KnowledgeInitModule.KnowledgeRuntime> => {
      const graph = {
        run: knowledgeHarness.graphRun.mockImplementation(
          async () => ({ records: [] }) as unknown as QueryResult,
        ),
        query: vi.fn(async () => [
          {
            id: 'auto-bubble-1',
            title: 'An automatically collected fact',
            content: 'A fact that needs consolidation.',
            tags: [],
            projectId: 'meta',
          },
        ]),
        queryOne: vi.fn(async () => undefined),
        withTransaction: vi.fn(async () => {
          throw new Error('Unexpected graph transaction in shutdown test');
        }),
        ensureSchema: vi.fn(async () => {}),
        close: vi.fn(async () => {
          knowledgeHarness.order.push('graph-client.close');
          knowledgeHarness.graphClose();
        }),
      } as unknown as Neo4jClient;

      const consolidation = createKnowledgeConsolidation({
        neo4j: graph,
        eventBus: deps.eventBus,
        ...fakeConsolidationStorage(),
      });
      knowledgeHarness.consolidationStop.mockImplementation(async () => {
        knowledgeHarness.order.push('knowledge-consolidation.stop');
        await consolidation.stop();
      });
      const knowledgeConsolidation = {
        ...consolidation,
        stop: knowledgeHarness.consolidationStop,
      };
      knowledgeHarness.graphRuntimeStop.mockImplementation(async () => {
        knowledgeHarness.order.push('graph-runtime.stop');
        knowledgeHarness.beforeGraphStop = {
          fire: getDb()
            .prepare(
              'SELECT status FROM schedule_fires WHERE schedule_name = ? ORDER BY fired_at DESC LIMIT 1',
            )
            .get('knowledge-consolidation'),
          budget: getDb()
            .prepare(
              'SELECT status FROM model_budget_leases WHERE task_id IS NOT NULL ORDER BY created_at DESC LIMIT 1',
            )
            .get(),
        };
        await graph.close();
      });

      // The test needs only the real consolidation processor. Raven checks
      // optional engines before registering knowledge routes, so the other
      // runtime members can stay absent at this mocked initialization seam.
      return {
        neo4jClient: graph,
        knowledgeConsolidation,
        stop: knowledgeHarness.graphRuntimeStop,
      } as unknown as KnowledgeInitModule.KnowledgeRuntime;
    },
  };
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('e2e: scheduled knowledge work drains before graph disposal', () => {
  let root: string | undefined;
  let raven: RavenInstance | undefined;
  let releaseBackend: (() => void) | undefined;

  afterEach(async () => {
    releaseBackend?.();
    releaseBackend = undefined;
    await raven?.stop();
    raven = undefined;
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('aborts a manually triggered consolidation, records blocked/unknown state, then closes the graph', async () => {
    knowledgeHarness.order.length = 0;
    knowledgeHarness.consolidationStop.mockClear();
    knowledgeHarness.graphRuntimeStop.mockClear();
    knowledgeHarness.graphClose.mockClear();
    knowledgeHarness.graphRun.mockClear();
    knowledgeHarness.beforeGraphStop = null;

    root = mkdtempSync(join(tmpdir(), 'raven-e2e-knowledge-stop-'));
    const paths = createRavenTestFixture(root);
    mkdirSync(join(paths.projectsDir, 'schedules'), { recursive: true });
    writeFileSync(
      join(paths.projectsDir, 'schedules', 'knowledge-consolidation.yaml'),
      stringify({
        name: 'knowledge-consolidation',
        cron: '0 0 1 1 *',
        timezone: 'UTC',
        enabled: false,
        run: { kind: 'job', ref: 'knowledge-consolidation' },
      }),
      'utf8',
    );

    const backendStarted = deferred<BackendOptions>();
    const backendFinished = deferred<BackendResult>();
    const backend: AgentBackend = async (options) => {
      backendStarted.resolve(options);
      await backendFinished.promise;
      return backendFinished.promise;
    };
    // The fake provider intentionally ignores abort. Raven must drain its
    // local cancellation outcome without waiting for this remote promise.
    releaseBackend = () => backendFinished.resolve({ result: 'late', success: true, errors: [] });

    raven = await createRaven(
      { ...buildTestConfig(), NEO4J_ENABLED: true },
      {
        ...paths,
        skipSuites: true,
        apiHost: '127.0.0.1',
        agentBackend: backend,
      },
    );
    await raven.start();

    const baseUrl = `http://127.0.0.1:${String(raven.port)}`;
    const trigger = fetch(`${baseUrl}/api/schedules/knowledge-consolidation/trigger`, {
      method: 'POST',
    }).then(async (response) => ({
      status: response.status,
      connection: response.headers.get('connection'),
      body: await response.text(),
    }));
    await backendStarted.promise;

    await raven.stop();
    raven = undefined;

    const triggerResponse = await trigger;
    expect(triggerResponse.status).toBe(200);
    expect(triggerResponse.connection).toBe('close');
    expect(knowledgeHarness.consolidationStop).toHaveBeenCalledTimes(1);
    expect(knowledgeHarness.graphRuntimeStop).toHaveBeenCalledTimes(1);
    expect(knowledgeHarness.graphClose).toHaveBeenCalledTimes(1);
    expect(knowledgeHarness.order).toEqual([
      'knowledge-consolidation.stop',
      'graph-runtime.stop',
      'graph-client.close',
    ]);
    expect(knowledgeHarness.beforeGraphStop).toEqual({
      fire: { status: 'blocked' },
      budget: { status: 'unknown' },
    });

    // The completion promise is released only after Raven and its database
    // have closed. Its late success must therefore have no opportunity to
    // rewrite the durable blocked fire or its unknown budget lease.
    releaseBackend();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(knowledgeHarness.graphRun).not.toHaveBeenCalled();
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(paths.dbPath);
    try {
      expect(
        db
          .prepare(
            'SELECT status FROM schedule_fires WHERE schedule_name = ? ORDER BY fired_at DESC LIMIT 1',
          )
          .get('knowledge-consolidation'),
      ).toEqual({ status: 'blocked' });
      expect(
        db
          .prepare(
            'SELECT status FROM model_budget_leases WHERE task_id IS NOT NULL ORDER BY created_at DESC LIMIT 1',
          )
          .get(),
      ).toMatchObject({ status: 'unknown' });
    } finally {
      db.close();
    }
  }, 15_000);
});
