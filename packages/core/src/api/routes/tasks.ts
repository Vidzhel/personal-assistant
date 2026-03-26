import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  HTTP_STATUS,
  TaskCreateInputSchema,
  TaskUpdateInputSchema,
  TaskStatusValues,
  TaskSourceValues,
} from '@raven/shared';
import type { TaskStore } from '../../task-manager/task-store.ts';
import type { TemplateLoader } from '../../task-manager/template-loader.ts';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const TaskQuerySchema = z.object({
  status: z.enum(TaskStatusValues).optional(),
  projectId: z.string().optional(),
  assignedAgentId: z.string().optional(),
  parentTaskId: z.string().optional(),
  source: z.enum(TaskSourceValues).optional(),
  search: z.string().optional(),
  includeArchived: z
    .string()
    .transform((v) => v === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  offset: z.coerce.number().int().min(0).default(0),
});

const CountsQuerySchema = z.object({
  projectId: z.string().optional(),
});

const CreateBodySchema = TaskCreateInputSchema.extend({
  templateName: z.string().optional(),
});

// eslint-disable-next-line max-lines-per-function -- route registration
export function registerTaskRoutes(
  app: FastifyInstance,
  deps: { taskStore: TaskStore; templateLoader: TemplateLoader },
): void {
  const { taskStore, templateLoader } = deps;

  // GET /api/tasks — query tasks with filters
  app.get('/api/tasks', async (req, reply) => {
    const result = TaskQuerySchema.safeParse(req.query);
    if (!result.success) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({
        error: 'Invalid query parameters',
        details: result.error.issues,
      });
    }
    return taskStore.queryTasks(result.data);
  });

  // GET /api/tasks/counts — status counts
  app.get('/api/tasks/counts', async (req, reply) => {
    const result = CountsQuerySchema.safeParse(req.query);
    if (!result.success) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'Invalid query parameters' });
    }
    return taskStore.getTaskCountsByStatus(result.data.projectId);
  });

  // GET /api/tasks/:id — full task detail with subtasks
  app.get('/api/tasks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = taskStore.getTask(id);
    if (!task) {
      return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Task not found' });
    }

    const subtasks = taskStore.getSubtasks(id);
    return { ...task, subtasks };
  });

  // POST /api/tasks — create task (manual or from template)
  app.post('/api/tasks', async (req, reply) => {
    const result = CreateBodySchema.safeParse(req.body);
    if (!result.success) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({
        error: 'Invalid task input',
        details: result.error.issues,
      });
    }

    const { templateName, ...input } = result.data;

    if (templateName) {
      try {
        const task = templateLoader.createTaskFromTemplate(templateName, input);
        return reply.status(HTTP_STATUS.CREATED).send(task);
      } catch (err) {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: (err as Error).message });
      }
    }

    const task = taskStore.createTask(input);
    return reply.status(HTTP_STATUS.CREATED).send(task);
  });

  // PATCH /api/tasks/:id — update task fields
  app.patch('/api/tasks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = TaskUpdateInputSchema.safeParse(req.body);
    if (!result.success) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({
        error: 'Invalid update input',
        details: result.error.issues,
      });
    }

    try {
      const task = taskStore.updateTask(id, result.data);
      return task;
    } catch (err) {
      return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: (err as Error).message });
    }
  });

  // POST /api/tasks/:id/complete — complete with optional artifacts
  app.post('/api/tasks/:id/complete', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { artifacts?: string[] };
    const artifacts = Array.isArray(body.artifacts) ? body.artifacts : undefined;

    try {
      const task = taskStore.completeTask(id, artifacts);
      return task;
    } catch (err) {
      return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: (err as Error).message });
    }
  });

  // GET /api/task-templates — list available templates
  app.get('/api/task-templates', async () => {
    return templateLoader.listTemplates();
  });
}
