import type * as RavenShared from '@raven/shared';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@raven/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof RavenShared>();
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

const mockNeo4jQuery = vi.fn();
const mockClose = vi.fn(async () => {});

vi.mock('../../../knowledge-engine/neo4j-client.ts', () => ({
  createNeo4jClient: vi.fn(() => ({
    query: (...args: any[]) => mockNeo4jQuery(...args),
    close: (...args: []) => mockClose(...args),
  })),
}));

import { createNeo4jClient } from '../../../knowledge-engine/neo4j-client.ts';
import type { ServiceContext } from '../../../services/types.ts';
import service from '../../../services/proactive-intelligence/cross-domain-detector.ts';

describe('cross-domain-detector', () => {
  let mockEventBus: any;
  let mockDb: any;
  let context: ServiceContext;
  let handleLinksSuggested: (event: unknown) => void;

  afterEach(async () => {
    await service.stop();
  });

  beforeEach(async () => {
    await service.stop();
    vi.clearAllMocks();
    mockNeo4jQuery.mockReset().mockResolvedValue([]);

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

    context = {
      eventBus: mockEventBus,
      db: mockDb,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      config: {
        neo4j: {
          enabled: true,
          uri: 'bolt://configured.invalid',
          user: 'configured-user',
          password: 'fake-configured-password',
        },
      },
      projectRoot: '/tmp',
      integrationsConfig: {} as any,
      jobRegistry: {} as any,
    };
    await service.start(context);

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

    await handleLinksSuggested(
      makeLinkEvent('bubble-a', [
        { targetBubbleId: 'bubble-b', confidence: 0.85, relationshipType: 'RELATES_TO' },
      ]),
    );

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

    await handleLinksSuggested(
      makeLinkEvent('bubble-a', [
        { targetBubbleId: 'bubble-b', confidence: 0.85, relationshipType: 'RELATES_TO' },
      ]),
    );

    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });

  it('skips links below default confidence threshold (0.75)', async () => {
    mockNeo4jQuery
      .mockResolvedValueOnce([{ title: 'A', name: 'technology' }])
      .mockResolvedValueOnce([{ title: 'B', name: 'health' }]);

    await handleLinksSuggested(
      makeLinkEvent('bubble-a', [
        { targetBubbleId: 'bubble-b', confidence: 0.5, relationshipType: 'RELATES_TO' },
      ]),
    );

    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });

  it('respects per-pair adaptive threshold from DB', async () => {
    mockNeo4jQuery
      .mockResolvedValueOnce([{ title: 'A', name: 'health' }])
      .mockResolvedValueOnce([{ title: 'B', name: 'technology' }]);

    // Simulate adaptive threshold of 0.9 for health-technology pair
    mockDb.get.mockReturnValueOnce({ domain_pair: 'health-technology', threshold: 0.9 });

    await handleLinksSuggested(
      makeLinkEvent('bubble-a', [
        { targetBubbleId: 'bubble-b', confidence: 0.85, relationshipType: 'RELATES_TO' },
      ]),
    );

    // 0.85 < 0.9 adaptive threshold → skipped
    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });

  it('emits when confidence meets adaptive threshold', async () => {
    mockNeo4jQuery
      .mockResolvedValueOnce([{ title: 'A', name: 'health' }])
      .mockResolvedValueOnce([{ title: 'B', name: 'technology' }]);

    mockDb.get.mockReturnValueOnce({ domain_pair: 'health-technology', threshold: 0.8 });

    await handleLinksSuggested(
      makeLinkEvent('bubble-a', [
        { targetBubbleId: 'bubble-b', confidence: 0.85, relationshipType: 'RELATES_TO' },
      ]),
    );

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

    await handleLinksSuggested(
      makeLinkEvent('bubble-a', [
        { targetBubbleId: 'bubble-b', confidence: 0.85, relationshipType: 'RELATES_TO' },
        { targetBubbleId: 'bubble-c', confidence: 0.85, relationshipType: 'SIMILAR_TO' },
      ]),
    );

    // Only one cross-domain event for bubble-c
    const crossDomainEmits = mockEventBus.emit.mock.calls.filter(
      (c: any) => c[0].type === 'knowledge:insight:cross-domain',
    );
    expect(crossDomainEmits).toHaveLength(1);
    expect(crossDomainEmits[0][0].payload.targetBubble.id).toBe('bubble-c');
  });

  it('handles bubbles with multiple domains (cross-domain only if zero overlap)', async () => {
    mockNeo4jQuery
      .mockResolvedValueOnce([
        { title: 'A', name: 'technology' },
        { title: 'A', name: 'productivity' },
      ])
      .mockResolvedValueOnce([
        { title: 'B', name: 'technology' },
        { title: 'B', name: 'health' },
      ]);

    await handleLinksSuggested(
      makeLinkEvent('bubble-a', [
        { targetBubbleId: 'bubble-b', confidence: 0.85, relationshipType: 'RELATES_TO' },
      ]),
    );

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
      config: {
        neo4j: {
          enabled: true,
          uri: 'bolt://configured.invalid',
          user: 'configured-user',
          password: 'fake-configured-password',
        },
      },
      projectRoot: '/tmp',
      integrationsConfig: {} as any,
      jobRegistry: {} as any,
    });

    const onCall = mockEventBus.on.mock.calls.find(
      (c: any) => c[0] === 'knowledge:links:suggested',
    );
    handleLinksSuggested = onCall[1];
    mockEventBus.emit.mockClear();

    mockNeo4jQuery
      .mockResolvedValueOnce([{ title: 'A', name: 'technology' }])
      .mockResolvedValueOnce([{ title: 'B', name: 'health' }]);

    await handleLinksSuggested(
      makeLinkEvent('bubble-a', [
        { targetBubbleId: 'bubble-b', confidence: 0.85, relationshipType: 'RELATES_TO' },
      ]),
    );

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

    await handleLinksSuggested(
      makeLinkEvent('bubble-a', [
        { targetBubbleId: 'bubble-b', confidence: 0.85, relationshipType: 'RELATES_TO' },
      ]),
    );

    const crossDomainEmit = mockEventBus.emit.mock.calls.find(
      (c: any) => c[0].type === 'knowledge:insight:cross-domain',
    );
    expect(crossDomainEmit).toBeDefined();
    // Titles come from Neo4j query — should be present even if empty string
    expect(crossDomainEmit[0].payload.sourceBubble).toHaveProperty('title');
    expect(crossDomainEmit[0].payload.targetBubble).toHaveProperty('title');
  });
  it('does not create a client when graph is explicitly disabled', async () => {
    await service.stop();
    vi.mocked(createNeo4jClient).mockClear();
    mockEventBus.on.mockClear();
    await service.start({
      ...context,
      config: { neo4j: { ...(context.config.neo4j as object), enabled: false } },
    });
    expect(createNeo4jClient).not.toHaveBeenCalled();
    expect(mockEventBus.on).not.toHaveBeenCalled();
  });

  it('uses threaded credentials and disposes a client after a failed probe', async () => {
    expect(createNeo4jClient).toHaveBeenCalledWith(
      expect.objectContaining({
        uri: 'bolt://configured.invalid',
        user: 'configured-user',
        password: 'fake-configured-password',
      }),
    );
    await service.stop();
    mockClose.mockClear();
    mockEventBus.on.mockClear();
    mockNeo4jQuery.mockRejectedValueOnce(new Error('probe unavailable'));
    await service.start(context);
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(mockEventBus.on).not.toHaveBeenCalled();
    await service.stop();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('ignores an in-flight query result after stop', async () => {
    let release!: (value: Array<{ title: string; name: string }>) => void;
    mockNeo4jQuery.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const pending = handleLinksSuggested(
      makeLinkEvent('one', [{ targetBubbleId: 'two', confidence: 1, relationshipType: 'related' }]),
    );
    await service.stop();
    const queries = mockNeo4jQuery.mock.calls.length;
    release([{ title: 'One', name: 'technology' }]);
    await pending;
    expect(mockNeo4jQuery).toHaveBeenCalledTimes(queries);
    expect(mockEventBus.emit).not.toHaveBeenCalled();
  });

  it('does not subscribe if stopped while the startup probe is pending', async () => {
    await service.stop();
    let release!: (value: unknown[]) => void;
    mockNeo4jQuery.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    mockEventBus.on.mockClear();
    const starting = service.start(context);
    await Promise.resolve();
    await Promise.resolve();
    await service.stop();
    release([]);
    await starting;
    expect(mockEventBus.on).not.toHaveBeenCalled();
  });
});
