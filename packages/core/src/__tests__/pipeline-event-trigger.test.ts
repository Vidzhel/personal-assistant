import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createPipelineEventTrigger,
  matchesFilter,
} from '../pipeline-engine/pipeline-event-trigger.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import type { PipelineEngine } from '../pipeline-engine/pipeline-engine.ts';
import type { ValidatedPipeline } from '../pipeline-engine/pipeline-loader.ts';
import type { RavenEvent } from '@raven/shared';

// ─── Helpers ───────────────────────────────────────────────────────────────

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

function makeEvent(type: string, payload: Record<string, unknown>): RavenEvent {
  return {
    id: 'evt-1',
    timestamp: Date.now(),
    source: 'test',
    type,
    payload,
  } as any;
}

// ─── matchesFilter Tests ───────────────────────────────────────────────────

describe('matchesFilter', () => {
  it('returns true for exact match', () => {
    expect(matchesFilter({ sender: 'alice@example.com' }, { sender: 'alice@example.com' })).toBe(
      true,
    );
  });

  it('returns true for string substring match', () => {
    expect(matchesFilter({ sender: 'alice@important.com' }, { sender: '@important.com' })).toBe(
      true,
    );
  });

  it('returns false when filter key not in payload', () => {
    expect(matchesFilter({ subject: 'hello' }, { sender: 'alice' })).toBe(false);
  });

  it('returns false when string does not match', () => {
    expect(matchesFilter({ sender: 'bob@other.com' }, { sender: '@important.com' })).toBe(false);
  });

  it('returns true for non-string exact match (number)', () => {
    expect(matchesFilter({ priority: 5 }, { priority: 5 })).toBe(true);
  });

  it('returns false for non-string mismatch', () => {
    expect(matchesFilter({ priority: 3 }, { priority: 5 })).toBe(false);
  });

  it('requires ALL filter keys to match (AND logic)', () => {
    const payload = { sender: 'alice@important.com', subject: 'urgent' };
    expect(matchesFilter(payload, { sender: '@important.com', subject: 'urgent' })).toBe(true);
    expect(matchesFilter(payload, { sender: '@important.com', subject: 'not-found' })).toBe(false);
  });

  it('returns true when filter is empty', () => {
    expect(matchesFilter({ sender: 'anyone' }, {})).toBe(true);
  });
});

// ─── PipelineEventTrigger Tests ────────────────────────────────────────────

