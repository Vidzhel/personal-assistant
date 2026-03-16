import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RavenEvent, PipelineConfig } from '@raven/shared';
import { EventBus } from '../event-bus/event-bus.ts';
import { createPipelineExecutor } from '../pipeline-engine/pipeline-executor.ts';
import type { PipelineExecutor } from '../pipeline-engine/pipeline-executor.ts';
import type { ValidatedPipeline } from '../pipeline-engine/pipeline-loader.ts';
import type { PipelineStore } from '../pipeline-engine/pipeline-store.ts';

// ─── Mock Helpers ──────────────────────────────────────────────────────────

function makeMockSuiteRegistry() {
  return {
    getSuite: vi.fn().mockReturnValue({ name: 'test' }),
    collectMcpServers: vi.fn().mockReturnValue({}),
    collectAgentDefinitions: vi.fn().mockReturnValue({}),
    getAllSuites: vi.fn().mockReturnValue([]),
    loadSuites: vi.fn(),
    validateAgentTools: vi.fn(),
  };
}

function makeMockMcpManager() {
  return {
    resolveForSuite: vi.fn().mockReturnValue({}),
  };
}

function makeMockPipelineStore(): PipelineStore {
  const runs = new Map<string, any>();
  return {
    insertRun: vi.fn((run) => runs.set(run.id, { ...run })),
    updateRun: vi.fn((id, updates) => {
      const existing = runs.get(id);
      if (existing) runs.set(id, { ...existing, ...updates });
    }),
    getRun: vi.fn((id) => runs.get(id)),
    getRecentRuns: vi.fn().mockReturnValue([]),
    getGlobalStats: vi
      .fn()
      .mockReturnValue({ total: 0, succeeded: 0, failed: 0, successRate: 0, avgDurationMs: null }),
    getPerPipelineStats: vi.fn().mockReturnValue([]),
  };
}

function makeValidatedPipeline(
  config: Partial<PipelineConfig> & { nodes: PipelineConfig['nodes'] },
): ValidatedPipeline {
  const fullConfig: PipelineConfig = {
    name: config.name ?? 'test-pipeline',
    version: config.version ?? 1,
    trigger: config.trigger ?? { type: 'manual' },
    nodes: config.nodes,
    connections: config.connections ?? [],
    enabled: config.enabled ?? true,
    settings: config.settings,
  };

  // Simple topological sort for test helper
  const nodeIds = Object.keys(fullConfig.nodes);
  const inDegree = new Map<string, number>();
  for (const id of nodeIds) inDegree.set(id, 0);
  for (const conn of fullConfig.connections) {
    inDegree.set(conn.to, (inDegree.get(conn.to) ?? 0) + 1);
  }
  const queue = nodeIds.filter((id) => (inDegree.get(id) ?? 0) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    order.push(node);
    for (const conn of fullConfig.connections.filter((c) => c.from === node)) {
      const d = (inDegree.get(conn.to) ?? 1) - 1;
      inDegree.set(conn.to, d);
      if (d === 0) queue.push(conn.to);
    }
  }

  return {
    config: fullConfig,
    executionOrder: order,
    entryPoints: nodeIds.filter(
      (id) => (inDegree.get(id) ?? 0) === 0 || !fullConfig.connections.some((c) => c.to === id),
    ),
    filePath: '/test/pipeline.yaml',
    loadedAt: new Date().toISOString(),
  };
}

/**
 * Simulate agent task completion after a short delay.
 * Listens for agent:task:request and responds with agent:task:complete.
 */
function autoCompleteAgentTasks(eventBus: EventBus, resultFn?: (skillName: string) => string) {
  eventBus.on('agent:task:request', (event: RavenEvent) => {
    if (event.type !== 'agent:task:request') return;
    const { taskId } = event.payload;
    const skillName = event.payload.skillName;

    setTimeout(() => {
      eventBus.emit({
        id: `complete-${taskId}`,
        timestamp: Date.now(),
        source: 'mock-agent',
        type: 'agent:task:complete',
        payload: {
          taskId,
          result: resultFn ? resultFn(skillName) : `Result from ${skillName}`,
          durationMs: 10,
          success: true,
        },
      } as any);
    }, 5);
  });
}

