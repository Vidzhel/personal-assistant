import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ExecutionLogger } from '../../agent-manager/execution-logger.ts';

const TaskQuerySchema = z.object({
  skillName: z.string().optional(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'blocked']).optional(),
  sessionId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export function registerAgentTaskRoutes(
  app: FastifyInstance,
  deps: { executionLogger: ExecutionLogger },
): void {
  app.get<{
    Querystring: Record<string, string | undefined>;
  }>('/api/agent-tasks', async (req, reply) => {
    const result = TaskQuerySchema.safeParse(req.query);
    if (!result.success) {
      return reply
        .status(400)
        .send({ error: 'Invalid query parameters', details: result.error.flatten().fieldErrors });
    }

    return deps.executionLogger.queryTasks(result.data);
  });

  app.get<{
    Params: { id: string };
  }>('/api/agent-tasks/:id', async (req, reply) => {
    const task = deps.executionLogger.getTaskById(req.params.id);
    if (!task) {
      return reply.status(404).send({ error: 'Task not found', code: 'NOT_FOUND' });
    }
    return task;
  });
}
