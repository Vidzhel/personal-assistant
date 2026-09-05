import { describe, expect, it, vi } from 'vitest';
import type * as Fs from 'node:fs';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';
import type { AgentTask } from '@raven/shared';
import { createExecutionLogger } from '../agent-manager/execution-logger.ts';
import {
  agentTaskToRunRecord,
  runLocation,
  writeExecutionRunRecord,
} from '../agent-manager/execution-run-records.ts';
import type { ProjectRecordProject } from '../project-manager/project-records.ts';
import { withProjectMutation } from '../project-manager/project-mutation.ts';

const fsFaults = vi.hoisted(() => ({ read: false, write: false, rename: false }));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof Fs>('node:fs');
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (fsFaults.read) {
        fsFaults.read = false;
        const error = new Error('injected missing file') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return actual.readFileSync(...args);
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (fsFaults.write) {
        fsFaults.write = false;
        throw new Error('injected write fault');
      }
      return actual.writeFileSync(...args);
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (fsFaults.rename) {
        fsFaults.rename = false;
        throw new Error('injected rename fault');
      }
      return actual.renameSync(...args);
    },
  };
});

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  const createdAt = Date.now();
  return {
    id: `task-${Math.random().toString(36).slice(2, 9)}`,
    skillName: 'test-skill',
    prompt: 'do something',
    status: 'running',
    priority: 'normal',
    mcpServers: {},
    agentDefinitions: {},
    createdAt,
    startedAt: createdAt,
    ...overrides,
  };
}

function fixture(projects: ProjectRecordProject[] = [{ id: 'meta', fsPath: 'system' }]): {
  root: string;
  projects: ProjectRecordProject[];
  logger: ReturnType<typeof createExecutionLogger>;
} {
  const root = mkdtempSync(join(tmpdir(), 'raven-execution-logger-'));
  for (const project of projects) mkdirSync(join(root, project.fsPath), { recursive: true });
  return {
    root,
    projects,
    logger: createExecutionLogger({ projectsDir: root, projects: () => projects }),
  };
}

function runPath(root: string, fsPath: string, id: string): string {
  return join(root, fsPath, 'tasks', 'runs', `${id}.yaml`);
}

