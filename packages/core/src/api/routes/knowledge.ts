import type { FastifyInstance } from 'fastify';
import {
  HTTP_STATUS,
  generateId,
  createLogger,
  CreateKnowledgeBubbleSchema,
  UpdateKnowledgeBubbleSchema,
  KnowledgeQuerySchema,
  IngestKnowledgeSchema,
  KnowledgeLinkSchema,
  ResolveLinkSchema,
  ResolveMergeSchema,
  PermanenceSchema,
  SearchQuerySchema,
  TimelineQuerySchema,
  SnoozeSchema,
  MergeBubblesSchema,
} from '@raven/shared';
import type { EventBus } from '../../event-bus/event-bus.ts';
import type { KnowledgeStore } from '../../knowledge-engine/knowledge-store.ts';
import type { IngestionProcessor } from '../../knowledge-engine/ingestion.ts';
import type { EmbeddingEngine } from '../../knowledge-engine/embeddings.ts';
import type { ClusteringEngine } from '../../knowledge-engine/clustering.ts';
import type { ChunkingEngine } from '../../knowledge-engine/chunking.ts';
import type { RetrievalEngine } from '../../knowledge-engine/retrieval.ts';
import type { ExecutionLogger } from '../../agent-manager/execution-logger.ts';
import type { Neo4jClient } from '../../knowledge-engine/neo4j-client.ts';
import type { KnowledgeLifecycle } from '../../knowledge-engine/knowledge-lifecycle.ts';
import type { Retrospective } from '../../knowledge-engine/retrospective.ts';

const log = createLogger('knowledge-api');

