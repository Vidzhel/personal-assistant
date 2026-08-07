import type { FastifyInstance } from 'fastify';
import { HTTP_STATUS } from '@raven/shared';
import type { IntentStore } from '../../intents/intent-store.ts';

export interface IntentRoutesDeps {
  intentStore: IntentStore;
}

/**
 * Deliberately minimal: GET (list) + cancel only. Creation is chat-only
 * (create_intent MCP tool) — see intents/intent-store.ts's design note and
 * the Phase 4 plan's self-review ("Intents deliberately have no UI creation
 * form — chat is the interface; web only lists + cancels").
 */
export function registerIntentRoutes(app: FastifyInstance, deps: IntentRoutesDeps): void {
  app.get('/api/intents', async () => {
    return deps.intentStore.list();
  });

  app.post<{ Params: { id: string } }>('/api/intents/:id/cancel', async (req, reply) => {
    const ok = deps.intentStore.cancel(req.params.id);
    if (!ok) {
      return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Intent not found or not active' });
    }
    return { id: req.params.id, status: 'cancelled' };
  });
}
