import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { createLogger } from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { SkillRegistry } from '../skill-registry/skill-registry.ts';
import type { SessionManager } from '../session-manager/session-manager.ts';
import type { Scheduler } from '../scheduler/scheduler.ts';
import type { AgentManager } from '../agent-manager/agent-manager.ts';
import type { AuditLog } from '../permission-engine/audit-log.ts';
import type { PendingApprovals } from '../permission-engine/pending-approvals.ts';
import { registerHealthRoute } from './routes/health.ts';
import { registerProjectRoutes } from './routes/projects.ts';
import { registerSessionRoutes } from './routes/sessions.ts';
import { registerChatRoute } from './routes/chat.ts';
import { registerSkillRoutes } from './routes/skills.ts';
import { registerScheduleRoutes } from './routes/schedules.ts';
import { registerEventRoutes } from './routes/events.ts';
import { registerAuditLogRoutes } from './routes/audit-logs.ts';
import { registerApprovalRoutes } from './routes/approvals.ts';
import { registerWebSocketHandler } from './ws/handler.ts';

const log = createLogger('api');

export interface ApiDeps {
  eventBus: EventBus;
  skillRegistry: SkillRegistry;
  sessionManager: SessionManager;
  scheduler: Scheduler;
  agentManager: AgentManager;
  auditLog: AuditLog;
  pendingApprovals: PendingApprovals;
}

export async function createApiServer(
  deps: ApiDeps,
  port: number,
): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify({ logger: false });

  await app.register(cors, { origin: true });
  await app.register(websocket);

  // REST routes
  registerHealthRoute(app, deps);
  registerProjectRoutes(app);
  registerSessionRoutes(app, deps);
  registerChatRoute(app, deps);
  registerSkillRoutes(app, deps);
  registerScheduleRoutes(app, deps);
  registerEventRoutes(app);
  registerAuditLogRoutes(app, deps.auditLog);
  registerApprovalRoutes(app, {
    pendingApprovals: deps.pendingApprovals,
    auditLog: deps.auditLog,
    agentManager: deps.agentManager,
    eventBus: deps.eventBus,
  });

  // WebSocket
  registerWebSocketHandler(app, deps.eventBus);

  await app.listen({ port, host: '0.0.0.0' });
  log.info(`API server listening on port ${port}`);

  return app;
}
