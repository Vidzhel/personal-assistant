import type { FastifyInstance } from 'fastify';
import { createLogger, HTTP_STATUS } from '@raven/shared';
import type { ScaffoldingApi } from './scaffolding-api.ts';
import type { ScaffoldAndActivateFn } from './scaffold-and-activate.ts';

const log = createLogger('api:scaffolding');

export interface ScaffoldingRouteDeps {
  scaffoldingApi: ScaffoldingApi;
  /** When present, the single-artifact routes (project/agent/template/
   * schedule) go live immediately — write, reload the affected registry,
   * git-commit — instead of sitting inert until the next restart. Optional
   * only so call sites that never wired hot-reload (e.g. older tests) keep
   * working; production boot (raven.ts) always provides it. */
  scaffoldAndActivate?: ScaffoldAndActivateFn;
}

// eslint-disable-next-line max-lines-per-function -- route registration for all scaffold endpoints
export function registerScaffoldingRoutes(app: FastifyInstance, deps: ScaffoldingRouteDeps): void {
  const { scaffoldingApi: api, scaffoldAndActivate } = deps;

  // POST /api/scaffold/project
  app.post('/api/scaffold/project', async (req, reply) => {
    try {
      const input = req.body as {
        path: string;
        displayName?: string;
        description?: string;
        systemAccess?: 'none' | 'read' | 'read-write';
      };
      if (scaffoldAndActivate) {
        const activated = await scaffoldAndActivate({ kind: 'project', input });
        return reply.code(HTTP_STATUS.CREATED).send({ relativePath: input.path, ...activated });
      }
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
      const scaffoldInput = { projectPath: input.projectPath, agent: input.agent as never };
      if (scaffoldAndActivate) {
        const activated = await scaffoldAndActivate({ kind: 'agent', input: scaffoldInput });
        return reply.code(HTTP_STATUS.CREATED).send({ name: input.agent.name, ...activated });
      }
      const name = await api.createAgent(scaffoldInput);
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
      const scaffoldInput = { projectPath: input.projectPath, template: input.template as never };
      if (scaffoldAndActivate) {
        const activated = await scaffoldAndActivate({ kind: 'template', input: scaffoldInput });
        return reply.code(HTTP_STATUS.CREATED).send({ name: input.template.name, ...activated });
      }
      const name = await api.createTemplate(scaffoldInput);
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
      const scaffoldInput = { projectPath: input.projectPath, schedule: input.schedule as never };
      if (scaffoldAndActivate) {
        const activated = await scaffoldAndActivate({ kind: 'schedule', input: scaffoldInput });
        return reply.code(HTTP_STATUS.CREATED).send({ name: input.schedule.name, ...activated });
      }
      const name = await api.createSchedule(scaffoldInput);
      return reply.code(HTTP_STATUS.CREATED).send({ name });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`scaffold schedule failed: ${message}`);
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: message });
    }
  });

  // POST /api/scaffold/domain — bulk multi-project scaffolding. Left on the
  // write-only api.scaffoldDomain path deliberately: it already reloads the
  // project registry once for the whole batch, and per-item hot-reload +
  // git-commit for a bulk domain plan is a separate concern from the
  // chat-driven single-artifact flow this phase targets (see MCP
  // create_template/create_schedule/create_skill tools).
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