describe('PipelineEventTrigger', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
  });

  it('subscribes to correct event type for event-triggered pipeline', () => {
    const pipelines = [makePipeline('email-handler', { type: 'event', event: 'email:new' })];
    const engine = createMockEngine(pipelines);

    const trigger = createPipelineEventTrigger({ pipelineEngine: engine, eventBus });
    trigger.registerPipelines();

    // Emit the event
    eventBus.emit(makeEvent('email:new', { from: 'test@test.com', subject: 'hi' }));

    expect(engine.triggerPipeline).toHaveBeenCalledWith('email-handler', 'event');

    trigger.shutdown();
  });

  it('skips disabled pipelines', () => {
    const pipelines = [
      makePipeline('disabled-handler', { type: 'event', event: 'email:new' }, false),
    ];
    const engine = createMockEngine(pipelines);

    const trigger = createPipelineEventTrigger({ pipelineEngine: engine, eventBus });
    trigger.registerPipelines();

    eventBus.emit(makeEvent('email:new', { from: 'test@test.com' }));

    expect(engine.triggerPipeline).not.toHaveBeenCalled();

    trigger.shutdown();
  });

  it('calls triggerPipeline on matching event', () => {
    const pipelines = [makePipeline('email-handler', { type: 'event', event: 'email:new' })];
    const engine = createMockEngine(pipelines);

    const trigger = createPipelineEventTrigger({ pipelineEngine: engine, eventBus });
    trigger.registerPipelines();

    eventBus.emit(makeEvent('email:new', { from: 'alice@test.com' }));

    expect(engine.triggerPipeline).toHaveBeenCalledTimes(1);
    expect(engine.triggerPipeline).toHaveBeenCalledWith('email-handler', 'event');

    trigger.shutdown();
  });

  it('filter matching: exact match works', () => {
    const pipelines = [
      makePipeline('filtered-handler', {
        type: 'event',
        event: 'email:new',
        filter: { from: 'boss@company.com' },
      }),
    ];
    const engine = createMockEngine(pipelines);

    const trigger = createPipelineEventTrigger({ pipelineEngine: engine, eventBus });
    trigger.registerPipelines();

    eventBus.emit(makeEvent('email:new', { from: 'boss@company.com', subject: 'meeting' }));

    expect(engine.triggerPipeline).toHaveBeenCalledTimes(1);

    trigger.shutdown();
  });

  it('filter matching: substring match for string values', () => {
    const pipelines = [
      makePipeline('important-handler', {
        type: 'event',
        event: 'email:new',
        filter: { from: '@important.com' },
      }),
    ];
    const engine = createMockEngine(pipelines);

    const trigger = createPipelineEventTrigger({ pipelineEngine: engine, eventBus });
    trigger.registerPipelines();

    eventBus.emit(makeEvent('email:new', { from: 'alice@important.com' }));

    expect(engine.triggerPipeline).toHaveBeenCalledTimes(1);

    trigger.shutdown();
  });

  it('filter matching: skips when filter does not match', () => {
    const pipelines = [
      makePipeline('filtered-handler', {
        type: 'event',
        event: 'email:new',
        filter: { from: '@important.com' },
      }),
    ];
    const engine = createMockEngine(pipelines);

    const trigger = createPipelineEventTrigger({ pipelineEngine: engine, eventBus });
    trigger.registerPipelines();

    eventBus.emit(makeEvent('email:new', { from: 'bob@other.com' }));

    expect(engine.triggerPipeline).not.toHaveBeenCalled();

    trigger.shutdown();
  });

  it('filter matching: no filter means all events of that type trigger', () => {
    const pipelines = [makePipeline('all-emails', { type: 'event', event: 'email:new' })];
    const engine = createMockEngine(pipelines);

    const trigger = createPipelineEventTrigger({ pipelineEngine: engine, eventBus });
    trigger.registerPipelines();

    eventBus.emit(makeEvent('email:new', { from: 'anyone@anywhere.com' }));

    expect(engine.triggerPipeline).toHaveBeenCalledTimes(1);

    trigger.shutdown();
  });

  it('re-registers on config:pipelines:reloaded', () => {
    const pipelines = [makePipeline('email-handler', { type: 'event', event: 'email:new' })];
    const engine = createMockEngine(pipelines);

    const trigger = createPipelineEventTrigger({ pipelineEngine: engine, eventBus });
    trigger.registerPipelines();

    // Update engine to return different pipelines
    const newPipelines = [makePipeline('slack-handler', { type: 'event', event: 'slack:message' })];
    (engine.getAllPipelines as any).mockReturnValue(newPipelines);

    // Emit reload event
    eventBus.emit({
      id: 'evt-reload',
      timestamp: Date.now(),
      source: 'pipeline-loader',
      type: 'config:pipelines:reloaded',
      payload: {
        pipelineName: 'slack-handler',
        action: 'loaded',
        timestamp: new Date().toISOString(),
      },
    } as any);

    // Old event type should not trigger
    eventBus.emit(makeEvent('email:new', { from: 'test@test.com' }));
    expect(engine.triggerPipeline).not.toHaveBeenCalled();

    // New event type should trigger
    eventBus.emit(makeEvent('slack:message', { text: 'hello' }));
    expect(engine.triggerPipeline).toHaveBeenCalledWith('slack-handler', 'event');

    trigger.shutdown();
  });

  it('shutdown unsubscribes all listeners', () => {
    const pipelines = [makePipeline('email-handler', { type: 'event', event: 'email:new' })];
    const engine = createMockEngine(pipelines);

    const trigger = createPipelineEventTrigger({ pipelineEngine: engine, eventBus });
    trigger.registerPipelines();

    trigger.shutdown();

    // Event should not trigger after shutdown
    eventBus.emit(makeEvent('email:new', { from: 'test@test.com' }));
    expect(engine.triggerPipeline).not.toHaveBeenCalled();
  });

  it('handles triggerPipeline sync throw without crashing', () => {
    const pipelines = [makePipeline('email-handler', { type: 'event', event: 'email:new' })];
    const engine = createMockEngine(pipelines);
    (engine.triggerPipeline as any).mockImplementation(() => {
      throw new Error('Pipeline is disabled');
    });

    const trigger = createPipelineEventTrigger({ pipelineEngine: engine, eventBus });
    trigger.registerPipelines();

    // Should not throw — error is caught internally
    expect(() => {
      eventBus.emit(makeEvent('email:new', { from: 'test@test.com' }));
    }).not.toThrow();

    trigger.shutdown();
  });

  it('skips non-event trigger types', () => {
    const pipelines = [
      makePipeline('cron-pipeline', { type: 'cron', schedule: '0 6 * * *' }),
      makePipeline('manual-pipeline', { type: 'manual' }),
    ];
    const engine = createMockEngine(pipelines);

    const trigger = createPipelineEventTrigger({ pipelineEngine: engine, eventBus });
    trigger.registerPipelines();

    // Should not have subscribed to anything — emitting random events should do nothing
    eventBus.emit(makeEvent('email:new', { from: 'test@test.com' }));
    expect(engine.triggerPipeline).not.toHaveBeenCalled();

    trigger.shutdown();
  });
});
