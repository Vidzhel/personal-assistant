import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { META_PROJECT_ID, type AgentTask } from '@raven/shared';
import type { AgentBackend } from '../agent-manager/agent-backend.ts';
import { createExecutionLogger } from '../agent-manager/execution-logger.ts';
import { createRaven, type RavenInstance } from '../raven.ts';
import { buildTestConfig, createRavenTestFixture } from './fixtures/raven-fixture.ts';

const RUN_ID = 'restart-agent-run';

function runningRun(): Record<string, unknown> {
  const timestamp = '2026-09-05T08:00:00.000Z';
  return {
    id: RUN_ID,
    skillName: 'fixture-skill',
    prompt: 'A run that was admitted before the process stopped.',
    status: 'running',
    priority: 'normal',
    blocked: false,
    createdAt: timestamp,
    startedAt: timestamp,
  };
}

function makeTerminalTask(id: string, projectId: string): AgentTask {
  const now = Date.now();
  return {
    id,
    projectId,
    skillName: 'fixture-skill',
    prompt: 'Persist this run in the project history.',
    status: 'completed',
    priority: 'normal',
    mcpServers: {},
    agentDefinitions: {},
    createdAt: now,
    startedAt: now,
    completedAt: now,
    result: 'persisted',
    durationMs: 10,
  };
}

describe('e2e: agent run history is YAML-backed across restart', () => {
  let root: string | undefined;
  let raven: RavenInstance | undefined;

  afterEach(async () => {
    await raven?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
    raven = undefined;
    root = undefined;
  });

  async function request(path: string, method = 'GET', body?: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${String(raven!.port)}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
  }

  function setupRoot(prefix: string) {
    root = mkdtempSync(join(tmpdir(), prefix));
    const paths = createRavenTestFixture(root);
    mkdirSync(join(paths.projectsDir, 'system', 'tasks', 'runs'), { recursive: true });
    writeFileSync(
      join(paths.projectsDir, 'system', 'context.md'),
      'Raven system context\n',
      'utf8',
    );
    return paths;
  }

  it('rejects invalid run YAML before workers and boots after cleanup', async () => {
    const paths = setupRoot('raven-invalid-agent-run-');
    const invalidPath = join(paths.projectsDir, 'system', 'tasks', 'runs', 'invalid.yaml');
    writeFileSync(invalidPath, 'id: invalid\nstatus: definitely-invalid\n', 'utf8');
    const calls: string[] = [];
    const fakeBackend: AgentBackend = async () => {
      calls.push('unexpected model request');
      return { result: '', success: true, errors: [] };
    };
    const overrides = {
      ...paths,
      skipSuites: true,
      apiHost: '127.0.0.1',
      agentBackend: fakeBackend,
    };

    await expect(createRaven(buildTestConfig(), overrides)).rejects.toThrow(
      /Invalid agent run record/,
    );
    expect(calls).toEqual([]);
    rmSync(invalidPath);

    raven = await createRaven(buildTestConfig(), overrides);
    await raven.start();
    expect((await request('/api/health')).status).toBe(200);
    expect(calls).toEqual([]);
  });

  it('marks an interrupted run failed after restart without replaying it', async () => {
    const paths = setupRoot('raven-interrupted-agent-run-');
    const runPath = join(paths.projectsDir, 'system', 'tasks', 'runs', `${RUN_ID}.yaml`);
    writeFileSync(runPath, stringify(runningRun()), 'utf8');
    const calls: string[] = [];
    const fakeBackend: AgentBackend = async () => {
      calls.push('unexpected model request');
      return { result: '', success: true, errors: [] };
    };
    const overrides = {
      ...paths,
      skipSuites: true,
      apiHost: '127.0.0.1',
      agentBackend: fakeBackend,
    };

    raven = await createRaven(buildTestConfig(), overrides);
    await raven.start();
    const first = await request(`/api/agent-tasks/${RUN_ID}`);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      id: RUN_ID,
      status: 'failed',
      interrupted: true,
    });
    expect(calls).toEqual([]);
    expect(
      raven.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM agent_tasks')?.count,
    ).toBe(0);

    await raven.stop();
    raven = undefined;
    raven = await createRaven(buildTestConfig(), overrides);
    await raven.start();
    const afterRestart = await request(`/api/agent-tasks/${RUN_ID}`);
    expect(afterRestart.status).toBe(200);
    expect(await afterRestart.json()).toMatchObject({ status: 'failed', interrupted: true });
    expect(calls).toEqual([]);
    expect(readFileSync(runPath, 'utf8')).toContain('interrupted: true');
  });

  it('keeps project run history visible and protects the project from deletion', async () => {
    const paths = setupRoot('raven-project-agent-run-');
    const fakeBackend: AgentBackend = async () => ({ result: '', success: true, errors: [] });
    const overrides = {
      ...paths,
      skipSuites: true,
      apiHost: '127.0.0.1',
      agentBackend: fakeBackend,
    };

    raven = await createRaven(buildTestConfig(), overrides);
    await raven.start();
    const createResponse = await request('/api/projects', 'POST', { name: 'Run History Project' });
    expect(createResponse.status).toBe(200);
    const project = (await createResponse.json()) as { id: string; fsPath: string };
    const logger = createExecutionLogger({
      projectsDir: paths.projectsDir,
      projects: () => [
        { id: META_PROJECT_ID, fsPath: 'system' },
        { id: project.id, fsPath: project.fsPath },
      ],
    });
    const completedRun = makeTerminalTask('project-run-1', project.id);
    await logger.logTaskStart({
      ...completedRun,
      status: 'running',
      completedAt: undefined,
      result: undefined,
      durationMs: undefined,
    });
    await logger.logTaskComplete(completedRun);

    const history = await request(`/api/agent-tasks/project-run-1`);
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({
      id: 'project-run-1',
      projectId: project.id,
      status: 'completed',
    });
    expect((await request(`/api/projects/${project.id}`, 'DELETE')).status).toBe(409);
    expect(
      raven.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM agent_tasks')?.count,
    ).toBe(0);

    await raven.stop();
    raven = undefined;
    raven = await createRaven(buildTestConfig(), overrides);
    await raven.start();
    const afterRestart = await request('/api/agent-tasks/project-run-1');
    expect(afterRestart.status).toBe(200);
    expect(await afterRestart.json()).toMatchObject({ id: 'project-run-1', status: 'completed' });
  });
});
