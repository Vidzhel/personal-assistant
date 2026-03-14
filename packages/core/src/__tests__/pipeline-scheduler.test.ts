import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPipelineScheduler } from '../pipeline-engine/pipeline-scheduler.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import type { PipelineEngine } from '../pipeline-engine/pipeline-engine.ts';
import type { ValidatedPipeline } from '../pipeline-engine/pipeline-loader.ts';
import type { PipelineCompleteEvent, PipelineFailedEvent } from '@raven/shared';

// ─── Helpers ───────────────────────────────────────────────────────────────

let cronCallbacks: Map<string, () => void>;
let cronInstances: Array<{ pattern: string; stop: ReturnType<typeof vi.fn> }>;

vi.mock('croner', () => {
  // Use a real class so `new Cron(...)` works
  class MockCron {
    stop = vi.fn();
    constructor(pattern: string, _opts: unknown, callback: () => void) {
      cronCallbacks.set(pattern, callback);
      cronInstances.push({ pattern, stop: this.stop });
    }
  }
  return { Cron: MockCron };
});

function makePipeline(
  name: string,
  trigger: { type: string; schedule?: string; event?: string; filter?: Record<string, unknown> },
  enabled = true,
): ValidatedPipeline {
  return {
    config: {
      name,
      version: 1,
      trigger: trigger as any,
      nodes: { step: { skill: 'test', action: 'run' } },
      connections: [],
      enabled,
    },
    executionOrder: ['step'],
    entryPoints: ['step'],
    filePath: `/pipelines/${name}.yaml`,
    loadedAt: new Date().toISOString(),
  };
}

