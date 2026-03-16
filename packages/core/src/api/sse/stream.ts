import { createLogger, HTTP_STATUS } from '@raven/shared';
import type { RavenEvent } from '@raven/shared';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ServerResponse } from 'node:http';
import type { EventBus } from '../../event-bus/event-bus.ts';
import type { ExecutionLogger } from '../../agent-manager/execution-logger.ts';

const log = createLogger('sse');

export interface SSEDeps {
  eventBus: EventBus;
  executionLogger: ExecutionLogger;
}

interface SSEStreamOpts {
  raw: ServerResponse;
  req: FastifyRequest;
  taskId: string;
  eventBus: EventBus;
}

function setupSSEStream({ raw, req, taskId, eventBus }: SSEStreamOpts): void {
  const writeSSE = (event: string, data: unknown): void => {
    raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const onMessage = (ev: RavenEvent): void => {
    if (ev.type === 'agent:message' && ev.payload.taskId === taskId) {
      writeSSE('agent-output', {
        chunk: ev.payload.content,
        taskId: ev.payload.taskId,
        messageType: ev.payload.messageType,
      });
    }
  };

  const onComplete = (ev: RavenEvent): void => {
    if (ev.type === 'agent:task:complete' && ev.payload.taskId === taskId) {
      writeSSE('agent-complete', {
        taskId: ev.payload.taskId,
        status: ev.payload.success ? 'completed' : 'failed',
        result: ev.payload.result,
        errors: ev.payload.errors,
      });
      cleanup();
    }
  };

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    eventBus.off('agent:message', onMessage);
    eventBus.off('agent:task:complete', onComplete);
    raw.end();
    log.info(`SSE stream closed for task ${taskId}`);
  };

  eventBus.on('agent:message', onMessage);
  eventBus.on('agent:task:complete', onComplete);
  req.raw.on('close', cleanup);
}

export function registerSSERoutes(app: FastifyInstance, deps: SSEDeps): void {
  app.get<{ Params: { id: string } }>(
    '/api/agent-tasks/:id/stream',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = req.params;
      const task = deps.executionLogger.getTaskById(id);

      if (!task) {
        return reply
          .status(HTTP_STATUS.NOT_FOUND)
          .send({ error: 'Task not found', code: 'NOT_FOUND' });
      }

      if (task.status === 'completed' || task.status === 'failed') {
        return reply.status(HTTP_STATUS.OK).send({
          event: 'agent-complete',
          taskId: task.id,
          status: task.status,
        });
      }

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(HTTP_STATUS.OK, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      raw.write(':ok\n\n');
      log.info(`SSE stream opened for task ${id}`);

      setupSSEStream({ raw, req, taskId: id, eventBus: deps.eventBus });
    },
  );
}
