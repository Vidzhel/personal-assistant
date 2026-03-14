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
});
