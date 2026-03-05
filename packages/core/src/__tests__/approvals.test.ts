import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, getDb } from '../db/database.ts';
import { createAuditLog } from '../permission-engine/audit-log.ts';
import { createPendingApprovals } from '../permission-engine/pending-approvals.ts';
import { registerApprovalRoutes } from '../api/routes/approvals.ts';
import type { ApprovalRouteDeps } from '../api/routes/approvals.ts';
import type { AuditLog } from '../permission-engine/audit-log.ts';
import type { PendingApprovals, PendingApproval } from '../permission-engine/pending-approvals.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import {
  PermissionApprovedPayloadSchema,
  PermissionDeniedPayloadSchema,
  type RavenEvent,
} from '@raven/shared';

function makeMockAgentManager() {
  return {
    executeApprovedAction: vi.fn().mockResolvedValue({ success: true }),
    getQueueLength: () => 0,
    getRunningCount: () => 0,
  };
}

describe('Approval Queue API', () => {
  let tmpDir: string;
  let auditLog: AuditLog;
  let pendingApprovals: PendingApprovals;
  let eventBus: EventBus;
  let mockAgentManager: ReturnType<typeof makeMockAgentManager>;
  let app: ReturnType<typeof Fastify>;
  let emittedEvents: RavenEvent[];

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'approvals-'));
    initDatabase(join(tmpDir, 'test.db'));
    auditLog = createAuditLog(getDb());
    auditLog.initialize();
    pendingApprovals = createPendingApprovals(getDb());
    pendingApprovals.initialize();
    eventBus = new EventBus();

    emittedEvents = [];
    eventBus.on('permission:approved', (e) => emittedEvents.push(e));
    eventBus.on('permission:denied', (e) => emittedEvents.push(e));

    mockAgentManager = makeMockAgentManager();

    app = Fastify({ logger: false });

    const deps: ApprovalRouteDeps = {
      pendingApprovals,
      auditLog,
      agentManager: mockAgentManager as any,
      eventBus,
    };

    registerApprovalRoutes(app, deps);
    await app.ready();
  });

  beforeEach(() => {
    emittedEvents = [];
    mockAgentManager.executeApprovedAction.mockClear();
  });

  afterAll(async () => {
    await app.close();
    try {
      getDb().close();
    } catch {
      /* */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertTestApproval(overrides?: Partial<PendingApproval>): PendingApproval {
    return pendingApprovals.insert({
      actionName: overrides?.actionName ?? 'gmail:send-email',
      skillName: overrides?.skillName ?? 'gmail',
      details: overrides?.details ?? 'Test action details',
      sessionId: overrides?.sessionId ?? 'sess-1',
    });
  }

  describe('GET /api/approvals/pending (AC #1)', () => {
    it('returns pending approvals', async () => {
      const a1 = insertTestApproval({ actionName: 'action-a' });
      const a2 = insertTestApproval({ actionName: 'action-b' });
      const a3 = insertTestApproval({ actionName: 'action-c' });

      const res = await app.inject({ method: 'GET', url: '/api/approvals/pending' });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.payload) as PendingApproval[];
      const ids = body.map((b) => b.id);
      expect(ids).toContain(a1.id);
      expect(ids).toContain(a2.id);
      expect(ids).toContain(a3.id);

      for (const item of body) {
        expect(item.actionName).toBeDefined();
        expect(item.skillName).toBeDefined();
        expect(item.requestedAt).toBeDefined();
      }
    });

    it('filters by skillName', async () => {
      insertTestApproval({ skillName: 'ticktick', actionName: 'ticktick:create-task' });

      const res = await app.inject({
        method: 'GET',
        url: '/api/approvals/pending?skillName=ticktick',
      });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.payload) as PendingApproval[];
      expect(body.length).toBeGreaterThan(0);
      for (const item of body) {
        expect(item.skillName).toBe('ticktick');
      }
    });
  });

  describe('POST /api/approvals/:id/resolve — approve (AC #2)', () => {
    it('approves a pending approval and triggers execution', async () => {
      const approval = insertTestApproval({ actionName: 'gmail:send-email' });

      const res = await app.inject({
        method: 'POST',
        url: `/api/approvals/${approval.id}/resolve`,
        payload: { resolution: 'approved' },
      });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.payload);
      expect(body.resolution).toBe('approved');
      expect(body.status).toBe('resolved');

      // Verify audit entries
      const logs = auditLog.query({ outcome: 'approved' });
      const matching = logs.filter(
        (l) => l.actionName === 'gmail:send-email' && l.outcome === 'approved',
      );
      expect(matching.length).toBeGreaterThan(0);

      // Verify event emission
      const approvedEvents = emittedEvents.filter((e) => e.type === 'permission:approved');
      expect(approvedEvents.length).toBeGreaterThan(0);

      // Verify post-approval execution
      expect(mockAgentManager.executeApprovedAction).toHaveBeenCalledWith(
        expect.objectContaining({
          actionName: 'gmail:send-email',
          skillName: 'gmail',
        }),
      );
    });
  });

  describe('POST /api/approvals/:id/resolve — deny (AC #3)', () => {
    it('denies a pending approval without execution', async () => {
      const approval = insertTestApproval({ actionName: 'ticktick:delete-task' });

      const res = await app.inject({
        method: 'POST',
        url: `/api/approvals/${approval.id}/resolve`,
        payload: { resolution: 'denied' },
      });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.payload);
      expect(body.resolution).toBe('denied');
      expect(body.status).toBe('resolved');

      // Verify NO execution on deny
      expect(mockAgentManager.executeApprovedAction).not.toHaveBeenCalled();

      // Verify denied event emission
      const deniedEvents = emittedEvents.filter((e) => e.type === 'permission:denied');
      expect(deniedEvents.length).toBeGreaterThan(0);
    });
  });

  describe('Already-resolved guard (AC #5)', () => {
    it('returns 409 on double-resolve', async () => {
      const approval = insertTestApproval();

      await app.inject({
        method: 'POST',
        url: `/api/approvals/${approval.id}/resolve`,
        payload: { resolution: 'approved' },
      });

      const res2 = await app.inject({
        method: 'POST',
        url: `/api/approvals/${approval.id}/resolve`,
        payload: { resolution: 'denied' },
      });
      expect(res2.statusCode).toBe(409);

      const body = JSON.parse(res2.payload);
      expect(body.code).toBe('ALREADY_RESOLVED');
    });

    it('returns 404 for non-existent approval ID', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/approvals/nonexistent-id/resolve',
        payload: { resolution: 'approved' },
      });
      expect(res.statusCode).toBe(404);

      const body = JSON.parse(res.payload);
      expect(body.code).toBe('NOT_FOUND');
    });
  });

  describe('POST /api/approvals/batch (AC #4)', () => {
    it('batch resolves multiple approvals', async () => {
      const a1 = insertTestApproval({ actionName: 'batch-a' });
      const a2 = insertTestApproval({ actionName: 'batch-b' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/approvals/batch',
        payload: { ids: [a1.id, a2.id], resolution: 'approved' },
      });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.payload);
      expect(body.resolved).toBe(2);
      expect(body.skipped).toBe(0);
      expect(body.results).toHaveLength(2);
    });

    it('handles mixed resolved/unresolved in batch', async () => {
      const a1 = insertTestApproval({ actionName: 'mixed-a' });
      const a2 = insertTestApproval({ actionName: 'mixed-b' });

      // Pre-resolve a1
      await app.inject({
        method: 'POST',
        url: `/api/approvals/${a1.id}/resolve`,
        payload: { resolution: 'denied' },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/approvals/batch',
        payload: { ids: [a1.id, a2.id], resolution: 'approved' },
      });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.payload);
      expect(body.resolved).toBe(1);
      expect(body.skipped).toBe(1);
    });

    it('reports not_found IDs separately in batch', async () => {
      const a1 = insertTestApproval({ actionName: 'batch-exists' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/approvals/batch',
        payload: { ids: [a1.id, 'nonexistent-batch-id'], resolution: 'approved' },
      });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.payload);
      expect(body.resolved).toBe(1);
      expect(body.notFound).toBe(1);
      expect(body.results).toHaveLength(2);
    });

    it('rejects empty ids array', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/approvals/batch',
        payload: { ids: [], resolution: 'approved' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('Post-approval execution (AC #6)', () => {
    it('calls executeApprovedAction on approve with correct params', async () => {
      const approval = insertTestApproval({
        actionName: 'gmail:send-email',
        skillName: 'gmail',
        details: 'Send to user@test.com',
        sessionId: 'sess-exec',
      });

      await app.inject({
        method: 'POST',
        url: `/api/approvals/${approval.id}/resolve`,
        payload: { resolution: 'approved' },
      });

      expect(mockAgentManager.executeApprovedAction).toHaveBeenCalledWith({
        actionName: 'gmail:send-email',
        skillName: 'gmail',
        details: 'Send to user@test.com',
        sessionId: 'sess-exec',
      });
    });

    it('writes executed audit entry on successful execution', async () => {
      const approval = insertTestApproval({ actionName: 'exec-success-test' });
      mockAgentManager.executeApprovedAction.mockResolvedValueOnce({ success: true });

      await app.inject({
        method: 'POST',
        url: `/api/approvals/${approval.id}/resolve`,
        payload: { resolution: 'approved' },
      });

      const logs = auditLog.query({ outcome: 'executed' });
      const matching = logs.filter((l) => l.actionName === 'exec-success-test');
      expect(matching.length).toBeGreaterThan(0);
    });

    it('writes failed audit entry on execution failure', async () => {
      const approval = insertTestApproval({ actionName: 'exec-fail-test' });
      mockAgentManager.executeApprovedAction.mockResolvedValueOnce({
        success: false,
        error: 'Agent crash',
      });

      await app.inject({
        method: 'POST',
        url: `/api/approvals/${approval.id}/resolve`,
        payload: { resolution: 'approved' },
      });

      const logs = auditLog.query({ outcome: 'failed' });
      const matching = logs.filter((l) => l.actionName === 'exec-fail-test');
      expect(matching.length).toBeGreaterThan(0);
      expect(matching[0].details).toContain('Agent crash');
    });
  });

  describe('Event emissions (AC #7)', () => {
    it('emits permission:approved with Zod-valid payload', async () => {
      emittedEvents = [];
      const approval = insertTestApproval({ actionName: 'event-approve-test' });

      await app.inject({
        method: 'POST',
        url: `/api/approvals/${approval.id}/resolve`,
        payload: { resolution: 'approved' },
      });

      const event = emittedEvents.find((e) => e.type === 'permission:approved');
      expect(event).toBeDefined();
      const payload = (event as any).payload;
      expect(payload.actionName).toBe('event-approve-test');
      expect(payload.skillName).toBe('gmail');
      expect(payload.tier).toBe('red');

      const zodResult = PermissionApprovedPayloadSchema.safeParse(payload);
      expect(zodResult.success).toBe(true);
    });

    it('emits permission:denied with Zod-valid payload', async () => {
      emittedEvents = [];
      const approval = insertTestApproval({ actionName: 'event-deny-test' });

      await app.inject({
        method: 'POST',
        url: `/api/approvals/${approval.id}/resolve`,
        payload: { resolution: 'denied' },
      });

      const event = emittedEvents.find((e) => e.type === 'permission:denied');
      expect(event).toBeDefined();
      const payload = (event as any).payload;
      expect(payload.actionName).toBe('event-deny-test');
      expect(payload.skillName).toBe('gmail');
      expect(payload.tier).toBe('red');
      expect(payload.approvalId).toBe(approval.id);

      const zodResult = PermissionDeniedPayloadSchema.safeParse(payload);
      expect(zodResult.success).toBe(true);
    });
  });

  describe('Validation', () => {
    it('rejects invalid resolution value', async () => {
      const approval = insertTestApproval();

      const res = await app.inject({
        method: 'POST',
        url: `/api/approvals/${approval.id}/resolve`,
        payload: { resolution: 'maybe' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects missing resolution', async () => {
      const approval = insertTestApproval();

      const res = await app.inject({
        method: 'POST',
        url: `/api/approvals/${approval.id}/resolve`,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects batch with invalid resolution', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/approvals/batch',
        payload: { ids: ['id-1'], resolution: 'maybe' },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
