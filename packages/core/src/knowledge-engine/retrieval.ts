import { join, resolve } from 'node:path';
import {
  type QueryType,
  type RetrievalOptions,
  type RetrievalResult,
  type RetrievalResultItem,
  type TimelineOptions,
  type TimelineResult,
  type IndexStatus,
  type KnowledgeBubbleSummary,
  type Permanence,
} from '@raven/shared';
import type { Neo4jClient } from './neo4j-client.ts';
import type { KnowledgeStore } from './knowledge-store.ts';
import { getPipeline, buildQueryEmbeddingInput } from './embeddings.ts';
import { extractFromFile } from './content-extractor.ts';
import { createSemaphore } from './semaphore.ts';

const DEFAULT_TOKEN_BUDGET = 4000;
const DEFAULT_LIMIT = 20;
const DEFAULT_TOP_K = 20;
const CHARS_PER_TOKEN = 4;
const LINKED_SCORE_FACTOR = 0.7;
const CLUSTER_SCORE_FACTOR = 0.5;
const TAG_COOCCURRENCE_FACTOR = 0.3;
const TAG_COOCCURRENCE_LIMIT = 5;
const TOP_BUBBLES_FOR_TAG_QUERY = 5;
const SCORE_DECREMENT = 0.01;
const DEFAULT_MAX_CONCURRENT = 3;

const PERMANENCE_WEIGHTS: Record<string, number> = {
  temporary: 0.9,
  normal: 1.0,
  robust: 1.2,
};

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// --- Query Classification (rule-based, no LLM) ---

const PRECISE_PATTERNS = [
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}/i,
  /\b(last|this)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\bwhat happened\b/i,
  /\bwho said\b/i,
  /\bon\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d/i,
];

const TIMELINE_PATTERNS = [
  /\b(browse|show me|list|recent|latest|oldest)\b/i,
  /\b(last|past|this)\s+(week|month|year|day)\b/i,
  /\b(timeline|chronolog|history)\b/i,
];

export function classifyQuery(query: string): QueryType {
  // Check timeline first — "last week" is a range browse, not a precise lookup
  if (TIMELINE_PATTERNS.some((p) => p.test(query))) return 'timeline';
  if (PRECISE_PATTERNS.some((p) => p.test(query))) return 'precise';
  return 'generic';
}

// --- Date extraction for precise queries ---

const MONTH_MAP: Record<string, string> = {
  january: '01',
  february: '02',
  march: '03',
  april: '04',
  may: '05',
  june: '06',
  july: '07',
  august: '08',
  september: '09',
  october: '10',
  november: '11',
  december: '12',
};

function extractDateRange(query: string): { from?: string; to?: string } {
  // ISO date
  const isoMatch = query.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) {
    return { from: isoMatch[1] + 'T00:00:00', to: isoMatch[1] + 'T23:59:59' };
  }

  // "March 5th" / "March 5"
  const monthDayMatch = query.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})/i,
  );
  if (monthDayMatch) {
    const month = MONTH_MAP[monthDayMatch[1].toLowerCase()];
    const day = monthDayMatch[2].padStart(2, '0');
    const year = new Date().getFullYear().toString();
    return { from: `${year}-${month}-${day}T00:00:00`, to: `${year}-${month}-${day}T23:59:59` };
  }

  return {};
}

export interface RetrievalEngine {
  search: (query: string, options?: RetrievalOptions) => Promise<RetrievalResult>;
  retrieveTimeline: (options: TimelineOptions) => Promise<TimelineResult>;
  getIndexStatus: () => Promise<IndexStatus>;
  enrichWithSource: (bubbleId: string) => Promise<string | undefined>;
}

interface RetrievalDeps {
  neo4j: Neo4jClient;
  knowledgeStore: KnowledgeStore;
  knowledgeDir: string;
  maxConcurrentSearches?: number;
}

