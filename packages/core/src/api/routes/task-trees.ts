import type { FastifyInstance } from 'fastify';
import { HTTP_STATUS } from '@raven/shared';
import type { TaskExecutionEngine } from '../../task-execution/task-execution-engine.ts';

// eslint-disable-next-line max-lines-per-function -- route registration
export function registerTaskTreeRoutes(
  app: FastifyInstance,
  deps: { executionEngine: TaskExecutionEngine },
): void {
  const { executionEngine } = deps;

  // GET /api/task-trees — list active task trees
  app.get('/api/task-trees', async () => {
    const trees = executionEngine.getActiveTrees();
    return trees.map((tree) => ({
      id: tree.id,
      projectId: tree.projectId,
      status: tree.status,
      plan: tree.plan,
      taskCount: tree.tasks.size,
      createdAt: tree.createdAt,
      updatedAt: tree.updatedAt,
    }));
  });

  // GET /api/task-trees/:id — full tree with all tasks
  app.get('/api/task-trees/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const tree = executionEngine.getTree(id);
    if (!tree) {
      return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Task tree not found' });
    }
    return {
      ...tree,
      tasks: [...tree.tasks.values()],
    };
  });

  // POST /api/task-trees/:id/approve — approve a pending plan
  app.post('/api/task-trees/:id/approve', async (req, reply) => {
    const { id } = req.params as { id: string };
    const tree = executionEngine.getTree(id);
    if (!tree) {
      return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Task tree not found' });
    }
    if (tree.status !== 'pending_approval') {
      return reply
        .status(HTTP_STATUS.BAD_REQUEST)
        .send({ error: `Tree is not pending approval (status: ${tree.status})` });
    }
    await executionEngine.startTree(id);
    const updated = executionEngine.getTree(id);
    return {
      ...updated,
      tasks: updated ? [...updated.tasks.values()] : [],
    };
  });

  // POST /api/task-trees/:id/cancel — cancel a tree
  app.post('/api/task-trees/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    const tree = executionEngine.getTree(id);
    if (!tree) {
      return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Task tree not found' });
    }
    executionEngine.cancelTree(id);
    return { status: 'cancelled' };
  });

  // POST /api/task-trees/:id/tasks/:taskId/approve — approve an approval-type task
  app.post('/api/task-trees/:id/tasks/:taskId/approve', async (req, reply) => {
    const { id, taskId } = req.params as { id: string; taskId: string };
    const tree = executionEngine.getTree(id);
    if (!tree) {
      return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Task tree not found' });
    }
    const task = tree.tasks.get(taskId);
    if (!task) {
      return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Task not found in tree' });
    }
    await executionEngine.onApprovalGranted(id, taskId);
    return { status: 'approved' };
  });
}
