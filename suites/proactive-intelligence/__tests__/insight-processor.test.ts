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
const mockGetInsightsByStatus = vi.fn(() => []);
const mockUpdateInsightStatus = vi.fn();

vi.mock('@raven/core/insight-engine/insight-store.ts', () => ({
  insertInsight: (...args: any[]) => mockInsertInsight(...args),
  findRecentByHash: (...args: any[]) => mockFindRecentByHash(...args),
  computeSuppressionHash: (...args: any[]) => mockComputeSuppressionHash(...args),
  getInsightsByStatus: (...args: any[]) => mockGetInsightsByStatus(...args),
  updateInsightStatus: (...args: any[]) => mockUpdateInsightStatus(...args),
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

  describe('auto-dismiss stale insights', () => {
    it('auto-dismisses queued insights older than 24h before processing new ones', () => {
      const oldTime = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
      mockGetInsightsByStatus.mockReturnValue([
        { id: 'stale-1', created_at: oldTime, status: 'queued' },
        { id: 'stale-2', created_at: oldTime, status: 'queued' },
      ]);
      mockFindRecentByHash.mockReturnValue(undefined);

      handleTaskComplete(makeEvent([{
        patternKey: 'new-pattern',
        title: 'New',
        body: 'Fresh.',
        confidence: 0.9,
        serviceSources: ['s'],
        keyFacts: ['k:1'],
      }]));

      // Should dismiss both stale insights
      expect(mockUpdateInsightStatus).toHaveBeenCalledWith(mockDb, 'stale-1', 'dismissed');
      expect(mockUpdateInsightStatus).toHaveBeenCalledWith(mockDb, 'stale-2', 'dismissed');

      // Should still process the new insight
      expect(mockInsertInsight).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({ patternKey: 'new-pattern', status: 'queued' }),
      );
    });

    it('does not dismiss recent queued insights', () => {
      const recentTime = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
      mockGetInsightsByStatus.mockReturnValue([
        { id: 'recent-1', created_at: recentTime, status: 'queued' },
      ]);
      mockFindRecentByHash.mockReturnValue(undefined);

      handleTaskComplete(makeEvent([{
        patternKey: 'another',
        title: 'Another',
        body: 'Test.',
        confidence: 0.9,
        serviceSources: ['s'],
        keyFacts: ['k:2'],
      }]));

      // Should NOT dismiss the recent insight
      expect(mockUpdateInsightStatus).not.toHaveBeenCalled();
    });
  });

  describe('cross-domain insight handler', () => {
    let handleCrossDomain: (event: unknown) => void;

    beforeEach(() => {
      const onCall = mockEventBus.on.mock.calls.find(
        (c: any) => c[0] === 'knowledge:insight:cross-domain',
      );
      expect(onCall).toBeDefined();
      handleCrossDomain = onCall[1];
      mockEventBus.emit.mockClear();
    });

    function makeCrossDomainEvent(overrides: Record<string, unknown> = {}): unknown {
      return {
        id: 'evt-cd-1',
        timestamp: Date.now(),
        source: 'proactive-intelligence',
        type: 'knowledge:insight:cross-domain',
        payload: {
          sourceBubble: { id: 'b1', title: 'Budget Plan', domains: ['finances'] },
          targetBubble: { id: 'b2', title: 'Gym Routine', domains: ['health'] },
          confidence: 0.85,
          relationshipType: 'RELATES_TO',
          ...overrides,
        },
      };
    }

    it('creates insight with correct pattern_key and emits notification', () => {
      mockFindRecentByHash.mockReturnValue(undefined);

      handleCrossDomain(makeCrossDomainEvent());

      expect(mockInsertInsight).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({
          patternKey: 'cross-domain:finances-health',
          status: 'queued',
          confidence: 0.85,
        }),
      );

      const notifEmit = mockEventBus.emit.mock.calls.find(
        (c: any) => c[0].type === 'notification',
      );
      expect(notifEmit).toBeDefined();
      expect(notifEmit[0].payload.actions).toHaveLength(3);
      expect(notifEmit[0].payload.actions[0].label).toBe('View in Graph');
      expect(notifEmit[0].payload.actions[1].label).toBe('Interesting');
      expect(notifEmit[0].payload.actions[2].label).toBe('Not Useful');
    });

    it('uses ki: prefix for callback actions', () => {
      mockFindRecentByHash.mockReturnValue(undefined);

      handleCrossDomain(makeCrossDomainEvent());

      const notifEmit = mockEventBus.emit.mock.calls.find(
        (c: any) => c[0].type === 'notification',
      );
      expect(notifEmit[0].payload.actions[0].action).toMatch(/^ki:v:/);
      expect(notifEmit[0].payload.actions[1].action).toMatch(/^ki:i:/);
      expect(notifEmit[0].payload.actions[2].action).toMatch(/^ki:n:/);
    });

    it('suppresses duplicates via suppression hash', () => {
      mockFindRecentByHash.mockReturnValue({ id: 'existing', suppression_hash: 'hash-abc' });

      handleCrossDomain(makeCrossDomainEvent());

      expect(mockInsertInsight).not.toHaveBeenCalled();
      expect(mockEventBus.emit).not.toHaveBeenCalled();
    });

    it('formats message body with bubble titles, domains, and relationship', () => {
      mockFindRecentByHash.mockReturnValue(undefined);

      handleCrossDomain(makeCrossDomainEvent());

      const insertCall = mockInsertInsight.mock.calls[0][1];
      expect(insertCall.body).toContain('Budget Plan');
      expect(insertCall.body).toContain('Gym Routine');
      expect(insertCall.body).toContain('finances');
      expect(insertCall.body).toContain('health');
      expect(insertCall.body).toContain('RELATES_TO');
      expect(insertCall.body).toContain('85%');
    });

    it('sorts domains alphabetically in pattern_key', () => {
      mockFindRecentByHash.mockReturnValue(undefined);

      handleCrossDomain(makeCrossDomainEvent({
        sourceBubble: { id: 'b1', title: 'X', domains: ['zebra'] },
        targetBubble: { id: 'b2', title: 'Y', domains: ['alpha'] },
      }));

      expect(mockInsertInsight).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({ patternKey: 'cross-domain:alpha-zebra' }),
      );
    });
  });
});
