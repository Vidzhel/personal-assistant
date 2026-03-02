import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { createLogger } from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.js';
import type { SkillRegistry } from '../skill-registry/skill-registry.js';
import type { SessionManager } from '../session-manager/session-manager.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { AgentManager } from '../agent-manager/agent-manager.js';
import { registerHealthRoute } from './routes/health.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerChatRoute } from './routes/chat.js';
import { registerSkillRoutes } from './routes/skills.js';
import { registerScheduleRoutes } from './routes/schedules.js';
import { registerEventRoutes } from './routes/events.js';
import { registerWebSocketHandler } from './ws/handler.js';

const log = createLogger('api');

export interface ApiDeps {
  eventBus: EventBus;
  skillRegistry: SkillRegistry;
  sessionManager: SessionManager;
  scheduler: Scheduler;
  agentManager: AgentManager;
}

export async function createApiServer(deps: ApiDeps, port: number) {
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

  // WebSocket
  registerWebSocketHandler(app, deps.eventBus);

  await app.listen({ port, host: '0.0.0.0' });
  log.info(`API server listening on port ${port}`);

  return app;
}
