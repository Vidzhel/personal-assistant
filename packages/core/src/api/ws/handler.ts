import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { createLogger } from '@raven/shared';
import type { RavenEvent, WsMessageFromClient } from '@raven/shared';
import type { EventBus } from '../../event-bus/event-bus.js';

const log = createLogger('ws');

export function registerWebSocketHandler(
  app: FastifyInstance,
  eventBus: EventBus,
): void {
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
            eventBus.emit({
              id: crypto.randomUUID(),
              timestamp: Date.now(),
              source: 'web',
              type: 'user:chat:message',
              payload: {
                projectId: msg.projectId,
                sessionId: msg.sessionId,
                message: msg.message,
              },
            });
            break;
        }
      } catch (err) {
        log.error('Invalid WebSocket message', err);
      }
    });

    const forwardEvent = (event: RavenEvent) => {
      const channel = event.projectId
        ? `project:${event.projectId}`
        : 'global';

      if (
        subscribedChannels.has(channel) ||
        subscribedChannels.has('global')
      ) {
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
