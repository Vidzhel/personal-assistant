import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentTaskRequestEvent } from '@raven/shared';
import type { AgentBackend, BackendOptions } from '../agent-manager/agent-backend.ts';
import { createRaven, type RavenInstance } from '../raven.ts';
import { buildTestConfig, createRavenTestFixture } from './fixtures/raven-fixture.ts';

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

describe('e2e: shared model budget composition', () => {
  let root: string | undefined;
  let raven: RavenInstance | undefined;

  afterEach(async () => {
    try {
      await raven?.stop();
    } finally {
      raven = undefined;
      if (root) rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  function emitRequest(taskId: string, prompt: string): void {
    raven!.eventBus.emit({
      id: randomUUID(),
      timestamp: Date.now(),
      source: 'e2e-model-budget',
      type: 'agent:task:request',
      payload: {
        taskId,
        projectId: 'meta',
        namedAgentId: 'raven',
        skillName: 'orchestrator',
        prompt,
        priority: 'normal',
        mcpServers: {},
      },
    } satisfies AgentTaskRequestEvent);
  }

  async function boot(
    configOverrides: Partial<ReturnType<typeof buildTestConfig>> = {},
    agentBackend: AgentBackend,
  ): Promise<void> {
    root = mkdtempSync(join(tmpdir(), 'raven-e2e-model-budget-'));
    const fixture = createRavenTestFixture(root!);
    raven = await createRaven(
      { ...buildTestConfig(), ...configOverrides },
      { ...fixture, skipSuites: true, apiHost: '127.0.0.1', agentBackend },
    );
    await raven.start();
  }

  async function budgetResponse(): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`http://127.0.0.1:${String(raven!.port)}/api/budget`);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it('rejects a manager task at zero budget before invoking the backend', async () => {
    const calls: BackendOptions[] = [];
    await boot({ RAVEN_MAX_BUDGET_USD_PER_DAY: 0 }, async (options) => {
      calls.push(options);
      return { result: 'must not run', success: true, errors: [], estimatedCostUsd: 0 };
    });
    const completions: Array<{ payload: Record<string, unknown> }> = [];
    raven!.eventBus.on('agent:task:complete', (event) => {
      completions.push(event as unknown as { payload: Record<string, unknown> });
    });

    emitRequest('zero-budget-task', 'reject this request');
    await vi.waitFor(() => expect(completions).toHaveLength(1));
    expect(calls).toHaveLength(0);
    expect(completions[0].payload).toMatchObject({
      taskId: 'zero-budget-task',
      success: false,
      cancelled: false,
      errors: ['budget exhausted: no model budget remains for this query'],
    });

    const first = await budgetResponse();
    const second = await budgetResponse();
    expect(first.status).toBe(200);
    expect(second).toEqual(first);
    expect(first.body).toMatchObject({
      limitUsd: 0,
      knownUsd: 0,
      reservedUsd: 0,
      unknownUsd: 0,
      remainingUsd: 0,
      counts: { known: 0, reserved: 0, unknown: 0 },
    });
  }, 10_000);

  it('persists known and cancelled-unknown costs through restart without late mutation', async () => {
    const heldStarted = deferred<boolean>();
    const lateCompletion = deferred<Awaited<ReturnType<AgentBackend>>>();
    const calls: BackendOptions[] = [];
    const backend: AgentBackend = async (options) => {
      calls.push(options);
      if (options.prompt === 'held query') {
        heldStarted.resolve(true);
        return lateCompletion.promise;
      }
      return { result: 'known result', success: true, errors: [], estimatedCostUsd: 0.1 };
    };
    await boot({ RAVEN_MAX_BUDGET_USD_PER_DAY: 10 }, backend);
    const completions: Array<{ payload: Record<string, unknown> }> = [];
    let statusObservedBeforeClose: string | undefined;
    raven!.eventBus.on('agent:task:complete', (event) => {
      const typed = event as unknown as { payload: Record<string, unknown> };
      completions.push(typed);
      if (typed.payload.taskId === 'held-query') {
        statusObservedBeforeClose = raven!.db.get<{ status: string }>(
          'SELECT status FROM model_budget_leases WHERE task_id = ?',
          'held-query',
        )?.status;
      }
    });

    emitRequest('known-query', 'known query');
    await vi.waitFor(() => expect(completions).toHaveLength(1));
    emitRequest('held-query', 'held query');
    await heldStarted.promise;
    const first = raven!;
    await first.stop();
    raven = undefined;

    expect(statusObservedBeforeClose).toBe('unknown');
    expect(calls).toHaveLength(2);

    const fixture = createRavenTestFixture(root!);
    raven = await createRaven(
      { ...buildTestConfig(), RAVEN_MAX_BUDGET_USD_PER_DAY: 10 },
      {
        ...fixture,
        skipSuites: true,
        apiHost: '127.0.0.1',
        agentBackend: async () => ({ result: 'fresh backend', success: true, errors: [] }),
      },
    );
    await raven.start();
    const afterRestart = await budgetResponse();
    expect(afterRestart.body).toMatchObject({
      knownUsd: 0.1,
      unknownUsd: 2.5,
      reservedUsd: 0,
      counts: { known: 1, unknown: 1, reserved: 0 },
    });
    lateCompletion.resolve({
      result: 'late success',
      success: true,
      errors: [],
      estimatedCostUsd: 9,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await budgetResponse()).toEqual(afterRestart);
  }, 15_000);
});
