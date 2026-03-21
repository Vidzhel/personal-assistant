import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseCallbackData,
  handleCallback,
} from '../services/callback-handler.ts';
import type {
  CallbackAction,
  CallbackDeps,
  PendingApprovalInfo,
} from '../services/callback-handler.ts';
import { initDatabase, getDb, createDbInterface } from '@raven/core/db/database.ts';
import { createSnooze, getActiveSnoozes } from '@raven/core/notification-engine/snooze-store.ts';
import type { DatabaseInterface } from '@raven/shared';

describe('parseCallbackData', () => {
  describe('valid task actions', () => {
    it('parses task complete', () => {
      const result = parseCallbackData('t:c:taskId123');
      expect(result).toEqual<CallbackAction>({
        domain: 'task',
        action: 'complete',
        target: 'taskId123',
        args: [],
      });
    });

    it('parses task snooze with duration arg', () => {
      const result = parseCallbackData('t:s:taskId123:1d');
      expect(result).toEqual<CallbackAction>({
        domain: 'task',
        action: 'snooze',
        target: 'taskId123',
        args: ['1d'],
      });
    });

    it('parses task snooze 1 week', () => {
      const result = parseCallbackData('t:s:abc:1w');
      expect(result).toEqual<CallbackAction>({
        domain: 'task',
        action: 'snooze',
        target: 'abc',
        args: ['1w'],
      });
    });

    it('parses task drop', () => {
      const result = parseCallbackData('t:d:taskId123');
      expect(result).toEqual<CallbackAction>({
        domain: 'task',
        action: 'drop',
        target: 'taskId123',
        args: [],
      });
    });
  });

  describe('valid email actions', () => {
    it('parses email reply', () => {
      const result = parseCallbackData('e:r:emailId789');
      expect(result).toEqual<CallbackAction>({
        domain: 'email',
        action: 'reply',
        target: 'emailId789',
        args: [],
      });
    });

    it('parses email archive', () => {
      const result = parseCallbackData('e:a:emailId789');
      expect(result).toEqual<CallbackAction>({
        domain: 'email',
        action: 'archive',
        target: 'emailId789',
        args: [],
      });
    });

    it('parses email flag', () => {
      const result = parseCallbackData('e:f:emailId789');
      expect(result).toEqual<CallbackAction>({
        domain: 'email',
        action: 'flag',
        target: 'emailId789',
        args: [],
      });
    });

    it('stays within 64-byte limit', () => {
      // e:r: = 4 bytes + 60 = 64 bytes total
      const data = 'e:r:' + 'x'.repeat(60);
      const result = parseCallbackData(data);
      expect(result).not.toBeNull();
      expect(result!.domain).toBe('email');
    });
  });

  describe('valid approval actions', () => {
    it('parses approval approve', () => {
      const result = parseCallbackData('a:y:approvalId456');
      expect(result).toEqual<CallbackAction>({
        domain: 'approval',
        action: 'approve',
        target: 'approvalId456',
        args: [],
      });
    });

    it('parses approval deny', () => {
      const result = parseCallbackData('a:n:approvalId456');
      expect(result).toEqual<CallbackAction>({
        domain: 'approval',
        action: 'deny',
        target: 'approvalId456',
        args: [],
      });
    });

    it('parses approval view details', () => {
      const result = parseCallbackData('a:v:approvalId456');
      expect(result).toEqual<CallbackAction>({
        domain: 'approval',
        action: 'details',
        target: 'approvalId456',
        args: [],
      });
    });
  });

  describe('valid snooze actions', () => {
    it('parses snooze week', () => {
      const result = parseCallbackData('s:w:pipe');
      expect(result).toEqual<CallbackAction>({
        domain: 'snooze',
        action: 'snooze-week',
        target: 'pipe',
        args: [],
      });
    });

    it('parses snooze keep', () => {
      const result = parseCallbackData('s:k:email');
      expect(result).toEqual<CallbackAction>({
        domain: 'snooze',
        action: 'keep',
        target: 'email',
        args: [],
      });
    });

    it('parses snooze mute', () => {
      const result = parseCallbackData('s:m:task');
      expect(result).toEqual<CallbackAction>({
        domain: 'snooze',
        action: 'mute',
        target: 'task',
        args: [],
      });
    });

    it('parses unsnooze', () => {
      const result = parseCallbackData('s:u:abc123');
      expect(result).toEqual<CallbackAction>({
        domain: 'snooze',
        action: 'unsnooze',
        target: 'abc123',
        args: [],
      });
    });
  });

  describe('noop', () => {
    it('returns null for noop', () => {
      expect(parseCallbackData('noop')).toBeNull();
    });
  });

  describe('invalid inputs', () => {
    it('returns null for empty string', () => {
      expect(parseCallbackData('')).toBeNull();
    });

    it('returns null for missing target', () => {
      expect(parseCallbackData('t:c')).toBeNull();
    });

    it('returns null for unknown domain prefix', () => {
      expect(parseCallbackData('x:y:z')).toBeNull();
    });

    it('returns null for unknown task action', () => {
      expect(parseCallbackData('t:x:taskId')).toBeNull();
    });

    it('returns null for unknown approval action', () => {
      expect(parseCallbackData('a:x:approvalId')).toBeNull();
    });

    it('returns null for unknown email action', () => {
      expect(parseCallbackData('e:x:emailId')).toBeNull();
    });

    it('returns null for string exceeding 64 bytes', () => {
      const longData = 't:c:' + 'a'.repeat(61); // 65 bytes
      expect(parseCallbackData(longData)).toBeNull();
    });

    it('returns null for single segment', () => {
      expect(parseCallbackData('hello')).toBeNull();
    });

    it('returns null for two segments only', () => {
      expect(parseCallbackData('t:c')).toBeNull();
    });
  });

  describe('64-byte constraint', () => {
    it('accepts callback data at exactly 64 bytes', () => {
      // t:c: = 4 chars, target fills the rest up to 64
      const data = 't:c:' + 'a'.repeat(60); // 4 + 60 = 64 bytes
      const result = parseCallbackData(data);
      expect(result).not.toBeNull();
      expect(result!.target).toBe('a'.repeat(60));
    });
  });
});

