import type { FastifyInstance } from 'fastify';
import { HTTP_STATUS } from '@raven/shared';
import type { TemplateRegistry } from '../../template-engine/template-registry.ts';
import type { TemplateScheduler } from '../../template-engine/template-scheduler.ts';

interface TemplateDeps {
  templateRegistry: TemplateRegistry;
  templateScheduler: TemplateScheduler;
}

export function registerTemplateRoutes(app: FastifyInstance, deps: TemplateDeps): void {
  const { templateRegistry, templateScheduler } = deps;

  // GET /api/templates — list all templates
  app.get('/api/templates', async () => {
    const templates = templateRegistry.getAllTemplates();
    return templates.map((t) => ({
      name: t.name,
      displayName: t.displayName,
      description: t.description,
      trigger: t.trigger,
      plan: t.plan,
      taskCount: t.tasks.length,
    }));
  });

  // GET /api/templates/:name — get template details
  app.get('/api/templates/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const template = templateRegistry.getTemplate(name);
    if (!template) {
      return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Template not found' });
    }
    return template;
  });

  // POST /api/templates/:name/trigger — trigger a template
  app.post('/api/templates/:name/trigger', async (req, reply) => {
    const { name } = req.params as { name: string };
    const body = (req.body ?? {}) as { params?: Record<string, unknown> };
    const params = body.params ?? {};

    try {
      const treeId = await templateScheduler.triggerTemplate(name, params);
      return reply.code(HTTP_STATUS.ACCEPTED).send({ treeId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: message });
    }
  });
}