// eslint-disable-next-line max-lines-per-function -- factory function for retrieval engine
export function createRetrievalEngine(deps: RetrievalDeps): RetrievalEngine {
  const { neo4j, knowledgeStore, knowledgeDir } = deps;
  const semaphore = createSemaphore(deps.maxConcurrentSearches ?? DEFAULT_MAX_CONCURRENT);

  async function embedQuery(query: string): Promise<number[]> {
    const input = buildQueryEmbeddingInput(query);
    const pipe = await getPipeline();
    const output = await pipe(input, { pooling: 'mean', normalize: true });
    return Array.from(new Float32Array(output.data));
  }

  // --- Precise retrieval ---
  // eslint-disable-next-line max-lines-per-function -- Neo4j query + result assembly
  async function retrievePrecise(
    query: string,
    options: RetrievalOptions,
  ): Promise<RetrievalResult> {
    const { from, to } = extractDateRange(query);
    const limit = options.limit ?? DEFAULT_LIMIT;
    const tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;

    const conditions: string[] = [];
    const params: Record<string, unknown> = { limit };
    if (from) {
      conditions.push('b.createdAt >= $from');
      params.from = from;
    }
    if (to) {
      conditions.push('b.createdAt <= $to');
      params.to = to;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = await neo4j.query<{
      id: string;
      title: string;
      contentPreview: string;
      permanence: string;
      sourceFile: string | null;
      createdAt: string;
      tags: string[];
      domains: string[];
    }>(
      `MATCH (b:Bubble) ${whereClause}
       WITH b ORDER BY b.createdAt DESC LIMIT $limit
       OPTIONAL MATCH (b)-[:HAS_TAG]->(t:Tag)
       OPTIONAL MATCH (b)-[:IN_DOMAIN]->(d:Domain)
       RETURN b.id AS id, b.title AS title, b.contentPreview AS contentPreview,
              b.permanence AS permanence, b.sourceFile AS sourceFile, b.createdAt AS createdAt,
              collect(DISTINCT t.name) AS tags, collect(DISTINCT d.name) AS domains`,
      params,
    );

    return assembleResult({
      items: rows.map((r, i) => ({
        bubbleId: r.id,
        title: r.title,
        contentPreview: r.contentPreview ?? '',
        score: 1.0 - i * SCORE_DECREMENT,
        provenance: { tier: 1, tierName: 'precise_date', rawScore: 1.0, permanenceWeight: 1.0 },
        tags: r.tags.filter(Boolean),
        domains: r.domains.filter(Boolean),
        permanence: (r.permanence ?? 'normal') as Permanence,
        sourceFile: r.sourceFile ?? undefined,
      })),
      query,
      queryType: 'precise',
      tokenBudget,
    });
  }

  // --- Multi-tier generic retrieval ---
  // eslint-disable-next-line max-lines-per-function, complexity -- multi-tier retrieval pipeline
  async function retrieveGeneric(
    query: string,
    options: RetrievalOptions,
  ): Promise<RetrievalResult> {
    const topK = options.topK ?? DEFAULT_TOP_K;
    const limit = options.limit ?? DEFAULT_LIMIT;
    const tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;

    const queryEmbedding = await embedQuery(query);

    // Tiers 1-4 in a single Neo4j query
    const mainRows = await neo4j.query<{
      bubbleId: string;
      title: string;
      contentPreview: string;
      chunkText: string;
      chunkScore: number;
      permanence: string;
      sourceFile: string | null;
      tags: string[];
      domains: string[];
      linkedIds: string[];
      linkedTitles: string[];
      linkedPreviews: string[];
      linkedPermanences: string[];
      linkedSourceFiles: Array<string | null>;
      siblingIds: string[];
      siblingTitles: string[];
      siblingPreviews: string[];
      siblingPermanences: string[];
      siblingSourceFiles: Array<string | null>;
    }>(
      `CALL db.index.vector.queryNodes('chunk_embedding', $topK, $queryEmbedding)
       YIELD node AS chunk, score
       MATCH (b:Bubble)-[:HAS_CHUNK]->(chunk)
       WITH b, chunk.text AS chunkText, max(score) AS chunkScore
       ORDER BY chunkScore DESC LIMIT $limit
       OPTIONAL MATCH (b)-[:HAS_TAG]->(t:Tag)
       OPTIONAL MATCH (b)-[:IN_DOMAIN]->(d:Domain)
       OPTIONAL MATCH (b)-[link:LINKS_TO]-(linked:Bubble)
       WHERE link.status = 'accepted'
       OPTIONAL MATCH (b)-[:IN_CLUSTER]->(cl:Cluster)<-[:IN_CLUSTER]-(sibling:Bubble)
       WHERE sibling.id <> b.id
       RETURN b.id AS bubbleId, b.title AS title, b.contentPreview AS contentPreview,
              chunkText, chunkScore, b.permanence AS permanence, b.sourceFile AS sourceFile,
              collect(DISTINCT t.name) AS tags, collect(DISTINCT d.name) AS domains,
              collect(DISTINCT linked.id) AS linkedIds,
              collect(DISTINCT linked.title) AS linkedTitles,
              collect(DISTINCT linked.contentPreview) AS linkedPreviews,
              collect(DISTINCT linked.permanence) AS linkedPermanences,
              collect(DISTINCT linked.sourceFile) AS linkedSourceFiles,
              collect(DISTINCT sibling.id) AS siblingIds,
              collect(DISTINCT sibling.title) AS siblingTitles,
              collect(DISTINCT sibling.contentPreview) AS siblingPreviews,
              collect(DISTINCT sibling.permanence) AS siblingPermanences,
              collect(DISTINCT sibling.sourceFile) AS siblingSourceFiles`,
      { topK, limit, queryEmbedding },
    );

    const resultMap = new Map<string, RetrievalResultItem>();

    for (const row of mainRows) {
      const perm = (row.permanence ?? 'normal') as Permanence;
      const permWeight = PERMANENCE_WEIGHTS[perm] ?? 1.0;

      // Tier 1+2: chunk match → parent bubble
      if (!resultMap.has(row.bubbleId)) {
        resultMap.set(row.bubbleId, {
          bubbleId: row.bubbleId,
          title: row.title,
          contentPreview: row.contentPreview ?? '',
          chunkText: row.chunkText ?? undefined,
          score: row.chunkScore * permWeight,
          provenance: {
            tier: 1,
            tierName: 'chunk_vector',
            rawScore: row.chunkScore,
            permanenceWeight: permWeight,
          },
          tags: row.tags.filter(Boolean),
          domains: row.domains.filter(Boolean),
          permanence: perm,
          sourceFile: row.sourceFile ?? undefined,
        });
      }

      // Tier 3: linked bubbles
      for (let i = 0; i < row.linkedIds.length; i++) {
        const linkedId = row.linkedIds[i];
        if (!linkedId || resultMap.has(linkedId)) continue;
        const linkedPerm = (row.linkedPermanences[i] ?? 'normal') as Permanence;
        const linkedPermW = PERMANENCE_WEIGHTS[linkedPerm] ?? 1.0;
        const linkedScore = row.chunkScore * LINKED_SCORE_FACTOR * linkedPermW;
        resultMap.set(linkedId, {
          bubbleId: linkedId,
          title: row.linkedTitles[i] ?? '',
          contentPreview: row.linkedPreviews[i] ?? '',
          score: linkedScore,
          provenance: {
            tier: 3,
            tierName: 'linked',
            rawScore: row.chunkScore * LINKED_SCORE_FACTOR,
            permanenceWeight: linkedPermW,
          },
          tags: [],
          domains: [],
          permanence: linkedPerm,
          sourceFile: row.linkedSourceFiles[i] ?? undefined,
        });
      }

      // Tier 4: cluster siblings
      for (let i = 0; i < row.siblingIds.length; i++) {
        const sibId = row.siblingIds[i];
        if (!sibId || resultMap.has(sibId)) continue;
        const sibPerm = (row.siblingPermanences[i] ?? 'normal') as Permanence;
        const sibPermW = PERMANENCE_WEIGHTS[sibPerm] ?? 1.0;
        const sibScore = row.chunkScore * CLUSTER_SCORE_FACTOR * sibPermW;
        resultMap.set(sibId, {
          bubbleId: sibId,
          title: row.siblingTitles[i] ?? '',
          contentPreview: row.siblingPreviews[i] ?? '',
          score: sibScore,
          provenance: {
            tier: 4,
            tierName: 'cluster',
            rawScore: row.chunkScore * CLUSTER_SCORE_FACTOR,
            permanenceWeight: sibPermW,
          },
          tags: [],
          domains: [],
          permanence: sibPerm,
          sourceFile: row.siblingSourceFiles[i] ?? undefined,
        });
      }
    }

    // Tier 5: tag co-occurrence (separate query for top bubbles)
    const topBubbleIds = mainRows.slice(0, TOP_BUBBLES_FOR_TAG_QUERY).map((r) => r.bubbleId);
    if (topBubbleIds.length > 0) {
      const tagRows = await neo4j.query<{
        bubbleId: string;
        title: string;
        contentPreview: string;
        permanence: string;
        sourceFile: string | null;
      }>(
        `UNWIND $bubbleIds AS bid
         MATCH (b:Bubble {id: bid})-[:HAS_TAG]->(t:Tag)-[:CHILD_OF]->(parent:Tag)<-[:CHILD_OF]-(sibling:Tag)<-[:HAS_TAG]-(related:Bubble)
         WHERE NOT related.id IN $bubbleIds AND NOT related.id IN $existingIds
         RETURN DISTINCT related.id AS bubbleId, related.title AS title,
                related.contentPreview AS contentPreview, related.permanence AS permanence,
                related.sourceFile AS sourceFile
         LIMIT $tagLimit`,
        {
          bubbleIds: topBubbleIds,
          existingIds: [...resultMap.keys()],
          tagLimit: TAG_COOCCURRENCE_LIMIT,
        },
      );

      const avgScore =
        mainRows.length > 0
          ? mainRows.reduce((sum, r) => sum + r.chunkScore, 0) / mainRows.length
          : 0;

      for (const tr of tagRows) {
        if (resultMap.has(tr.bubbleId)) continue;
        const perm = (tr.permanence ?? 'normal') as Permanence;
        const permW = PERMANENCE_WEIGHTS[perm] ?? 1.0;
        resultMap.set(tr.bubbleId, {
          bubbleId: tr.bubbleId,
          title: tr.title ?? '',
          contentPreview: tr.contentPreview ?? '',
          score: avgScore * TAG_COOCCURRENCE_FACTOR * permW,
          provenance: {
            tier: 5,
            tierName: 'tag_cooccurrence',
            rawScore: avgScore * TAG_COOCCURRENCE_FACTOR,
            permanenceWeight: permW,
          },
          tags: [],
          domains: [],
          permanence: perm,
          sourceFile: tr.sourceFile ?? undefined,
        });
      }
    }

    return assembleResult({
      items: [...resultMap.values()],
      query,
      queryType: 'generic',
      tokenBudget,
    });
  }

  // --- Timeline navigation ---
  // eslint-disable-next-line max-lines-per-function, complexity -- timeline dimension switch
  async function retrieveTimeline(options: TimelineOptions): Promise<TimelineResult> {
    const { dimension, cursor, direction = 'forward', limit = DEFAULT_LIMIT } = options;
    const dir = direction === 'forward' ? 'ASC' : 'DESC';
    const op = direction === 'forward' ? '>' : '<';

    let cypher: string;
    let countCypher = 'MATCH (b:Bubble) RETURN count(b) AS total';
    const params: Record<string, unknown> = { limit };

    switch (dimension) {
      case 'date':
        cypher = cursor
          ? `MATCH (b:Bubble) WHERE b.createdAt ${op} $cursor
             WITH b ORDER BY b.createdAt ${dir} LIMIT $limit`
          : `MATCH (b:Bubble) WITH b ORDER BY b.createdAt ${dir} LIMIT $limit`;
        if (cursor) params.cursor = cursor;
        break;
      case 'domain':
        cypher = cursor
          ? `MATCH (b:Bubble)-[:IN_DOMAIN]->(d:Domain {name: $filter})
             WHERE b.createdAt ${op} $cursor
             WITH b ORDER BY b.createdAt ${dir} LIMIT $limit`
          : `MATCH (b:Bubble)-[:IN_DOMAIN]->(d:Domain {name: $filter})
             WITH b ORDER BY b.createdAt ${dir} LIMIT $limit`;
        params.filter = options.filter?.domain ?? '';
        if (cursor) params.cursor = cursor;
        countCypher =
          'MATCH (b:Bubble)-[:IN_DOMAIN]->(d:Domain {name: $filter}) RETURN count(b) AS total';
        break;
      case 'source':
        cypher = cursor
          ? `MATCH (b:Bubble) WHERE b.source = $filter AND b.createdAt ${op} $cursor
             WITH b ORDER BY b.createdAt ${dir} LIMIT $limit`
          : `MATCH (b:Bubble) WHERE b.source = $filter
             WITH b ORDER BY b.createdAt ${dir} LIMIT $limit`;
        params.filter = options.filter?.source ?? '';
        if (cursor) params.cursor = cursor;
        countCypher = 'MATCH (b:Bubble) WHERE b.source = $filter RETURN count(b) AS total';
        break;
      case 'permanence':
        cypher = cursor
          ? `MATCH (b:Bubble) WHERE b.permanence = $filter AND b.createdAt ${op} $cursor
             WITH b ORDER BY b.createdAt ${dir} LIMIT $limit`
          : `MATCH (b:Bubble) WHERE b.permanence = $filter
             WITH b ORDER BY b.createdAt ${dir} LIMIT $limit`;
        params.filter = options.filter?.permanence ?? '';
        if (cursor) params.cursor = cursor;
        countCypher = 'MATCH (b:Bubble) WHERE b.permanence = $filter RETURN count(b) AS total';
        break;
      case 'cluster':
        cypher = cursor
          ? `MATCH (b:Bubble)-[:IN_CLUSTER]->(c:Cluster {id: $filter})
             WHERE b.createdAt ${op} $cursor
             WITH b ORDER BY b.createdAt ${dir} LIMIT $limit`
          : `MATCH (b:Bubble)-[:IN_CLUSTER]->(c:Cluster {id: $filter})
             WITH b ORDER BY b.createdAt ${dir} LIMIT $limit`;
        params.filter = options.filter?.clusterId ?? cursor ?? '';
        if (cursor) params.cursor = cursor;
        countCypher =
          'MATCH (b:Bubble)-[:IN_CLUSTER]->(c:Cluster {id: $filter}) RETURN count(b) AS total';
        break;
      case 'connection_degree':
        cypher = `MATCH (b:Bubble)
                  WITH b, size([(b)-[:LINKS_TO]-() | 1]) AS degree
                  ORDER BY degree ${dir} LIMIT $limit`;
        break;
      case 'recency':
        cypher = cursor
          ? `MATCH (b:Bubble) WHERE b.updatedAt ${op} $cursor
             WITH b ORDER BY b.updatedAt ${dir} LIMIT $limit`
          : `MATCH (b:Bubble) WITH b ORDER BY b.updatedAt ${dir} LIMIT $limit`;
        if (cursor) params.cursor = cursor;
        break;
      // M3: confidence dimension requires embedding similarity to cursor bubble — deferred to 6.5
      default:
        cypher = `MATCH (b:Bubble) WITH b ORDER BY b.createdAt ${dir} LIMIT $limit`;
    }

    const fullCypher = `${cypher}
      OPTIONAL MATCH (b)-[:HAS_TAG]->(t:Tag)
      OPTIONAL MATCH (b)-[:IN_DOMAIN]->(d:Domain)
      RETURN b.id AS id, b.title AS title, b.contentPreview AS contentPreview,
             b.filePath AS filePath, b.source AS source, b.sourceFile AS sourceFile,
             b.sourceUrl AS sourceUrl, b.permanence AS permanence,
             b.createdAt AS createdAt, b.updatedAt AS updatedAt,
             collect(DISTINCT t.name) AS tags, collect(DISTINCT d.name) AS domains`;

    const rows = await neo4j.query<{
      id: string;
      title: string;
      contentPreview: string;
      filePath: string;
      source: string | null;
      sourceFile: string | null;
      sourceUrl: string | null;
      permanence: string;
      createdAt: string;
      updatedAt: string;
      tags: string[];
      domains: string[];
    }>(fullCypher, params);

    const bubbles: KnowledgeBubbleSummary[] = rows.map((r) => ({
      id: r.id,
      title: r.title,
      contentPreview: r.contentPreview ?? '',
      filePath: r.filePath,
      source: r.source,
      sourceFile: r.sourceFile ?? null,
      sourceUrl: r.sourceUrl ?? null,
      tags: r.tags.filter(Boolean),
      domains: r.domains.filter(Boolean),
      permanence: (r.permanence ?? 'normal') as Permanence,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));

    const lastBubble = bubbles[bubbles.length - 1];
    const firstBubble = bubbles[0];

    function getCursor(bubble: KnowledgeBubbleSummary | undefined): string | null {
      if (!bubble) return null;
      return dimension === 'recency' ? bubble.updatedAt : bubble.createdAt;
    }

    // Count total for this dimension (uses dimension-specific query)
    const countRow = await neo4j.queryOne<{ total: number }>(countCypher, params);

    return {
      bubbles,
      nextCursor: getCursor(lastBubble),
      prevCursor: getCursor(firstBubble),
      dimension,
      total: countRow?.total ?? 0,
    };
  }

  // --- Source enrichment ---
  async function enrichWithSource(bubbleId: string): Promise<string | undefined> {
    const bubble = await knowledgeStore.getById(bubbleId);
    if (!bubble?.sourceFile) return undefined;
    const mediaDir = resolve(knowledgeDir, '..', 'media');
    const mediaPath = join(mediaDir, bubble.sourceFile);
    try {
      return await extractFromFile(mediaPath);
    } catch {
      return undefined;
    }
  }

  // --- Index status ---
  async function getIndexStatus(): Promise<IndexStatus> {
    const row = await neo4j.queryOne<{
      totalBubbles: number;
      indexedBubbles: number;
      totalChunks: number;
    }>(
      `MATCH (b:Bubble)
       OPTIONAL MATCH (b)-[:HAS_CHUNK]->(c:Chunk)
       WITH count(DISTINCT b) AS totalBubbles,
            count(DISTINCT CASE WHEN c IS NOT NULL THEN b END) AS indexedBubbles,
            count(c) AS totalChunks
       RETURN totalBubbles, indexedBubbles, totalChunks`,
    );

    // Get the most recently updated bubble that has chunks as a proxy for last indexing time
    const lastRow = await neo4j.queryOne<{ lastIndexed: string }>(
      `MATCH (b:Bubble)-[:HAS_CHUNK]->(:Chunk)
       RETURN b.updatedAt AS lastIndexed ORDER BY b.updatedAt DESC LIMIT 1`,
    );

    return {
      totalBubbles: row?.totalBubbles ?? 0,
      indexedBubbles: row?.indexedBubbles ?? 0,
      totalChunks: row?.totalChunks ?? 0,
      lastIndexed: lastRow?.lastIndexed ?? null,
    };
  }

  // --- Source enrichment for search results ---
  async function applySourceEnrichment(result: RetrievalResult): Promise<RetrievalResult> {
    const enriched = await Promise.all(
      result.results.map(async (item) => {
        if (!item.sourceFile) return item;
        const content = await enrichWithSource(item.bubbleId);
        return content ? { ...item, sourceContent: content } : item;
      }),
    );
    return { ...result, results: enriched };
  }

  // --- Bump lastAccessedAt for all bubbles in search results ---
  async function bumpAccessTimestamps(bubbleIds: string[]): Promise<void> {
    if (bubbleIds.length === 0) return;
    const now = new Date().toISOString();
    await neo4j.run(`UNWIND $ids AS bid MATCH (b:Bubble {id: bid}) SET b.lastAccessedAt = $now`, {
      ids: bubbleIds,
      now,
    });
  }

  // --- Main search entry point (with semaphore) ---
  async function search(query: string, options?: RetrievalOptions): Promise<RetrievalResult> {
    return semaphore.acquire(async () => {
      const queryType = options?.type ?? classifyQuery(query);
      const opts = options ?? {};

      let result: RetrievalResult;
      switch (queryType) {
        case 'precise':
          result = await retrievePrecise(query, opts);
          break;
        case 'timeline': {
          const timeline = await retrieveTimeline({
            dimension: 'date',
            direction: 'backward',
            limit: opts.limit,
          });
          result = {
            results: timeline.bubbles.map((b, i) => ({
              bubbleId: b.id,
              title: b.title,
              contentPreview: b.contentPreview,
              score: 1.0 - i * SCORE_DECREMENT,
              provenance: { tier: 1, tierName: 'timeline', rawScore: 1.0, permanenceWeight: 1.0 },
              tags: b.tags,
              domains: b.domains,
              permanence: b.permanence,
              sourceFile: b.sourceFile ?? undefined,
            })),
            query,
            queryType: 'timeline',
            totalCandidates: timeline.total,
            tokenBudgetUsed: 0,
            tokenBudgetTotal: opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
          };
          break;
        }
        default:
          result = await retrieveGeneric(query, opts);
          break;
      }

      if (opts.includeSourceContent) {
        result = await applySourceEnrichment(result);
      }

      // Bump lastAccessedAt for all returned bubbles (access tracking for stale detection)
      bumpAccessTimestamps(result.results.map((r) => r.bubbleId)).catch(() => {
        // Non-critical — don't fail the search if access tracking fails
      });

      return result;
    });
  }

  return { search, retrieveTimeline, getIndexStatus, enrichWithSource };
}

// --- Token budget assembly ---
interface AssembleOpts {
  items: RetrievalResultItem[];
  query: string;
  queryType: QueryType;
  tokenBudget: number;
}

function assembleResult(opts: AssembleOpts): RetrievalResult {
  const { items, query, queryType, tokenBudget } = opts;
  const sorted = items.sort((a, b) => b.score - a.score);
  const totalCandidates = sorted.length;
  const results: RetrievalResultItem[] = [];
  let budgetUsed = 0;

  for (const item of sorted) {
    const tokens = estimateTokens(item.contentPreview + (item.chunkText ?? ''));
    if (budgetUsed + tokens > tokenBudget && results.length > 0) break;
    budgetUsed += tokens;
    results.push(item);
  }

  return {
    results,
    query,
    queryType,
    totalCandidates,
    tokenBudgetUsed: budgetUsed,
    tokenBudgetTotal: tokenBudget,
  };
}
