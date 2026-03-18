import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@raven/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@raven/shared')>();
  return {
    ...actual,
    generateId: vi.fn(() => 'test-uuid'),
    createLogger: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  };
});

vi.mock('@raven/core/suite-registry/service-runner.ts', () => ({}));

const mockInsertInsight = vi.fn(() => 'insight-id-1');
const mockFindRecentByHash = vi.fn();
const mockComputeSuppressionHash = vi.fn(() => 'hash-abc');

vi.mock('@raven/core/insight-engine/insight-store.ts', () => ({
  insertInsight: (...args: any[]) => mockInsertInsight(...args),
  findRecentByHash: (...args: any[]) => mockFindRecentByHash(...args),
  computeSuppressionHash: (...args: any[]) => mockComputeSuppressionHash(...args),
}));

import service from '../services/insight-processor.ts';

describe('insight-processor', () => {
  let mockEventBus: any;
  let mockDb: any;
  let handleTaskComplete: (event: unknown) => void;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockEventBus = {
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    };

    mockDb = {};

    await service.start({
      eventBus: mockEventBus,
      db: mockDb,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      config: { confidenceThreshold: 0.6, suppressionWindowDays: 7, maxInsightsPerRun: 5 },
      projectRoot: '/tmp',
    });

    const onCall = mockEventBus.on.mock.calls.find(
      (c: any) => c[0] === 'agent:task:complete',
    );
    handleTaskComplete = onCall[1];
    mockEventBus.emit.mockClear();
  });

  function makeEvent(insights: any[], success = true): unknown {
    return {
      id: 'evt-1',
      timestamp: Date.now(),
      source: 'proactive-intelligence',
      type: 'agent:task:complete',
      payload: {
        taskId: 'task-1',
        skillName: 'proactive-intelligence',
        success,
        result: JSON.stringify({ insights }),
      },
    };
  }

  it('suppresses low-confidence insights with reason low-confidence', () => {
    mockFindRecentByHash.mockReturnValue(undefined);

    handleTaskComplete(makeEvent([{
      patternKey: 'low-conf',
      title: 'Low',
      body: 'Not sure.',
      confidence: 0.3,
      serviceSources: ['gmail'],
      keyFacts: ['emails:2'],
    }]));

    expect(mockInsertInsight).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ status: 'pending', patternKey: 'low-conf' }),
    );

    const suppressedEmit = mockEventBus.emit.mock.calls.find(
      (c: any) => c[0].type === 'insight:suppressed',
    );
    expect(suppressedEmit).toBeDefined();
    expect(suppressedEmit[0].payload.reason).toBe('low-confidence');

    const generatedEmit = mockEventBus.emit.mock.calls.find(
      (c: any) => c[0].type === 'insight:generated',
    );
    expect(generatedEmit).toBeUndefined();
  });

  it('queues high-confidence non-duplicate insights and emits generated + queued + notification', () => {
    mockFindRecentByHash.mockReturnValue(undefined);

    handleTaskComplete(makeEvent([{
      patternKey: 'meeting-overload',
      title: 'Too many meetings',
      body: '8 meetings this week.',
      confidence: 0.9,
      serviceSources: ['ticktick', 'gmail'],
      keyFacts: ['meetings:8'],
    }]));

    expect(mockInsertInsight).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ status: 'queued', patternKey: 'meeting-overload' }),
    );

    const emitTypes = mockEventBus.emit.mock.calls.map((c: any) => c[0].type);
    expect(emitTypes).toContain('insight:generated');
    expect(emitTypes).toContain('insight:queued');
    expect(emitTypes).toContain('notification');
  });

  it('suppresses duplicate insights with reason duplicate', () => {
    mockFindRecentByHash.mockReturnValue({ id: 'existing', suppression_hash: 'hash-abc' });

    handleTaskComplete(makeEvent([{
      patternKey: 'dup-pattern',
      title: 'Duplicate',
      body: 'Same again.',
      confidence: 0.85,
      serviceSources: ['gmail'],
      keyFacts: ['fact:1'],
    }]));

    expect(mockInsertInsight).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ status: 'pending' }),
    );

    const suppressedEmit = mockEventBus.emit.mock.calls.find(
      (c: any) => c[0].type === 'insight:suppressed',
    );
    expect(suppressedEmit).toBeDefined();
    expect(suppressedEmit[0].payload.reason).toBe('duplicate');
  });

  it('ignores events from other skills', () => {
    handleTaskComplete({
      id: 'evt-2',
      timestamp: Date.now(),
      source: 'other',
      type: 'agent:task:complete',
      payload: { taskId: 't2', skillName: 'other-skill', success: true, result: '{}' },
    });

    expect(mockInsertInsight).not.toHaveBeenCalled();
    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });

  it('ignores failed tasks', () => {
    handleTaskComplete(makeEvent([], false));

    expect(mockInsertInsight).not.toHaveBeenCalled();
  });

  it('handles invalid JSON gracefully', () => {
    const event = {
      id: 'evt-3',
      timestamp: Date.now(),
      source: 'proactive-intelligence',
      type: 'agent:task:complete',
      payload: {
        taskId: 'task-3',
        skillName: 'proactive-intelligence',
        success: true,
        result: 'not valid json at all',
      },
    };

    handleTaskComplete(event);

    expect(mockInsertInsight).not.toHaveBeenCalled();
    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });

  it('respects maxInsightsPerRun limit', () => {
    mockFindRecentByHash.mockReturnValue(undefined);

    const insights = Array.from({ length: 8 }, (_, i) => ({
      patternKey: `pattern-${i}`,
      title: `Insight ${i}`,
      body: `Body ${i}`,
      confidence: 0.9,
      serviceSources: ['s'],
      keyFacts: [`k:${i}`],
    }));

    handleTaskComplete(makeEvent(insights));

    expect(mockInsertInsight).toHaveBeenCalledTimes(5);
  });
});
