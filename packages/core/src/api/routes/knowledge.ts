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
  GraphQuerySchema,
} from '@raven/shared';
import type { GraphNode, GraphEdge, GraphData } from '@raven/shared';
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

function buildTagEdges(nodes: GraphNode[], nodeIds: Set<string>): GraphEdge[] {
  const tagMap = new Map<string, string[]>();
  for (const node of nodes) {
    for (const t of node.tags) {
      const list = tagMap.get(t);
      if (list) list.push(node.id);
      else tagMap.set(t, [node.id]);
    }
  }
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const [, ids] of tagMap) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = `${ids[i]}:${ids[j]}`;
        if (!seen.has(key) && nodeIds.has(ids[i]) && nodeIds.has(ids[j])) {
          seen.add(key);
          edges.push({
            source: ids[i],
            target: ids[j],
            relationshipType: 'shared-tag',
            confidence: null,
          });
        }
      }
    }
  }
  return edges;
}

function buildClusterEdges(nodes: GraphNode[], nodeIds: Set<string>): GraphEdge[] {
  const clusterMap = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.clusterLabel) continue;
    const list = clusterMap.get(node.clusterLabel);
    if (list) list.push(node.id);
    else clusterMap.set(node.clusterLabel, [node.id]);
  }
  const edges: GraphEdge[] = [];
  for (const [, ids] of clusterMap) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        if (nodeIds.has(ids[i]) && nodeIds.has(ids[j])) {
          edges.push({
            source: ids[i],
            target: ids[j],
            relationshipType: 'cluster-member',
            confidence: null,
          });
        }
      }
    }
  }
  return edges;
}

function buildDomainEdges(nodes: GraphNode[], nodeIds: Set<string>): GraphEdge[] {
  const domainMap = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.domain) continue;
    const list = domainMap.get(node.domain);
    if (list) list.push(node.id);
    else domainMap.set(node.domain, [node.id]);
  }
  const edges: GraphEdge[] = [];
  for (const [, ids] of domainMap) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        if (nodeIds.has(ids[i]) && nodeIds.has(ids[j])) {
          edges.push({
            source: ids[i],
            target: ids[j],
            relationshipType: 'same-domain',
            confidence: null,
          });
        }
      }
    }
  }
  return edges;
}

// eslint-disable-next-line max-lines-per-function -- composite graph query
async function buildGraphData(
  neo: Neo4jClient,
  params: { view: GraphData['view']; tag?: string; domain?: string; permanence?: string },
): Promise<GraphData> {
  const { view, tag, domain, permanence } = params;

  const filterClauses: string[] = [];
  const filterParams: Record<string, unknown> = {};
  if (tag) {
    filterClauses.push('$tag IN b.tags');
    filterParams.tag = tag;
  }
  if (domain) {
    filterClauses.push('$domain IN b.domains');
    filterParams.domain = domain;
  }
  if (permanence) {
    filterClauses.push('b.permanence = $permanence');
    filterParams.permanence = permanence;
  }
  const whereClause = filterClauses.length > 0 ? `WHERE ${filterClauses.join(' AND ')}` : '';

  const nodeRows = await neo.query<{
    id: string;
    title: string;
    permanence: string;
    tags: string[];
    domains: string[];
    clusterLabel: string | null;
    createdAt: string;
    updatedAt: string;
    lastAccessedAt: string | null;
    degree: number;
  }>(
    `MATCH (b:Bubble) ${whereClause}
     OPTIONAL MATCH (b)-[r:LINKED_TO]-()
     OPTIONAL MATCH (b)-[:HAS_TAG]->(tag:Tag)
     WITH b, count(DISTINCT r) as degree, collect(DISTINCT tag.name) as tagNames
     RETURN b.id as id, b.title as title, b.permanence as permanence,
            tagNames as tags, b.domains as domains, b.clusterLabel as clusterLabel,
            b.createdAt as createdAt, b.updatedAt as updatedAt,
            b.lastAccessedAt as lastAccessedAt, degree`,
    filterParams,
  );

  const nodes: GraphNode[] = nodeRows.map((r) => ({
    id: r.id,
    title: r.title,
    domain: r.domains?.[0] ?? null,
    permanence: (r.permanence as GraphNode['permanence']) ?? 'normal',
    tags: r.tags ?? [],
    clusterLabel: r.clusterLabel ?? null,
    connectionDegree: r.degree,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastAccessedAt: r.lastAccessedAt ?? null,
  }));

  const nodeIds = new Set(nodes.map((n) => n.id));
  let edges: GraphEdge[] = [];

  if (view === 'links') {
    const edgeRows = await neo.query<{
      source: string;
      target: string;
      relationshipType: string;
      confidence: number | null;
    }>(
      `MATCH (b1:Bubble)-[r:LINKED_TO]->(b2:Bubble)
       RETURN b1.id as source, b2.id as target,
              r.type as relationshipType, r.confidence as confidence`,
    );
    edges = edgeRows.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
  } else if (view === 'tags') {
    edges = buildTagEdges(nodes, nodeIds);
  } else if (view === 'clusters') {
    edges = buildClusterEdges(nodes, nodeIds);
  } else if (view === 'domains') {
    edges = buildDomainEdges(nodes, nodeIds);
  }

  return { nodes, edges, view };
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
    const overrideDays = days !== undefined && !isNaN(days) ? days : undefined;
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
    const snoozedUntil = await knowledgeLifecycle.snoozeBubble(req.params.id, result.data.days);
    if (!snoozedUntil) return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Not found' });
    return { success: true, snoozedUntil };
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

  // --- Story 6.7: Knowledge Graph Visualization ---
  app.get('/api/knowledge/graph', async (req, reply) => {
    const parsed = GraphQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: parsed.error.message });
    }
    if (!deps.neo4j) {
      return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'Neo4j not available' });
    }
    return buildGraphData(deps.neo4j, parsed.data);
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
    return reply.status(HTTP_STATUS.OK).send(bubble);
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
