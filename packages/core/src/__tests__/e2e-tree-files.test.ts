import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import type { AgentTaskRequestEvent } from '@raven/shared';
import type { AgentBackend } from '../agent-manager/agent-backend.ts';
import { createRaven, type RavenInstance } from '../raven.ts';
import { buildTestConfig, createRavenTestFixture } from './fixtures/raven-fixture.ts';

const TREE_ID = 'restart-tree';
const COMPLETED_TASK_ID = 'completed-step';
const INTERRUPTED_TASK_ID = 'interrupted-step';
const OLD_AGENT_TASK_ID = 'old-agent-attempt';
const INTERRUPTED_REASON = 'Execution interrupted by process restart; deliberate resume required';

interface TaskTreeTaskView {
  id: string;
  status: string;
  artifacts: Array<{ type: string; label: string; filePath?: string }>;
  lastError?: string;
  agentTaskId?: string;
}

interface TaskTreeView {
  id: string;
  status: string;
  taskCount: number;
  completedCount: number;
  tasks: TaskTreeTaskView[];
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 8_000,
): Promise<void> {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('waitFor: timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function seededTree(): Record<string, unknown> {
  const timestamp = '2026-09-05T08:00:00.000Z';
  return {
    id: TREE_ID,
    projectId: 'meta',
    status: 'running',
    plan: 'Resume the interrupted work after deliberate approval.',
    tasks: [
      {
        id: COMPLETED_TASK_ID,
        parentTaskId: TREE_ID,
        node: {
          id: COMPLETED_TASK_ID,
          type: 'agent',
          title: 'Completed step',
          prompt: 'This step was completed before the restart.',
          blockedBy: [],
        },
        status: 'completed',
        artifacts: [
          {
            type: 'file',
            label: 'Completed report',
            filePath: 'notes/completed-report.md',
          },
        ],
        summary: 'Completed before restart',
        retryCount: 0,
        completedAt: timestamp,
      },
      {
        id: INTERRUPTED_TASK_ID,
        parentTaskId: TREE_ID,
        node: {
          id: INTERRUPTED_TASK_ID,
          type: 'agent',
          title: 'Interrupted step',
          prompt: 'Finish the interrupted work.',
          blockedBy: [COMPLETED_TASK_ID],
        },
        status: 'in_progress',
        agentTaskId: OLD_AGENT_TASK_ID,
        artifacts: [],
        retryCount: 0,
        startedAt: timestamp,
      },
    ],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe('e2e: execution trees are YAML-backed across restart', () => {
  let root: string | undefined;
  let raven: RavenInstance | undefined;

  afterEach(async () => {
    await raven?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
    raven = undefined;
    root = undefined;
  });

  it('marks a running tree interrupted on startup and deliberately resumes it', async () => {
    root = mkdtempSync(join(tmpdir(), 'raven-e2e-tree-files-'));
    const paths = createRavenTestFixture(root);
    mkdirSync(join(paths.projectsDir, 'system'), { recursive: true });
    writeFileSync(
      join(paths.projectsDir, 'system', 'context.md'),
      'Raven system context\n',
      'utf8',
    );
    const treePath = join(paths.projectsDir, 'system', 'tasks', 'trees', `${TREE_ID}.yaml`);
    mkdirSync(join(paths.projectsDir, 'system', 'tasks', 'trees'), { recursive: true });
    writeFileSync(treePath, stringify(seededTree()), 'utf8');

    const requests: AgentTaskRequestEvent[] = [];
    const fakeBackend: AgentBackend = async (options) => {
      options.onAssistantMessage('fresh completion');
      return { result: 'fresh completion', success: true, errors: [] };
    };
    const overrides = {
      ...paths,
      skipSuites: true,
      apiHost: '127.0.0.1',
      agentBackend: fakeBackend,
    };

    raven = await createRaven(buildTestConfig(), overrides);
    await raven.start();
    raven.eventBus.on<AgentTaskRequestEvent>('agent:task:request', (event) => {
      requests.push(event);
    });

    let baseUrl = `http://127.0.0.1:${String(raven.port)}`;
    const getTree = async (): Promise<TaskTreeView> => {
      const response = await fetch(`${baseUrl}/api/task-trees/${TREE_ID}`);
      expect(response.status).toBe(200);
      return (await response.json()) as TaskTreeView;
    };

    expect(requests).toHaveLength(0);
    const interrupted = await getTree();
    expect(interrupted).toMatchObject({
      id: TREE_ID,
      status: 'pending_approval',
      taskCount: 2,
      completedCount: 1,
    });
    expect(interrupted.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: COMPLETED_TASK_ID,
          status: 'completed',
          artifacts: [
            {
              type: 'file',
              label: 'Completed report',
              filePath: 'notes/completed-report.md',
            },
          ],
        }),
        expect.objectContaining({
          id: INTERRUPTED_TASK_ID,
          status: 'blocked',
          lastError: INTERRUPTED_REASON,
        }),
      ]),
    );
    const persistedAfterStartup = parse(readFileSync(treePath, 'utf8')) as {
      status: string;
      tasks: Array<{ id: string; status: string }>;
    };
    expect(persistedAfterStartup.status).toBe('pending_approval');
    expect(persistedAfterStartup.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: INTERRUPTED_TASK_ID, status: 'blocked' }),
      ]),
    );
    expect(
      raven.db.get("SELECT name FROM sqlite_master WHERE name = 'task_trees'"),
    ).toBeUndefined();

    await raven.stop();
    raven = undefined;

    raven = await createRaven(buildTestConfig(), overrides);
    await raven.start();
    baseUrl = `http://127.0.0.1:${String(raven.port)}`;
    raven.eventBus.on<AgentTaskRequestEvent>('agent:task:request', (event) => {
      requests.push(event);
    });
    expect(requests).toHaveLength(0);

    const listResponse = await fetch(`${baseUrl}/api/task-trees`);
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: TREE_ID, status: 'pending_approval', taskCount: 2 }),
      ]),
    );

    const approval = await fetch(`${baseUrl}/api/task-trees/${TREE_ID}/approve`, {
      method: 'POST',
    });
    expect(approval.status).toBe(200);
    await waitFor(() => requests.length === 1);
    expect(requests[0]?.payload).toMatchObject({
      treeId: TREE_ID,
      executionTaskId: INTERRUPTED_TASK_ID,
    });
    expect(requests[0]?.payload.taskId).not.toBe(OLD_AGENT_TASK_ID);

    await waitFor(async () => (await getTree()).status === 'completed');
    const completed = await getTree();
    expect(completed).toMatchObject({ status: 'completed', taskCount: 2, completedCount: 2 });
    expect(completed.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: COMPLETED_TASK_ID,
          status: 'completed',
          artifacts: [
            {
              type: 'file',
              label: 'Completed report',
              filePath: 'notes/completed-report.md',
            },
          ],
        }),
        expect.objectContaining({ id: INTERRUPTED_TASK_ID, status: 'completed' }),
      ]),
    );
    expect(parse(readFileSync(treePath, 'utf8'))).toMatchObject({ status: 'completed' });
    expect(
      raven.db.get("SELECT name FROM sqlite_master WHERE name = 'task_trees'"),
    ).toBeUndefined();
  }, 15_000);

  it('fails before serving when a tree YAML record is invalid, then boots cleanly', async () => {
    root = mkdtempSync(join(tmpdir(), 'raven-invalid-tree-startup-'));
    const paths = createRavenTestFixture(root);
    mkdirSync(join(paths.projectsDir, 'system'), { recursive: true });
    writeFileSync(
      join(paths.projectsDir, 'system', 'context.md'),
      'Raven system context\n',
      'utf8',
    );
    const treesDir = join(paths.projectsDir, 'system', 'tasks', 'trees');
    mkdirSync(treesDir, { recursive: true });
    const invalidPath = join(treesDir, 'invalid.yaml');
    writeFileSync(invalidPath, 'id: invalid\nstatus: definitely-invalid\n', 'utf8');

    const fakeBackend: AgentBackend = async () => ({ result: '', success: true, errors: [] });
    const overrides = {
      ...paths,
      skipSuites: true,
      apiHost: '127.0.0.1',
      agentBackend: fakeBackend,
    };
    await expect(createRaven(buildTestConfig(), overrides)).rejects.toThrow(
      /Invalid execution tree record/,
    );

    rmSync(invalidPath);
    raven = await createRaven(buildTestConfig(), overrides);
    await raven.start();
    const health = await fetch(`http://127.0.0.1:${String(raven.port)}/api/health`);
    expect(health.status).toBe(200);
  });
});
