import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskExecutionEngine } from '../task-execution/task-execution-engine.ts';
import type { TaskTreeNode } from '@raven/shared';
import { withProjectMutation } from '../project-manager/project-mutation.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'raven-tree-storage-'));
  const projectsDir = join(root, 'projects');
  mkdirSync(join(projectsDir, 'system'), { recursive: true });
  const projects = [{ id: 'meta', fsPath: 'system' }];
  const events: unknown[] = [];
  const eventBus = {
    emit: vi.fn((event: unknown) => events.push(event)),
    on: vi.fn(),
    off: vi.fn(),
  };
  const deps = { projectsDir, projects: () => projects, eventBus };
  return { root, projectsDir, deps, events, store: new TaskExecutionEngine(deps) };
}

function agent(id: string): TaskTreeNode {
  return { type: 'agent', id, title: id, prompt: `Do ${id}`, blockedBy: [] };
}

describe('execution tree YAML persistence', () => {
  it('writes one whole-tree document and returns detached snapshots', () => {
    const data = fixture();
    try {
      const tree = data.store.createTree({ id: 'tree-1', tasks: [agent('task-1')] });
      const path = join(data.projectsDir, 'system', 'tasks', 'trees', 'tree-1.yaml');
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, 'utf8')).toContain('tasks:');
      tree.tasks.clear();
      expect(data.store.getTree('tree-1')?.tasks.size).toBe(1);
    } finally {
      rmSync(data.root, { recursive: true, force: true });
    }
  });

  it('rejects malformed plans before a record or dispatch exists', () => {
    const data = fixture();
    try {
      expect(() =>
        data.store.createTree({
          id: 'bad-tree',
          tasks: [agent('task-1'), { ...agent('task-2'), blockedBy: ['missing'] }],
        }),
      ).toThrow(/Missing execution dependency/);
      expect(existsSync(join(data.projectsDir, 'system', 'tasks', 'trees', 'bad-tree.yaml'))).toBe(
        false,
      );
      expect(data.events).toHaveLength(0);
    } finally {
      rmSync(data.root, { recursive: true, force: true });
    }
  });

  it.each(['999999999d', '{{ params.duration }}', '-1ms', '1.5s'])(
    'rejects delay duration %s before writing a record',
    (duration) => {
      const data = fixture();
      try {
        expect(() =>
          data.store.createTree({
            id: 'too-long',
            tasks: [{ type: 'delay', id: 'wait', title: 'wait', duration, blockedBy: [] }],
          }),
        ).toThrow(/Invalid delay duration/);
        expect(
          existsSync(join(data.projectsDir, 'system', 'tasks', 'trees', 'too-long.yaml')),
        ).toBe(false);
        expect(data.events).toHaveLength(0);
      } finally {
        rmSync(data.root, { recursive: true, force: true });
      }
    },
  );

  it('cancels all nodes in one durable snapshot for restart', async () => {
    const data = fixture();
    try {
      data.store.createTree({ id: 'tree-1', tasks: [agent('task-1'), agent('task-2')] });
      await data.store.startTree('tree-1');
      await data.store.cancelTree('tree-1');
      const restarted = new TaskExecutionEngine({
        ...data.deps,
        eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
      });
      const tree = restarted.getTree('tree-1');
      expect(tree?.status).toBe('cancelled');
      expect([...tree!.tasks.values()].every((task) => task.status === 'cancelled')).toBe(true);
    } finally {
      rmSync(data.root, { recursive: true, force: true });
    }
  });

  it('does not write a late delay completion after stop', async () => {
    const data = fixture();
    try {
      data.store.createTree({
        id: 'tree-1',
        tasks: [{ type: 'delay', id: 'wait', title: 'wait', duration: '20ms', blockedBy: [] }],
      });
      await data.store.startTree('tree-1');
      const before = readFileSync(
        join(data.projectsDir, 'system', 'tasks', 'trees', 'tree-1.yaml'),
        'utf8',
      );
      await data.store.stop();
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(
        readFileSync(join(data.projectsDir, 'system', 'tasks', 'trees', 'tree-1.yaml'), 'utf8'),
      ).toBe(before);
    } finally {
      rmSync(data.root, { recursive: true, force: true });
    }
  });

  it('ignores a held validation result after cancellation', async () => {
    let release!: (result: { passed: boolean; reason: string }) => void;
    const held = new Promise<{ passed: boolean; reason: string }>((resolve) => {
      release = resolve;
    });
    const data = fixture();
    const engine = new TaskExecutionEngine({
      ...data.deps,
      validationDeps: {
        runEvaluator: async () => held,
        runQualityReviewer: async () => ({ passed: true, score: 5, feedback: '' }),
      },
    });
    try {
      engine.createTree({
        id: 'tree-1',
        tasks: [
          {
            ...agent('task-1'),
            validation: {
              requireArtifacts: false,
              evaluator: true,
              evaluatorModel: 'haiku',
              qualityReview: false,
              qualityModel: 'sonnet',
              qualityThreshold: 3,
              maxRetries: 0,
              retryBackoffMs: 0,
              onMaxRetriesFailed: 'escalate',
            },
          },
        ],
      });
      await engine.startTree('tree-1');
      expect(await engine.setAgentTaskId('tree-1', 'task-1', 'attempt-1')).toBe(true);
      const completing = engine.onTaskCompleted({
        treeId: 'tree-1',
        taskId: 'task-1',
        agentTaskId: 'attempt-1',
        summary: 'held',
        artifacts: [],
      });
      await Promise.resolve();
      await engine.cancelTree('tree-1');
      release({ passed: true, reason: 'late success' });
      await completing;
      expect(engine.getTree('tree-1')?.status).toBe('cancelled');
      expect(engine.getTree('tree-1')?.tasks.get('task-1')?.status).toBe('cancelled');
    } finally {
      await engine.stop();
      rmSync(data.root, { recursive: true, force: true });
    }
  });

  it('drains an admitted completion queued behind a project mutation', async () => {
    const data = fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      data.store.createTree({ id: 'tree-1', tasks: [agent('task-1')] });
      await data.store.startTree('tree-1');
      const path = join(data.projectsDir, 'system', 'tasks', 'trees', 'tree-1.yaml');
      const mutation = withProjectMutation(data.projectsDir, async () => held);
      await Promise.resolve();
      const completion = data.store.onTaskCompleted({
        treeId: 'tree-1',
        taskId: 'task-1',
        summary: 'queued completion',
        artifacts: [],
      });
      const stopping = data.store.stop();
      expect(readFileSync(path, 'utf8')).toContain('status: in_progress');
      release();
      await Promise.all([mutation, completion, stopping]);
      const restarted = new TaskExecutionEngine({
        ...data.deps,
        eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
      });
      expect(restarted.getTree('tree-1')?.tasks.get('task-1')?.status).toBe('completed');
    } finally {
      release();
      await data.store.stop();
      rmSync(data.root, { recursive: true, force: true });
    }
  });

  it('accepts an already admitted cancellation after admission stops', async () => {
    const data = fixture();
    try {
      data.store.createTree({ id: 'tree-1', tasks: [agent('task-1')] });
      await data.store.startTree('tree-1');
      data.store.stopAdmission();
      const cancellation = data.store.onTaskCancelled('tree-1', 'task-1');
      const stopping = data.store.stop();
      await Promise.all([cancellation, stopping]);
      const restarted = new TaskExecutionEngine({
        ...data.deps,
        eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
      });
      expect(restarted.getTree('tree-1')?.status).toBe('cancelled');
    } finally {
      await data.store.stop();
      rmSync(data.root, { recursive: true, force: true });
    }
  });
});
