import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

vi.mock('@raven/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@raven/shared')>();
  return {
    ...actual,
    generateId: vi.fn(() => 'test-uuid-1234'),
    createLogger: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  };
});

vi.mock('@raven/core/suite-registry/service-runner.ts', () => ({}));

import service from '../services/email-triage.ts';

const validConfig = JSON.stringify({
  rules: [
    {
      name: 'newsletter-archive',
      match: { has: ['unsubscribe'] },
      actions: { archive: true, markRead: true, extractActions: true },
      enabled: true,
      priority: 10,
    },
    {
      name: 'important-senders',
      match: { from: ['boss@company.com'] },
      actions: { label: 'urgent', flag: 'urgent' },
      enabled: true,
      priority: 1,
    },
  ],
  matchMode: 'all',
  enabled: true,
});

describe('email-triage service', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockEventBus: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockAgentManager: any;
  let eventHandlers: Record<string, ((event: unknown) => void)[]>;

  beforeEach(() => {
    eventHandlers = {};

    mockAgentManager = {
      executeApprovedAction: vi.fn().mockResolvedValue({ success: true }),
    };

    mockEventBus = {
      emit: vi.fn(),
      on: vi.fn((type: string, handler: (event: unknown) => void) => {
        if (!eventHandlers[type]) eventHandlers[type] = [];
        eventHandlers[type].push(handler);
      }),
      off: vi.fn(),
    };

    vi.mocked(readFile).mockResolvedValue(validConfig);
  });

  afterEach(async () => {
    try {
      await service.stop();
    } catch {
      // Service may not have been started
    }
  });

  async function startService(): Promise<void> {
    await service.start({
      eventBus: mockEventBus,
      db: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      config: { agentManager: mockAgentManager },
      projectRoot: '/tmp/test-project',
    });
  }

  async function emitEventAsync(type: string, payload: unknown): Promise<void> {
    const handlers = eventHandlers[type] ?? [];
    for (const handler of handlers) {
      await handler({ id: 'evt1', timestamp: Date.now(), source: 'test', type, payload });
    }
  }

  describe('service lifecycle', () => {
    it('subscribes to email:new and config:reloaded on start', async () => {
      await startService();

      expect(mockEventBus.on).toHaveBeenCalledWith('email:new', expect.any(Function));
      expect(mockEventBus.on).toHaveBeenCalledWith('config:reloaded', expect.any(Function));
    });

    it('unsubscribes on stop', async () => {
      await startService();
      await service.stop();

      expect(mockEventBus.off).toHaveBeenCalledWith('email:new', expect.any(Function));
      expect(mockEventBus.off).toHaveBeenCalledWith('config:reloaded', expect.any(Function));
    });

    it('loads rules on start', async () => {
      await startService();

      expect(readFile).toHaveBeenCalled();
    });

    it('starts with empty rules when config is invalid', async () => {
      vi.mocked(readFile).mockResolvedValue('not json');
      await startService();

      // Service should start without crashing
      expect(mockEventBus.on).toHaveBeenCalledWith('email:new', expect.any(Function));
    });
  });

  describe('email:new event handling', () => {
    it('triages a newsletter email — archives, marks read, extracts actions', async () => {
      await startService();

      await emitEventAsync('email:new', {
        from: 'news@example.com',
        subject: 'Weekly Update — click to unsubscribe',
        snippet: 'Top stories this week',
        messageId: 'msg-newsletter-001',
        receivedAt: Date.now(),
      });

      // Should call executeApprovedAction for archive + markRead
      expect(mockAgentManager.executeApprovedAction).toHaveBeenCalledWith(
        expect.objectContaining({ actionName: 'gmail:archive-email' }),
      );
      expect(mockAgentManager.executeApprovedAction).toHaveBeenCalledWith(
        expect.objectContaining({ actionName: 'gmail:mark-read' }),
      );

      // Should emit email:triage:action-items
      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'email:triage:action-items',
          payload: { emailId: 'msg-newsletter-001' },
        }),
      );

      // Should emit email:triage:processed
      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'email:triage:processed',
          payload: expect.objectContaining({
            emailId: 'msg-newsletter-001',
            rulesMatched: ['newsletter-archive'],
          }),
        }),
      );
    });

    it('flags urgent email from important sender with notification', async () => {
      await startService();

      await emitEventAsync('email:new', {
        from: 'boss@company.com',
        subject: 'Q1 review meeting',
        snippet: 'Please prepare the slides',
        messageId: 'msg-urgent-001',
        receivedAt: Date.now(),
      });

      // Should call executeApprovedAction for label
      expect(mockAgentManager.executeApprovedAction).toHaveBeenCalledWith(
        expect.objectContaining({ actionName: 'gmail:label-email' }),
      );

      // Should emit notification for urgent flag
      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'notification',
          payload: expect.objectContaining({
            title: expect.stringContaining('Urgent Email'),
            actions: expect.arrayContaining([
              expect.objectContaining({ label: 'View' }),
              expect.objectContaining({ label: 'Archive' }),
              expect.objectContaining({ label: 'Reply' }),
            ]),
          }),
        }),
      );
    });

    it('does nothing when no rules match', async () => {
      await startService();

      await emitEventAsync('email:new', {
        from: 'random@nowhere.com',
        subject: 'Hello',
        snippet: 'Just saying hi',
        messageId: 'msg-no-match-001',
        receivedAt: Date.now(),
      });

      expect(mockAgentManager.executeApprovedAction).not.toHaveBeenCalled();
      // Should NOT emit triage:processed when no rules match
      const processedEmits = mockEventBus.emit.mock.calls.filter(
        (c: unknown[]) => (c[0] as { type: string }).type === 'email:triage:processed',
      );
      expect(processedEmits).toHaveLength(0);
    });

    it('handles missing messageId gracefully', async () => {
      await startService();

      await emitEventAsync('email:new', {
        from: 'test@test.com',
        subject: 'Test',
        snippet: '',
      });

      expect(mockAgentManager.executeApprovedAction).not.toHaveBeenCalled();
    });
  });

  describe('graceful degradation', () => {
    it('continues processing when agent manager action fails', async () => {
      mockAgentManager.executeApprovedAction.mockRejectedValue(new Error('Gmail API unavailable'));
      await startService();

      await emitEventAsync('email:new', {
        from: 'news@example.com',
        subject: 'Newsletter — unsubscribe here',
        snippet: 'Top stories',
        messageId: 'msg-fail-001',
        receivedAt: Date.now(),
      });

      // Should still emit triage:processed even if actions fail
      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'email:triage:processed',
          payload: expect.objectContaining({
            emailId: 'msg-fail-001',
            rulesMatched: ['newsletter-archive'],
          }),
        }),
      );
    });

    it('does not process when triage config is disabled', async () => {
      vi.mocked(readFile).mockResolvedValue(
        JSON.stringify({ rules: [], matchMode: 'all', enabled: false }),
      );

      await startService();

      await emitEventAsync('email:new', {
        from: 'boss@company.com',
        subject: 'Urgent',
        snippet: 'test',
        messageId: 'msg-disabled-001',
        receivedAt: Date.now(),
      });

      expect(mockAgentManager.executeApprovedAction).not.toHaveBeenCalled();
    });
  });

  describe('config hot-reload', () => {
    it('reloads rules on config:reloaded event for email-rules', async () => {
      await startService();

      const newConfig = JSON.stringify({
        rules: [
          {
            name: 'new-rule',
            match: { from: ['new@test.com'] },
            actions: { archive: true },
            enabled: true,
            priority: 1,
          },
        ],
        matchMode: 'first',
        enabled: true,
      });
      vi.mocked(readFile).mockResolvedValue(newConfig);

      await emitEventAsync('config:reloaded', {
        configType: 'email-rules',
        timestamp: new Date().toISOString(),
      });

      // Now test new rule works
      await emitEventAsync('email:new', {
        from: 'new@test.com',
        subject: 'Hello',
        snippet: 'test',
        messageId: 'msg-reload-001',
        receivedAt: Date.now(),
      });

      expect(mockAgentManager.executeApprovedAction).toHaveBeenCalledWith(
        expect.objectContaining({ actionName: 'gmail:archive-email' }),
      );
    });

    it('keeps previous rules when reload produces invalid config', async () => {
      await startService();

      vi.mocked(readFile).mockResolvedValue('invalid json {{{');

      await emitEventAsync('config:reloaded', {
        configType: 'email-rules',
        timestamp: new Date().toISOString(),
      });

      // Previous rules should still work
      await emitEventAsync('email:new', {
        from: 'boss@company.com',
        subject: 'Test',
        snippet: 'test',
        messageId: 'msg-keep-001',
        receivedAt: Date.now(),
      });

      expect(mockAgentManager.executeApprovedAction).toHaveBeenCalledWith(
        expect.objectContaining({ actionName: 'gmail:label-email' }),
      );
    });

    it('ignores config:reloaded for other config types', async () => {
      await startService();
      const readCallCount = vi.mocked(readFile).mock.calls.length;

      await emitEventAsync('config:reloaded', {
        configType: 'permissions',
        timestamp: new Date().toISOString(),
      });

      // readFile should NOT have been called again
      expect(vi.mocked(readFile).mock.calls.length).toBe(readCallCount);
    });
  });

  describe('edge cases', () => {
    it('handles empty rules config', async () => {
      vi.mocked(readFile).mockResolvedValue(
        JSON.stringify({ rules: [], matchMode: 'all', enabled: true }),
      );

      await startService();

      await emitEventAsync('email:new', {
        from: 'test@test.com',
        subject: 'Test',
        snippet: 'test',
        messageId: 'msg-empty-001',
        receivedAt: Date.now(),
      });

      expect(mockAgentManager.executeApprovedAction).not.toHaveBeenCalled();
    });
  });
});
