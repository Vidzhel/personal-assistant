import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../server.ts';

export function registerHealthRoute(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/api/health', async () => {
    return {
      status: 'ok',
      uptime: process.uptime(),
      skills: deps.skillRegistry.getEnabledSkillNames(),
      agentQueue: deps.agentManager.getQueueLength(),
      agentsRunning: deps.agentManager.getRunningCount(),
    };
  });
}
