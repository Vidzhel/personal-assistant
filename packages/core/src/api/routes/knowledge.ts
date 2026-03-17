import type { FastifyInstance } from 'fastify';
import {
  HTTP_STATUS,
  generateId,
  CreateKnowledgeBubbleSchema,
  UpdateKnowledgeBubbleSchema,
  KnowledgeQuerySchema,
} from '@raven/shared';
import type { EventBus } from '../../event-bus/event-bus.ts';
import type { KnowledgeStore } from '../../knowledge-engine/knowledge-store.ts';

export interface KnowledgeRouteDeps {
  eventBus: EventBus;
  knowledgeStore: KnowledgeStore;
}

function emitKnowledgeEvent(
  eventBus: EventBus,
  type: 'knowledge:bubble:created' | 'knowledge:bubble:updated' | 'knowledge:bubble:deleted',
  payload: { bubbleId: string; title: string; filePath: string },
): void {
  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: 'knowledge-api',
    type,
    payload,
  });
}

// eslint-disable-next-line max-lines-per-function -- route registration for all knowledge CRUD endpoints
export function registerKnowledgeRoutes(app: FastifyInstance, deps: KnowledgeRouteDeps): void {
  const { eventBus, knowledgeStore } = deps;

  // Static routes BEFORE parameterized routes
  app.get('/api/knowledge/tags', async () => {
    return knowledgeStore.getAllTags();
  });

  app.post('/api/knowledge/reindex', async () => {
    return knowledgeStore.reindexAll();
  });

  app.get('/api/knowledge', async (req, reply) => {
    const result = KnowledgeQuerySchema.safeParse(req.query);
    if (!result.success) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: result.error.message });
    }
    return knowledgeStore.list(result.data);
  });

  app.get<{ Params: { id: string } }>('/api/knowledge/:id', async (req, reply) => {
    const bubble = knowledgeStore.getById(req.params.id);
    if (!bubble) return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Not found' });
    return bubble;
  });

  app.post('/api/knowledge', async (req, reply) => {
    const result = CreateKnowledgeBubbleSchema.safeParse(req.body);
    if (!result.success) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: result.error.message });
    }
    const bubble = knowledgeStore.insert(result.data);
    emitKnowledgeEvent(eventBus, 'knowledge:bubble:created', {
      bubbleId: bubble.id,
      title: bubble.title,
      filePath: bubble.filePath,
    });
    return reply.status(HTTP_STATUS.CREATED).send(bubble);
  });

  app.put<{ Params: { id: string } }>('/api/knowledge/:id', async (req, reply) => {
    const result = UpdateKnowledgeBubbleSchema.safeParse(req.body);
    if (!result.success) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: result.error.message });
    }
    const bubble = knowledgeStore.update(req.params.id, result.data);
    if (!bubble) return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Not found' });
    emitKnowledgeEvent(eventBus, 'knowledge:bubble:updated', {
      bubbleId: bubble.id,
      title: bubble.title,
      filePath: bubble.filePath,
    });
    return bubble;
  });

  app.delete<{ Params: { id: string } }>('/api/knowledge/:id', async (req, reply) => {
    const existing = knowledgeStore.getById(req.params.id);
    if (!existing) return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Not found' });
    knowledgeStore.remove(req.params.id);
    emitKnowledgeEvent(eventBus, 'knowledge:bubble:deleted', {
      bubbleId: existing.id,
      title: existing.title,
      filePath: existing.filePath,
    });
    return { success: true };
  });
}
