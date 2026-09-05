import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTaskCompleteEvent } from '@raven/shared';
import type { AgentBackend, BackendOptions } from '../agent-manager/agent-backend.ts';
import { createRaven, type RavenInstance } from '../raven.ts';
import { buildTestConfig, createRavenTestFixture } from './fixtures/raven-fixture.ts';

describe('named-agent settings through chat, queue and budget', () => {
  let root: string | undefined;
  let raven: RavenInstance | undefined;
  let release: (() => void) | undefined;

  afterEach(async () => {
    release?.();
    await raven?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
    raven = undefined;
    root = undefined;
    release = undefined;
  });

  async function request(path: string, method = 'GET', body?: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${String(raven!.port)}/api${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
  }

  it('keeps queued settings stable and reserves the same model that actually runs', async () => {
    root = mkdtempSync(join(tmpdir(), 'raven-agent-settings-'));
    const paths = createRavenTestFixture(root);
    writeFileSync(
      join(paths.projectsDir, 'agents', 'raven', 'agent.yaml'),
      'name: raven\ndisplayName: Raven\nisDefault: true\nskills: []\nmodel: haiku\nmaxTurns: 4\n',
    );
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: BackendOptions[] = [];
    const completed: AgentTaskCompleteEvent[] = [];
    const backend: AgentBackend = async (options) => {
      calls.push(options);
      if (calls.length === 1) await held;
      return { result: 'Completed', success: true, errors: [], estimatedCostUsd: 0 };
    };
    raven = await createRaven(
      { ...buildTestConfig(), RAVEN_MAX_CONCURRENT_AGENTS: 1 },
      { ...paths, skipSuites: true, apiHost: '127.0.0.1', agentBackend: backend },
    );
    raven.eventBus.on<AgentTaskCompleteEvent>('agent:task:complete', (event) =>
      completed.push(event),
    );
    await raven.start();
    const projectResponse = await request('/projects', 'POST', { name: 'Settings fixture' });
    expect(projectResponse.ok).toBe(true);
    const project = (await projectResponse.json()) as { id: string };
    const chatPath = `/projects/${project.id}/chat`;
    expect((await request(chatPath, 'POST', { message: 'Hold first task' })).ok).toBe(true);
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    expect((await request(chatPath, 'POST', { message: 'Queue second task' })).ok).toBe(true);
    await vi.waitFor(async () => {
      const active = (await (await request('/agent-tasks/active')).json()) as { queued: unknown[] };
      expect(active.queued).toHaveLength(1);
    });
    const update = await request('/agents/raven', 'PATCH', { model: 'opus', maxTurns: 9 });
    expect(update.ok).toBe(true);
    release!();
    await vi.waitFor(() => expect(completed).toHaveLength(2));
    expect(calls.map(({ model, maxTurns }) => ({ model, maxTurns }))).toEqual([
      { model: 'claude-haiku-4-5', maxTurns: 4 },
      { model: 'claude-haiku-4-5', maxTurns: 4 },
    ]);

    expect((await request(chatPath, 'POST', { message: 'Use changed settings' })).ok).toBe(true);
    await vi.waitFor(() => expect(completed).toHaveLength(3));
    expect(calls[2]).toMatchObject({ model: 'claude-opus-5', maxTurns: 9 });
    expect(completed.every((event) => event.payload.success)).toBe(true);
    const leases = raven.db.all<{ task_id: string; model: string; status: string }>(
      'SELECT task_id, model, status FROM model_budget_leases',
    );
    expect(leases).toHaveLength(3);
    for (const [index, event] of completed.entries()) {
      expect(leases.find((lease) => lease.task_id === event.payload.taskId)).toMatchObject({
        model: calls[index].model,
        status: 'known',
      });
    }
  });
});
