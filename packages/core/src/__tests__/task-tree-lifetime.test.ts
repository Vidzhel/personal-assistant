import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { TaskValidationConfigSchema, type TaskTreeNode } from '@raven/shared';
import { EventBus } from '../event-bus/event-bus.ts';
import { withProjectMutation } from '../project-manager/project-mutation.ts';
import { TaskExecutionEngine } from '../task-execution/task-execution-engine.ts';
import type { ValidationDeps } from '../task-execution/validation-pipeline.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

function agent(id: string, blockedBy: string[] = []): TaskTreeNode {
  return { id, type: 'agent', title: id, prompt: id, blockedBy };
}

describe('execution tree admitted work lifetime', () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const finish of cleanup.reverse()) await finish();
    cleanup.length = 0;
  });

  function fixture(validationDeps?: ValidationDeps) {
    const projectsDir = mkdtempSync(join(tmpdir(), 'raven-tree-lifetime-'));
    mkdirSync(join(projectsDir, 'system'));
    const eventBus = new EventBus();
    const engine = new TaskExecutionEngine({
      projectsDir,
      projects: () => [{ id: 'meta', fsPath: 'system' }],
      eventBus,
      validationDeps,
    });
    const path = join(projectsDir, 'system/tasks/trees/tree.yaml');
    cleanup.push(async () => {
      await engine.stop();
      rmSync(projectsDir, { recursive: true });
    });
    return { engine, projectsDir, eventBus, path };
  }

  async function validatingFixture() {
    const verdict = deferred<{ passed: boolean; reason: string }>();
    const started = deferred<undefined>();
    const data = fixture({
      runEvaluator: async () => {
        started.resolve(undefined);
        return verdict.promise;
      },
      runQualityReviewer: async () => ({ passed: true, score: 5, feedback: '' }),
    });
    data.engine.createTree({
      id: 'tree',
      tasks: [
        {
          ...agent('work'),
          validation: TaskValidationConfigSchema.parse({
            requireArtifacts: false,
            evaluator: true,
            qualityReview: false,
            maxRetries: 0,
          }),
        },
      ],
    });
    await data.engine.startTree('tree');
    await data.engine.setAgentTaskId('tree', 'work', 'attempt');
    const completing = data.engine.onTaskCompleted({
      treeId: 'tree',
      taskId: 'work',
      agentTaskId: 'attempt',
      summary: 'Result',
      artifacts: [],
    });
    await started.promise;
    return { ...data, verdict, completing };
  }

  it('persists cancellation received while new execution admission is stopped', async () => {
    const { engine } = fixture();
    engine.createTree({ id: 'tree', tasks: [agent('work'), agent('dependent', ['work'])] });
    await engine.startTree('tree');
    await engine.setAgentTaskId('tree', 'work', 'attempt');
    engine.stopAdmission();
    await engine.onTaskCancelled('tree', 'work', 'attempt');
    expect(engine.getTree('tree')?.status).toBe('cancelled');
    expect(engine.getTree('tree')?.tasks.get('dependent')?.status).toBe('cancelled');
  });

  it('both concurrent stop callers wait for a held validator and reject late state changes', async () => {
    const data = await validatingFixture();
    const before = readFileSync(data.path, 'utf8');
    const events = vi.fn();
    data.eventBus.on('*', events);
    let stopped = 0;
    const stops = [data.engine.stop(), data.engine.stop()].map(async (work) => {
      await work;
      stopped++;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(stopped).toBe(0);
    } finally {
      data.verdict.resolve({ passed: true, reason: 'Late success' });
    }
    await Promise.all([...stops, data.completing]);
    expect(stopped).toBe(2);
    expect(readFileSync(data.path, 'utf8')).toBe(before);
    expect(events).not.toHaveBeenCalled();
  });

  it('waits for a held project mutation before committing a validation verdict', async () => {
    const data = await validatingFixture();
    const release = deferred<undefined>();
    const entered = deferred<undefined>();
    const mutation = withProjectMutation(data.projectsDir, async () => {
      entered.resolve(undefined);
      await release.promise;
    });
    await entered.promise;
    data.verdict.resolve({ passed: true, reason: 'Accepted' });
    let completed = false;
    void data.completing.then(() => {
      completed = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(completed).toBe(false);
      expect(data.engine.getTree('tree')?.tasks.get('work')?.status).toBe('validating');
    } finally {
      release.resolve(undefined);
    }
    await Promise.all([mutation, data.completing]);
    expect(data.engine.getTree('tree')?.status).toBe('completed');
  });

  it('does not apply a verdict to a task externally edited during validation', async () => {
    const data = await validatingFixture();
    const document = parse(readFileSync(data.path, 'utf8'));
    document.tasks[0].node.prompt = 'New owner instructions';
    const edited = stringify(document);
    writeFileSync(data.path, edited);
    data.verdict.resolve({ passed: true, reason: 'Verdict for previous instructions' });
    await data.completing;
    expect(readFileSync(data.path, 'utf8')).toBe(edited);
    expect(data.engine.getTree('tree')?.tasks.get('work')?.status).toBe('validating');
  });

  it('can cancel an interrupted plan without resuming or retaining invalid markers', async () => {
    const data = fixture();
    data.engine.createTree({ id: 'tree', tasks: [agent('work')] });
    await data.engine.startTree('tree');
    await data.engine.stop();
    const restarted = new TaskExecutionEngine({
      projectsDir: data.projectsDir,
      projects: () => [{ id: 'meta', fsPath: 'system' }],
      eventBus: data.eventBus,
    });
    try {
      expect(restarted.getTree('tree')?.interrupted).toBe(true);
      await restarted.cancelTree('tree');
      expect(restarted.getTree('tree')?.status).toBe('cancelled');
      expect(restarted.getTree('tree')?.interrupted).toBeUndefined();
      expect(restarted.getTree('tree')?.tasks.get('work')?.interrupted).toBeUndefined();
    } finally {
      await restarted.stop();
    }
  });

  it('fail mode stops independent work while preserving the failing result', async () => {
    const { engine } = fixture();
    engine.createTree({
      id: 'tree',
      tasks: [
        {
          ...agent('required'),
          validation: TaskValidationConfigSchema.parse({
            maxRetries: 0,
            onMaxRetriesFailed: 'fail',
          }),
        },
        agent('independent'),
      ],
    });
    await engine.startTree('tree');
    await engine.onTaskFailed('tree', 'required', 'Required work failed');
    expect(engine.getTree('tree')?.status).toBe('failed');
    expect(engine.getTree('tree')?.tasks.get('independent')?.status).toBe('cancelled');
    expect(engine.getTree('tree')?.tasks.get('required')?.lastError).toBe('Required work failed');
  });

  it('a successful parallel branch cannot turn a failed tree into success', async () => {
    const { engine } = fixture();
    engine.createTree({
      id: 'tree',
      tasks: [
        { ...agent('failed'), validation: TaskValidationConfigSchema.parse({ maxRetries: 0 }) },
        agent('successful'),
        agent('unreachable', ['failed']),
      ],
    });
    await engine.startTree('tree');
    await engine.onTaskFailed('tree', 'failed', 'Deliberate failure');
    await engine.onTaskCompleted({
      treeId: 'tree',
      taskId: 'successful',
      summary: 'Other branch completed',
      artifacts: [],
    });
    expect(engine.getTree('tree')?.status).toBe('failed');
    expect(engine.getTree('tree')?.tasks.get('unreachable')?.status).toBe('skipped');
  });

  it('preserves retry backoff across independent completion and a held project reload', async () => {
    const { engine, projectsDir, eventBus } = fixture();
    engine.createTree({
      id: 'tree',
      tasks: [
        { ...agent('retry'), validation: TaskValidationConfigSchema.parse({ retryBackoffMs: 60 }) },
        agent('independent'),
      ],
    });
    await engine.startTree('tree');
    const dispatch = vi.fn();
    eventBus.on('execution:task:run-agent', dispatch);
    await engine.onTaskFailed('tree', 'retry', 'Try again');
    await engine.onTaskCompleted({
      treeId: 'tree',
      taskId: 'independent',
      summary: 'Done',
      artifacts: [],
    });
    expect(dispatch).not.toHaveBeenCalled();
    const release = deferred<undefined>();
    const entered = deferred<undefined>();
    const mutation = withProjectMutation(projectsDir, async () => {
      entered.resolve(undefined);
      await release.promise;
    });
    await entered.promise;
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(dispatch).not.toHaveBeenCalled();
      expect(engine.getTree('tree')?.tasks.get('retry')?.status).toBe('todo');
    } finally {
      release.resolve(undefined);
    }
    await mutation;
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    expect(engine.getTree('tree')?.tasks.get('retry')?.status).toBe('in_progress');
  });

  it('waits for owned command cleanup before stop resolves and preserves interrupted state', async () => {
    const { engine, projectsDir, path } = fixture();
    const ready = join(projectsDir, 'ready');
    const terminated = join(projectsDir, 'terminated');
    const script = [
      "const fs = require('node:fs');",
      `process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync(${JSON.stringify(terminated)}, 'closed'); process.exit(0); }, 100));`,
      `fs.writeFileSync(${JSON.stringify(ready)}, 'ready');`,
      'setInterval(() => {}, 1000);',
    ].join('');
    engine.createTree({
      id: 'tree',
      tasks: [
        {
          id: 'command',
          type: 'code',
          title: 'Owned command',
          blockedBy: [],
          script: process.execPath,
          args: ['-e', script],
        },
      ],
    });
    await engine.startTree('tree');
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 3_000 });
    const before = readFileSync(path, 'utf8');
    await engine.stop();
    expect(existsSync(terminated)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(engine.getTree('tree')?.tasks.get('command')?.status).toBe('in_progress');
  });
});
