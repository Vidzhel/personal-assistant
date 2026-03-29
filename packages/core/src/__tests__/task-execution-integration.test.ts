import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, getDb } from '../db/database.ts';
import { TaskExecutionEngine } from '../task-execution/task-execution-engine.ts';
import type { TaskTreeNode } from '@raven/shared';

// ── Helpers ──────────────────────────────────────────────────────────────

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
    get: <T>(sql: string, ...params: unknown[]) =>
      db.prepare(sql).get(...params) as T | undefined,
    all: <T>(sql: string, ...params: unknown[]) =>
      db.prepare(sql).all(...params) as T[],
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

// ── Integration tests ────────────────────────────────────────────────────

describe('task execution integration', () => {
  let tmpDir: string;
  let rawDb: any;
  let dbInterface: ReturnType<typeof makeDbInterface>;
  let eventBus: ReturnType<typeof makeMockEventBus>;
  let engine: TaskExecutionEngine;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-exec-integration-'));
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

  // ── Full sequential chain A → B → C end-to-end ────────────────────────

  it('drives a sequential chain A → B → C to completion with artifacts flowing through', async () => {
    const treeId = uid('tree');
    const a = uid('a');
    const b = uid('b');
    const c = uid('c');

    engine.createTree({
      id: treeId,
      projectId: 'proj-integ',
      plan: 'Sequential pipeline: gather → transform → report',
      tasks: [
        agentNode(a, { title: 'Gather data' }),
        agentNode(b, { title: 'Transform data', blockedBy: [a] }),
        agentNode(c, { title: 'Generate report', blockedBy: [b] }),
      ],
    });

    await engine.startTree(treeId);

    // Only A should be triggered
    let runEvents = eventBus.getByType('execution:task:run-agent');
    expect(runEvents).toHaveLength(1);
    expect(runEvents[0].payload.taskId).toBe(a);

    // Complete A with artifacts
    eventBus.clear();
    await engine.onTaskCompleted({
      treeId,
      taskId: a,
      summary: 'Gathered 100 records',
      artifacts: [{ type: 'data', label: 'records', data: { count: 100 } }],
    });

    // B should now be triggered, A should be completed
    runEvents = eventBus.getByType('execution:task:run-agent');
    expect(runEvents).toHaveLength(1);
    expect(runEvents[0].payload.taskId).toBe(b);
    expect(engine.getTree(treeId)!.tasks.get(a)!.status).toBe('completed');
    expect(engine.getTree(treeId)!.tasks.get(a)!.artifacts[0].data).toEqual({ count: 100 });

    // Complete B
    eventBus.clear();
    await engine.onTaskCompleted({
      treeId,
      taskId: b,
      summary: 'Transformed records',
      artifacts: [{ type: 'data', label: 'transformed', data: { processed: true } }],
    });

    // C should now be triggered
    runEvents = eventBus.getByType('execution:task:run-agent');
    expect(runEvents).toHaveLength(1);
    expect(runEvents[0].payload.taskId).toBe(c);

    // Complete C
    eventBus.clear();
    await engine.onTaskCompleted({
      treeId,
      taskId: c,
      summary: 'Report generated',
      artifacts: [{ type: 'file', label: 'report', filePath: '/tmp/report.pdf' }],
    });

    // Tree should be completed
    const tree = engine.getTree(treeId)!;
    expect(tree.status).toBe('completed');
    expect(tree.projectId).toBe('proj-integ');

    // All tasks should be completed
    for (const [, task] of tree.tasks) {
      expect(task.status).toBe('completed');
      expect(task.completedAt).toBeDefined();
    }

    // Tree completion event should have been emitted
    const treeCompletedEvents = eventBus.getByType('execution:tree:completed');
    expect(treeCompletedEvents).toHaveLength(1);
    expect(treeCompletedEvents[0].payload.status).toBe('completed');
  });

  // ── Parallel fan-out then fan-in ──────────────────────────────────────

  it('executes parallel tasks and waits for all before triggering join', async () => {
    const treeId = uid('tree');
    const a = uid('par-a');
    const b = uid('par-b');
    const c = uid('par-c');
    const joiner = uid('join');

    engine.createTree({
      id: treeId,
      tasks: [
        agentNode(a, { title: 'Parallel A' }),
        agentNode(b, { title: 'Parallel B' }),
        agentNode(c, { title: 'Parallel C' }),
        agentNode(joiner, { title: 'Join results', blockedBy: [a, b, c] }),
      ],
    });

    await engine.startTree(treeId);

    // All three parallel tasks should be triggered
    let runEvents = eventBus.getByType('execution:task:run-agent');
    expect(runEvents).toHaveLength(3);
    const triggeredIds = runEvents.map((e: any) => e.payload.taskId).sort();
    expect(triggeredIds).toEqual([a, b, c].sort());

    // Complete A — joiner should NOT trigger yet
    eventBus.clear();
    await engine.onTaskCompleted({ treeId, taskId: a, summary: 'A done', artifacts: [] });
    expect(eventBus.getByType('execution:task:run-agent')).toHaveLength(0);

    // Complete B — joiner should NOT trigger yet
    eventBus.clear();
    await engine.onTaskCompleted({ treeId, taskId: b, summary: 'B done', artifacts: [] });
    expect(eventBus.getByType('execution:task:run-agent')).toHaveLength(0);

    // Complete C — NOW joiner should trigger
    eventBus.clear();
    await engine.onTaskCompleted({ treeId, taskId: c, summary: 'C done', artifacts: [] });
    runEvents = eventBus.getByType('execution:task:run-agent');
    expect(runEvents).toHaveLength(1);
    expect(runEvents[0].payload.taskId).toBe(joiner);

    // Complete joiner
    eventBus.clear();
    await engine.onTaskCompleted({
      treeId,
      taskId: joiner,
      summary: 'All joined',
      artifacts: [],
    });

    expect(engine.getTree(treeId)!.status).toBe('completed');
  });

  // ── Validation failure with retry then success ────────────────────────

  it('retries a task after validation failure then succeeds', async () => {
    const mockEvaluator = vi
      .fn()
      .mockResolvedValueOnce({ passed: false, reason: 'Summary too vague' })
      .mockResolvedValueOnce({ passed: true, reason: 'Good work' });

    const validatedEngine = new TaskExecutionEngine({
      db: dbInterface,
      eventBus,
      validationDeps: {
        runEvaluator: mockEvaluator,
        runQualityReviewer: async () => ({ passed: true, score: 5, feedback: '' }),
      },
    });

    const treeId = uid('tree');
    const taskId = uid('validated');

    validatedEngine.createTree({
      id: treeId,
      tasks: [
        {
          type: 'agent',
          id: taskId,
          title: 'Task with validation',
          prompt: 'Write a summary of the project',
          blockedBy: [],
          validation: {
            requireArtifacts: false,
            evaluator: true,
            evaluatorModel: 'haiku',
            qualityReview: false,
            qualityModel: 'sonnet',
            qualityThreshold: 3,
            maxRetries: 1,
            retryBackoffMs: 0,
            onMaxRetriesFailed: 'escalate',
          },
        },
      ],
    });

    await validatedEngine.startTree(treeId);

    // First attempt — evaluator will reject
    let runEvents = eventBus.getByType('execution:task:run-agent');
    expect(runEvents).toHaveLength(1);

    await validatedEngine.onTaskCompleted({
      treeId,
      taskId,
      summary: 'Vague summary',
      artifacts: [{ type: 'data', label: 'result', data: { text: 'stuff' } }],
    });

    // Task should be retried
    const tree1 = validatedEngine.getTree(treeId)!;
    const task1 = tree1.tasks.get(taskId)!;
    expect(task1.retryCount).toBe(1);
    expect(task1.lastError).toBe('Summary too vague');

    // A retry run-agent event should have been emitted (with retryFeedback)
    runEvents = eventBus.getByType('execution:task:run-agent');
    const retryEvent = runEvents.find(
      (e: any) => e.payload.taskId === taskId && e.payload.retryFeedback,
    );
    expect(retryEvent).toBeDefined();
    expect(retryEvent!.payload.retryFeedback).toContain('Retry Attempt');

    // Second attempt — evaluator will accept
    eventBus.clear();
    await validatedEngine.onTaskCompleted({
      treeId,
      taskId,
      summary: 'Detailed project summary with metrics',
      artifacts: [{ type: 'data', label: 'result', data: { text: 'detailed' } }],
    });

    const tree2 = validatedEngine.getTree(treeId)!;
    expect(tree2.status).toBe('completed');
    expect(tree2.tasks.get(taskId)!.status).toBe('completed');
    expect(tree2.tasks.get(taskId)!.validationResult?.gate2Passed).toBe(true);
  });

  // ── runIf condition skips dependent task ───────────────────────────────

  it('skips tasks with false runIf condition based on upstream result', async () => {
    const treeId = uid('tree');
    const condition = uid('cond');
    const dependent = uid('dep');
    const always = uid('always');

    engine.createTree({
      id: treeId,
      tasks: [
        {
          type: 'condition',
          id: condition,
          title: 'Check if deploy needed',
          expression: 'false',
          blockedBy: [],
        },
        agentNode(dependent, {
          title: 'Deploy (conditional)',
          blockedBy: [condition],
          runIf: `{{ ${condition}.result }} === true`,
        }),
        agentNode(always, {
          title: 'Send notification',
          blockedBy: [condition],
        }),
      ],
    });

    await engine.startTree(treeId);

    // Condition task executes immediately and evaluates to false
    const tree = engine.getTree(treeId)!;
    expect(tree.tasks.get(condition)!.status).toBe('completed');
    expect(tree.tasks.get(condition)!.artifacts[0].data).toEqual({ result: false });

    // Dependent should be skipped (runIf evaluates to false)
    expect(tree.tasks.get(dependent)!.status).toBe('skipped');

    // The "always" task should have been triggered
    const runEvents = eventBus.getByType('execution:task:run-agent');
    const alwaysTriggered = runEvents.find((e: any) => e.payload.taskId === always);
    expect(alwaysTriggered).toBeDefined();

    // Complete the always task
    eventBus.clear();
    await engine.onTaskCompleted({
      treeId,
      taskId: always,
      summary: 'Notification sent',
      artifacts: [],
    });

    // Tree should complete (condition=completed, dependent=skipped, always=completed)
    expect(engine.getTree(treeId)!.status).toBe('completed');
  });

  // ── Code task execution ───────────────────────────────────────────────

  it('executes a code task and captures output artifact', async () => {
    const scriptPath = join(tmpDir, 'integration-test-script.sh');
    writeFileSync(scriptPath, '#!/bin/bash\necho "integration-test-output"');
    chmodSync(scriptPath, '755');

    const treeId = uid('tree');
    const codeTask = uid('code');
    const afterTask = uid('after');

    engine.createTree({
      id: treeId,
      tasks: [
        {
          type: 'code',
          id: codeTask,
          title: 'Run build script',
          script: scriptPath,
          args: [],
          blockedBy: [],
        },
        agentNode(afterTask, { title: 'Analyze build output', blockedBy: [codeTask] }),
      ],
    });

    await engine.startTree(treeId);

    // Wait for the async execFile to complete
    await new Promise((resolve) => setTimeout(resolve, 500));

    const tree = engine.getTree(treeId)!;
    const code = tree.tasks.get(codeTask)!;
    expect(code.status).toBe('completed');
    expect(code.summary).toBe('integration-test-output');
    expect(code.artifacts[0].data).toEqual({ output: 'integration-test-output' });

    // The dependent agent task should have been triggered after code completed
    const runEvents = eventBus.getByType('execution:task:run-agent');
    const afterTriggered = runEvents.find((e: any) => e.payload.taskId === afterTask);
    expect(afterTriggered).toBeDefined();
  });

  // ── Mixed task types in a complex DAG ─────────────────────────────────

  it('handles a complex DAG with mixed task types: agent, condition, notify', async () => {
    const treeId = uid('tree');
    const gather = uid('gather');
    const check = uid('check');
    const processTrue = uid('proc-true');
    const processFalse = uid('proc-false');
    const notify = uid('notify');

    engine.createTree({
      id: treeId,
      plan: 'Gather → condition → branch → notify',
      tasks: [
        agentNode(gather, { title: 'Gather metrics' }),
        {
          type: 'condition',
          id: check,
          title: 'Check if metrics are good',
          expression: `{{ ${gather}.result }} === true`,
          blockedBy: [gather],
        },
        agentNode(processTrue, {
          title: 'Process good metrics',
          blockedBy: [check],
          runIf: `{{ ${check}.result }} === true`,
        }),
        agentNode(processFalse, {
          title: 'Handle bad metrics',
          blockedBy: [check],
          runIf: `{{ ${check}.result }} === false`,
        }),
        {
          type: 'notify',
          id: notify,
          title: 'Notify team',
          channel: 'telegram',
          message: 'Pipeline finished',
          attachments: [],
          blockedBy: [processTrue, processFalse],
        },
      ],
    });

    await engine.startTree(treeId);

    // Only gather should be triggered
    let runEvents = eventBus.getByType('execution:task:run-agent');
    expect(runEvents).toHaveLength(1);
    expect(runEvents[0].payload.taskId).toBe(gather);

    // Complete gather with result=true
    eventBus.clear();
    await engine.onTaskCompleted({
      treeId,
      taskId: gather,
      summary: 'Metrics collected',
      artifacts: [{ type: 'data', label: 'result', data: { result: true } }],
    });

    // Condition should evaluate (synchronous), then trigger branching
    const tree1 = engine.getTree(treeId)!;
    expect(tree1.tasks.get(check)!.status).toBe('completed');
    expect(tree1.tasks.get(check)!.artifacts[0].data).toEqual({ result: true });

    // processTrue should be triggered (runIf=true), processFalse should be skipped
    expect(tree1.tasks.get(processFalse)!.status).toBe('skipped');

    runEvents = eventBus.getByType('execution:task:run-agent');
    const processTrueEvent = runEvents.find((e: any) => e.payload.taskId === processTrue);
    expect(processTrueEvent).toBeDefined();

    // Complete processTrue
    eventBus.clear();
    await engine.onTaskCompleted({
      treeId,
      taskId: processTrue,
      summary: 'Processed good metrics',
      artifacts: [],
    });

    // Notify should fire (both processTrue=completed and processFalse=skipped are terminal)
    const tree2 = engine.getTree(treeId)!;
    expect(tree2.tasks.get(notify)!.status).toBe('completed');

    const notifyEvents = eventBus.getByType('notification:deliver');
    expect(notifyEvents).toHaveLength(1);
    expect(notifyEvents[0].payload.channel).toBe('telegram');

    // Tree should be completed
    expect(tree2.status).toBe('completed');
  });

  // ── Approval gate blocks then unblocks downstream ─────────────────────

  it('blocks execution at approval gate, then proceeds after approval', async () => {
    const treeId = uid('tree');
    const prep = uid('prep');
    const approve = uid('approve');
    const deploy = uid('deploy');
    const notifyDone = uid('notify-done');

    engine.createTree({
      id: treeId,
      tasks: [
        agentNode(prep, { title: 'Prepare deployment' }),
        {
          type: 'approval',
          id: approve,
          title: 'Approve deployment',
          message: 'Ready to deploy to production?',
          blockedBy: [prep],
        },
        agentNode(deploy, { title: 'Deploy to production', blockedBy: [approve] }),
        {
          type: 'notify',
          id: notifyDone,
          title: 'Notify deployment complete',
          channel: 'telegram',
          message: 'Deployed!',
          attachments: [],
          blockedBy: [deploy],
        },
      ],
    });

    await engine.startTree(treeId);

    // Prep should be triggered
    expect(eventBus.getByType('execution:task:run-agent')).toHaveLength(1);

    // Complete prep
    eventBus.clear();
    await engine.onTaskCompleted({
      treeId,
      taskId: prep,
      summary: 'Prep done',
      artifacts: [],
    });

    // Approval should be pending
    const tree1 = engine.getTree(treeId)!;
    expect(tree1.tasks.get(approve)!.status).toBe('pending_approval');
    expect(eventBus.getByType('execution:task:approval-needed')).toHaveLength(1);

    // Deploy should NOT be triggered yet
    expect(
      eventBus.getByType('execution:task:run-agent').find((e: any) => e.payload.taskId === deploy),
    ).toBeUndefined();

    // Grant approval
    eventBus.clear();
    await engine.onApprovalGranted(treeId, approve);

    // Deploy should now be triggered
    const runEvents = eventBus.getByType('execution:task:run-agent');
    expect(runEvents).toHaveLength(1);
    expect(runEvents[0].payload.taskId).toBe(deploy);

    // Complete deploy
    eventBus.clear();
    await engine.onTaskCompleted({
      treeId,
      taskId: deploy,
      summary: 'Deployed successfully',
      artifacts: [],
    });

    // Notify should fire and tree should complete
    const tree2 = engine.getTree(treeId)!;
    expect(tree2.tasks.get(notifyDone)!.status).toBe('completed');
    expect(tree2.status).toBe('completed');

    const notifyEvents = eventBus.getByType('notification:deliver');
    expect(notifyEvents).toHaveLength(1);
  });

  // ── DB persistence across engine instances ────────────────────────────

  it('persists tree state to DB and loads it in a new engine instance', async () => {
    const treeId = uid('tree');
    const a = uid('a');
    const b = uid('b');

    engine.createTree({
      id: treeId,
      projectId: 'proj-persist',
      plan: 'Persistence test',
      tasks: [agentNode(a), agentNode(b, { blockedBy: [a] })],
    });

    await engine.startTree(treeId);
    await engine.onTaskCompleted({
      treeId,
      taskId: a,
      summary: 'A completed',
      artifacts: [{ type: 'data', label: 'result', data: { value: 42 } }],
    });

    // Create a fresh engine pointing at the same DB
    const freshEventBus = makeMockEventBus();
    const freshEngine = new TaskExecutionEngine({ db: dbInterface, eventBus: freshEventBus });

    // Load the tree from DB
    const loaded = freshEngine.getTree(treeId);
    expect(loaded).toBeDefined();
    expect(loaded!.projectId).toBe('proj-persist');
    expect(loaded!.status).toBe('running');
    expect(loaded!.tasks.size).toBe(2);

    // Task A should show as completed with its artifacts
    const taskA = loaded!.tasks.get(a)!;
    expect(taskA.status).toBe('completed');
    expect(taskA.summary).toBe('A completed');
    expect(taskA.artifacts[0].data).toEqual({ value: 42 });

    // Task B should be in_progress (it was triggered when A completed)
    const taskB = loaded!.tasks.get(b)!;
    expect(taskB.status).toBe('in_progress');
  });

  // ── Cancellation mid-flight ───────────────────────────────────────────

  it('cancels a tree mid-execution, stopping pending tasks', async () => {
    const treeId = uid('tree');
    const a = uid('a');
    const b = uid('b');
    const c = uid('c');

    engine.createTree({
      id: treeId,
      tasks: [
        agentNode(a),
        agentNode(b, { blockedBy: [a] }),
        agentNode(c, { blockedBy: [b] }),
      ],
    });

    await engine.startTree(treeId);

    // Complete A so B gets triggered
    await engine.onTaskCompleted({ treeId, taskId: a, summary: 'Done', artifacts: [] });

    // Now cancel while B is in progress and C is still todo
    engine.cancelTree(treeId);

    const tree = engine.getTree(treeId)!;
    expect(tree.status).toBe('cancelled');
    expect(tree.tasks.get(a)!.status).toBe('completed'); // already finished
    expect(tree.tasks.get(b)!.status).toBe('cancelled'); // was in_progress
    expect(tree.tasks.get(c)!.status).toBe('cancelled'); // was todo

    const cancelEvents = eventBus.getByType('execution:tree:completed');
    const cancelEvent = cancelEvents.find((e: any) => e.payload.status === 'cancelled');
    expect(cancelEvent).toBeDefined();
  });
});
