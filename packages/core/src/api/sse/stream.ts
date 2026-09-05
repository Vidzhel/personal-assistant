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
  taskId: string;
  eventBus: EventBus;
}

function terminalStatus(input: {
  status?: string;
  success?: boolean;
  blocked?: boolean;
  cancelled?: boolean;
}): 'completed' | 'failed' | 'blocked' | 'cancelled' {
  if (input.cancelled || input.status === 'cancelled') return 'cancelled';
  if (input.blocked || input.status === 'blocked') return 'blocked';
  if (input.status === 'completed' || input.success) return 'completed';
  return 'failed';
}

function terminalPayload(
  taskId: string,
  input: {
    status?: string;
    success?: boolean;
    result?: string;
    errors?: string[];
    blocked?: boolean;
    cancelled?: boolean;
    interrupted?: boolean;
  },
): Record<string, unknown> {
  const status = terminalStatus(input);
  return {
    taskId,
    status,
    ...(input.result !== undefined && { result: input.result }),
    ...(input.errors !== undefined && { errors: input.errors }),
    blocked: status === 'blocked',
    cancelled: status === 'cancelled',
    ...(input.interrupted === true && { interrupted: true }),
  };
}

function setupSSEStream({ raw, taskId, eventBus }: SSEStreamOpts): void {
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
      writeSSE('agent-complete', terminalPayload(ev.payload.taskId, ev.payload));
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
  raw.once('close', cleanup);
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

      if (['completed', 'failed', 'blocked', 'cancelled'].includes(task.status)) {
        return reply.status(HTTP_STATUS.OK).send({
          event: 'agent-complete',
          ...terminalPayload(task.id, task),
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

      setupSSEStream({ raw, taskId: id, eventBus: deps.eventBus });
    },
  );
}