function clean(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

function recordFor(overrides: Partial<AgentTask> = {}) {
  return agentTaskToRunRecord(
    makeTask({ status: 'completed', completedAt: Date.now(), ...overrides }),
  );
}

async function logStartedCompletion(
  logger: ReturnType<typeof createExecutionLogger>,
  task: AgentTask,
): Promise<void> {
  await logger.logTaskStart({
    ...task,
    status: 'running',
    startedAt: task.startedAt ?? task.createdAt,
    completedAt: undefined,
  });
  await logger.logTaskComplete(task);
}

describe('file execution logger', () => {
  it('snapshots persisted fields without cloning nonpersisted task metadata', async () => {
    const state = fixture();
    try {
      const task = makeTask({ id: 'noncloneable-metadata' });
      Object.assign(task, { nonCloneableMetadata: () => 'runtime only' });
      await state.logger.logTaskStart(task);
      await state.logger.logTaskComplete({
        ...task,
        status: 'completed',
        completedAt: Date.now(),
        result: 'done',
      });
      expect(state.logger.getTaskById(task.id)?.result).toBe('done');
    } finally {
      clean(state.root);
    }
  });

  it('persists starts and completion metadata in the owning project', async () => {
    const state = fixture([
      { id: 'meta', fsPath: 'system' },
      { id: 'project-a', fsPath: 'project-a' },
    ]);
    try {
      const task = makeTask({
        id: 'run-1',
        projectId: 'project-a',
        treeId: 'tree-1',
        executionTaskId: 'node-1',
        namedAgentId: 'researcher',
      });
      await state.logger.logTaskStart(task);
      expect(readFileSync(runPath(state.root, 'project-a', task.id), 'utf8')).toContain(
        'executionTaskId: node-1',
      );

      await state.logger.logTaskComplete({
        ...task,
        status: 'completed',
        result: 'done',
        durationMs: 125,
        completedAt: Date.now(),
      });
      expect(state.logger.getTaskById(task.id)).toMatchObject({
        status: 'completed',
        result: 'done',
        projectId: 'project-a',
        treeId: 'tree-1',
        executionTaskId: 'node-1',
        namedAgentId: 'researcher',
      });
      expect(state.logger.queryTasks({ projectId: 'project-a' })).toHaveLength(1);
      expect(state.logger.queryTasks({ projectId: 'meta' })).toHaveLength(0);
    } finally {
      clean(state.root);
    }
  });

  it('supports terminal outcomes, cancellation before start, and idempotent completion', async () => {
    const state = fixture();
    try {
      const failed = makeTask({
        id: 'failed-run',
        status: 'failed',
        errors: ['bad'],
        completedAt: Date.now(),
      });
      const blocked = makeTask({ id: 'blocked-run', status: 'blocked', completedAt: Date.now() });
      const cancelled = makeTask({
        id: 'cancelled-run',
        status: 'cancelled',
        startedAt: undefined,
        completedAt: Date.now(),
      });
      await logStartedCompletion(state.logger, failed);
      await logStartedCompletion(state.logger, blocked);
      await state.logger.logTaskComplete(cancelled);
      expect(state.logger.getTaskById('failed-run')?.status).toBe('failed');
      expect(state.logger.getTaskById('blocked-run')?.blocked).toBe(true);
      expect(state.logger.getTaskById('cancelled-run')?.status).toBe('cancelled');

      const completed = makeTask({
        id: 'idempotent-run',
        status: 'completed',
        result: 'done',
        completedAt: Date.now(),
      });
      await logStartedCompletion(state.logger, completed);
      const path = runPath(state.root, 'system', completed.id);
      const before = readFileSync(path, 'utf8');
      await state.logger.logTaskComplete({ ...completed, completedAt: Date.now() });
      expect(readFileSync(path, 'utf8')).toBe(before);
      await expect(
        state.logger.logTaskComplete({
          ...completed,
          result: 'different',
          completedAt: Date.now(),
        }),
      ).rejects.toThrow(/Conflicting terminal update/);
    } finally {
      clean(state.root);
    }
  });

  it('marks queued and running history failed and interrupted on restart', async () => {
    const state = fixture();
    try {
      const running = makeTask({ id: 'restart-running' });
      await state.logger.logTaskStart(running);
      const queued = makeTask({ id: 'restart-queued', status: 'queued', startedAt: undefined });
      writeExecutionRunRecord(
        { projectsDir: state.root, projects: () => state.projects },
        runLocation(
          { projectsDir: state.root, projects: () => state.projects },
          undefined,
          queued.id,
        ),
        agentTaskToRunRecord(queued),
      );
      const restarted = createExecutionLogger({
        projectsDir: state.root,
        projects: () => state.projects,
      });
      expect(restarted.getTaskById(running.id)).toMatchObject({
        status: 'failed',
        interrupted: true,
      });
      expect(restarted.getTaskById(running.id)?.errors).toEqual([
        'Agent run was not durably finalized before process restart; prior execution outcome is unknown',
      ]);
      expect(restarted.getTaskById(queued.id)).toMatchObject({
        status: 'failed',
        interrupted: true,
      });
    } finally {
      clean(state.root);
    }
  });

  it('rejects orphan results and completion callbacks with another attempt identity', async () => {
    const state = fixture();
    try {
      const task = makeTask({ id: 'attempt' });
      const completed = { ...task, status: 'completed' as const, completedAt: Date.now() };
      await expect(state.logger.logTaskComplete(completed)).rejects.toThrow(/no start record/);
      expect(state.logger.queryTasks({})).toEqual([]);
      await state.logger.logTaskStart(task);
      const path = runPath(state.root, 'system', task.id);
      const before = readFileSync(path, 'utf8');
      await expect(
        state.logger.logTaskComplete({ ...completed, startedAt: task.startedAt! + 1 }),
      ).rejects.toThrow(/identity changed/);
      expect(readFileSync(path, 'utf8')).toBe(before);
    } finally {
      clean(state.root);
    }
  });

  it('rejects a stale terminal write while retaining externally edited bytes after a query', async () => {
    const state = fixture();
    try {
      const task = makeTask({ id: 'manual-edit' });
      await state.logger.logTaskStart(task);
      const path = runPath(state.root, 'system', task.id);
      const edited = readFileSync(path, 'utf8').replace('prompt: do something', 'prompt: edited');
      writeFileSync(path, edited);
      expect(state.logger.getTaskById(task.id)?.prompt).toBe('edited');
      await expect(
        state.logger.logTaskComplete({
          ...task,
          status: 'completed',
          result: 'done',
          completedAt: Date.now(),
        }),
      ).rejects.toThrow(/changed on disk/);
      expect(readFileSync(path, 'utf8')).toBe(edited);
    } finally {
      clean(state.root);
    }
  });

  it('retains the previous document when atomic write or rename fails, then recovers', async () => {
    const state = fixture();
    try {
      const task = makeTask({ id: 'atomic-fault' });
      await state.logger.logTaskStart(task);
      const path = runPath(state.root, 'system', task.id);
      const before = readFileSync(path, 'utf8');
      const completed = {
        ...task,
        status: 'completed' as const,
        result: 'done',
        completedAt: Date.now(),
      };

      fsFaults.write = true;
      await expect(state.logger.logTaskComplete(completed)).rejects.toThrow('injected write fault');
      expect(readFileSync(path, 'utf8')).toBe(before);

      fsFaults.rename = true;
      await expect(state.logger.logTaskComplete(completed)).rejects.toThrow(
        'injected rename fault',
      );
      expect(readFileSync(path, 'utf8')).toBe(before);

      await state.logger.logTaskComplete(completed);
      expect(state.logger.getTaskById(task.id)?.status).toBe('completed');
    } finally {
      fsFaults.write = false;
      fsFaults.rename = false;
      fsFaults.read = false;
      clean(state.root);
    }
  });

  it('surfaces a record that disappears after directory enumeration', async () => {
    const projects = [{ id: 'meta', fsPath: 'system' }];
    const root = mkdtempSync(join(tmpdir(), 'raven-execution-missing-'));
    mkdirSync(join(root, 'system', 'tasks', 'runs'), { recursive: true });
    const deps = { projectsDir: root, projects: () => projects };
    const task = makeTask({ id: 'vanished', status: 'running' });
    writeExecutionRunRecord(
      deps,
      runLocation(deps, undefined, task.id),
      agentTaskToRunRecord(task),
    );
    try {
      fsFaults.read = true;
      expect(() => createExecutionLogger(deps)).toThrow('injected missing file');
    } finally {
      fsFaults.read = false;
      clean(root);
    }
  });

  it('filters inclusively and keeps pagination separate from unbounded statistics', async () => {
    const state = fixture();
    try {
      const base = Date.now();
      mkdirSync(join(state.root, 'system', 'tasks', 'runs'), { recursive: true });
      for (let index = 0; index < 55; index += 1) {
        writeFileSync(
          runPath(state.root, 'system', `many-${index}`),
          stringify(
            recordFor({
              id: `many-${index}`,
              skillName: index % 2 === 0 ? 'even' : 'odd',
              status: index % 3 === 0 ? 'failed' : 'completed',
              createdAt: base + index,
              completedAt: base + index,
              durationMs: index,
            }),
          ),
        );
      }
      expect(state.logger.queryTasks({})).toHaveLength(50);
      expect(state.logger.queryTasks({ limit: null })).toHaveLength(55);
      expect(state.logger.queryTasks({ createdSinceMs: base + 54, limit: null })).toHaveLength(1);
      expect(state.logger.queryTasks({ completedSinceMs: base + 54, limit: null })).toHaveLength(1);
      expect(state.logger.getTaskStats(60_000)).toMatchObject({
        total1h: 55,
        succeeded1h: 36,
        failed1h: 19,
      });
      expect(state.logger.getPerSkillStats(60_000).map((item) => item.total)).toEqual([28, 27]);
      await state.logger.logTaskStart(makeTask({ id: 'still-running', skillName: 'incomplete' }));
      expect(state.logger.getTaskStats(Date.now() + 60_000).total1h).toBe(55);
      expect(
        state.logger.getPerSkillStats(Date.now() + 60_000).map((item) => item.skillName),
      ).toEqual(['even', 'odd']);
    } finally {
      clean(state.root);
    }
  });

  it('waits for an active project mutation before committing a terminal transition', async () => {
    const state = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const task = makeTask({ id: 'held-mutation' });
      await state.logger.logTaskStart(task);
      const mutation = withProjectMutation(state.root, async () => gate);
      await Promise.resolve();
      let settled = false;
      const completion = state.logger
        .logTaskComplete({ ...task, status: 'completed', result: 'done', completedAt: Date.now() })
        .then(() => {
          settled = true;
        });
      await Promise.resolve();
      expect(settled).toBe(false);
      release();
      await mutation;
      await completion;
      expect(state.logger.getTaskById(task.id)?.status).toBe('completed');
    } finally {
      release();
      clean(state.root);
    }
  });

  it('rejects malformed, foreign, duplicate, mismatched, and symlinked records', () => {
    const projects = [
      { id: 'meta', fsPath: 'system' },
      { id: 'project-a', fsPath: 'project-a' },
      { id: 'project-b', fsPath: 'project-b' },
    ];
    const cases: Array<{ name: string; prepare: (root: string) => void; message: RegExp }> = [
      {
        name: 'unknown keys',
        prepare: (root) => {
          const record = recordFor({ id: 'unknown-key' });
          writeFileSync(
            runPath(root, 'system', record.id),
            stringify({ ...record, unexpected: true }),
          );
        },
        message: /Invalid agent run record/,
      },
      {
        name: 'running without start',
        prepare: (root) => {
          const record = recordFor({ id: 'running-no-start' });
          writeFileSync(
            runPath(root, 'system', record.id),
            stringify({
              ...record,
              status: 'running',
              startedAt: undefined,
              completedAt: undefined,
            }),
          );
        },
        message: /Running records need startedAt/,
      },
      {
        name: 'terminal without completion',
        prepare: (root) => {
          const record = recordFor({ id: 'terminal-no-completion' });
          writeFileSync(
            runPath(root, 'system', record.id),
            stringify({ ...record, completedAt: undefined }),
          );
        },
        message: /Terminal records need completedAt/,
      },
      {
        name: 'nonterminal with completion',
        prepare: (root) => {
          const record = recordFor({ id: 'queued-with-completion' });
          writeFileSync(
            runPath(root, 'system', record.id),
            stringify({ ...record, status: 'queued' }),
          );
        },
        message: /Nonterminal records cannot have completedAt/,
      },
      {
        name: 'inconsistent blocked state',
        prepare: (root) => {
          const record = recordFor({ id: 'failed-blocked' });
          writeFileSync(
            runPath(root, 'system', record.id),
            stringify({ ...record, status: 'failed', blocked: true }),
          );
        },
        message: /blocked must match status/,
      },
      {
        name: 'interrupted nonfailed state',
        prepare: (root) => {
          const record = recordFor({ id: 'completed-interrupted' });
          writeFileSync(
            runPath(root, 'system', record.id),
            stringify({ ...record, interrupted: true }),
          );
        },
        message: /Only failed records can be interrupted/,
      },
      {
        name: 'foreign ownership',
        prepare: (root) => {
          const record = recordFor({ id: 'foreign', projectId: 'project-a' });
          writeFileSync(runPath(root, 'project-b', record.id), stringify(record));
        },
        message: /ownership mismatch/,
      },
      {
        name: 'duplicate IDs',
        prepare: (root) => {
          for (const fsPath of ['project-a', 'project-b']) {
            const record = recordFor({ id: 'duplicate', projectId: fsPath });
            writeFileSync(runPath(root, fsPath, record.id), stringify(record));
          }
        },
        message: /Duplicate agent run record id/,
      },
      {
        name: 'filename identity',
        prepare: (root) => {
          const record = recordFor({ id: 'document-id' });
          writeFileSync(runPath(root, 'system', 'filename-id'), stringify(record));
        },
        message: /filename does not match/,
      },
      {
        name: 'symlink entry',
        prepare: (root) => {
          const target = runPath(root, 'system', 'target');
          writeFileSync(target, 'invalid');
          symlinkSync(target, runPath(root, 'system', 'link'));
        },
        message: /must not be a symlink/,
      },
    ];

    for (const testCase of cases) {
      const root = mkdtempSync(
        join(tmpdir(), `raven-execution-${testCase.name.replaceAll(' ', '-')}-`),
      );
      for (const project of projects)
        mkdirSync(join(root, project.fsPath, 'tasks', 'runs'), { recursive: true });
      try {
        testCase.prepare(root);
        expect(() =>
          createExecutionLogger({ projectsDir: root, projects: () => projects }),
        ).toThrow(testCase.message);
      } finally {
        clean(root);
      }
    }
  });

  it('does not recreate a missing physical project during a write', async () => {
    const projects = [
      { id: 'meta', fsPath: 'system' },
      { id: 'missing-project', fsPath: 'missing-project' },
    ];
    const state = fixture([projects[0]]);
    try {
      const logger = createExecutionLogger({ projectsDir: state.root, projects: () => projects });
      await expect(
        logger.logTaskStart(makeTask({ id: 'missing', projectId: 'missing-project' })),
      ).rejects.toThrow(/Project directory does not exist/);
      expect(readdirSync(state.root).includes('missing-project')).toBe(false);
    } finally {
      clean(state.root);
    }
  });

  it('rejects unsafe run IDs before creating any record', async () => {
    const state = fixture();
    try {
      await expect(state.logger.logTaskStart(makeTask({ id: '../escape' }))).rejects.toThrow(
        /Invalid record id/,
      );
      expect(readdirSync(join(state.root, 'system'))).toEqual([]);
    } finally {
      clean(state.root);
    }
  });
});
