import type { FastifyInstance } from 'fastify';
import { createLogger, HTTP_STATUS } from '@raven/shared';
import type { ScaffoldingApi } from './scaffolding-api.ts';

const log = createLogger('api:scaffolding');

// eslint-disable-next-line max-lines-per-function -- route registration for all scaffold endpoints
export function registerScaffoldingRoutes(app: FastifyInstance, api: ScaffoldingApi): void {
  // POST /api/scaffold/project
  app.post('/api/scaffold/project', async (req, reply) => {
    try {
      const input = req.body as {
        path: string;
        displayName?: string;
        description?: string;
        systemAccess?: 'none' | 'read' | 'read-write';
      };
      const path = await api.createProject(input);
      return reply.code(HTTP_STATUS.CREATED).send({ path });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`scaffold project failed: ${message}`);
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: message });
    }
  });

  // POST /api/scaffold/agent
  app.post('/api/scaffold/agent', async (req, reply) => {
    try {
      const input = req.body as { projectPath: string; agent: Record<string, unknown> };
      const name = await api.createAgent({
        projectPath: input.projectPath,
        agent: input.agent as never,
      });
      return reply.code(HTTP_STATUS.CREATED).send({ name });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`scaffold agent failed: ${message}`);
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: message });
    }
  });

  // POST /api/scaffold/template
  app.post('/api/scaffold/template', async (req, reply) => {
    try {
      const input = req.body as { projectPath: string; template: Record<string, unknown> };
      const name = await api.createTemplate({
        projectPath: input.projectPath,
        template: input.template as never,
      });
      return reply.code(HTTP_STATUS.CREATED).send({ name });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`scaffold template failed: ${message}`);
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: message });
    }
  });

  // POST /api/scaffold/schedule
  app.post('/api/scaffold/schedule', async (req, reply) => {
    try {
      const input = req.body as { projectPath: string; schedule: Record<string, unknown> };
      const name = await api.createSchedule({
        projectPath: input.projectPath,
        schedule: input.schedule as never,
      });
      return reply.code(HTTP_STATUS.CREATED).send({ name });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`scaffold schedule failed: ${message}`);
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: message });
    }
  });

  // POST /api/scaffold/domain
  app.post('/api/scaffold/domain', async (req, reply) => {
    try {
      const plan = req.body as {
        projects: Array<Record<string, unknown>>;
        agents: Array<Record<string, unknown>>;
        templates: Array<Record<string, unknown>>;
        schedules: Array<Record<string, unknown>>;
      };
      const result = await api.scaffoldDomain(plan as never);
      return reply.code(HTTP_STATUS.OK).send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`scaffold domain failed: ${message}`);
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: message });
    }
  });
}