function createMockEngine(pipelines: ValidatedPipeline[]): PipelineEngine {
  return {
    initialize: vi.fn(),
    getPipeline: vi.fn((name: string) => pipelines.find((p) => p.config.name === name)),
    getAllPipelines: vi.fn(() => pipelines),
    executePipeline: vi.fn(),
    triggerPipeline: vi.fn(() => ({
      runId: 'test-run-id',
      execution: Promise.resolve({} as any),
    })),
    shutdown: vi.fn(),
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('PipelineScheduler', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    cronCallbacks = new Map();
    cronInstances = [];
    eventBus = new EventBus();
  });

  it('registers cron job for cron-triggered pipeline', () => {
    const pipelines = [makePipeline('daily-briefing', { type: 'cron', schedule: '0 6 * * *' })];
    const engine = createMockEngine(pipelines);

    const scheduler = createPipelineScheduler({
      pipelineEngine: engine,
      eventBus,
      timezone: 'UTC',
    });
    scheduler.registerPipelines();

    expect(cronCallbacks.has('0 6 * * *')).toBe(true);
  });

  it('skips disabled pipelines (no cron job created)', () => {
    const pipelines = [
      makePipeline('disabled-one', { type: 'cron', schedule: '0 8 * * *' }, false),
    ];
    const engine = createMockEngine(pipelines);

    const scheduler = createPipelineScheduler({
      pipelineEngine: engine,
      eventBus,
      timezone: 'UTC',
    });
    scheduler.registerPipelines();

    expect(cronCallbacks.size).toBe(0);
  });

  it('skips non-cron trigger types', () => {
    const pipelines = [
      makePipeline('event-one', { type: 'event', event: 'email:new' }),
      makePipeline('manual-one', { type: 'manual' }),
    ];
    const engine = createMockEngine(pipelines);

    const scheduler = createPipelineScheduler({
      pipelineEngine: engine,
      eventBus,
      timezone: 'UTC',
    });
    scheduler.registerPipelines();

    expect(cronCallbacks.size).toBe(0);
  });

  it('calls triggerPipeline when cron fires', () => {
    const pipelines = [makePipeline('daily-briefing', { type: 'cron', schedule: '0 6 * * *' })];
    const engine = createMockEngine(pipelines);

    const scheduler = createPipelineScheduler({
      pipelineEngine: engine,
      eventBus,
      timezone: 'UTC',
    });
    scheduler.registerPipelines();

    // Fire the cron callback
    const callback = cronCallbacks.get('0 6 * * *');
    expect(callback).toBeDefined();
    callback!();

    expect(engine.triggerPipeline).toHaveBeenCalledWith('daily-briefing', 'cron');
  });

  it('skips execution when pipeline already running (concurrent guard)', () => {
    const pipelines = [makePipeline('daily-briefing', { type: 'cron', schedule: '0 6 * * *' })];
    const engine = createMockEngine(pipelines);

    const scheduler = createPipelineScheduler({
      pipelineEngine: engine,
      eventBus,
      timezone: 'UTC',
    });
    scheduler.registerPipelines();

    const callback = cronCallbacks.get('0 6 * * *')!;

    // First fire — should trigger
    callback();
    expect(engine.triggerPipeline).toHaveBeenCalledTimes(1);

    // Second fire — should be skipped (already running)
    callback();
    expect(engine.triggerPipeline).toHaveBeenCalledTimes(1);
  });

  it('removes pipeline from running set on pipeline:complete event', () => {
    const pipelines = [makePipeline('daily-briefing', { type: 'cron', schedule: '0 6 * * *' })];
    const engine = createMockEngine(pipelines);

    const scheduler = createPipelineScheduler({
      pipelineEngine: engine,
      eventBus,
      timezone: 'UTC',
    });
    scheduler.registerPipelines();

    const callback = cronCallbacks.get('0 6 * * *')!;

    // First fire
    callback();
    expect(engine.triggerPipeline).toHaveBeenCalledTimes(1);

    // Emit pipeline:complete
    eventBus.emit({
      id: 'evt-1',
      timestamp: Date.now(),
      source: 'pipeline-executor',
      type: 'pipeline:complete',
      payload: {
        runId: 'run-1',
        pipelineName: 'daily-briefing',
        status: 'completed',
        durationMs: 100,
        timestamp: new Date().toISOString(),
      },
    } as PipelineCompleteEvent);

    // Third fire — should trigger again since complete event was received
    callback();
    expect(engine.triggerPipeline).toHaveBeenCalledTimes(2);
  });

  it('removes pipeline from running set on pipeline:failed event', () => {
    const pipelines = [makePipeline('daily-briefing', { type: 'cron', schedule: '0 6 * * *' })];
    const engine = createMockEngine(pipelines);

    const scheduler = createPipelineScheduler({
      pipelineEngine: engine,
      eventBus,
      timezone: 'UTC',
    });
    scheduler.registerPipelines();

    const callback = cronCallbacks.get('0 6 * * *')!;

    callback();
    expect(engine.triggerPipeline).toHaveBeenCalledTimes(1);

    // Emit pipeline:failed
    eventBus.emit({
      id: 'evt-2',
      timestamp: Date.now(),
      source: 'pipeline-executor',
      type: 'pipeline:failed',
      payload: {
        runId: 'run-1',
        pipelineName: 'daily-briefing',
        status: 'failed',
        error: 'something broke',
        durationMs: 50,
        timestamp: new Date().toISOString(),
      },
    } as PipelineFailedEvent);

    callback();
    expect(engine.triggerPipeline).toHaveBeenCalledTimes(2);
  });

  it('re-registers on config:pipelines:reloaded event (old jobs stopped, new jobs created)', () => {
    const pipelines = [makePipeline('daily-briefing', { type: 'cron', schedule: '0 6 * * *' })];
    const engine = createMockEngine(pipelines);

    const scheduler = createPipelineScheduler({
      pipelineEngine: engine,
      eventBus,
      timezone: 'UTC',
    });
    scheduler.registerPipelines();

    expect(cronCallbacks.has('0 6 * * *')).toBe(true);

    // Clear callbacks to track re-registration
    cronCallbacks.clear();

    // Update engine to return different pipelines
    const newPipelines = [makePipeline('weekly-report', { type: 'cron', schedule: '0 9 * * 1' })];
    (engine.getAllPipelines as any).mockReturnValue(newPipelines);

    // Emit reloaded event
    eventBus.emit({
      id: 'evt-3',
      timestamp: Date.now(),
      source: 'pipeline-loader',
      type: 'config:pipelines:reloaded',
      payload: {
        pipelineName: 'weekly-report',
        action: 'loaded',
        timestamp: new Date().toISOString(),
      },
    });

    // New cron should be registered
    expect(cronCallbacks.has('0 9 * * 1')).toBe(true);
    // Old cron should be gone
    expect(cronCallbacks.has('0 6 * * *')).toBe(false);
  });

  it('shutdown stops all cron jobs', () => {
    const pipelines = [
      makePipeline('daily-briefing', { type: 'cron', schedule: '0 6 * * *' }),
      makePipeline('weekly-report', { type: 'cron', schedule: '0 9 * * 1' }),
    ];
    const engine = createMockEngine(pipelines);

    const scheduler = createPipelineScheduler({
      pipelineEngine: engine,
      eventBus,
      timezone: 'UTC',
    });
    scheduler.registerPipelines();

    expect(cronCallbacks.size).toBe(2);
    expect(cronInstances).toHaveLength(2);

    scheduler.shutdown();

    for (const instance of cronInstances) {
      expect(instance.stop).toHaveBeenCalled();
    }
  });

  it('removes from runningPipelines if triggerPipeline throws synchronously', () => {
    const pipelines = [makePipeline('daily-briefing', { type: 'cron', schedule: '0 6 * * *' })];
    const engine = createMockEngine(pipelines);
    (engine.triggerPipeline as any).mockImplementation(() => {
      throw new Error('Pipeline is disabled');
    });

    const scheduler = createPipelineScheduler({
      pipelineEngine: engine,
      eventBus,
      timezone: 'UTC',
    });
    scheduler.registerPipelines();

    const callback = cronCallbacks.get('0 6 * * *')!;

    // First fire — triggerPipeline throws, should clean up runningPipelines
    callback();

    // Restore normal behavior
    (engine.triggerPipeline as any).mockReturnValue({
      runId: 'test-run-id',
      execution: Promise.resolve({} as any),
    });

    // Second fire — should NOT be blocked by concurrent guard
    callback();
    expect(engine.triggerPipeline).toHaveBeenCalledTimes(2);
  });

  it('clears runningPipelines on config:pipelines:reloaded', () => {
    const pipelines = [makePipeline('daily-briefing', { type: 'cron', schedule: '0 6 * * *' })];
    const engine = createMockEngine(pipelines);

    const scheduler = createPipelineScheduler({
      pipelineEngine: engine,
      eventBus,
      timezone: 'UTC',
    });
    scheduler.registerPipelines();

    // Fire cron to add to runningPipelines
    const callback = cronCallbacks.get('0 6 * * *')!;
    callback();
    expect(engine.triggerPipeline).toHaveBeenCalledTimes(1);

    // Second fire blocked by concurrent guard
    callback();
    expect(engine.triggerPipeline).toHaveBeenCalledTimes(1);

    // Emit reload — should clear runningPipelines
    cronCallbacks.clear();
    eventBus.emit({
      id: 'evt-reload',
      timestamp: Date.now(),
      source: 'pipeline-loader',
      type: 'config:pipelines:reloaded',
      payload: {
        pipelineName: 'daily-briefing',
        action: 'loaded',
        timestamp: new Date().toISOString(),
      },
    });

    // Fire again — should trigger since runningPipelines was cleared
    const newCallback = cronCallbacks.get('0 6 * * *')!;
    newCallback();
    expect(engine.triggerPipeline).toHaveBeenCalledTimes(2);
  });
});
