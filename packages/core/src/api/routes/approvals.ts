import { z } from 'zod';
import { createLogger, generateId, HTTP_STATUS } from '@raven/shared';
import type { PermissionTier } from '@raven/shared';
import type { FastifyInstance } from 'fastify';
import type { PendingApprovals } from '../../permission-engine/pending-approvals.ts';
import type { AuditLog } from '../../permission-engine/audit-log.ts';
import type { AgentManager } from '../../agent-manager/agent-manager.ts';
import type { EventBus } from '../../event-bus/event-bus.ts';

const log = createLogger('api-approvals');

export interface ApprovalRouteDeps {
  pendingApprovals: PendingApprovals;
  auditLog: AuditLog;
  agentManager: AgentManager;
  eventBus: EventBus;
}

const ResolveBodySchema = z.object({
  resolution: z.enum(['approved', 'denied']),
});

const BatchBodySchema = z.object({
  ids: z.array(z.string()).min(1),
  resolution: z.enum(['approved', 'denied']),
});

const PendingQuerySchema = z.object({
  skillName: z.string().optional(),
});

interface ResolveResult {
  id: string;
  resolution: 'approved' | 'denied';
  status: 'resolved' | 'skipped' | 'not_found';
  error?: string;
}

function emitApprovedEvent(
  deps: ApprovalRouteDeps,
  params: { actionName: string; skillName: string; sessionId?: string },
): void {
  deps.eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: 'approval-queue',
    type: 'permission:approved',
    payload: {
      actionName: params.actionName,
      skillName: params.skillName,
      tier: 'red' as PermissionTier,
      sessionId: params.sessionId,
    },
  });
}

function emitDeniedEvent(
  deps: ApprovalRouteDeps,
  params: { actionName: string; skillName: string; approvalId: string; sessionId?: string },
): void {
  deps.eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: 'approval-queue',
    type: 'permission:denied',
    payload: {
      actionName: params.actionName,
      skillName: params.skillName,
      tier: 'red' as PermissionTier,
      approvalId: params.approvalId,
      sessionId: params.sessionId,
    },
  });
}

// eslint-disable-next-line max-lines-per-function -- approval resolution with audit logging and post-execution
async function resolveApproval(
  id: string,
  resolution: 'approved' | 'denied',
  deps: ApprovalRouteDeps,
): Promise<ResolveResult> {
  try {
    const approval = deps.pendingApprovals.resolve(id, resolution);

    deps.auditLog.insert({
      skillName: approval.skillName,
      actionName: approval.actionName,
      permissionTier: 'red',
      outcome: resolution,
      sessionId: approval.sessionId,
    });

    if (resolution === 'approved') {
      emitApprovedEvent(deps, {
        actionName: approval.actionName,
        skillName: approval.skillName,
        sessionId: approval.sessionId,
      });
    } else {
      emitDeniedEvent(deps, {
        actionName: approval.actionName,
        skillName: approval.skillName,
        approvalId: approval.id,
        sessionId: approval.sessionId,
      });
    }

    if (resolution === 'approved') {
      const execResult = await deps.agentManager.executeApprovedAction({
        actionName: approval.actionName,
        skillName: approval.skillName,
        details: approval.details,
        sessionId: approval.sessionId,
      });

      if (execResult.success) {
        deps.auditLog.insert({
          skillName: approval.skillName,
          actionName: approval.actionName,
          permissionTier: 'red',
          outcome: 'executed',
          sessionId: approval.sessionId,
        });
      } else {
        log.error(`Post-approval execution failed for ${id}: ${execResult.error}`);

        deps.auditLog.insert({
          skillName: approval.skillName,
          actionName: approval.actionName,
          permissionTier: 'red',
          outcome: 'failed',
          sessionId: approval.sessionId,
          details: execResult.error,
        });
      }
    }

    return { id, resolution, status: 'resolved' };
  } catch (err) {
    if (err instanceof Error && (err as Error & { code?: string }).code === 'APPROVAL_NOT_FOUND') {
      return { id, resolution, status: 'not_found', error: 'not found' };
    }
    if (
      err instanceof Error &&
      (err as Error & { code?: string }).code === 'APPROVAL_ALREADY_RESOLVED'
    ) {
      return { id, resolution, status: 'skipped', error: 'already resolved' };
    }
    throw err;
  }
}

// eslint-disable-next-line max-lines-per-function -- route registration for all approval endpoints
export function registerApprovalRoutes(app: FastifyInstance, deps: ApprovalRouteDeps): void {
  app.get<{
    Querystring: { skillName?: string };
  }>('/api/approvals/pending', async (req, reply) => {
    const result = PendingQuerySchema.safeParse(req.query);
    if (!result.success) {
      return reply
        .status(HTTP_STATUS.BAD_REQUEST)
        .send({ error: 'Invalid query parameters', details: z.treeifyError(result.error) });
    }

    const approvals = deps.pendingApprovals.query();

    if (result.data.skillName) {
      return approvals.filter((a) => a.skillName === result.data.skillName);
    }

    return approvals;
  });

  app.post<{
    Params: { id: string };
    Body: { resolution: 'approved' | 'denied' };
  }>('/api/approvals/:id/resolve', async (req, reply) => {
    const bodyResult = ResolveBodySchema.safeParse(req.body);
    if (!bodyResult.success) {
      return reply
        .status(HTTP_STATUS.BAD_REQUEST)
        .send({ error: 'Invalid request body', details: z.treeifyError(bodyResult.error) });
    }

    const { id } = req.params;
    const result = await resolveApproval(id, bodyResult.data.resolution, deps);

    if (result.status === 'not_found') {
      return reply
        .status(HTTP_STATUS.NOT_FOUND)
        .send({ error: 'Approval not found', code: 'NOT_FOUND' });
    }

    if (result.status === 'skipped') {
      return reply
        .status(HTTP_STATUS.CONFLICT)
        .send({ error: 'Approval already resolved', code: 'ALREADY_RESOLVED' });
    }

    return result;
  });

  app.post<{
    Body: { ids: string[]; resolution: 'approved' | 'denied' };
  }>('/api/approvals/batch', async (req, reply) => {
    const bodyResult = BatchBodySchema.safeParse(req.body);
    if (!bodyResult.success) {
      return reply
        .status(HTTP_STATUS.BAD_REQUEST)
        .send({ error: 'Invalid request body', details: z.treeifyError(bodyResult.error) });
    }

    const { ids, resolution } = bodyResult.data;
    const results: ResolveResult[] = [];
    let resolved = 0;
    let skipped = 0;
    let notFound = 0;

    for (const id of ids) {
      const result = await resolveApproval(id, resolution, deps);
      results.push(result);
      if (result.status === 'resolved') resolved++;
      if (result.status === 'skipped') skipped++;
      if (result.status === 'not_found') notFound++;
    }

    return { resolved, skipped, notFound, results };
  });
}
