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

const mockNeo4jQuery = vi.fn();

vi.mock('@raven/core/knowledge-engine/neo4j-client.ts', () => ({
  createNeo4jClient: vi.fn(() => ({
    query: (...args: any[]) => mockNeo4jQuery(...args),
    close: vi.fn(),
  })),
}));

import service from '../services/cross-domain-detector.ts';

describe('cross-domain-detector', () => {
  let mockEventBus: any;
  let mockDb: any;
  let handleLinksSuggested: (event: unknown) => void;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockEventBus = {
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    };

    mockDb = {
      get: vi.fn(),
      all: vi.fn(() => []),
      run: vi.fn(),
    };

    await service.start({
      eventBus: mockEventBus,
      db: mockDb,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      config: {},
      projectRoot: '/tmp',
      integrationsConfig: {} as any,
    });

    const onCall = mockEventBus.on.mock.calls.find(
      (c: any) => c[0] === 'knowledge:links:suggested',
    );
    expect(onCall).toBeDefined();
    handleLinksSuggested = onCall[1];
    mockEventBus.emit.mockClear();
  });

  function makeLinkEvent(
    bubbleId: string,
    links: Array<{ targetBubbleId: string; confidence: number; relationshipType: string }>,
  ): unknown {
    return {
      id: 'evt-1',
      timestamp: Date.now(),
      source: 'clustering',
      type: 'knowledge:links:suggested',
      payload: { bubbleId, links },
    };
  }

  it('emits knowledge:insight:cross-domain for cross-domain links', async () => {
    // Source bubble in 'technology' domain, target in 'health' domain
    mockNeo4jQuery
      .mockResolvedValueOnce([{ title: 'AI Tools', name: 'technology' }])
      .mockResolvedValueOnce([{ title: 'Exercise Tips', name: 'health' }]);

    await handleLinksSuggested(makeLinkEvent('bubble-a', [
      { targetBubbleId: 'bubble-b', confidence: 0.85, relationshipType: 'RELATES_TO' },
    ]));

    const crossDomainEmit = mockEventBus.emit.mock.calls.find(
      (c: any) => c[0].type === 'knowledge:insight:cross-domain',
    );
    expect(crossDomainEmit).toBeDefined();
    expect(crossDomainEmit[0].payload).toMatchObject({
      sourceBubble: { id: 'bubble-a', title: 'AI Tools', domains: ['technology'] },
      targetBubble: { id: 'bubble-b', title: 'Exercise Tips', domains: ['health'] },
      confidence: 0.85,
      relationshipType: 'RELATES_TO',
    });
  });

  it('skips same-domain links (no event emitted)', async () => {
    mockNeo4jQuery
      .mockResolvedValueOnce([{ title: 'A', name: 'technology' }])
      .mockResolvedValueOnce([{ title: 'B', name: 'technology' }]);

    await handleLinksSuggested(makeLinkEvent('bubble-a', [
      { targetBubbleId: 'bubble-b', confidence: 0.85, relationshipType: 'RELATES_TO' },
    ]));

    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });

  it('skips links below default confidence threshold (0.75)', async () => {
    mockNeo4jQuery
      .mockResolvedValueOnce([{ title: 'A', name: 'technology' }])
      .mockResolvedValueOnce([{ title: 'B', name: 'health' }]);

    await handleLinksSuggested(makeLinkEvent('bubble-a', [
      { targetBubbleId: 'bubble-b', confidence: 0.5, relationshipType: 'RELATES_TO' },
    ]));

    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });

  it('respects per-pair adaptive threshold from DB', async () => {
    mockNeo4jQuery
      .mockResolvedValueOnce([{ title: 'A', name: 'health' }])
      .mockResolvedValueOnce([{ title: 'B', name: 'technology' }]);

    // Simulate adaptive threshold of 0.9 for health-technology pair
    mockDb.get.mockReturnValueOnce({ domain_pair: 'health-technology', threshold: 0.9 });

    await handleLinksSuggested(makeLinkEvent('bubble-a', [
      { targetBubbleId: 'bubble-b', confidence: 0.85, relationshipType: 'RELATES_TO' },
    ]));

    // 0.85 < 0.9 adaptive threshold → skipped
    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });

  it('emits when confidence meets adaptive threshold', async () => {
    mockNeo4jQuery
      .mockResolvedValueOnce([{ title: 'A', name: 'health' }])
      .mockResolvedValueOnce([{ title: 'B', name: 'technology' }]);

    mockDb.get.mockReturnValueOnce({ domain_pair: 'health-technology', threshold: 0.8 });

    await handleLinksSuggested(makeLinkEvent('bubble-a', [
      { targetBubbleId: 'bubble-b', confidence: 0.85, relationshipType: 'RELATES_TO' },
    ]));

    const crossDomainEmit = mockEventBus.emit.mock.calls.find(
      (c: any) => c[0].type === 'knowledge:insight:cross-domain',
    );
    expect(crossDomainEmit).toBeDefined();
  });

  it('handles multiple links with mixed domains', async () => {
    // bubble-a: technology, bubble-b: technology (same), bubble-c: health (cross)
    mockNeo4jQuery
      .mockResolvedValueOnce([{ title: 'A', name: 'technology' }])
      .mockResolvedValueOnce([{ title: 'B', name: 'technology' }])
      .mockResolvedValueOnce([{ title: 'A', name: 'technology' }])
      .mockResolvedValueOnce([{ title: 'C', name: 'health' }]);

    await handleLinksSuggested(makeLinkEvent('bubble-a', [
      { targetBubbleId: 'bubble-b', confidence: 0.85, relationshipType: 'RELATES_TO' },
      { targetBubbleId: 'bubble-c', confidence: 0.85, relationshipType: 'SIMILAR_TO' },
    ]));

    // Only one cross-domain event for bubble-c
    const crossDomainEmits = mockEventBus.emit.mock.calls.filter(
      (c: any) => c[0].type === 'knowledge:insight:cross-domain',
    );
    expect(crossDomainEmits).toHaveLength(1);
    expect(crossDomainEmits[0][0].payload.targetBubble.id).toBe('bubble-c');
  });

  it('handles bubbles with multiple domains (cross-domain only if zero overlap)', async () => {
    mockNeo4jQuery
      .mockResolvedValueOnce([{ title: 'A', name: 'technology' }, { title: 'A', name: 'productivity' }])
      .mockResolvedValueOnce([{ title: 'B', name: 'technology' }, { title: 'B', name: 'health' }]);

    await handleLinksSuggested(makeLinkEvent('bubble-a', [
      { targetBubbleId: 'bubble-b', confidence: 0.85, relationshipType: 'RELATES_TO' },
    ]));

    // Overlapping domain 'technology' → NOT cross-domain
    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });

  it('respects custom threshold from RAVEN_CROSS_DOMAIN_INSIGHT_THRESHOLD env var', async () => {
    // Stop and restart with custom env
    await service.stop();

    const origEnv = process.env.RAVEN_CROSS_DOMAIN_INSIGHT_THRESHOLD;
    process.env.RAVEN_CROSS_DOMAIN_INSIGHT_THRESHOLD = '0.9';

    mockEventBus.on.mockClear();
    await service.start({
      eventBus: mockEventBus,
      db: mockDb,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      config: {},
      projectRoot: '/tmp',
      integrationsConfig: {} as any,
    });

    const onCall = mockEventBus.on.mock.calls.find(
      (c: any) => c[0] === 'knowledge:links:suggested',
    );
    handleLinksSuggested = onCall[1];
    mockEventBus.emit.mockClear();

    mockNeo4jQuery
      .mockResolvedValueOnce([{ title: 'A', name: 'technology' }])
      .mockResolvedValueOnce([{ title: 'B', name: 'health' }]);

    await handleLinksSuggested(makeLinkEvent('bubble-a', [
      { targetBubbleId: 'bubble-b', confidence: 0.85, relationshipType: 'RELATES_TO' },
    ]));

    // 0.85 < 0.9 → skipped
    expect(mockEventBus.emit).not.toHaveBeenCalled();

    // Restore
    if (origEnv === undefined) {
      delete process.env.RAVEN_CROSS_DOMAIN_INSIGHT_THRESHOLD;
    } else {
      process.env.RAVEN_CROSS_DOMAIN_INSIGHT_THRESHOLD = origEnv;
    }
  });

  it('includes bubble titles in the emitted event payload', async () => {
    mockNeo4jQuery
      .mockResolvedValueOnce([{ title: 'Budget Plan', name: 'finances' }])
      .mockResolvedValueOnce([{ title: 'Gym Routine', name: 'health' }]);

    await handleLinksSuggested(makeLinkEvent('bubble-a', [
      { targetBubbleId: 'bubble-b', confidence: 0.85, relationshipType: 'RELATES_TO' },
    ]));

    const crossDomainEmit = mockEventBus.emit.mock.calls.find(
      (c: any) => c[0].type === 'knowledge:insight:cross-domain',
    );
    expect(crossDomainEmit).toBeDefined();
    // Titles come from Neo4j query — should be present even if empty string
    expect(crossDomainEmit[0].payload.sourceBubble).toHaveProperty('title');
    expect(crossDomainEmit[0].payload.targetBubble).toHaveProperty('title');
  });
});
