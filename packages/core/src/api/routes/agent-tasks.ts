import { z } from 'zod';
import { HTTP_STATUS } from '@raven/shared';
import type { FastifyInstance } from 'fastify';
import type { ExecutionLogger } from '../../agent-manager/execution-logger.ts';
import type { AgentManager } from '../../agent-manager/agent-manager.ts';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const TaskQuerySchema = z.object({
  skillName: z.string().optional(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'blocked', 'cancelled']).optional(),
  sessionId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  offset: z.coerce.number().int().min(0).default(0),
});

export function registerAgentTaskRoutes(
  app: FastifyInstance,
  deps: { executionLogger: ExecutionLogger; agentManager: AgentManager },
): void {
  app.get<{
    Querystring: Record<string, string | undefined>;
  }>('/api/agent-tasks', async (req, reply) => {
    const result = TaskQuerySchema.safeParse(req.query);
    if (!result.success) {
      return reply
        .status(HTTP_STATUS.BAD_REQUEST)
        .send({ error: 'Invalid query parameters', details: z.treeifyError(result.error) });
    }

    return deps.executionLogger.queryTasks(result.data);
  });

  app.get('/api/agent-tasks/active', async () => {
    return deps.agentManager.getActiveTasks();
  });

  app.get<{
    Params: { id: string };
  }>('/api/agent-tasks/:id', async (req, reply) => {
    const task = deps.executionLogger.getTaskById(req.params.id);
    if (!task) {
      return reply
        .status(HTTP_STATUS.NOT_FOUND)
        .send({ error: 'Task not found', code: 'NOT_FOUND' });
    }
    return task;
  });

  app.post<{
    Params: { id: string };
  }>('/api/agent-tasks/:id/cancel', async (req, reply) => {
    const cancelled = deps.agentManager.cancelTask(req.params.id);
    if (!cancelled) {
      return reply
        .status(HTTP_STATUS.NOT_FOUND)
        .send({ error: 'Task not found or already completed' });
    }
    return { status: 'cancelled', taskId: req.params.id };
  });
}
