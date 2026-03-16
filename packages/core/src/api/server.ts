import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { createLogger } from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { SuiteRegistry } from '../suite-registry/suite-registry.ts';
import type { SessionManager } from '../session-manager/session-manager.ts';
import type { Scheduler } from '../scheduler/scheduler.ts';
import type { AgentManager } from '../agent-manager/agent-manager.ts';
import type { AuditLog } from '../permission-engine/audit-log.ts';
import type { PendingApprovals } from '../permission-engine/pending-approvals.ts';
import type { ExecutionLogger } from '../agent-manager/execution-logger.ts';
import type { MessageStore } from '../session-manager/message-store.ts';
import type { PipelineEngine } from '../pipeline-engine/pipeline-engine.ts';
import type { PipelineStore } from '../pipeline-engine/pipeline-store.ts';
import type { PipelineScheduler } from '../pipeline-engine/pipeline-scheduler.ts';
import { registerHealthRoute } from './routes/health.ts';
import { registerProjectRoutes } from './routes/projects.ts';
import { registerSessionRoutes } from './routes/sessions.ts';
import { registerChatRoute } from './routes/chat.ts';
import { registerSuiteRoutes } from './routes/suites.ts';
import { registerScheduleRoutes } from './routes/schedules.ts';
import { registerEventRoutes } from './routes/events.ts';
import { registerAuditLogRoutes } from './routes/audit-logs.ts';
import { registerApprovalRoutes } from './routes/approvals.ts';
import { registerAgentTaskRoutes } from './routes/agent-tasks.ts';
import { registerPipelineRoutes } from './routes/pipelines.ts';
import { registerMetricsRoute } from './routes/metrics.ts';
import { registerSSERoutes } from './sse/stream.ts';
import { registerWebSocketHandler } from './ws/handler.ts';

const log = createLogger('api');

export interface ApiDeps {
  eventBus: EventBus;
  suiteRegistry: SuiteRegistry;
  sessionManager: SessionManager;
  scheduler: Scheduler;
  agentManager: AgentManager;
  auditLog: AuditLog;
  pendingApprovals: PendingApprovals;
  executionLogger: ExecutionLogger;
  messageStore: MessageStore;
  pipelineEngine: PipelineEngine;
  pipelineStore?: PipelineStore;
  pipelineScheduler?: PipelineScheduler;
  configuredSuiteCount: number;
}

export async function createApiServer(
  deps: ApiDeps,
  port: number,
  host = '0.0.0.0',
): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify({ logger: false });

  await app.register(cors, { origin: true });
  await app.register(websocket);

  // REST routes
  registerHealthRoute(app, deps);
  registerProjectRoutes(app);
  registerSessionRoutes(app, deps);
  registerChatRoute(app, deps);
  registerSuiteRoutes(app, deps);
  registerScheduleRoutes(app, deps);
  registerEventRoutes(app);
  registerAuditLogRoutes(app, deps.auditLog);
  registerApprovalRoutes(app, {
    pendingApprovals: deps.pendingApprovals,
    auditLog: deps.auditLog,
    agentManager: deps.agentManager,
    eventBus: deps.eventBus,
  });
  registerAgentTaskRoutes(app, {
    executionLogger: deps.executionLogger,
    agentManager: deps.agentManager,
  });
  registerPipelineRoutes(app, {
    pipelineEngine: deps.pipelineEngine,
    pipelineStore: deps.pipelineStore,
    pipelineScheduler: deps.pipelineScheduler,
  });
  registerMetricsRoute(app, {
    executionLogger: deps.executionLogger,
    pipelineStore: deps.pipelineStore,
  });

  // SSE streaming
  registerSSERoutes(app, {
    eventBus: deps.eventBus,
    executionLogger: deps.executionLogger,
  });

  // WebSocket
  registerWebSocketHandler(app, deps.eventBus);

  await app.listen({ port, host });
  log.info(`API server listening on port ${port}`);

  return app;
}