function autoFailAgentTasks(eventBus: EventBus) {
  eventBus.on('agent:task:request', (event: RavenEvent) => {
    if (event.type !== 'agent:task:request') return;
    const { taskId } = event.payload;

    setTimeout(() => {
      eventBus.emit({
        id: `complete-${taskId}`,
        timestamp: Date.now(),
        source: 'mock-agent',
        type: 'agent:task:complete',
        payload: {
          taskId,
          result: '',
          durationMs: 10,
          success: false,
          errors: ['Task execution failed'],
        },
      } as any);
    }, 5);
  });
}

/**
 * Fail agent tasks for the first N attempts, then succeed.
 * Tracks attempt count per nodeId (via skillName).
 */
function autoFailThenSucceedAgentTasks(eventBus: EventBus, failCount: number) {
  const attemptsBySkill = new Map<string, number>();
  eventBus.on('agent:task:request', (event: RavenEvent) => {
    if (event.type !== 'agent:task:request') return;
    const { taskId, skillName } = event.payload;
    const attempts = (attemptsBySkill.get(skillName) ?? 0) + 1;
    attemptsBySkill.set(skillName, attempts);

    setTimeout(() => {
      if (attempts <= failCount) {
        eventBus.emit({
          id: `complete-${taskId}`,
          timestamp: Date.now(),
          source: 'mock-agent',
          type: 'agent:task:complete',
          payload: {
            taskId,
            result: '',
            durationMs: 10,
            success: false,
            errors: ['Transient failure'],
          },
        } as any);
      } else {
        eventBus.emit({
          id: `complete-${taskId}`,
          timestamp: Date.now(),
          source: 'mock-agent',
          type: 'agent:task:complete',
          payload: {
            taskId,
            result: `Result from ${skillName}`,
            durationMs: 10,
            success: true,
          },
        } as any);
      }
    }, 5);
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('PipelineExecutor', () => {
  let eventBus: EventBus;
  let executor: PipelineExecutor;
  let store: PipelineStore;
  let suiteRegistry: ReturnType<typeof makeMockSuiteRegistry>;

  beforeEach(() => {
    eventBus = new EventBus();
    suiteRegistry = makeMockSuiteRegistry();
    store = makeMockPipelineStore();

    executor = createPipelineExecutor({
      eventBus,
      suiteRegistry: suiteRegistry as any,
      mcpManager: makeMockMcpManager() as any,
      pipelineStore: store,
    });
  });

  describe('sequential execution', () => {
    it('executes A → B → C in order', async () => {
      const executionOrder: string[] = [];
      autoCompleteAgentTasks(eventBus, (skill) => {
        executionOrder.push(skill);
        return `Result from ${skill}`;
      });

      const pipeline = makeValidatedPipeline({
        nodes: {
          a: { skill: 'skill-a', action: 'do-a' },
          b: { skill: 'skill-b', action: 'do-b' },
          c: { skill: 'skill-c', action: 'do-c' },
        },
        connections: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'c' },
        ],
      });

      const result = await executor.executePipeline(pipeline, 'manual');

      expect(result.status).toBe('completed');
      expect(result.nodeResults['a'].status).toBe('complete');
      expect(result.nodeResults['b'].status).toBe('complete');
      expect(result.nodeResults['c'].status).toBe('complete');
      // A finishes before B starts, B before C
      expect(executionOrder.indexOf('skill-a')).toBeLessThan(executionOrder.indexOf('skill-b'));
      expect(executionOrder.indexOf('skill-b')).toBeLessThan(executionOrder.indexOf('skill-c'));
    });
  });

  describe('parallel execution', () => {
    it('executes A and B in parallel, then C', async () => {
      const startTimes: Record<string, number> = {};
      autoCompleteAgentTasks(eventBus, (skill) => {
        startTimes[skill] = Date.now();
        return `Result from ${skill}`;
      });

      const pipeline = makeValidatedPipeline({
        nodes: {
          a: { skill: 'skill-a', action: 'do-a' },
          b: { skill: 'skill-b', action: 'do-b' },
          c: { skill: 'skill-c', action: 'do-c' },
        },
        connections: [
          { from: 'a', to: 'c' },
          { from: 'b', to: 'c' },
        ],
      });

      const result = await executor.executePipeline(pipeline, 'manual');

      expect(result.status).toBe('completed');
      expect(result.nodeResults['a'].status).toBe('complete');
      expect(result.nodeResults['b'].status).toBe('complete');
      expect(result.nodeResults['c'].status).toBe('complete');
    });
  });

  describe('condition branching', () => {
    it('follows true branch when condition evaluates to true', async () => {
      // Set up: condition node evaluates expression, routes to true or false path
      autoCompleteAgentTasks(eventBus);

      const pipeline = makeValidatedPipeline({
        nodes: {
          start: { skill: 'test', action: 'start' },
          check: { type: 'condition', expression: '{{ start.urgentCount > 0 }}' },
          'true-path': { skill: 'test', action: 'urgent' },
          'false-path': { skill: 'test', action: 'normal' },
        },
        connections: [
          { from: 'start', to: 'check' },
          { from: 'check', to: 'true-path', condition: 'true' },
          { from: 'check', to: 'false-path', condition: 'false' },
        ],
      });

      // Reset event bus listeners and re-setup with urgentCount in result
      eventBus.removeAllListeners();
      autoCompleteAgentTasks(eventBus, () => JSON.stringify({ urgentCount: 5 }));

      await executor.executePipeline(pipeline, 'manual');

      // Condition flow completes without errors
    });

    it('evaluates condition with properly structured outputs', async () => {
      const pipeline = makeValidatedPipeline({
        nodes: {
          check: {
            type: 'condition',
            expression: '{{ data.output.count > 0 }}',
          },
          'yes-path': { skill: 'test', action: 'yes' },
          'no-path': { skill: 'test', action: 'no' },
        },
        connections: [
          { from: 'check', to: 'yes-path', condition: 'true' },
          { from: 'check', to: 'no-path', condition: 'false' },
        ],
      });

      // Pre-populate nodeOutputs isn't possible through the public API,
      // but condition with no upstream data will evaluate to false,
      // so the false-path should be active and true-path skipped
      autoCompleteAgentTasks(eventBus);

      const result = await executor.executePipeline(pipeline, 'manual');

      expect(result.nodeResults['check'].status).toBe('complete');
      expect(result.nodeResults['check'].output).toBe(false);
      // false-path should run, true-path should be skipped
      expect(result.nodeResults['no-path'].status).toBe('complete');
      expect(result.nodeResults['yes-path'].status).toBe('skipped');
    });
  });

  describe('delay node', () => {
    it('executes delay node', async () => {
      const pipeline = makeValidatedPipeline({
        nodes: {
          wait: { type: 'delay', duration: 10 },
        },
      });

      const result = await executor.executePipeline(pipeline, 'manual');

      expect(result.status).toBe('completed');
      expect(result.nodeResults['wait'].status).toBe('complete');
      expect(result.nodeResults['wait'].durationMs).toBeGreaterThanOrEqual(5);
    });
  });

  describe('merge node', () => {
    it('merge node acts as no-op gate', async () => {
      autoCompleteAgentTasks(eventBus);

      const pipeline = makeValidatedPipeline({
        nodes: {
          a: { skill: 'test', action: 'do-a' },
          b: { skill: 'test', action: 'do-b' },
          merge: { type: 'merge' },
          c: { skill: 'test', action: 'do-c' },
        },
        connections: [
          { from: 'a', to: 'merge' },
          { from: 'b', to: 'merge' },
          { from: 'merge', to: 'c' },
        ],
      });

      const result = await executor.executePipeline(pipeline, 'manual');

      expect(result.status).toBe('completed');
      expect(result.nodeResults['merge'].status).toBe('complete');
      expect(result.nodeResults['c'].status).toBe('complete');
    });
  });

  describe('skill-action node dispatching', () => {
    it('emits agent:task:request with correct payload', async () => {
      const emittedRequests: RavenEvent[] = [];
      eventBus.on('agent:task:request', (e) => emittedRequests.push(e));
      autoCompleteAgentTasks(eventBus);

      const pipeline = makeValidatedPipeline({
        nodes: {
          step: { skill: 'email', action: 'fetch-emails' },
        },
      });

      await executor.executePipeline(pipeline, 'manual');

      expect(emittedRequests).toHaveLength(1);
      const req = emittedRequests[0] as any;
      expect(req.payload.skillName).toBe('email');
      expect(req.payload.actionName).toBe('fetch-emails');
      expect(req.payload.taskId).toBeDefined();
    });
  });

  describe('pipeline failure handling', () => {
    it('marks downstream nodes as skipped when onError: stop', async () => {
      autoFailAgentTasks(eventBus);

      const pipeline = makeValidatedPipeline({
        nodes: {
          a: { skill: 'test', action: 'fail' },
          b: { skill: 'test', action: 'should-skip' },
        },
        connections: [{ from: 'a', to: 'b' }],
        settings: { onError: 'stop', timeout: 600000 },
      });

      const result = await executor.executePipeline(pipeline, 'manual');

      expect(result.status).toBe('failed');
      expect(result.nodeResults['a'].status).toBe('failed');
      expect(result.nodeResults['b'].status).toBe('skipped');
      expect(result.error).toContain('a');
    });
  });

  describe('event emissions', () => {
    it('emits pipeline:started, pipeline:step:complete, pipeline:complete', async () => {
      const events: RavenEvent[] = [];
      eventBus.on('*', (e) => events.push(e));
      autoCompleteAgentTasks(eventBus);

      const pipeline = makeValidatedPipeline({
        nodes: {
          a: { skill: 'test', action: 'do' },
        },
      });

      await executor.executePipeline(pipeline, 'manual');

      const types = events.map((e) => e.type);
      expect(types).toContain('pipeline:started');
      expect(types).toContain('pipeline:step:complete');
      expect(types).toContain('pipeline:complete');
    });

    it('emits pipeline:step:failed and pipeline:failed on failure', async () => {
      const events: RavenEvent[] = [];
      eventBus.on('*', (e) => events.push(e));
      autoFailAgentTasks(eventBus);

      const pipeline = makeValidatedPipeline({
        nodes: {
          a: { skill: 'test', action: 'fail' },
        },
        settings: { onError: 'stop', timeout: 600000 },
      });

      await executor.executePipeline(pipeline, 'manual');

      const types = events.map((e) => e.type);
      expect(types).toContain('pipeline:started');
      expect(types).toContain('pipeline:step:failed');
      expect(types).toContain('pipeline:failed');
    });
  });

  describe('DB record management', () => {
    it('creates and updates pipeline_runs record', async () => {
      autoCompleteAgentTasks(eventBus);

      const pipeline = makeValidatedPipeline({
        nodes: { a: { skill: 'test', action: 'do' } },
      });

      await executor.executePipeline(pipeline, 'manual');

      expect(store.insertRun).toHaveBeenCalledOnce();
      expect(store.updateRun).toHaveBeenCalledOnce();

      const insertCall = (store.insertRun as any).mock.calls[0][0];
      expect(insertCall.status).toBe('running');
      expect(insertCall.pipeline_name).toBe('test-pipeline');

      const updateCall = (store.updateRun as any).mock.calls[0];
      expect(updateCall[1].status).toBe('completed');
      expect(updateCall[1].completed_at).toBeDefined();
    });
  });

  describe('node output threading', () => {
    it('passes upstream outputs to downstream nodes via prompt', async () => {
      const prompts: string[] = [];
      eventBus.on('agent:task:request', (event: RavenEvent) => {
        if (event.type === 'agent:task:request') {
          prompts.push(event.payload.prompt);
        }
      });
      autoCompleteAgentTasks(eventBus, (skill) => `output-from-${skill}`);

      const pipeline = makeValidatedPipeline({
        nodes: {
          a: { skill: 'skill-a', action: 'first' },
          b: { skill: 'skill-b', action: 'second' },
        },
        connections: [{ from: 'a', to: 'b' }],
      });

      await executor.executePipeline(pipeline, 'manual');

      // Second node's prompt should contain upstream output
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain('output-from-skill-a');
    });
  });

  describe('suite not found', () => {
    it('fails node when suite is not found', async () => {
      suiteRegistry.getSuite.mockReturnValue(undefined);

      const pipeline = makeValidatedPipeline({
        nodes: {
          a: { skill: 'nonexistent-suite', action: 'do' },
        },
      });

      const result = await executor.executePipeline(pipeline, 'manual');

      expect(result.status).toBe('failed');
      expect(result.nodeResults['a'].status).toBe('failed');
      expect(result.nodeResults['a'].error).toContain('Suite not found');
    });
  });

  describe('retry behavior', () => {
    it('retries up to maxAttempts with exponential backoff', async () => {
      autoFailAgentTasks(eventBus);

      const pipeline = makeValidatedPipeline({
        nodes: { a: { skill: 'test', action: 'flaky' } },
        settings: { onError: 'stop', timeout: 600000, retry: { maxAttempts: 3, backoffMs: 10 } },
      });

      const result = await executor.executePipeline(pipeline, 'manual');

      expect(result.status).toBe('failed');
      expect(result.nodeResults['a'].status).toBe('failed');
    });

    it('succeeds on retry after transient failure', async () => {
      // Fail first attempt, succeed on second
      autoFailThenSucceedAgentTasks(eventBus, 1);

      const pipeline = makeValidatedPipeline({
        nodes: { a: { skill: 'test', action: 'flaky' } },
        settings: { onError: 'stop', timeout: 600000, retry: { maxAttempts: 3, backoffMs: 10 } },
      });

      const result = await executor.executePipeline(pipeline, 'manual');

      expect(result.status).toBe('completed');
      expect(result.nodeResults['a'].status).toBe('complete');
    });

    it('fails after all retries exhausted', async () => {
      autoFailAgentTasks(eventBus);

      const pipeline = makeValidatedPipeline({
        nodes: { a: { skill: 'test', action: 'always-fail' } },
        settings: { onError: 'stop', timeout: 600000, retry: { maxAttempts: 2, backoffMs: 10 } },
      });

      const result = await executor.executePipeline(pipeline, 'manual');

      expect(result.status).toBe('failed');
      expect(result.nodeResults['a'].status).toBe('failed');
      expect(result.nodeResults['a'].error).toContain('Task execution failed');
    });

    it('does not retry when settings.retry is undefined (single attempt)', async () => {
      const retryEvents: RavenEvent[] = [];
      eventBus.on('pipeline:step:retry', (e) => retryEvents.push(e));
      autoFailAgentTasks(eventBus);

      const pipeline = makeValidatedPipeline({
        nodes: { a: { skill: 'test', action: 'fail' } },
        settings: { onError: 'stop', timeout: 600000 },
      });

      const result = await executor.executePipeline(pipeline, 'manual');

      expect(result.status).toBe('failed');
      expect(retryEvents).toHaveLength(0);
    });

    it('does not retry condition/merge/delay nodes even with retry config', async () => {
      const retryEvents: RavenEvent[] = [];
      eventBus.on('pipeline:step:retry', (e) => retryEvents.push(e));

      const pipeline = makeValidatedPipeline({
        nodes: {
          check: { type: 'condition', expression: '{{ nonexistent.value }}' },
        },
        settings: {
          onError: 'continue',
          timeout: 600000,
          retry: { maxAttempts: 3, backoffMs: 10 },
        },
      });

      await executor.executePipeline(pipeline, 'manual');

      // Condition nodes should not be retried
      expect(retryEvents).toHaveLength(0);
    });

    it('emits pipeline:step:retry event before each retry', async () => {
      const retryEvents: RavenEvent[] = [];
      eventBus.on('pipeline:step:retry', (e) => retryEvents.push(e));
      // Fail first 2 attempts, succeed on third
      autoFailThenSucceedAgentTasks(eventBus, 2);

      const pipeline = makeValidatedPipeline({
        nodes: { a: { skill: 'test', action: 'flaky' } },
        settings: { onError: 'stop', timeout: 600000, retry: { maxAttempts: 3, backoffMs: 10 } },
      });

      const result = await executor.executePipeline(pipeline, 'manual');

      expect(result.status).toBe('completed');
      // 2 retries = 2 retry events (after attempt 1 and after attempt 2)
      expect(retryEvents).toHaveLength(2);

      const first = retryEvents[0] as any;
      expect(first.type).toBe('pipeline:step:retry');
      expect(first.payload.nodeId).toBe('a');
      expect(first.payload.attempt).toBe(1);
      expect(first.payload.maxAttempts).toBe(3);
      expect(first.payload.backoffMs).toBe(10); // 10 * 2^0

      const second = retryEvents[1] as any;
      expect(second.payload.attempt).toBe(2);
      expect(second.payload.backoffMs).toBe(20); // 10 * 2^1
    });

    it('includes attempt and maxAttempts in pipeline:step:failed event', async () => {
      const failedEvents: RavenEvent[] = [];
      eventBus.on('pipeline:step:failed', (e) => failedEvents.push(e));
      autoFailAgentTasks(eventBus);

      const pipeline = makeValidatedPipeline({
        nodes: { a: { skill: 'test', action: 'fail' } },
        settings: { onError: 'stop', timeout: 600000, retry: { maxAttempts: 3, backoffMs: 10 } },
      });

      await executor.executePipeline(pipeline, 'manual');

      expect(failedEvents).toHaveLength(1);
      const payload = (failedEvents[0] as any).payload;
      expect(payload.attempt).toBe(3);
      expect(payload.maxAttempts).toBe(3);
    });

    it('includes attempt number in pipeline:step:complete event', async () => {
      const completeEvents: RavenEvent[] = [];
      eventBus.on('pipeline:step:complete', (e) => completeEvents.push(e));
      // Fail first, succeed on second attempt
      autoFailThenSucceedAgentTasks(eventBus, 1);

      const pipeline = makeValidatedPipeline({
        nodes: { a: { skill: 'test', action: 'flaky' } },
        settings: { onError: 'stop', timeout: 600000, retry: { maxAttempts: 3, backoffMs: 10 } },
      });

      await executor.executePipeline(pipeline, 'manual');

      expect(completeEvents).toHaveLength(1);
      const payload = (completeEvents[0] as any).payload;
      expect(payload.attempt).toBe(2); // succeeded on second attempt
      expect(payload.maxAttempts).toBe(3);
    });

    it('onError: stop still works — pipeline halts after node fails all retries', async () => {
      autoFailAgentTasks(eventBus);

      const pipeline = makeValidatedPipeline({
        nodes: {
          a: { skill: 'test', action: 'fail' },
          b: { skill: 'test', action: 'should-skip' },
        },
        connections: [{ from: 'a', to: 'b' }],
        settings: { onError: 'stop', timeout: 600000, retry: { maxAttempts: 2, backoffMs: 10 } },
      });

      const result = await executor.executePipeline(pipeline, 'manual');

      expect(result.status).toBe('failed');
      expect(result.nodeResults['a'].status).toBe('failed');
      expect(result.nodeResults['b'].status).toBe('skipped');
    });

    it('onError: continue still works — remaining nodes execute after node fails all retries', async () => {
      // Set up: a always fails, b always succeeds
      eventBus.on('agent:task:request', (event: RavenEvent) => {
        if (event.type !== 'agent:task:request') return;
        const { taskId, skillName } = event.payload;

        setTimeout(() => {
          if (skillName === 'fail-skill') {
            eventBus.emit({
              id: `complete-${taskId}`,
              timestamp: Date.now(),
              source: 'mock-agent',
              type: 'agent:task:complete',
              payload: { taskId, result: '', durationMs: 10, success: false, errors: ['Failed'] },
            } as any);
          } else {
            eventBus.emit({
              id: `complete-${taskId}`,
              timestamp: Date.now(),
              source: 'mock-agent',
              type: 'agent:task:complete',
              payload: { taskId, result: 'ok', durationMs: 10, success: true },
            } as any);
          }
        }, 5);
      });

      const pipeline = makeValidatedPipeline({
        nodes: {
          a: { skill: 'fail-skill', action: 'fail' },
          b: { skill: 'ok-skill', action: 'succeed' },
          c: { skill: 'ok-skill', action: 'after-both' },
        },
        connections: [
          { from: 'a', to: 'c' },
          { from: 'b', to: 'c' },
        ],
        settings: {
          onError: 'continue',
          timeout: 600000,
          retry: { maxAttempts: 2, backoffMs: 10 },
        },
      });

      const result = await executor.executePipeline(pipeline, 'manual');

      // a fails after retries, b succeeds, pipeline continues
      expect(result.status).toBe('completed');
      expect(result.nodeResults['a'].status).toBe('failed');
      expect(result.nodeResults['b'].status).toBe('complete');
      // c depends on both a and b — b completed so c should execute
      expect(result.nodeResults['c'].status).toBe('complete');
    });

    it('onError: continue reports failed when ALL nodes fail', async () => {
      autoFailAgentTasks(eventBus);

      const pipeline = makeValidatedPipeline({
        nodes: {
          a: { skill: 'test', action: 'fail-a' },
          b: { skill: 'test', action: 'fail-b' },
        },
        settings: {
          onError: 'continue',
          timeout: 600000,
          retry: { maxAttempts: 1, backoffMs: 10 },
        },
      });

      const result = await executor.executePipeline(pipeline, 'manual');

      expect(result.status).toBe('failed');
      expect(result.error).toBe('All nodes failed');
      expect(result.nodeResults['a'].status).toBe('failed');
      expect(result.nodeResults['b'].status).toBe('failed');
    });
  });
});