describe('handleCallback', () => {
  let deps: CallbackDeps;

  beforeEach(() => {
    deps = {
      eventBus: {
        emit: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      pendingApprovals: {
        resolve: vi.fn(),
        query: vi.fn().mockReturnValue([]),
        getById: vi.fn().mockReturnValue(undefined),
      },
      agentManager: {
        executeApprovedAction: vi.fn().mockResolvedValue({ success: true }),
      },
      auditLog: {
        insert: vi.fn(),
      },
    };
  });

  describe('task actions', () => {
    it('routes task:complete to agent manager', () => {
      const action: CallbackAction = { domain: 'task', action: 'complete', target: 'tid1', args: [] };
      const result = handleCallback(action, deps);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Done \u2713');
      expect(result.updatedKeyboard).toEqual([[{ text: 'Done \u2713', callback_data: 'noop' }]]);
      expect(deps.agentManager.executeApprovedAction).toHaveBeenCalledWith({
        actionName: 'task:complete',
        skillName: 'task-management',
        details: expect.stringContaining('tid1'),
      });
    });

    it('routes task:snooze with 1d duration', () => {
      const action: CallbackAction = { domain: 'task', action: 'snooze', target: 'tid2', args: ['1d'] };
      const result = handleCallback(action, deps);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Snoozed \u2713');
      expect(deps.agentManager.executeApprovedAction).toHaveBeenCalledWith({
        actionName: 'task:snooze',
        skillName: 'task-management',
        details: expect.stringContaining('1 day'),
      });
    });

    it('routes task:snooze with 1w duration', () => {
      const action: CallbackAction = { domain: 'task', action: 'snooze', target: 'tid3', args: ['1w'] };
      handleCallback(action, deps);

      expect(deps.agentManager.executeApprovedAction).toHaveBeenCalledWith({
        actionName: 'task:snooze',
        skillName: 'task-management',
        details: expect.stringContaining('1 week'),
      });
    });

    it('routes task:drop to agent manager', () => {
      const action: CallbackAction = { domain: 'task', action: 'drop', target: 'tid4', args: [] };
      const result = handleCallback(action, deps);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Dropped');
      expect(deps.agentManager.executeApprovedAction).toHaveBeenCalledWith({
        actionName: 'task:drop',
        skillName: 'task-management',
        details: expect.stringContaining('tid4'),
      });
    });

    it('logs error when agent execution fails', async () => {
      (deps.agentManager.executeApprovedAction as ReturnType<typeof vi.fn>)
        .mockResolvedValue({ success: false, error: 'MCP timeout' });

      const action: CallbackAction = { domain: 'task', action: 'complete', target: 'tid5', args: [] };
      handleCallback(action, deps);

      // Wait for the async fire-and-forget
      await vi.waitFor(() => {
        expect(deps.logger.error).toHaveBeenCalledWith(expect.stringContaining('MCP timeout'));
      });
    });
  });

  describe('email actions', () => {
    it('routes email:reply by emitting email:reply:start event', () => {
      const action: CallbackAction = { domain: 'email', action: 'reply', target: 'em1', args: [] };
      const result = handleCallback(action, deps);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Replying...');
      expect(deps.eventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'email:reply:start',
          source: 'telegram-callback',
          payload: expect.objectContaining({
            emailId: 'em1',
          }),
        }),
      );
    });

    it('routes email:archive via agent manager', () => {
      const action: CallbackAction = { domain: 'email', action: 'archive', target: 'em2', args: [] };
      const result = handleCallback(action, deps);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Archived \u2713');
      expect(deps.agentManager.executeApprovedAction).toHaveBeenCalledWith({
        actionName: 'email:archive',
        skillName: 'email',
        details: expect.stringContaining('em2'),
      });
    });

    it('routes email:flag via agent manager', () => {
      const action: CallbackAction = { domain: 'email', action: 'flag', target: 'em3', args: [] };
      const result = handleCallback(action, deps);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Flagged \u2713');
      expect(deps.agentManager.executeApprovedAction).toHaveBeenCalledWith({
        actionName: 'email:flag',
        skillName: 'email',
        details: expect.stringContaining('em3'),
      });
    });

    it('updates keyboard after email action', () => {
      const action: CallbackAction = { domain: 'email', action: 'archive', target: 'em4', args: [] };
      const result = handleCallback(action, deps);

      expect(result.updatedKeyboard).toEqual([[{ text: 'Archived \u2713', callback_data: 'noop' }]]);
    });
  });

  describe('email reply actions (er: prefix)', () => {
    it('parses email reply send callback', () => {
      const result = parseCallbackData('er:s:abc12345');
      expect(result).toEqual<CallbackAction>({
        domain: 'email-reply',
        action: 'send',
        target: 'abc12345',
        args: [],
      });
    });

    it('parses email reply edit callback', () => {
      const result = parseCallbackData('er:e:abc12345');
      expect(result).toEqual<CallbackAction>({
        domain: 'email-reply',
        action: 'edit',
        target: 'abc12345',
        args: [],
      });
    });

    it('parses email reply cancel callback', () => {
      const result = parseCallbackData('er:c:abc12345');
      expect(result).toEqual<CallbackAction>({
        domain: 'email-reply',
        action: 'cancel',
        target: 'abc12345',
        args: [],
      });
    });

    it('routes email reply send by emitting email:reply:send event', () => {
      const action: CallbackAction = { domain: 'email-reply', action: 'send', target: 'comp123', args: [] };
      const result = handleCallback(action, deps);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Sending...');
      expect(deps.eventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'email:reply:send',
          payload: expect.objectContaining({
            compositionId: 'comp123',
          }),
        }),
      );
    });

    it('routes email reply edit by emitting notification and email:reply:edit event', () => {
      const action: CallbackAction = { domain: 'email-reply', action: 'edit', target: 'comp456', args: [] };
      const result = handleCallback(action, deps);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Editing...');
      // Should emit a notification asking for new instructions
      expect(deps.eventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'notification',
          payload: expect.objectContaining({
            title: 'Edit Reply',
          }),
        }),
      );
      // Should emit email:reply:edit event
      expect(deps.eventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'email:reply:edit',
          payload: expect.objectContaining({
            compositionId: 'comp456',
          }),
        }),
      );
    });

    it('routes email reply cancel by emitting email:reply:cancel event', () => {
      const action: CallbackAction = { domain: 'email-reply', action: 'cancel', target: 'comp789', args: [] };
      const result = handleCallback(action, deps);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Cancelled');
      expect(deps.eventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'email:reply:cancel',
          payload: expect.objectContaining({
            compositionId: 'comp789',
          }),
        }),
      );
    });

    it('updates keyboard after email reply action', () => {
      const action: CallbackAction = { domain: 'email-reply', action: 'send', target: 'comp123', args: [] };
      const result = handleCallback(action, deps);

      expect(result.updatedKeyboard).toEqual([[{ text: 'Sending...', callback_data: 'noop' }]]);
    });
  });

  describe('approval actions', () => {
    it('resolves approval as approved and emits permission:approved event', () => {
      const mockApproval: PendingApprovalInfo = {
        id: 'ap1',
        actionName: 'gmail:send',
        skillName: 'email',
        details: 'Send email to bob',
        sessionId: 'sess1',
      };
      (deps.pendingApprovals.resolve as ReturnType<typeof vi.fn>).mockReturnValue(mockApproval);

      const action: CallbackAction = { domain: 'approval', action: 'approve', target: 'ap1', args: [] };
      const result = handleCallback(action, deps);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Approved \u2713');
      expect(deps.pendingApprovals.resolve).toHaveBeenCalledWith('ap1', 'approved');
      expect(deps.auditLog.insert).toHaveBeenCalledWith({
        skillName: 'email',
        actionName: 'gmail:send',
        permissionTier: 'red',
        outcome: 'approved',
      });
      expect(deps.agentManager.executeApprovedAction).toHaveBeenCalledWith({
        actionName: 'gmail:send',
        skillName: 'email',
        details: 'Send email to bob',
        sessionId: 'sess1',
      });
      // Verify permission:approved event emitted
      expect(deps.eventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'permission:approved',
          source: 'telegram-callback',
          payload: expect.objectContaining({
            actionName: 'gmail:send',
            skillName: 'email',
            tier: 'red',
            sessionId: 'sess1',
          }),
        }),
      );
    });

    it('resolves approval as denied and emits permission:denied event', () => {
      const mockApproval: PendingApprovalInfo = {
        id: 'ap2',
        actionName: 'gmail:send',
        skillName: 'email',
      };
      (deps.pendingApprovals.resolve as ReturnType<typeof vi.fn>).mockReturnValue(mockApproval);

      const action: CallbackAction = { domain: 'approval', action: 'deny', target: 'ap2', args: [] };
      const result = handleCallback(action, deps);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Denied \u2717');
      expect(deps.pendingApprovals.resolve).toHaveBeenCalledWith('ap2', 'denied');
      expect(deps.agentManager.executeApprovedAction).not.toHaveBeenCalled();
      expect(result.updatedKeyboard).toEqual([[{ text: 'Denied \u2717', callback_data: 'noop' }]]);
      // Verify permission:denied event emitted
      expect(deps.eventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'permission:denied',
          source: 'telegram-callback',
          payload: expect.objectContaining({
            actionName: 'gmail:send',
            skillName: 'email',
            tier: 'red',
            approvalId: 'ap2',
          }),
        }),
      );
    });

    it('handles already resolved approval', () => {
      const err = new Error('Already resolved');
      (err as Error & { code: string }).code = 'APPROVAL_ALREADY_RESOLVED';
      (deps.pendingApprovals.resolve as ReturnType<typeof vi.fn>).mockImplementation(() => { throw err; });

      const action: CallbackAction = { domain: 'approval', action: 'approve', target: 'ap3', args: [] };
      const result = handleCallback(action, deps);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Already resolved');
    });

    it('handles approval not found', () => {
      const err = new Error('Not found');
      (err as Error & { code: string }).code = 'APPROVAL_NOT_FOUND';
      (deps.pendingApprovals.resolve as ReturnType<typeof vi.fn>).mockImplementation(() => { throw err; });

      const action: CallbackAction = { domain: 'approval', action: 'approve', target: 'ap4', args: [] };
      const result = handleCallback(action, deps);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Approval not found');
    });

    it('shows approval details via getById', () => {
      const mockApproval: PendingApprovalInfo = {
        id: 'ap5', actionName: 'gmail:send', skillName: 'email', details: 'Send to bob@mail.com',
      };
      (deps.pendingApprovals.getById as ReturnType<typeof vi.fn>).mockReturnValue(mockApproval);

      const action: CallbackAction = { domain: 'approval', action: 'details', target: 'ap5', args: [] };
      const result = handleCallback(action, deps);

      expect(result.success).toBe(true);
      expect(result.message).toContain('email');
      expect(result.message).toContain('gmail:send');
      expect(result.message).toContain('Send to bob@mail.com');
      expect(deps.pendingApprovals.getById).toHaveBeenCalledWith('ap5');
    });

    it('shows details for already-resolved approvals', () => {
      const mockApproval: PendingApprovalInfo = {
        id: 'ap6', actionName: 'gmail:send', skillName: 'email', resolution: 'approved',
      };
      (deps.pendingApprovals.getById as ReturnType<typeof vi.fn>).mockReturnValue(mockApproval);

      const action: CallbackAction = { domain: 'approval', action: 'details', target: 'ap6', args: [] };
      const result = handleCallback(action, deps);

      expect(result.success).toBe(true);
      expect(result.message).toContain('Status: approved');
    });

    it('returns not found for unknown approval details', () => {
      (deps.pendingApprovals.getById as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      const action: CallbackAction = { domain: 'approval', action: 'details', target: 'unknown', args: [] };
      const result = handleCallback(action, deps);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Approval not found');
    });
  });

  describe('snooze actions (with real DB)', () => {
    let tmpDir: string;
    let dbInstance: DatabaseInterface;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'raven-cb-snooze-test-'));
      const dbPath = join(tmpDir, 'test.db');
      initDatabase(dbPath);
      dbInstance = createDbInterface();
      deps.db = dbInstance;
    });

    afterEach(() => {
      try {
        getDb().close();
      } catch {
        // ignore
      }
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('snooze-week creates a snooze for the resolved category', () => {
      const action: CallbackAction = { domain: 'snooze', action: 'snooze-week', target: 'pipe', args: [] };
      const result = handleCallback(action, deps);

      expect(result.success).toBe(true);
      expect(result.message).toContain('Snoozed');
      expect(result.message).toContain('pipeline:*');

      const snoozes = getActiveSnoozes(dbInstance);
      expect(snoozes).toHaveLength(1);
      expect(snoozes[0].category).toBe('pipeline:*');
      expect(snoozes[0].snoozedUntil).toBeTruthy();
    });

    it('mute creates a snooze with null snoozed_until', () => {
      const action: CallbackAction = { domain: 'snooze', action: 'mute', target: 'email', args: [] };
      const result = handleCallback(action, deps);

      expect(result.success).toBe(true);
      expect(result.message).toContain('Muted');

      const snoozes = getActiveSnoozes(dbInstance);
      expect(snoozes).toHaveLength(1);
      expect(snoozes[0].snoozedUntil).toBeNull();
    });

    it('keep records suggestion dismissal', () => {
      const action: CallbackAction = { domain: 'snooze', action: 'keep', target: 'insight', args: [] };
      const result = handleCallback(action, deps);

      expect(result.success).toBe(true);
      expect(result.message).toContain('Kept');
    });

    it('returns error when db is not available', () => {
      deps.db = undefined;
      const action: CallbackAction = { domain: 'snooze', action: 'snooze-week', target: 'pipe', args: [] };
      const result = handleCallback(action, deps);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Database not available');
    });
  });

  describe('knowledge-insight actions', () => {
    it('parses ki:v callback data', () => {
      const result = parseCallbackData('ki:v:insight123');
      expect(result).toEqual<CallbackAction>({
        domain: 'knowledge-insight',
        action: 'view-graph',
        target: 'insight123',
        args: [],
      });
    });

    it('parses ki:i callback data', () => {
      const result = parseCallbackData('ki:i:insight123');
      expect(result).toEqual<CallbackAction>({
        domain: 'knowledge-insight',
        action: 'interesting',
        target: 'insight123',
        args: [],
      });
    });

    it('parses ki:n callback data', () => {
      const result = parseCallbackData('ki:n:insight123');
      expect(result).toEqual<CallbackAction>({
        domain: 'knowledge-insight',
        action: 'not-useful',
        target: 'insight123',
        args: [],
      });
    });

    it('view-graph sends deep link with bubble IDs', () => {
      const mockInsight = {
        id: 'insight-1',
        pattern_key: 'cross-domain:finances-health',
        title: 'Cross-domain',
        body: 'Connection...',
        confidence: 0.85,
        status: 'queued',
        service_sources: JSON.stringify(['knowledge-engine', 'bubbles:b1,b2']),
        suppression_hash: 'h1',
        created_at: new Date().toISOString(),
        delivered_at: null,
        dismissed_at: null,
      };
      const mockDb: DatabaseInterface = {
        get: vi.fn().mockReturnValue(mockInsight),
        all: vi.fn().mockReturnValue([]),
        run: vi.fn(),
      };
      deps.db = mockDb;

      const action: CallbackAction = { domain: 'knowledge-insight', action: 'view-graph', target: 'insight-1', args: [] };
      const result = handleCallback(action, deps);

      expect(result.success).toBe(true);
      const notifCall = (deps.eventBus.emit as any).mock.calls.find(
        (c: any) => c[0].type === 'notification',
      );
      expect(notifCall).toBeDefined();
      expect(notifCall[0].payload.body).toContain('/knowledge?highlight=b1,b2');
    });

    it('interesting marks insight as acted and emits feedback', () => {
      const mockInsight = {
        id: 'insight-1',
        pattern_key: 'cross-domain:finances-health',
        title: 'Test',
        body: 'Test',
        confidence: 0.85,
        status: 'queued',
        service_sources: JSON.stringify(['knowledge-engine']),
        suppression_hash: 'h1',
        created_at: new Date().toISOString(),
        delivered_at: null,
        dismissed_at: null,
      };
      const mockDb: DatabaseInterface = {
        get: vi.fn().mockReturnValue(mockInsight),
        all: vi.fn().mockReturnValue([]),
        run: vi.fn(),
      };
      deps.db = mockDb;

      const action: CallbackAction = { domain: 'knowledge-insight', action: 'interesting', target: 'insight-1', args: [] };
      const result = handleCallback(action, deps);

      expect(result.success).toBe(true);
      expect(result.message).toContain('interesting');
      const feedbackCall = (deps.eventBus.emit as any).mock.calls.find(
        (c: any) => c[0].type === 'insight:feedback',
      );
      expect(feedbackCall).toBeDefined();
      expect(feedbackCall[0].payload.feedback).toBe('positive');
    });

    it('not-useful dismisses and records domain-pair dismissal', () => {
      const mockInsight = {
        id: 'insight-1',
        pattern_key: 'cross-domain:finances-health',
        title: 'Test',
        body: 'Test',
        confidence: 0.85,
        status: 'queued',
        service_sources: JSON.stringify(['knowledge-engine']),
        suppression_hash: 'h1',
        created_at: new Date().toISOString(),
        delivered_at: null,
        dismissed_at: null,
      };
      const mockDb: DatabaseInterface = {
        get: vi.fn()
          .mockReturnValueOnce(mockInsight)
          .mockReturnValueOnce({ cnt: 1 }),
        all: vi.fn().mockReturnValue([]),
        run: vi.fn(),
      };
      deps.db = mockDb;

      const action: CallbackAction = { domain: 'knowledge-insight', action: 'not-useful', target: 'insight-1', args: [] };
      const result = handleCallback(action, deps);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Dismissed');
      const runCalls = (mockDb.run as any).mock.calls;
      const dismissalInsert = runCalls.find((c: any) => c[0].includes('cross_domain_dismissals'));
      expect(dismissalInsert).toBeDefined();
    });

    it('bumps adaptive threshold after 3+ dismissals for same domain pair', () => {
      const mockInsight = {
        id: 'insight-1',
        pattern_key: 'cross-domain:finances-health',
        title: 'Test',
        body: 'Test',
        confidence: 0.85,
        status: 'queued',
        service_sources: JSON.stringify(['knowledge-engine']),
        suppression_hash: 'h1',
        created_at: new Date().toISOString(),
        delivered_at: null,
        dismissed_at: null,
      };
      const mockDb: DatabaseInterface = {
        get: vi.fn()
          .mockReturnValueOnce(mockInsight)
          .mockReturnValueOnce({ cnt: 3 })
          .mockReturnValueOnce({ threshold: 0.75 }),
        all: vi.fn().mockReturnValue([]),
        run: vi.fn(),
      };
      deps.db = mockDb;

      const action: CallbackAction = { domain: 'knowledge-insight', action: 'not-useful', target: 'insight-1', args: [] };
      handleCallback(action, deps);

      const runCalls = (mockDb.run as any).mock.calls;
      const thresholdUpsert = runCalls.find((c: any) => c[0].includes('cross_domain_thresholds'));
      expect(thresholdUpsert).toBeDefined();
      // New threshold should be 0.85 (0.75 + 0.1)
      expect(thresholdUpsert[2]).toBeCloseTo(0.85);
    });

    it('returns error when db is not available', () => {
      delete deps.db;
      const action: CallbackAction = { domain: 'knowledge-insight', action: 'view-graph', target: 'x', args: [] };
      const result = handleCallback(action, deps);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Database not available');
    });

    it('returns error when insight not found', () => {
      const mockDb: DatabaseInterface = {
        get: vi.fn().mockReturnValue(undefined),
        all: vi.fn().mockReturnValue([]),
        run: vi.fn(),
      };
      deps.db = mockDb;

      const action: CallbackAction = { domain: 'knowledge-insight', action: 'view-graph', target: 'missing', args: [] };
      const result = handleCallback(action, deps);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Insight not found');
    });
  });
});
