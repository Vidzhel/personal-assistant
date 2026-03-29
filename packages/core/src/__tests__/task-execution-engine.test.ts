import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, getDb } from '../db/database.ts';
import { TaskExecutionEngine } from '../task-execution/task-execution-engine.ts';
import type { TaskTreeNode } from '@raven/shared';

let idCounter = 0;
function uid(base: string): string {
  idCounter++;
  return `${base}-${String(idCounter)}`;
}

function makeMockEventBus() {
  const events: Array<{ type: string; payload: any }> = [];
  return {
    emit: vi.fn((event: any) => events.push(event)),
    on: vi.fn(),
    off: vi.fn(),
    events,
    getByType(type: string) {
      return events.filter((e) => e.type === type);
    },
    clear() {
      events.length = 0;
    },
  };
}

function makeDbInterface(db: any) {
  return {
    run: (sql: string, ...params: unknown[]) => db.prepare(sql).run(...params),
    get: <T>(sql: string, ...params: unknown[]) => db.prepare(sql).get(...params) as T | undefined,
    all: <T>(sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as T[],
  };
}

function agentNode(id: string, overrides: Partial<any> = {}): TaskTreeNode {
  return {
    type: 'agent',
    id,
    title: `Agent task ${id}`,
    prompt: `Do work for ${id}`,
    blockedBy: [],
    ...overrides,
  } as TaskTreeNode;
}

describe('TaskExecutionEngine', () => {
  let tmpDir: string;
  let rawDb: any;
  let dbInterface: ReturnType<typeof makeDbInterface>;
  let eventBus: ReturnType<typeof makeMockEventBus>;
  let engine: TaskExecutionEngine;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-exec-engine-'));
    rawDb = initDatabase(join(tmpDir, 'test.db'));
    dbInterface = makeDbInterface(rawDb);
  });

  afterAll(() => {
    try {
      getDb().close();
    } catch {
      /* */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    eventBus = makeMockEventBus();
    engine = new TaskExecutionEngine({ db: dbInterface, eventBus });
  });

  // ── createTree ────────────────────────────────────────────────────

  describe('createTree', () => {
    it('stores tree with tasks in correct initial state', () => {
      const treeId = uid('tree');
      const t1 = uid('t');
      const t2 = uid('t');

      const tree = engine.createTree({
        id: treeId,
        projectId: 'proj-1',
        plan: 'Test plan',
        tasks: [agentNode(t1), agentNode(t2)],
      });

      expect(tree.id).toBe(treeId);
      expect(tree.status).toBe('pending_approval');
      expect(tree.projectId).toBe('proj-1');
      expect(tree.plan).toBe('Test plan');
      expect(tree.tasks.size).toBe(2);

      const task1 = tree.tasks.get(t1)!;
      expect(task1.status).toBe('todo');
      expect(task1.retryCount).toBe(0);
      expect(task1.artifacts).toEqual([]);

      // Verify persisted to DB
      const loaded = engine.getTree(treeId);
      expect(loaded).toBeDefined();
      expect(loaded!.tasks.size).toBe(2);
    });
  });

  // ── startTree ─────────────────────────────────────────────────────

  describe('startTree', () => {
    it('triggers tasks with no dependencies', async () => {
      const treeId = uid('tree');
      const t1 = uid('t');
      const t2 = uid('t');

      engine.createTree({
        id: treeId,
        tasks: [agentNode(t1), agentNode(t2)],
      });

      await engine.startTree(treeId);

      const tree = engine.getTree(treeId)!;
      expect(tree.status).toBe('running');

      const runEvents = eventBus.getByType('execution:task:run-agent');
      expect(runEvents).toHaveLength(2);
      expect(runEvents.map((e: any) => e.payload.taskId).sort()).toEqual([t1, t2].sort());
    });

    it('does not trigger tasks with unmet dependencies', async () => {
      const treeId = uid('tree');
      const t1 = uid('t');
      const t2 = uid('t');

      engine.createTree({
        id: treeId,
        tasks: [agentNode(t1), agentNode(t2, { blockedBy: [t1] })],
      });

      await engine.startTree(treeId);

      const runEvents = eventBus.getByType('execution:task:run-agent');
      expect(runEvents).toHaveLength(1);
      expect(runEvents[0].payload.taskId).toBe(t1);
    });
  });

  // ── onTaskCompleted ───────────────────────────────────────────────

  describe('onTaskCompleted', () => {
    it('transitions task to completed and triggers next ready tasks', async () => {
      const treeId = uid('tree');
      const t1 = uid('t');
      const t2 = uid('t');

      engine.createTree({
        id: treeId,
        tasks: [agentNode(t1), agentNode(t2, { blockedBy: [t1] })],
      });
      await engine.startTree(treeId);
      eventBus.clear();

      await engine.onTaskCompleted({
        treeId,
        taskId: t1,
        summary: 'Done',
        artifacts: [{ type: 'data', label: 'result', data: { ok: true } }],
      });

      const tree = engine.getTree(treeId)!;
      expect(tree.tasks.get(t1)!.status).toBe('completed');

      const runEvents = eventBus.getByType('execution:task:run-agent');
      expect(runEvents).toHaveLength(1);
      expect(runEvents[0].payload.taskId).toBe(t2);
    });
  });

  // ── Sequential chain ──────────────────────────────────────────────

  describe('sequential chain A->B->C', () => {
    it('executes in order', async () => {
      const treeId = uid('tree');
      const a = uid('a');
      const b = uid('b');
      const c = uid('c');

      engine.createTree({
        id: treeId,
        tasks: [agentNode(a), agentNode(b, { blockedBy: [a] }), agentNode(c, { blockedBy: [b] })],
      });
      await engine.startTree(treeId);

      expect(eventBus.getByType('execution:task:run-agent')).toHaveLength(1);
      expect(eventBus.getByType('execution:task:run-agent')[0].payload.taskId).toBe(a);

      eventBus.clear();
      await engine.onTaskCompleted({ treeId, taskId: a, summary: 'A done', artifacts: [] });
      expect(eventBus.getByType('execution:task:run-agent')).toHaveLength(1);
      expect(eventBus.getByType('execution:task:run-agent')[0].payload.taskId).toBe(b);

      eventBus.clear();
      await engine.onTaskCompleted({ treeId, taskId: b, summary: 'B done', artifacts: [] });
      expect(eventBus.getByType('execution:task:run-agent')).toHaveLength(1);
      expect(eventBus.getByType('execution:task:run-agent')[0].payload.taskId).toBe(c);

      eventBus.clear();
      await engine.onTaskCompleted({ treeId, taskId: c, summary: 'C done', artifacts: [] });

      const tree = engine.getTree(treeId)!;
      expect(tree.status).toBe('completed');
      expect(eventBus.getByType('execution:tree:completed')).toHaveLength(1);
    });
  });

  // ── Parallel tasks ────────────────────────────────────────────────

  describe('parallel tasks', () => {
    it('triggers both A and B when they have no deps', async () => {
      const treeId = uid('tree');
      const a = uid('a');
      const b = uid('b');
      const c = uid('c');

      engine.createTree({
        id: treeId,
        tasks: [agentNode(a), agentNode(b), agentNode(c, { blockedBy: [a, b] })],
      });
      await engine.startTree(treeId);

      const runEvents = eventBus.getByType('execution:task:run-agent');
      expect(runEvents).toHaveLength(2);
      expect(runEvents.map((e: any) => e.payload.taskId).sort()).toEqual([a, b].sort());
    });
  });

  // ── Validation + retry ────────────────────────────────────────────

  describe('validation failure triggers retry', () => {
    it('increments retryCount and sets status back to todo', async () => {
      const mockEvaluator = vi
        .fn()
        .mockResolvedValueOnce({ passed: false, reason: 'Not good enough' })
        .mockResolvedValueOnce({ passed: true, reason: 'OK' });

      const engineV = new TaskExecutionEngine({
        db: dbInterface,
        eventBus,
        validationDeps: {
          runEvaluator: mockEvaluator,
          runQualityReviewer: async () => ({ passed: true, score: 5, feedback: '' }),
        },
      });

      const treeId = uid('tree');
      const taskId = uid('t');

      engineV.createTree({
        id: treeId,
        tasks: [
          {
            type: 'agent',
            id: taskId,
            title: 'Validated task',
            prompt: 'Do stuff',
            blockedBy: [],
            validation: {
              requireArtifacts: false,
              evaluator: true,
              evaluatorModel: 'haiku',
              qualityReview: false,
              qualityModel: 'sonnet',
              qualityThreshold: 3,
              maxRetries: 2,
              retryBackoffMs: 0,
              onMaxRetriesFailed: 'escalate',
            },
          },
        ],
      });

      await engineV.startTree(treeId);

      await engineV.onTaskCompleted({
        treeId,
        taskId,
        summary: 'First attempt',
        artifacts: [{ type: 'data', label: 'result', data: { x: 1 } }],
      });

      const tree = engineV.getTree(treeId)!;
      const task = tree.tasks.get(taskId)!;
      expect(task.retryCount).toBe(1);
      expect(task.lastError).toBe('Not good enough');

      const retryEvents = eventBus.getByType('execution:task:run-agent');
      expect(retryEvents.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── Max retries exceeded ──────────────────────────────────────────

  describe('max retries exceeded', () => {
    it('marks task failed and emits escalation event', async () => {
      const mockEvaluator = vi.fn().mockResolvedValue({ passed: false, reason: 'Still bad' });

      const engineF = new TaskExecutionEngine({
        db: dbInterface,
        eventBus,
        validationDeps: {
          runEvaluator: mockEvaluator,
          runQualityReviewer: async () => ({ passed: true, score: 5, feedback: '' }),
        },
      });

      const treeId = uid('tree');
      const taskId = uid('t');

      engineF.createTree({
        id: treeId,
        tasks: [
          {
            type: 'agent',
            id: taskId,
            title: 'Will fail',
            prompt: 'Try',
            blockedBy: [],
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

      await engineF.startTree(treeId);
      await engineF.onTaskCompleted({
        treeId,
        taskId,
        summary: 'Bad result',
        artifacts: [],
      });

      const tree = engineF.getTree(treeId)!;
      const task = tree.tasks.get(taskId)!;
      expect(task.status).toBe('failed');

      const failEvents = eventBus.getByType('execution:task:failed');
      expect(failEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Code task ─────────────────────────────────────────────────────

  describe('code task', () => {
    it('executes script and captures output', async () => {
      const scriptPath = join(tmpDir, 'test-script.sh');
      writeFileSync(scriptPath, '#!/bin/bash\necho "hello from script"');
      chmodSync(scriptPath, '755');

      const treeId = uid('tree');
      const taskId = uid('code');

      engine.createTree({
        id: treeId,
        tasks: [
          {
            type: 'code',
            id: taskId,
            title: 'Run script',
            script: scriptPath,
            args: [],
            blockedBy: [],
          },
        ],
      });

      await engine.startTree(treeId);

      // Wait for async execFile to complete
      await new Promise((resolve) => setTimeout(resolve, 500));

      const tree = engine.getTree(treeId)!;
      const task = tree.tasks.get(taskId)!;
      expect(task.status).toBe('completed');
      expect(task.summary).toBe('hello from script');
      expect(task.artifacts[0].data).toEqual({ output: 'hello from script' });
    });
  });

  // ── Condition task ────────────────────────────────────────────────

  describe('condition task', () => {
    it('evaluates expression and stores result', async () => {
      const treeId = uid('tree');
      const taskId = uid('cond');

      engine.createTree({
        id: treeId,
        tasks: [
          {
            type: 'condition',
            id: taskId,
            title: 'Check condition',
            expression: 'true',
            blockedBy: [],
          },
        ],
      });

      await engine.startTree(treeId);

      const tree = engine.getTree(treeId)!;
      const task = tree.tasks.get(taskId)!;
      expect(task.status).toBe('completed');
      expect(task.artifacts[0].data).toEqual({ result: true });
    });

    it('evaluates task reference expressions', async () => {
      const treeId = uid('tree');
      const producer = uid('prod');
      const checker = uid('check');

      engine.createTree({
        id: treeId,
        tasks: [
          agentNode(producer),
          {
            type: 'condition',
            id: checker,
            title: 'Check result',
            expression: `{{ ${producer}.result }} === true`,
            blockedBy: [producer],
          },
        ],
      });

      await engine.startTree(treeId);
      await engine.onTaskCompleted({
        treeId,
        taskId: producer,
        summary: 'Produced result',
        artifacts: [{ type: 'data', label: 'result', data: { result: true } }],
      });

      const tree = engine.getTree(treeId)!;
      const checkerTask = tree.tasks.get(checker)!;
      expect(checkerTask.status).toBe('completed');
      expect(checkerTask.artifacts[0].data).toEqual({ result: true });
    });
  });

  // ── Notify task ───────────────────────────────────────────────────

  describe('notify task', () => {
    it('emits notification event and marks complete', async () => {
      const treeId = uid('tree');
      const taskId = uid('note');

      engine.createTree({
        id: treeId,
        tasks: [
          {
            type: 'notify',
            id: taskId,
            title: 'Send notification',
            channel: 'telegram',
            message: 'Hello!',
            attachments: [],
            blockedBy: [],
          },
        ],
      });

      await engine.startTree(treeId);

      const tree = engine.getTree(treeId)!;
      const task = tree.tasks.get(taskId)!;
      expect(task.status).toBe('completed');

      const notifyEvents = eventBus.getByType('notification:deliver');
      expect(notifyEvents).toHaveLength(1);
      expect(notifyEvents[0].payload.channel).toBe('telegram');
    });
  });

  // ── Approval task ─────────────────────────────────────────────────

  describe('approval task', () => {
    it('pauses execution until approved', async () => {
      const treeId = uid('tree');
      const approveId = uid('approve');
      const afterId = uid('after');

      engine.createTree({
        id: treeId,
        tasks: [
          {
            type: 'approval',
            id: approveId,
            title: 'Get approval',
            message: 'Please approve',
            blockedBy: [],
          },
          agentNode(afterId, { blockedBy: [approveId] }),
        ],
      });

      await engine.startTree(treeId);

      const tree = engine.getTree(treeId)!;
      expect(tree.tasks.get(approveId)!.status).toBe('pending_approval');

      const runEvents = eventBus.getByType('execution:task:run-agent');
      expect(runEvents).toHaveLength(0);

      const approvalEvents = eventBus.getByType('execution:task:approval-needed');
      expect(approvalEvents).toHaveLength(1);

      eventBus.clear();
      await engine.onApprovalGranted(treeId, approveId);

      const treeAfter = engine.getTree(treeId)!;
      expect(treeAfter.tasks.get(approveId)!.status).toBe('completed');

      const postRunEvents = eventBus.getByType('execution:task:run-agent');
      expect(postRunEvents).toHaveLength(1);
      expect(postRunEvents[0].payload.taskId).toBe(afterId);
    });
  });

  // ── Tree completion ───────────────────────────────────────────────

  describe('tree completion', () => {
    it('marks tree completed when all tasks done', async () => {
      const treeId = uid('tree');
      const taskId = uid('t');

      engine.createTree({
        id: treeId,
        tasks: [agentNode(taskId)],
      });

      await engine.startTree(treeId);
      await engine.onTaskCompleted({
        treeId,
        taskId,
        summary: 'Done',
        artifacts: [],
      });

      const tree = engine.getTree(treeId)!;
      expect(tree.status).toBe('completed');

      const treeCompleted = eventBus.getByType('execution:tree:completed');
      expect(treeCompleted).toHaveLength(1);
      expect(treeCompleted[0].payload.status).toBe('completed');
    });

    it('marks tree failed if any task failed', async () => {
      const mockEvaluator = vi.fn().mockResolvedValue({ passed: false, reason: 'Bad' });

      const engineF = new TaskExecutionEngine({
        db: dbInterface,
        eventBus,
        validationDeps: {
          runEvaluator: mockEvaluator,
          runQualityReviewer: async () => ({ passed: true, score: 5, feedback: '' }),
        },
      });

      const treeId = uid('tree');
      const taskId = uid('t');

      engineF.createTree({
        id: treeId,
        tasks: [
          {
            type: 'agent',
            id: taskId,
            title: 'Bad task',
            prompt: 'Fail',
            blockedBy: [],
            validation: {
              requireArtifacts: false,
              evaluator: true,
              evaluatorModel: 'haiku',
              qualityReview: false,
              qualityModel: 'sonnet',
              qualityThreshold: 3,
              maxRetries: 0,
              retryBackoffMs: 0,
              onMaxRetriesFailed: 'fail',
            },
          },
        ],
      });

      await engineF.startTree(treeId);
      await engineF.onTaskCompleted({
        treeId,
        taskId,
        summary: 'Bad',
        artifacts: [],
      });

      const tree = engineF.getTree(treeId)!;
      expect(tree.status).toBe('failed');
    });
  });

  // ── cancelTree ────────────────────────────────────────────────────

  describe('cancelTree', () => {
    it('cancels all pending tasks', async () => {
      const treeId = uid('tree');
      const a = uid('a');
      const b = uid('b');

      engine.createTree({
        id: treeId,
        tasks: [agentNode(a), agentNode(b, { blockedBy: [a] })],
      });

      await engine.startTree(treeId);
      engine.cancelTree(treeId);

      const tree = engine.getTree(treeId)!;
      expect(tree.status).toBe('cancelled');

      for (const [, task] of tree.tasks) {
        expect(['cancelled', 'completed', 'skipped', 'failed']).toContain(task.status);
      }
    });
  });

  // ── runIf condition ───────────────────────────────────────────────

  describe('runIf condition', () => {
    it('skips task when runIf evaluates to false', async () => {
      const treeId = uid('tree');
      const taskId = uid('skip');

      engine.createTree({
        id: treeId,
        tasks: [agentNode(taskId, { runIf: 'false' })],
      });

      await engine.startTree(treeId);

      const tree = engine.getTree(treeId)!;
      expect(tree.tasks.get(taskId)!.status).toBe('skipped');
      expect(tree.status).toBe('completed');
    });
  });

  // ── Delay task ────────────────────────────────────────────────────

  describe('delay task', () => {
    it('sets in_progress during delay then completes', async () => {
      const treeId = uid('tree');
      const taskId = uid('wait');

      engine.createTree({
        id: treeId,
        tasks: [
          {
            type: 'delay',
            id: taskId,
            title: 'Wait briefly',
            duration: '100ms',
            blockedBy: [],
          },
        ],
      });

      await engine.startTree(treeId);

      let tree = engine.getTree(treeId)!;
      expect(tree.tasks.get(taskId)!.status).toBe('in_progress');

      await new Promise((resolve) => setTimeout(resolve, 200));

      tree = engine.getTree(treeId)!;
      expect(tree.tasks.get(taskId)!.status).toBe('completed');
    });
  });

  // ── onTaskBlocked ─────────────────────────────────────────────────

  describe('onTaskBlocked', () => {
    it('marks task as blocked and emits event', async () => {
      const treeId = uid('tree');
      const taskId = uid('stuck');

      engine.createTree({
        id: treeId,
        tasks: [agentNode(taskId)],
      });

      await engine.startTree(treeId);
      engine.onTaskBlocked(treeId, taskId, 'Missing resource');

      const tree = engine.getTree(treeId)!;
      expect(tree.tasks.get(taskId)!.status).toBe('blocked');
      expect(tree.tasks.get(taskId)!.lastError).toBe('Missing resource');

      const blockedEvents = eventBus.getByType('execution:task:blocked');
      expect(blockedEvents).toHaveLength(1);
    });
  });

  // ── getActiveTrees ────────────────────────────────────────────────

  describe('getActiveTrees', () => {
    it('returns trees with running or pending_approval status', () => {
      const treeId1 = uid('tree');
      const treeId2 = uid('tree');
      const t1 = uid('t');
      const t2 = uid('t');

      engine.createTree({ id: treeId1, tasks: [agentNode(t1)] });
      engine.createTree({ id: treeId2, tasks: [agentNode(t2)] });

      const active = engine.getActiveTrees();
      const ids = active.map((t) => t.id);
      expect(ids).toContain(treeId1);
      expect(ids).toContain(treeId2);
    });
  });
});
