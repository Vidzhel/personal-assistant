import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { createLogger } from '@raven/shared';
import type { RavenEvent, WsMessageFromClient } from '@raven/shared';
import type { EventBus } from '../../event-bus/event-bus.ts';
import type { SessionManager } from '../../session-manager/session-manager.ts';
import type { ProjectRegistry } from '../../project-registry/project-registry.ts';
import type {
  ConversationModelResolver,
  ConversationModelPreparation,
} from '../../agent-registry/conversation-models.ts';
import {
  CHAT_REQUEST_ID_MAX_LENGTH,
  ChatRequestSchema,
  validateChatTarget,
} from '../../session-manager/chat-validation.ts';

const log = createLogger('ws');

interface ChatDeps {
  eventBus: EventBus;
  sessionManager: SessionManager;
  projectRegistry?: ProjectRegistry;
  resolveModel?: ConversationModelResolver;
  prepareModel?: ConversationModelPreparation;
}

function sendChatError(
  socket: WebSocket,
  data: { requestId?: string; projectId?: string; sessionId?: string; error: string },
): void {
  socket.send(JSON.stringify({ type: 'chat:error', data }));
}

function chatRequestId(msg: WsMessageFromClient): string | undefined {
  return 'requestId' in msg &&
    typeof msg.requestId === 'string' &&
    msg.requestId.length <= CHAT_REQUEST_ID_MAX_LENGTH
    ? msg.requestId
    : undefined;
}

async function handleChatSend(
  socket: WebSocket,
  deps: ChatDeps,
  msg: WsMessageFromClient,
): Promise<void> {
  const parsed = ChatRequestSchema.safeParse(msg);
  if (!parsed.success) {
    // Preserve a valid correlation key even when another field failed validation.
    const requestId = chatRequestId(msg);
    sendChatError(socket, { requestId, error: 'Invalid chat message' });
    return;
  }
  const { projectId, sessionId, requestId } = parsed.data;
  const target = validateChatTarget(deps.sessionManager, projectId, {
    sessionId,
    projectRegistry: deps.projectRegistry,
  });
  if (!target.ok) {
    sendChatError(socket, { requestId, projectId, sessionId, error: target.error });
    return;
  }
  try {
    await deps.prepareModel?.({
      projectId,
      sessionId: target.session?.id,
      turn: parsed.data.modelConfig,
    });
    deps.resolveModel?.({
      projectId,
      sessionId: target.session?.id,
      turn: parsed.data.modelConfig,
    });
  } catch (error) {
    sendChatError(socket, { requestId, projectId, sessionId, error: String(error) });
    return;
  }
  deps.eventBus.emit({
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    source: 'web',
    type: 'user:chat:message',
    payload: parsed.data,
  });
}

export function registerWebSocketHandler(app: FastifyInstance, deps: ChatDeps): void {
  const { eventBus } = deps;
  app.get('/ws', { websocket: true }, (socket: WebSocket) => {
    const subscribedChannels = new Set<string>();
    log.info('WebSocket client connected');

    socket.on('message', (raw: Buffer) => {
      try {
        const msg: WsMessageFromClient = JSON.parse(raw.toString());

        switch (msg.type) {
          case 'subscribe':
            msg.channels.forEach((ch) => subscribedChannels.add(ch));
            log.debug(`Subscribed to: ${msg.channels.join(', ')}`);
            break;

          case 'unsubscribe':
            msg.channels.forEach((ch) => subscribedChannels.delete(ch));
            break;

          case 'chat:send':
            void handleChatSend(socket, deps, msg).catch((error: unknown) =>
              log.error(`Chat dispatch failed: ${String(error)}`),
            );
            break;
        }
      } catch (err) {
        log.error('Invalid WebSocket message', err);
      }
    });

    const forwardEvent = (event: RavenEvent): void => {
      const channel = event.projectId ? `project:${event.projectId}` : 'global';

      if (subscribedChannels.has(channel) || subscribedChannels.has('global')) {
        try {
          socket.send(JSON.stringify({ type: 'event', data: event }));
        } catch {
          // Client disconnected
        }
      }
    };

    eventBus.on('*', forwardEvent);

    socket.on('close', () => {
      log.info('WebSocket client disconnected');
      eventBus.off('*', forwardEvent);
    });
  });
}
