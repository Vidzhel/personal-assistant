import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../event-bus/event-bus.ts';
import { setActiveBackend } from '../agent-manager/agent-session.ts';
import { createModelBudget } from '../agent-manager/model-budget.ts';
import { createKnowledgeConsolidation } from '../knowledge-engine/knowledge-consolidation.ts';
import { buildTestConfig } from './fixtures/raven-fixture.ts';
import { setConfig } from '../config.ts';
import type { AgentBackend } from '../agent-manager/agent-backend.ts';
import type { Neo4jClient } from '../knowledge-engine/neo4j-client.ts';

const schema = readFileSync(
  new URL('../../../../migrations/001-initial-schema.sql', import.meta.url),
  'utf8',
);

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function graph(): Neo4jClient & { run: ReturnType<typeof vi.fn> } {
  return {
    query: vi.fn(async () => [
      { id: 'bubble-1', title: 'Bubble', content: 'Content', tags: [], projectId: 'project-1' },
    ]),
    run: vi.fn(async () => undefined),
    queryOne: vi.fn(async () => undefined),
    withTransaction: vi.fn(async () => undefined),
    ensureSchema: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as Neo4jClient & { run: ReturnType<typeof vi.fn> };
}

function database(): { db: Database.Database; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'raven-consolidation-budget-'));
  roots.push(root);
  const db = new Database(join(root, 'budget.db'));
  db.exec(schema);
  return { db, root };
}

describe('knowledge consolidation budget boundary', () => {
  it('rejects exhausted model work before parsing or graph writes', async () => {
    const { db } = database();
    const budget = createModelBudget({
      db,
      dailyLimitUsd: 0,
      maxConcurrent: 1,
      timeZone: 'UTC',
    });
    setConfig(buildTestConfig());
    const backend = vi.fn<AgentBackend>();
    setActiveBackend(backend, budget);
    const neo4j = graph();
    const consolidation = createKnowledgeConsolidation({
      neo4j,
      eventBus: new EventBus(),
      config: buildTestConfig(),
    });

    await expect(consolidation.runConsolidation()).rejects.toThrow(/budget exhausted/i);

    expect(backend).not.toHaveBeenCalled();
    expect(neo4j.run).not.toHaveBeenCalled();
    await consolidation.stop();
    db.close();
  });

  it('settles cancelled uncooperative work before database close and ignores its late completion', async () => {
    const { db } = database();
    const budget = createModelBudget({
      db,
      dailyLimitUsd: 10,
      maxConcurrent: 1,
      timeZone: 'UTC',
    });
    setConfig(buildTestConfig());
    const started = deferred<undefined>();
    const late = deferred<Awaited<ReturnType<AgentBackend>>>();
    const backend = vi.fn<AgentBackend>(async () => {
      started.resolve(undefined);
      return late.promise;
    });
    setActiveBackend(backend, budget);
    const neo4j = graph();
    const consolidation = createKnowledgeConsolidation({
      neo4j,
      eventBus: new EventBus(),
      config: buildTestConfig(),
    });

    const operation = consolidation.runConsolidation();
    const rejected = expect(operation).rejects.toThrow(/stopped|cancelled/i);
    await started.promise;
    await consolidation.stop();
    expect(budget.getSummary()).toMatchObject({ reservedUsd: 0 });
    expect(budget.getSummary().unknownUsd).toBeGreaterThan(0);
    expect(neo4j.run).not.toHaveBeenCalled();

    db.close();
    await rejected;
    late.resolve({ result: 'late', success: true, errors: [], estimatedCostUsd: 4 });
    await late.promise;
    expect(neo4j.run).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
