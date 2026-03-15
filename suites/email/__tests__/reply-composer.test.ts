import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@raven/shared', async () => {
  const actual = await vi.importActual<typeof import('@raven/shared')>('@raven/shared');
  return {
    ...actual,
    generateId: vi.fn(() => 'test-uuid-1234-5678-abcd-ef0123456789'),
    createLogger: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  };
});

vi.mock('@raven/core/suite-registry/service-runner.ts', () => ({}));

describe('reply-composer service', () => {
  let service: any;
  let mockEventBus: any;
  let mockAgentManager: any;
  let eventHandlers: Record<string, ((event: unknown) => void)[]>;

  beforeEach(async () => {
    vi.resetModules();
    eventHandlers = {};

    mockAgentManager = {
      executeApprovedAction: vi.fn().mockResolvedValue({
        success: true,
        result: JSON.stringify({
          emailId: 'email-123',
          to: 'john@example.com',
          subject: 'Re: Q1 Report',
          draftBody: 'Thanks for the update. I will have it ready by Thursday.',
          originalSnippet: 'Can you send the Q1 report?',
        }),
      }),
    };

    mockEventBus = {
      emit: vi.fn(),
      on: vi.fn((type: string, handler: any) => {
        if (!eventHandlers[type]) eventHandlers[type] = [];
        eventHandlers[type].push(handler);
      }),
      off: vi.fn(),
    };

    const mod = await import('../services/reply-composer.ts');
    service = mod.default;
  });

  afterEach(async () => {
    try {
      if (service) await service.stop();
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
    });
  }

  function emitEvent(type: string, payload: unknown): void {
    const handlers = eventHandlers[type] ?? [];
    for (const handler of handlers) {
      handler({ id: 'evt1', timestamp: Date.now(), source: 'test', type, payload });
    }
  }

  async function emitEventAsync(type: string, payload: unknown): Promise<void> {
    const handlers = eventHandlers[type] ?? [];
    for (const handler of handlers) {
      await handler({ id: 'evt1', timestamp: Date.now(), source: 'test', type, payload });
    }
  }

  describe('service lifecycle', () => {
    it('subscribes to all email reply events on start', async () => {
      await startService();

      expect(mockEventBus.on).toHaveBeenCalledWith('email:reply:start', expect.any(Function));
      expect(mockEventBus.on).toHaveBeenCalledWith('email:reply:send', expect.any(Function));
      expect(mockEventBus.on).toHaveBeenCalledWith('email:reply:edit', expect.any(Function));
      expect(mockEventBus.on).toHaveBeenCalledWith('email:reply:cancel', expect.any(Function));
      expect(mockEventBus.on).toHaveBeenCalledWith('permission:denied', expect.any(Function));
    });

    it('unsubscribes from all events on stop', async () => {
      await startService();
      await service.stop();

      expect(mockEventBus.off).toHaveBeenCalledWith('email:reply:start', expect.any(Function));
      expect(mockEventBus.off).toHaveBeenCalledWith('email:reply:send', expect.any(Function));
      expect(mockEventBus.off).toHaveBeenCalledWith('email:reply:edit', expect.any(Function));
      expect(mockEventBus.off).toHaveBeenCalledWith('email:reply:cancel', expect.any(Function));
      expect(mockEventBus.off).toHaveBeenCalledWith('permission:denied', expect.any(Function));
    });

    it('clears pending drafts on stop', async () => {
      await startService();

      // Trigger a reply start to create a pending draft
      await emitEventAsync('email:reply:start', {
        emailId: 'email-123',
        topicName: 'General',
      });

      const { pendingDrafts } = await import('../services/reply-composer.ts');
      expect(pendingDrafts.size).toBe(1);

      await service.stop();
      expect(pendingDrafts.size).toBe(0);
    });
  });

  describe('draft composition flow (AC #1)', () => {
    it('composes a draft when email:reply:start is received', async () => {
      await startService();

      await emitEventAsync('email:reply:start', {
        emailId: 'email-123',
        topicName: 'General',
      });

      // Should call agent manager to fetch email and compose draft
      expect(mockAgentManager.executeApprovedAction).toHaveBeenCalledWith({
        actionName: 'gmail:get-email',
        skillName: 'email',
        details: expect.stringContaining('email-123'),
      });

      // Should emit notification with draft preview
      const notifCalls = mockEventBus.emit.mock.calls.filter(
        (call: any) => call[0].type === 'notification',
      );
      expect(notifCalls.length).toBe(1);

      const notif = notifCalls[0][0];
      expect(notif.payload.title).toContain('Draft Reply');
      expect(notif.payload.body).toContain('Thanks for the update');
      expect(notif.payload.actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: 'Send' }),
          expect.objectContaining({ label: 'Edit' }),
          expect.objectContaining({ label: 'Cancel' }),
        ]),
      );
    });

    it('includes user intent in composition prompt when provided', async () => {
      await startService();

      await emitEventAsync('email:reply:start', {
        emailId: 'email-456',
        userIntent: "tell them I'll have it ready by Thursday",
        topicName: 'Email',
      });

      expect(mockAgentManager.executeApprovedAction).toHaveBeenCalledWith({
        actionName: 'gmail:get-email',
        skillName: 'email',
        details: expect.stringContaining("tell them I'll have it ready by Thursday"),
      });
    });

    it('stores pending draft state in Map', async () => {
      await startService();

      await emitEventAsync('email:reply:start', {
        emailId: 'email-789',
        topicName: 'General',
      });

      const { pendingDrafts } = await import('../services/reply-composer.ts');
      expect(pendingDrafts.size).toBe(1);

      const draft = [...pendingDrafts.values()][0];
      expect(draft.emailId).toBe('email-789');
      expect(draft.draftText).toBe('Thanks for the update. I will have it ready by Thursday.');
    });

    it('emits failure notification when agent returns no result', async () => {
      mockAgentManager.executeApprovedAction.mockResolvedValue({
        success: false,
        error: 'Email not found',
      });

      await startService();

      await emitEventAsync('email:reply:start', {
        emailId: 'nonexistent',
        topicName: 'General',
      });

      const notifCalls = mockEventBus.emit.mock.calls.filter(
        (call: any) => call[0].type === 'notification',
      );
      expect(notifCalls.length).toBe(1);
      expect(notifCalls[0][0].payload.title).toBe('Reply Failed');
    });

    it('emits failure notification when draft parsing fails', async () => {
      mockAgentManager.executeApprovedAction.mockResolvedValue({
        success: true,
        result: 'This is not valid JSON for a draft',
      });

      await startService();

      await emitEventAsync('email:reply:start', {
        emailId: 'email-bad',
        topicName: 'General',
      });

      const notifCalls = mockEventBus.emit.mock.calls.filter(
        (call: any) => call[0].type === 'notification',
      );
      expect(notifCalls.length).toBe(1);
      expect(notifCalls[0][0].payload.title).toBe('Reply Failed');
    });
  });

  describe('send flow (AC #2, #5)', () => {
    it('sends reply when email:reply:send is received', async () => {
      await startService();

      // First compose a draft
      await emitEventAsync('email:reply:start', {
        emailId: 'email-123',
        topicName: 'General',
      });

      // Get the compositionId from the notification actions
      const notifCalls = mockEventBus.emit.mock.calls.filter(
        (call: any) => call[0].type === 'notification',
      );
      const actions = notifCalls[0][0].payload.actions;
      const sendAction = actions.find((a: any) => a.label === 'Send');
      const compositionId = sendAction.action.split(':')[2]; // er:s:{id}

      // Reset mock to check the send call
      mockAgentManager.executeApprovedAction.mockClear();
      mockAgentManager.executeApprovedAction.mockResolvedValue({ success: true });

      // Trigger send
      await emitEventAsync('email:reply:send', { compositionId });

      // Should call agent manager with gmail:reply-email action
      expect(mockAgentManager.executeApprovedAction).toHaveBeenCalledWith({
        actionName: 'gmail:reply-email',
        skillName: 'email',
        details: expect.stringContaining('Reply to email'),
      });
    });

    it('emits confirmation notification on successful send', async () => {
      await startService();

      await emitEventAsync('email:reply:start', {
        emailId: 'email-123',
        topicName: 'General',
      });

      const notifCalls = mockEventBus.emit.mock.calls.filter(
        (call: any) => call[0].type === 'notification',
      );
      const actions = notifCalls[0][0].payload.actions;
      const sendAction = actions.find((a: any) => a.label === 'Send');
      const compositionId = sendAction.action.split(':')[2];

      mockEventBus.emit.mockClear();
      mockAgentManager.executeApprovedAction.mockResolvedValue({ success: true });

      await emitEventAsync('email:reply:send', { compositionId });

      const confirmCalls = mockEventBus.emit.mock.calls.filter(
        (call: any) => call[0].type === 'notification',
      );
      expect(confirmCalls.length).toBe(1);
      expect(confirmCalls[0][0].payload.title).toBe('Reply Sent');
    });

    it('does not remove draft when send is blocked (pending approval)', async () => {
      await startService();

      await emitEventAsync('email:reply:start', {
        emailId: 'email-123',
        topicName: 'General',
      });

      const notifCalls = mockEventBus.emit.mock.calls.filter(
        (call: any) => call[0].type === 'notification',
      );
      const actions = notifCalls[0][0].payload.actions;
      const sendAction = actions.find((a: any) => a.label === 'Send');
      const compositionId = sendAction.action.split(':')[2];

      mockAgentManager.executeApprovedAction.mockResolvedValue({
        success: false,
        error: 'Task did not complete successfully',
      });

      await emitEventAsync('email:reply:send', { compositionId });

      // Draft should still be in the map (pending approval)
      const { pendingDrafts } = await import('../services/reply-composer.ts');
      expect(pendingDrafts.size).toBe(1);
    });

    it('ignores send for unknown compositionId', async () => {
      await startService();

      await emitEventAsync('email:reply:send', { compositionId: 'unknown-id' });

      expect(mockAgentManager.executeApprovedAction).not.toHaveBeenCalled();
    });
  });

  describe('edit flow (AC #3)', () => {
    it('re-composes draft with new instructions', async () => {
      await startService();

      await emitEventAsync('email:reply:start', {
        emailId: 'email-123',
        topicName: 'General',
      });

      const notifCalls = mockEventBus.emit.mock.calls.filter(
        (call: any) => call[0].type === 'notification',
      );
      const actions = notifCalls[0][0].payload.actions;
      const editAction = actions.find((a: any) => a.label === 'Edit');
      const compositionId = editAction.action.split(':')[2];

      // Reset and reconfigure mock for the edit call
      mockAgentManager.executeApprovedAction.mockClear();
      mockAgentManager.executeApprovedAction.mockResolvedValue({
        success: true,
        result: JSON.stringify({
          emailId: 'email-123',
          to: 'john@example.com',
          subject: 'Re: Q1 Report',
          draftBody: 'Updated: I will have it ready by Friday instead.',
          originalSnippet: 'Can you send the Q1 report?',
        }),
      });

      mockEventBus.emit.mockClear();

      await emitEventAsync('email:reply:edit', {
        compositionId,
        newInstructions: 'Change Thursday to Friday',
      });

      // Should call agent with new instructions
      expect(mockAgentManager.executeApprovedAction).toHaveBeenCalledWith({
        actionName: 'gmail:get-email',
        skillName: 'email',
        details: expect.stringContaining('Change Thursday to Friday'),
      });

      // Should emit updated draft notification
      const updatedNotifs = mockEventBus.emit.mock.calls.filter(
        (call: any) => call[0].type === 'notification',
      );
      expect(updatedNotifs.length).toBe(1);
      expect(updatedNotifs[0][0].payload.title).toContain('Updated Draft');
      expect(updatedNotifs[0][0].payload.body).toContain('Friday instead');
    });
  });

  describe('cancel flow (AC #4)', () => {
    it('clears draft and sends confirmation on cancel', async () => {
      await startService();

      await emitEventAsync('email:reply:start', {
        emailId: 'email-123',
        topicName: 'General',
      });

      const notifCalls = mockEventBus.emit.mock.calls.filter(
        (call: any) => call[0].type === 'notification',
      );
      const actions = notifCalls[0][0].payload.actions;
      const cancelAction = actions.find((a: any) => a.label === 'Cancel');
      const compositionId = cancelAction.action.split(':')[2];

      mockEventBus.emit.mockClear();

      emitEvent('email:reply:cancel', { compositionId });

      // Draft should be removed
      const { pendingDrafts } = await import('../services/reply-composer.ts');
      expect(pendingDrafts.size).toBe(0);

      // Should emit cancellation confirmation
      const cancelNotifs = mockEventBus.emit.mock.calls.filter(
        (call: any) => call[0].type === 'notification',
      );
      expect(cancelNotifs.length).toBe(1);
      expect(cancelNotifs[0][0].payload.title).toBe('Reply Cancelled');
    });

    it('handles cancel for unknown compositionId gracefully', async () => {
      await startService();

      emitEvent('email:reply:cancel', { compositionId: 'unknown-id' });

      // Should not throw, no notification emitted
      const notifCalls = mockEventBus.emit.mock.calls.filter(
        (call: any) => call[0].type === 'notification',
      );
      expect(notifCalls.length).toBe(0);
    });
  });

  describe('permission denial (AC #5)', () => {
    it('notifies user when reply is denied by approval', async () => {
      await startService();

      await emitEventAsync('email:reply:start', {
        emailId: 'email-123',
        topicName: 'General',
      });

      mockEventBus.emit.mockClear();

      // Simulate permission denial
      emitEvent('permission:denied', {
        actionName: 'gmail:reply-email',
        approvalId: 'approval-1',
        skillName: 'email',
        tier: 'red',
      });

      const notifCalls = mockEventBus.emit.mock.calls.filter(
        (call: any) => call[0].type === 'notification',
      );
      expect(notifCalls.length).toBe(1);
      expect(notifCalls[0][0].payload.body).toContain('approval denial');

      // Draft should be cleared
      const { pendingDrafts } = await import('../services/reply-composer.ts');
      expect(pendingDrafts.size).toBe(0);
    });

    it('ignores permission denial for non-reply actions', async () => {
      await startService();

      emitEvent('permission:denied', {
        actionName: 'gmail:send-email',
        approvalId: 'approval-2',
        skillName: 'email',
        tier: 'red',
      });

      // Should not emit any notifications
      const notifCalls = mockEventBus.emit.mock.calls.filter(
        (call: any) => call[0].type === 'notification',
      );
      expect(notifCalls.length).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('handles invalid event payload gracefully', async () => {
      await startService();

      // Invalid payload (missing emailId)
      await emitEventAsync('email:reply:start', {});

      // Should not call agent manager
      expect(mockAgentManager.executeApprovedAction).not.toHaveBeenCalled();
    });

    it('handles agent error during composition', async () => {
      mockAgentManager.executeApprovedAction.mockRejectedValue(
        new Error('Network timeout'),
      );

      await startService();

      await emitEventAsync('email:reply:start', {
        emailId: 'email-err',
        topicName: 'General',
      });

      const notifCalls = mockEventBus.emit.mock.calls.filter(
        (call: any) => call[0].type === 'notification',
      );
      expect(notifCalls.length).toBe(1);
      expect(notifCalls[0][0].payload.title).toBe('Reply Failed');
    });

    it('handles concurrent reply attempts', async () => {
      // Make the mock return different compositionIds
      let callCount = 0;
      const { generateId } = await import('@raven/shared');
      (generateId as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        return `uuid-${callCount}-12345678`;
      });

      await startService();

      // Start two replies concurrently
      const p1 = emitEventAsync('email:reply:start', {
        emailId: 'email-A',
        topicName: 'General',
      });
      const p2 = emitEventAsync('email:reply:start', {
        emailId: 'email-B',
        topicName: 'Email',
      });

      await Promise.all([p1, p2]);

      const { pendingDrafts } = await import('../services/reply-composer.ts');
      expect(pendingDrafts.size).toBe(2);
    });
  });

  describe('parseDraftResult', () => {
    it('parses valid JSON from agent response', async () => {
      const { parseDraftResult } = await import('../services/reply-composer.ts');

      const result = parseDraftResult(JSON.stringify({
        emailId: 'e1',
        to: 'test@example.com',
        subject: 'Re: Test',
        draftBody: 'Hello!',
        originalSnippet: 'Hi there',
      }));

      expect(result).not.toBeNull();
      expect(result!.draftBody).toBe('Hello!');
    });

    it('extracts JSON from surrounding text', async () => {
      const { parseDraftResult } = await import('../services/reply-composer.ts');

      const result = parseDraftResult(
        'Here is the composed reply:\n' +
          JSON.stringify({
            emailId: 'e1',
            to: 'test@example.com',
            subject: 'Re: Test',
            draftBody: 'Thanks!',
          }) +
          '\nEnd of response.',
      );

      expect(result).not.toBeNull();
      expect(result!.draftBody).toBe('Thanks!');
    });

    it('returns null for non-JSON text', async () => {
      const { parseDraftResult } = await import('../services/reply-composer.ts');
      expect(parseDraftResult('just plain text')).toBeNull();
    });

    it('returns null for invalid schema', async () => {
      const { parseDraftResult } = await import('../services/reply-composer.ts');
      expect(parseDraftResult(JSON.stringify({ foo: 'bar' }))).toBeNull();
    });
  });

  describe('utility functions', () => {
    it('getShortId returns first 8 chars', async () => {
      const { getShortId } = await import('../services/reply-composer.ts');
      expect(getShortId('abcdefgh-1234-5678')).toBe('abcdefgh');
    });

    it('buildDraftActions creates correct callback data', async () => {
      const { buildDraftActions } = await import('../services/reply-composer.ts');
      const actions = buildDraftActions('abc12345');

      expect(actions).toEqual([
        { label: 'Send', action: 'er:s:abc12345' },
        { label: 'Edit', action: 'er:e:abc12345' },
        { label: 'Cancel', action: 'er:c:abc12345' },
      ]);
    });
  });
});