export interface KnowledgeRouteDeps {
  eventBus: EventBus;
  knowledgeStore: KnowledgeStore;
  ingestionProcessor: IngestionProcessor;
  executionLogger: ExecutionLogger;
  neo4j?: Neo4jClient;
  embeddingEngine?: EmbeddingEngine;
  clusteringEngine?: ClusteringEngine;
  chunkingEngine?: ChunkingEngine;
  retrievalEngine?: RetrievalEngine;
  knowledgeLifecycle?: KnowledgeLifecycle;
  retrospective?: Retrospective;
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

// eslint-disable-next-line max-lines-per-function -- route registration for all knowledge endpoints
export function registerKnowledgeRoutes(app: FastifyInstance, deps: KnowledgeRouteDeps): void {
  const { eventBus, knowledgeStore, ingestionProcessor, executionLogger } = deps;
  const { clusteringEngine } = deps;

  // --- Existing routes ---
  app.get('/api/knowledge/tags', async (req) => {
    const query = req.query as Record<string, string>;
    if (query.tree === 'true' && clusteringEngine) {
      return clusteringEngine.getTagTree();
    }
    return knowledgeStore.getAllTags();
  });

  app.post('/api/knowledge/reindex', async () => {
    return knowledgeStore.reindexAll();
  });

  app.post('/api/knowledge/ingest', async (req, reply) => {
    const result = IngestKnowledgeSchema.safeParse(req.body);
    if (!result.success) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: result.error.message });
    }
    const { taskId } = await ingestionProcessor.ingest(result.data);
    return reply.status(HTTP_STATUS.ACCEPTED).send({ taskId });
  });

  app.get<{ Params: { taskId: string } }>('/api/knowledge/ingest/:taskId', async (req, reply) => {
    const task = executionLogger.getTaskById(req.params.taskId);
    if (!task) return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Task not found' });
    return { taskId: task.id, status: task.status, result: task.result };
  });

  // --- New routes: domains ---
  app.get('/api/knowledge/domains', async () => {
    if (!clusteringEngine) return [];
    return clusteringEngine.getDomains();
  });

  // --- New routes: tag rebalancing ---
  app.post('/api/knowledge/tags/rebalance', async () => {
    if (!clusteringEngine) return { merged: 0, restructured: 0 };
    return clusteringEngine.rebalanceTagTree();
  });

  // --- New routes: clustering ---
  // M1 FIX: Added .catch() to runClustering() promise
  app.post('/api/knowledge/cluster', async (_req, reply) => {
    if (!clusteringEngine) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'Clustering not available' });
    }
    const taskId = generateId();
    clusteringEngine
      .runClustering()
      .then((result) => {
        eventBus.emit({
          id: generateId(),
          timestamp: Date.now(),
          source: 'knowledge-api',
          type: 'knowledge:clustering:complete',
          payload: { ...result, taskId },
        });
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`Clustering failed for task ${taskId}: ${msg}`);
      });
    return reply.status(HTTP_STATUS.ACCEPTED).send({ taskId });
  });

  app.get('/api/knowledge/clusters', async () => {
    if (!clusteringEngine) return [];
    return clusteringEngine.getClusters();
  });

  app.get<{ Params: { id: string } }>('/api/knowledge/clusters/:id', async (req, reply) => {
    if (!clusteringEngine) {
      return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Clustering not available' });
    }
    const clusters = await clusteringEngine.getClusters();
    const cluster = clusters.find((c) => c.id === req.params.id);
    if (!cluster) return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Cluster not found' });
    const members = await clusteringEngine.getClusterMembers(req.params.id);
    return { ...cluster, members };
  });

  // --- New routes: merge detection ---
  app.post('/api/knowledge/detect-merges', async () => {
    if (!clusteringEngine) return { mergeCount: 0 };
    return clusteringEngine.detectMerges();
  });

  app.get('/api/knowledge/merges', async (req) => {
    if (!clusteringEngine) return [];
    const query = req.query as Record<string, string>;
    return clusteringEngine.getMergeSuggestions(query.status);
  });

  app.post<{ Params: { id: string } }>('/api/knowledge/merges/:id/resolve', async (req, reply) => {
    if (!clusteringEngine) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'Not available' });
    }
    const result = ResolveMergeSchema.safeParse(req.body);
    if (!result.success) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: result.error.message });
    }
    const resolved = await clusteringEngine.resolveMerge(req.params.id, result.data.action);
    if (!resolved) return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Not found' });
    return { success: true };
  });

  // --- New routes: hub detection ---
  app.post('/api/knowledge/detect-hubs', async () => {
    if (!clusteringEngine) return [];
    return clusteringEngine.detectHubs();
  });

  app.post<{ Params: { id: string } }>('/api/knowledge/:id/split-hub', async (req, reply) => {
    if (!clusteringEngine) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'Not available' });
    }
    const taskId = generateId();
    clusteringEngine
      .splitHub(req.params.id)
      .then(() => {
        log.info(`Hub split complete for ${req.params.id} (task ${taskId})`);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`Hub split failed for ${req.params.id}: ${msg}`);
      });
    return reply.status(HTTP_STATUS.ACCEPTED).send({ taskId, status: 'splitting' });
  });

  // --- New routes: links ---
  app.get<{ Params: { id: string } }>('/api/knowledge/:id/links', async (req) => {
    if (!clusteringEngine) return [];
    return clusteringEngine.getLinksForBubble(req.params.id);
  });

  app.post('/api/knowledge/links', async (req, reply) => {
    if (!clusteringEngine) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'Not available' });
    }
    const result = KnowledgeLinkSchema.safeParse(req.body);
    if (!result.success) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: result.error.message });
    }
    const link = await clusteringEngine.createLink({
      sourceBubbleId: result.data.sourceBubbleId,
      targetBubbleId: result.data.targetBubbleId,
      relationshipType: result.data.relationshipType,
      confidence: result.data.confidence,
    });
    return reply.status(HTTP_STATUS.CREATED).send(link);
  });

  app.post<{ Params: { id: string } }>('/api/knowledge/links/:id/resolve', async (req, reply) => {
    if (!clusteringEngine) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'Not available' });
    }
    const result = ResolveLinkSchema.safeParse(req.body);
    if (!result.success) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: result.error.message });
    }
    const resolved = await clusteringEngine.resolveLink(req.params.id, result.data.action);
    if (!resolved) return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Not found' });
    return { success: true };
  });

  // --- Story 6.4: Search & Retrieval routes ---
  const { chunkingEngine, retrievalEngine } = deps;

  app.post('/api/knowledge/search', async (req, reply) => {
    if (!retrievalEngine) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'Retrieval not available' });
    }
    const result = SearchQuerySchema.safeParse(req.body);
    if (!result.success) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: result.error.message });
    }
    const { query, type, tokenBudget, includeSourceContent, limit: resultLimit } = result.data;
    return retrievalEngine.search(query, {
      tokenBudget,
      includeSourceContent,
      limit: resultLimit,
      ...(type !== 'auto' ? { type } : {}),
    });
  });

  app.get('/api/knowledge/timeline', async (req, reply) => {
    if (!retrievalEngine) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'Retrieval not available' });
    }
    const result = TimelineQuerySchema.safeParse(req.query);
    if (!result.success) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: result.error.message });
    }
    return retrievalEngine.retrieveTimeline(result.data);
  });

  app.post('/api/knowledge/reindex-embeddings', async (_req, reply) => {
    if (!chunkingEngine) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'Chunking not available' });
    }
    const taskId = generateId();
    chunkingEngine
      .reindexAllChunks()
      .then((result) => {
        log.info(`Chunk reindex complete (task ${taskId}): ${result.indexed}/${result.total}`);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`Chunk reindex failed (task ${taskId}): ${msg}`);
      });
    return reply.status(HTTP_STATUS.ACCEPTED).send({ taskId, status: 'reindexing' });
  });

  app.get<{ Params: { taskId: string } }>(
    '/api/knowledge/reindex-embeddings/:taskId',
    async (req, reply) => {
      const task = executionLogger.getTaskById(req.params.taskId);
      if (!task) return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Task not found' });
      return { taskId: task.id, status: task.status, result: task.result };
    },
  );

  app.get('/api/knowledge/index-status', async (_req, reply) => {
    if (!retrievalEngine) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'Retrieval not available' });
    }
    return retrievalEngine.getIndexStatus();
  });

  // --- Story 6.6: Lifecycle & Retrospective routes ---
  const { knowledgeLifecycle, retrospective } = deps;

  app.get('/api/knowledge/stale', async (req, reply) => {
    if (!knowledgeLifecycle) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'Lifecycle not available' });
    }
    const query = req.query as Record<string, string>;
    const days = query.days ? parseInt(query.days, 10) : undefined;
    const overrideDays = days && !isNaN(days) ? days : undefined;
    return knowledgeLifecycle.detectStaleBubbles(overrideDays);
  });

  app.post<{ Params: { id: string } }>('/api/knowledge/:id/snooze', async (req, reply) => {
    if (!knowledgeLifecycle) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'Lifecycle not available' });
    }
    const result = SnoozeSchema.safeParse(req.body);
    if (!result.success) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: result.error.message });
    }
    const success = await knowledgeLifecycle.snoozeBubble(req.params.id, result.data.days);
    if (!success) return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Not found' });
    return { success: true, snoozedDays: result.data.days };
  });

  app.post('/api/knowledge/merge', async (req, reply) => {
    if (!knowledgeLifecycle) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'Lifecycle not available' });
    }
    const result = MergeBubblesSchema.safeParse(req.body);
    if (!result.success) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: result.error.message });
    }
    const mergedId = await knowledgeLifecycle.mergeBubbles(result.data.bubbleIds);
    if (!mergedId) {
      return reply
        .status(HTTP_STATUS.BAD_REQUEST)
        .send({ error: 'Merge failed — not enough valid bubbles' });
    }
    return reply.status(HTTP_STATUS.CREATED).send({ mergedBubbleId: mergedId });
  });

  app.get('/api/knowledge/retrospective', async (req, reply) => {
    if (!retrospective) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'Retrospective not available' });
    }
    const query = req.query as Record<string, string>;
    const since = query.since;
    return retrospective.generateSummary(since);
  });

  app.post('/api/knowledge/retrospective/trigger', async (_req, reply) => {
    if (!retrospective) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'Retrospective not available' });
    }
    const summary = await retrospective.runFullRetrospective();
    return { triggered: true, summary };
  });

  // --- New routes: permanence ---
  app.patch<{ Params: { id: string } }>('/api/knowledge/:id/permanence', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const parsed = PermanenceSchema.safeParse(body.permanence);
    if (!parsed.success) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'Invalid permanence level' });
    }
    const bubble = await knowledgeStore.getById(req.params.id);
    if (!bubble) return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Not found' });
    if (deps.neo4j) {
      await deps.neo4j.run('MATCH (b:Bubble {id: $id}) SET b.permanence = $permanence', {
        id: req.params.id,
        permanence: parsed.data,
      });
    }
    return { id: req.params.id, permanence: parsed.data };
  });

  // --- Existing CRUD routes ---
  app.get('/api/knowledge', async (req, reply) => {
    const result = KnowledgeQuerySchema.safeParse(req.query);
    if (!result.success) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: result.error.message });
    }
    return knowledgeStore.list(result.data);
  });

  app.get<{ Params: { id: string } }>('/api/knowledge/:id', async (req, reply) => {
    const bubble = await knowledgeStore.getById(req.params.id);
    if (!bubble) return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Not found' });
    return bubble;
  });

  app.post('/api/knowledge', async (req, reply) => {
    const result = CreateKnowledgeBubbleSchema.safeParse(req.body);
    if (!result.success) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: result.error.message });
    }
    const bubble = await knowledgeStore.insert(result.data);
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
    const bubble = await knowledgeStore.update(req.params.id, result.data);
    if (!bubble) return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Not found' });
    emitKnowledgeEvent(eventBus, 'knowledge:bubble:updated', {
      bubbleId: bubble.id,
      title: bubble.title,
      filePath: bubble.filePath,
    });
    return bubble;
  });

  app.delete<{ Params: { id: string } }>('/api/knowledge/:id', async (req, reply) => {
    const existing = await knowledgeStore.getById(req.params.id);
    if (!existing) return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Not found' });
    await knowledgeStore.remove(req.params.id);
    emitKnowledgeEvent(eventBus, 'knowledge:bubble:deleted', {
      bubbleId: existing.id,
      title: existing.title,
      filePath: existing.filePath,
    });
    return { success: true };
  });
}
