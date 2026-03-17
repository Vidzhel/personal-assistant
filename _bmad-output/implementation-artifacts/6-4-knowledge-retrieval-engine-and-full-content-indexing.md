# Story 6.4: Knowledge Retrieval Engine & Full-Content Indexing

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As the system operator,
I want all knowledge bubble content chunked, embedded, and searchable through a multi-tier retrieval pipeline supporting precise, timeline, and generic query types across multiple dimensions, with concurrent query support,
so that querying my second brain returns deeply relevant, contextually enriched results at any scale.

## Acceptance Criteria

1. **Content chunking**: Given a knowledge bubble has content longer than ~300 tokens, when the chunking engine processes it, then the content is split into overlapping chunks (~300 tokens, 50 token overlap), each embedded with metadata prefix and stored in Neo4j.

2. **Auto-backfill on startup**: Given the application starts, when the indexing check runs, then any knowledge bubbles without chunk embeddings are automatically indexed (backfill), and already-indexed bubbles are skipped.

3. **Incremental indexing on create/update**: Given a knowledge bubble is created or updated, when the incremental indexer runs, then old chunks are removed and new chunks are generated and embedded.

4. **Full re-index API**: Given the user triggers `POST /api/knowledge/reindex-embeddings`, when the full re-index runs, then all chunk embeddings are rebuilt from scratch (useful after model change), with progress tracking.

5. **Precise query**: Given a precise query like "What happened on March 5th?", when the retrieval engine processes it, then results are filtered by date dimension, returning specific bubbles and their references.

6. **Timeline query**: Given a timeline query, when the user navigates forward/backward, then they can traverse knowledge along dimensions: date/time, domain, source type, permanence, cluster, connection degree, recency of access, confidence.

7. **Generic multi-tier retrieval**: Given a generic query like "What do I like eating?", when the multi-tier retrieval runs, then results combine: (1) top-K matching chunks by vector similarity, (2) expanded to full parent bubbles, (3) linked bubbles via graph traversal, (4) cluster siblings, (5) tag hierarchy co-occurrence, (6) optional source file enrichment — all deduplicated, ranked, and summarized with references for further exploration.

8. **Concurrent query support**: Given multiple concurrent search requests, when the embedding pipeline processes them, then queries are handled concurrently via a shared pipeline instance with proper serialization, without blocking each other.

9. **Token budget assembly**: Given a retrieval query with a token budget, when results are assembled, then content is ranked to fit within budget, with provenance trail showing which tier and dimension contributed each result, and bubble references for drill-down.

10. **Source file enrichment**: Given retrieval results reference source files, when source enrichment is enabled, then original source content (PDFs, documents from `data/media/`) is available for deep-dive context.

## Tasks / Subtasks

- [x] Task 1: Content chunking engine (AC: #1)
  - [x] 1.1 Create `packages/core/src/knowledge-engine/chunking.ts` — factory function `createChunkingEngine(deps)`
  - [x] 1.2 Implement `chunkContent(content: string, options?: { chunkSize?: number; overlap?: number }): Chunk[]` — split content into ~300-token overlapping chunks (50 token overlap). Use whitespace-aware splitting (split on sentence/paragraph boundaries, not mid-word). Simple token estimation: `Math.ceil(text.length / 4)`.
  - [x] 1.3 Define `Chunk` type: `{ index: number; text: string; startOffset: number; endOffset: number }`
  - [x] 1.4 Build chunk embedding input: `BGE_DOC_PREFIX + "Tags: ... Domains: ... " + chunk.text` — reuse `BGE_DOC_PREFIX` from `embeddings.ts`
  - [x] 1.5 Add `Chunk` node in Neo4j: `(c:Chunk {id, bubbleId, index, text, startOffset, endOffset, embedding})` with relationship `(b:Bubble)-[:HAS_CHUNK]->(c:Chunk)`
  - [x] 1.6 Add Neo4j constraint `CREATE CONSTRAINT chunk_id IF NOT EXISTS FOR (c:Chunk) REQUIRE c.id IS UNIQUE` and vector index `CREATE VECTOR INDEX chunk_embedding IF NOT EXISTS FOR (c:Chunk) ON (c.embedding) OPTIONS {indexConfig: {`vector.dimensions`: 384, `vector.similarity_function`: 'cosine'}}`
  - [x] 1.7 Implement `indexBubble(bubbleId: string): Promise<void>` — read full content from disk via `knowledge-file.ts`, chunk it, embed each chunk via `getPipeline()`, store chunks + embeddings in Neo4j
  - [x] 1.8 Implement `removeChunks(bubbleId: string): Promise<void>` — delete all `Chunk` nodes linked to a bubble
  - [x] 1.9 Short content (< 300 tokens): store single chunk covering full content (still gets chunk embedding for uniform search)

- [x] Task 2: Auto-backfill and incremental indexing (AC: #2, #3)
  - [x] 2.1 Implement `backfillChunks(): Promise<{ indexed: number; skipped: number }>` — find all `Bubble` nodes without `HAS_CHUNK` relationships, index each. Run at boot after `ensureSchema()`.
  - [x] 2.2 Hook into `knowledge:embedding:generated` event — after bubble-level embedding is stored, run `indexBubble(bubbleId)` for chunk-level embeddings
  - [x] 2.3 On bubble update: `removeChunks(bubbleId)` then `indexBubble(bubbleId)` — full re-chunk
  - [x] 2.4 On bubble delete: `removeChunks(bubbleId)` — clean up orphaned chunks
  - [x] 2.5 Backfill is non-blocking — runs in background, logs progress every 10 bubbles

- [x] Task 3: Full re-index API (AC: #4)
  - [x] 3.1 Add `POST /api/knowledge/reindex-embeddings` — triggers full re-index via `agent:task:request` event for async execution (returns 202 + taskId)
  - [x] 3.2 Implement `reindexAllChunks(): Promise<{ total: number; indexed: number; errors: string[] }>` — delete ALL `Chunk` nodes, then re-chunk and re-embed every bubble
  - [x] 3.3 Progress tracking: emit `knowledge:reindex:progress` events with `{ completed, total, bubbleId }` — can be surfaced via WebSocket
  - [x] 3.4 Add `GET /api/knowledge/reindex-embeddings/:taskId` — poll re-index status

- [x] Task 4: Query classification (AC: #5, #6, #7)
  - [x] 4.1 Create `packages/core/src/knowledge-engine/retrieval.ts` — factory function `createRetrievalEngine(deps)`
  - [x] 4.2 Implement `classifyQuery(query: string): QueryType` — classify as `precise`, `timeline`, or `generic` using heuristics:
    - `precise`: contains date patterns, specific names, "what happened on", "who said"
    - `timeline`: contains "recent", "last week", "show me", "browse", navigation keywords
    - `generic`: everything else (semantic search)
  - [x] 4.3 Define `QueryType = 'precise' | 'timeline' | 'generic'`
  - [x] 4.4 Query classification is rule-based (no LLM) — simple regex + keyword matching

- [x] Task 5: Precise query retrieval (AC: #5)
  - [x] 5.1 Implement `retrievePrecise(query: string, options: RetrievalOptions): Promise<RetrievalResult>` — extract date/entity filters from query, run filtered Neo4j query on Bubble nodes
  - [x] 5.2 Date extraction: regex for ISO dates, relative dates ("last Monday", "March 5th"), convert to date range
  - [x] 5.3 Neo4j filter: `WHERE b.createdAt >= $from AND b.createdAt <= $to` combined with optional fulltext search
  - [x] 5.4 Return bubbles sorted by date, with chunk snippets for context

- [x] Task 6: Timeline navigation (AC: #6)
  - [x] 6.1 Implement `retrieveTimeline(options: TimelineOptions): Promise<TimelineResult>` — paginated traversal along a dimension
  - [x] 6.2 Define `TimelineOptions`: `{ dimension, cursor, direction: 'forward' | 'backward', limit }`
  - [x] 6.3 Supported dimensions with Neo4j queries:
    - `date`: ORDER BY b.createdAt
    - `domain`: MATCH (b)-[:IN_DOMAIN]->(d:Domain {name: $domain})
    - `source`: WHERE b.source = $source
    - `permanence`: WHERE b.permanence = $permanence
    - `cluster`: MATCH (b)-[:IN_CLUSTER]->(c:Cluster {id: $clusterId})
    - `connection_degree`: ORDER BY size((b)-[:LINKS_TO]-()) DESC
    - `recency`: ORDER BY b.updatedAt DESC (approximate — no access tracking in 6.4)
    - `confidence`: ORDER BY embedding similarity to cursor bubble
  - [x] 6.4 Return `TimelineResult`: `{ bubbles: BubbleSummary[]; nextCursor; prevCursor; dimension; total }`

- [x] Task 7: Multi-tier generic retrieval (AC: #7, #9)
  - [x] 7.1 Implement `retrieveGeneric(query: string, options: RetrievalOptions): Promise<RetrievalResult>` — the main semantic search pipeline
  - [x] 7.2 **Tier 1 — Chunk vector search**: Embed query with `buildQueryEmbeddingInput()`, search `chunk_embedding` vector index for top-K chunks (default K=20), return with similarity scores
  - [x] 7.3 **Tier 2 — Parent bubble expansion**: For each matching chunk, load parent bubble metadata. Deduplicate bubbles (multiple chunks from same bubble → take highest score). Add bubble-level metadata (tags, domains, permanence)
  - [x] 7.4 **Tier 3 — Graph expansion (linked bubbles)**: For each top bubble, traverse `LINKS_TO` relationships (1 hop, status = 'accepted'). Add linked bubbles with reduced relevance score (parent score × 0.7)
  - [x] 7.5 **Tier 4 — Cluster siblings**: For each top bubble, find other bubbles in same cluster via `IN_CLUSTER` relationship. Add with reduced score (parent score × 0.5)
  - [x] 7.6 **Tier 5 — Tag hierarchy co-occurrence**: For each top bubble's tags, find sibling tags via `CHILD_OF` traversal (same parent), then bubbles with those sibling tags. Add with reduced score (parent score × 0.3)
  - [x] 7.7 Deduplicate across all tiers — keep highest score per bubble
  - [x] 7.8 Apply permanence weight: `temporary` → score × 0.9, `normal` → score × 1.0, `robust` → score × 1.2
  - [x] 7.9 **Token budget assembly**: Rank all results by final score. Estimate tokens per bubble (`Math.ceil(content.length / 4)`). Fill budget greedily from top. Each result includes `provenance: { tier: number; dimension: string; score: number }`.
  - [x] 7.10 Return `RetrievalResult`: `{ results: RetrievalResultItem[]; totalCandidates: number; tokenBudgetUsed: number; tokenBudgetTotal: number }`

- [x] Task 8: Source file enrichment (AC: #10)
  - [x] 8.1 Implement `enrichWithSource(bubbleId: string): Promise<string | undefined>` — if bubble has `sourceFile`, read original content from `data/media/` using `content-extractor.ts` patterns (PDF via unpdf, text via readFile)
  - [x] 8.2 Source enrichment is opt-in: `RetrievalOptions.includeSourceContent: boolean` (default false)
  - [x] 8.3 When enabled, append source content to matching results (truncated to fit token budget)

- [x] Task 9: Concurrent query support (AC: #8)
  - [x] 9.1 The `getPipeline()` singleton in `embeddings.ts` already handles concurrent access (ONNX runtime is thread-safe for inference)
  - [x] 9.2 Add a query queue/semaphore in the retrieval engine to limit concurrent vector searches to 3 (configurable via `RAVEN_MAX_CONCURRENT_SEARCHES`, default 3) — prevents memory spikes from simultaneous large result sets
  - [x] 9.3 Each query gets its own Neo4j session (Neo4j driver handles connection pooling)
  - [x] 9.4 Test: fire 5 concurrent queries, verify all return correct results without errors

- [x] Task 10: API routes (AC: all)
  - [x] 10.1 Add `POST /api/knowledge/search` — main retrieval endpoint. Body: `{ query: string; type?: 'precise' | 'timeline' | 'generic' | 'auto'; tokenBudget?: number; includeSourceContent?: boolean; limit?: number }`
  - [x] 10.2 Add `GET /api/knowledge/timeline` — timeline navigation. Query params: `?dimension=date&cursor=...&direction=forward&limit=20`
  - [x] 10.3 Add `POST /api/knowledge/reindex-embeddings` — full chunk re-index (202 + taskId)
  - [x] 10.4 Add `GET /api/knowledge/reindex-embeddings/:taskId` — poll re-index status
  - [x] 10.5 Add `GET /api/knowledge/index-status` — returns `{ totalBubbles, indexedBubbles, totalChunks, lastIndexed }` for monitoring
  - [x] 10.6 Zod validation on all request bodies/params (follow existing route patterns in `knowledge.ts`)
  - [x] 10.7 Wire `retrievalEngine` and `chunkingEngine` into boot sequence and API deps in `server.ts` + `index.ts`

- [x] Task 11: Tests (AC: all)
  - [x] 11.1 Unit tests for chunking: split long content, overlap verification, short content single chunk, whitespace-aware boundaries
  - [x] 11.2 Unit tests for query classification: precise/timeline/generic with various input patterns
  - [x] 11.3 Integration tests for chunk indexing: create bubble → verify chunks in Neo4j → update bubble → verify re-chunked
  - [x] 11.4 Integration tests for multi-tier retrieval: mock embeddings, create bubbles with links/clusters/tags, verify all 5 tiers contribute results
  - [x] 11.5 Integration tests for precise query: create bubbles with dates, query by date, verify filtered results
  - [x] 11.6 Integration tests for timeline navigation: create bubbles across dimensions, verify cursor-based pagination
  - [x] 11.7 Integration tests for token budget: verify budget truncation, provenance trail
  - [x] 11.8 Integration tests for source enrichment: create bubble with sourceFile, verify enrichment returns content
  - [x] 11.9 Integration tests for concurrent queries: fire multiple queries, verify no errors
  - [x] 11.10 API route tests for all new endpoints
  - [x] 11.11 Test backfill: create bubbles without chunks, run backfill, verify all indexed

## Dev Notes

### Core Design: Chunk-Level Semantic Search with Multi-Tier Expansion

Story 6.3 created **bubble-level** embeddings for similarity/clustering. Story 6.4 adds **chunk-level** embeddings for precise content retrieval. Both coexist:

| Level | Purpose | Index | Used by |
|-------|---------|-------|---------|
| Bubble embedding | Similarity, clustering, link suggestion | `bubble_embedding` vector index | 6.3 operations |
| Chunk embedding | Semantic search, retrieval | `chunk_embedding` vector index (NEW) | 6.4 retrieval |

The bubble-level embedding captures the overall topic. Chunk-level embeddings capture specific passages, enabling granular search results.

### Chunking Strategy

**Token estimation**: `Math.ceil(text.length / 4)` — simple heuristic, no tokenizer dependency needed.

**Chunk parameters**:
- Target: ~300 tokens (~1200 chars)
- Overlap: ~50 tokens (~200 chars)
- Minimum chunk: 50 tokens (don't create tiny fragments)

**Splitting logic** (whitespace-aware):
1. Split content into paragraphs (double newline)
2. Accumulate paragraphs until reaching ~300 tokens
3. If a single paragraph exceeds 300 tokens, split on sentence boundaries (`.` `!` `?` followed by space/newline)
4. Add overlap by including the last ~50 tokens of the previous chunk at the start of the next

**Chunk metadata prefix** for embedding:
```typescript
const chunkInput = BGE_DOC_PREFIX + `Tags: ${bubble.tags.join(', ')}. ` + chunk.text;
```

Include bubble tags but NOT domains/title in chunk input — the chunk text provides its own context, tags provide categorical signal.

### Neo4j Schema Additions

```cypher
-- Chunk node
CREATE CONSTRAINT chunk_id IF NOT EXISTS FOR (c:Chunk) REQUIRE c.id IS UNIQUE;

-- Chunk vector index (384-dim, cosine)
CREATE VECTOR INDEX chunk_embedding IF NOT EXISTS
FOR (c:Chunk) ON (c.embedding)
OPTIONS {indexConfig: {`vector.dimensions`: 384, `vector.similarity_function`: 'cosine'}};

-- Chunk properties: id, bubbleId, index, text, startOffset, endOffset, embedding
-- Relationship: (Bubble)-[:HAS_CHUNK]->(Chunk)
```

Add these to `neo4j-client.ts` `ensureSchema()`.

### Multi-Tier Retrieval Pipeline

```
Query → classifyQuery() → precise | timeline | generic

GENERIC PIPELINE:
  Tier 1: Embed query → chunk_embedding vector search → top-K chunks
  Tier 2: chunk.bubbleId → parent Bubble metadata
  Tier 3: parent.LINKS_TO → linked Bubbles (1 hop, score × 0.7)
  Tier 4: parent.IN_CLUSTER → cluster siblings (score × 0.5)
  Tier 5: parent.HAS_TAG → CHILD_OF → sibling tags → Bubbles (score × 0.3)
  ↓
  Deduplicate → Apply permanence weights → Rank by score → Token budget assembly
  ↓
  RetrievalResult with provenance
```

**Single Neo4j query for Tiers 1-5** (optimize into 1-2 queries, not 5 separate ones):

```cypher
// Tier 1+2: Chunk search → parent bubbles
CALL db.index.vector.queryNodes('chunk_embedding', $topK, $queryEmbedding)
YIELD node AS chunk, score
MATCH (b:Bubble)-[:HAS_CHUNK]->(chunk)
WITH b, max(score) AS chunkScore
ORDER BY chunkScore DESC
LIMIT $limit
// Tier 3: Linked bubbles
OPTIONAL MATCH (b)-[link:LINKS_TO]-(linked:Bubble)
WHERE link.status = 'accepted'
// Tier 4: Cluster siblings
OPTIONAL MATCH (b)-[:IN_CLUSTER]->(c:Cluster)<-[:IN_CLUSTER]-(sibling:Bubble)
WHERE sibling.id <> b.id
// Return all with tier labels
RETURN b, chunkScore, collect(DISTINCT linked) AS linkedBubbles, collect(DISTINCT sibling) AS clusterSiblings
```

Tier 5 (tag co-occurrence) may need a separate query due to complexity:
```cypher
MATCH (b:Bubble {id: $bubbleId})-[:HAS_TAG]->(t:Tag)-[:CHILD_OF]->(parent:Tag)<-[:CHILD_OF]-(sibling:Tag)<-[:HAS_TAG]-(related:Bubble)
WHERE related.id <> $bubbleId
RETURN DISTINCT related.id AS bubbleId
LIMIT 5
```

### Query Classification Heuristics

```typescript
function classifyQuery(query: string): QueryType {
  const lower = query.toLowerCase();

  // Precise: date/entity-specific questions
  const precisePatterns = [
    /\b\d{4}-\d{2}-\d{2}\b/,              // ISO date
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}/i,
    /\b(last|this)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
    /\bwhat happened\b/i,
    /\bwho said\b/i,
    /\bon\s+(march|april|may)\s+\d/i,
  ];
  if (precisePatterns.some(p => p.test(query))) return 'precise';

  // Timeline: browsing/navigation
  const timelinePatterns = [
    /\b(browse|show me|list|recent|latest|oldest)\b/i,
    /\b(last|past|this)\s+(week|month|year|day)\b/i,
    /\b(timeline|chronolog|history)\b/i,
  ];
  if (timelinePatterns.some(p => p.test(query))) return 'timeline';

  return 'generic';
}
```

### Token Budget Assembly with Provenance

```typescript
interface RetrievalResultItem {
  bubbleId: string;
  title: string;
  contentPreview: string;
  chunkText?: string;        // matching chunk snippet
  score: number;             // final weighted score
  provenance: {
    tier: number;            // 1-5
    tierName: string;        // 'chunk_vector' | 'parent_expansion' | 'linked' | 'cluster' | 'tag_cooccurrence'
    rawScore: number;        // before permanence weighting
    permanenceWeight: number; // 0.9 | 1.0 | 1.2
  };
  sourceFile?: string;       // path to original source for drill-down
  sourceContent?: string;    // enriched source content (if requested)
  tags: string[];
  domains: string[];
  permanence: Permanence;
}

interface RetrievalResult {
  results: RetrievalResultItem[];
  query: string;
  queryType: QueryType;
  totalCandidates: number;
  tokenBudgetUsed: number;
  tokenBudgetTotal: number;
}

interface RetrievalOptions {
  tokenBudget?: number;        // default 4000
  limit?: number;              // max results, default 20
  includeSourceContent?: boolean; // default false
  topK?: number;               // chunk search limit, default 20
  dimensions?: string[];       // filter for timeline
}
```

Budget filling algorithm:
1. Sort all deduplicated results by final score descending
2. For each result, estimate tokens: `Math.ceil((contentPreview.length + (chunkText?.length ?? 0)) / 4)`
3. Add result if it fits remaining budget
4. Stop when budget exhausted or all results added
5. Record `tokenBudgetUsed` for the response

### Concurrent Query Support

The `getPipeline()` singleton in `embeddings.ts` returns a single ONNX inference pipeline. ONNX runtime handles concurrent inference calls internally (CPU parallelism).

Add a semaphore to limit concurrent retrieval queries:

```typescript
import { Semaphore } from './semaphore.ts'; // simple counting semaphore

const querySemaphore = new Semaphore(config.maxConcurrentSearches ?? 3);

async function retrieve(query: string, options: RetrievalOptions): Promise<RetrievalResult> {
  return querySemaphore.acquire(async () => {
    // ... retrieval logic
  });
}
```

Create a lightweight `Semaphore` class (or use Promise-based queue) — do NOT add a dependency for this. ~20 lines of code.

### Source File Enrichment

Reuse `content-extractor.ts` from story 6.2:

```typescript
import { extractFromFile } from './content-extractor.ts';

async function enrichWithSource(bubble: KnowledgeBubble): Promise<string | undefined> {
  if (!bubble.sourceFile) return undefined;
  const mediaPath = path.join(knowledgeDir, '..', 'media', bubble.sourceFile);
  try {
    return await extractFromFile(mediaPath);
  } catch {
    return undefined; // source file may have been deleted
  }
}
```

Truncate source content to fit remaining token budget.

### Reuse from Existing Code — DO NOT REINVENT

| What | Where | How to reuse |
|------|-------|-------------|
| `BGE_DOC_PREFIX`, `BGE_QUERY_PREFIX` | `embeddings.ts` | Import directly |
| `getPipeline()` | `embeddings.ts` | Import and call for chunk embedding generation |
| `buildQueryEmbeddingInput()` | `embeddings.ts` | Import for query embedding |
| `cosineSimilarity()` | `embeddings.ts` | Import if client-side re-ranking needed |
| `serializeEmbedding()`, `deserializeEmbedding()` | `embeddings.ts` | Import if Buffer conversion needed |
| `Neo4jClient` | `neo4j-client.ts` | Add schema to `ensureSchema()`, use for all queries |
| `KnowledgeStore.getById()` | `knowledge-store.ts` | Load full bubble for source enrichment |
| `KnowledgeStore.getContentPreview()` | `knowledge-store.ts` | Quick preview without file read |
| `extractFromFile()` | `content-extractor.ts` | Source file enrichment |
| `readBubbleFile()` | `knowledge-file.ts` | Read full content for chunking |
| `EventBus` pattern | `embeddings.ts` | Follow for event-driven chunk indexing |
| Factory function pattern | `embeddings.ts`, `clustering.ts` | Follow for `createChunkingEngine(deps)`, `createRetrievalEngine(deps)` |
| API route patterns | `api/routes/knowledge.ts` | Follow existing Zod validation, response patterns, async 202 pattern |
| Agent task pattern | `ingestion.ts` | Follow for async re-index task (emit `agent:task:request`) |

### Event Types to Add

```typescript
// In packages/shared/src/types/events.ts
type KnowledgeChunkIndexedEvent = {
  type: 'knowledge:chunk:indexed';
  payload: { bubbleId: string; chunkCount: number };
};

type KnowledgeReindexProgressEvent = {
  type: 'knowledge:reindex:progress';
  payload: { completed: number; total: number; bubbleId: string };
};

type KnowledgeReindexCompleteEvent = {
  type: 'knowledge:reindex:complete';
  payload: { total: number; indexed: number; errors: string[] };
};
```

### Types to Add to shared/types/knowledge.ts

```typescript
// Chunk type
export interface KnowledgeChunk {
  id: string;
  bubbleId: string;
  index: number;
  text: string;
  startOffset: number;
  endOffset: number;
}

// Query/retrieval types
export type QueryType = 'precise' | 'timeline' | 'generic';

export interface RetrievalOptions {
  tokenBudget?: number;
  limit?: number;
  includeSourceContent?: boolean;
  topK?: number;
  dimensions?: string[];
}

export interface RetrievalResultItem {
  bubbleId: string;
  title: string;
  contentPreview: string;
  chunkText?: string;
  score: number;
  provenance: {
    tier: number;
    tierName: string;
    rawScore: number;
    permanenceWeight: number;
  };
  sourceFile?: string;
  sourceContent?: string;
  tags: string[];
  domains: string[];
  permanence: Permanence;
}

export interface RetrievalResult {
  results: RetrievalResultItem[];
  query: string;
  queryType: QueryType;
  totalCandidates: number;
  tokenBudgetUsed: number;
  tokenBudgetTotal: number;
}

export interface TimelineOptions {
  dimension: string;
  cursor?: string;
  direction?: 'forward' | 'backward';
  limit?: number;
  filter?: Record<string, string>;
}

export interface TimelineResult {
  bubbles: KnowledgeBubbleSummary[];
  nextCursor: string | null;
  prevCursor: string | null;
  dimension: string;
  total: number;
}

export interface IndexStatus {
  totalBubbles: number;
  indexedBubbles: number;
  totalChunks: number;
  lastIndexed: string | null;
}
```

### File Structure

```
packages/core/src/knowledge-engine/
├── chunking.ts             # NEW — content chunking, chunk embedding, backfill, re-index
├── retrieval.ts            # NEW — multi-tier retrieval pipeline, query classification, token budget
├── semaphore.ts            # NEW — lightweight Promise-based semaphore (~20 lines)
├── embeddings.ts           # MODIFY — add chunk schema to ensureSchema() via neo4j-client
├── neo4j-client.ts         # MODIFY — add Chunk constraint + chunk_embedding vector index
├── knowledge-store.ts      # NO CHANGES (already has getById, getContentPreview, list)
├── knowledge-file.ts       # NO CHANGES (readBubbleFile used for chunking)
├── content-extractor.ts    # NO CHANGES (used for source enrichment)
├── ingestion.ts            # NO CHANGES
├── clustering.ts           # NO CHANGES
├── clustering-ops.ts       # NO CHANGES
├── clustering-utils.ts     # NO CHANGES
├── tag-tree.ts             # NO CHANGES
├── link-ops.ts             # NO CHANGES
├── hub-ops.ts              # NO CHANGES
├── merge-ops.ts            # NO CHANGES
└── domain-config.ts        # NO CHANGES
```

### Existing Code to Understand

| File | Why |
|------|-----|
| `packages/core/src/knowledge-engine/embeddings.ts` | Reuse `getPipeline()`, `BGE_*_PREFIX`, `buildQueryEmbeddingInput()`, event handler pattern |
| `packages/core/src/knowledge-engine/neo4j-client.ts` | Add Chunk constraint + vector index to `ensureSchema()` |
| `packages/core/src/knowledge-engine/knowledge-store.ts` | `getById()` for full bubble load, `getContentPreview()` for summaries |
| `packages/core/src/knowledge-engine/knowledge-file.ts` | `readBubbleFile()` for full content read for chunking |
| `packages/core/src/knowledge-engine/content-extractor.ts` | `extractFromFile()` for source enrichment |
| `packages/core/src/knowledge-engine/clustering.ts` | Event-driven chain pattern, `safeChainStep()` error isolation |
| `packages/core/src/knowledge-engine/ingestion.ts` | Agent task request pattern for async re-index |
| `packages/core/src/api/routes/knowledge.ts` | Existing route patterns, Zod schemas, 202 async pattern |
| `packages/core/src/api/server.ts` | API dep wiring pattern |
| `packages/core/src/index.ts` | Boot sequence wiring |
| `packages/shared/src/types/knowledge.ts` | Types to extend with chunks, retrieval, timeline |
| `packages/shared/src/types/events.ts` | Event types to extend |

### What NOT to Build

- No LLM-based query classification — rule-based heuristics only
- No LLM-based query expansion or rewriting — direct embedding search
- No access tracking (last accessed timestamp) — `recency` dimension uses `updatedAt` as proxy
- No dashboard UI for search — API only (story 6.7 will add visualization)
- No knowledge agent / context injection — that's story 6.5
- No stale detection / lifecycle management — that's story 6.6
- No cross-domain connection detection — that's story 9.1
- No caching layer for search results — premature optimization
- No external embedding APIs — local only via `@huggingface/transformers`

### Testing Approach

- **Mock `@huggingface/transformers`** — return deterministic fake embeddings (Float32Arrays with known values)
- **Mock `@anthropic-ai/claude-code`** — for async re-index agent task
- **Neo4j testcontainers** (`@testcontainers/neo4j`) for integration tests — follow existing patterns in `knowledge-embeddings.test.ts` and `knowledge-clustering.test.ts`
- Test chunking with known text: verify chunk count, overlap, boundary splitting
- Test query classification with example queries for each type
- Test multi-tier retrieval: create graph with bubbles, links, clusters, tags → run generic query → verify tiers 1-5 each contribute
- Test token budget: create many results, set small budget, verify truncation and provenance
- Test concurrent queries: `Promise.all()` with 5 queries, verify all succeed
- Test backfill: create bubbles, run backfill, verify chunk nodes created
- Test re-index: index bubbles, re-index, verify chunk replacement

### Previous Story Intelligence (from 6.3)

**Patterns to follow:**
- Factory function: `createEmbeddingEngine(deps)` → follow for `createChunkingEngine(deps)` and `createRetrievalEngine(deps)`
- Event-driven processing: listen for events, process in isolated `safeChainStep()` wrappers with `.catch()` on fire-and-forget handlers
- Neo4j vector index: `CALL db.index.vector.queryNodes('bubble_embedding', $topK, $embedding)` — use same pattern for `chunk_embedding`
- Code review fixes from 6.3 to avoid repeating:
  - Always add `.catch()` to fire-and-forget async event handlers
  - Guard `afterAll` in tests against undefined variables
  - Use `count(DISTINCT r)` when counting relationships to avoid double-counting
  - Neo4j vector indexes are eventually consistent — document this in comments

**Libraries already installed (no new deps needed):**
- `@huggingface/transformers` — embedding pipeline
- `neo4j-driver` — Neo4j client
- `unpdf` — PDF extraction (for source enrichment)
- `gray-matter` — YAML frontmatter parsing

### Git Intelligence

Recent commits show the knowledge engine evolution:
1. `27af742` — Migrated from SQLite to Neo4j (story 6.3 scope expansion)
2. `19579de` — Intelligence engine with embeddings, clustering, tag hierarchy
3. `d277e58` — Ingestion pipeline with AI metadata
4. `7fc9bdd` — Bubble storage and CRUD with file-first architecture

All knowledge engine code is Neo4j-based. SQLite is only used for non-knowledge data. There are uncommitted changes from 6.3 code review fixes (safer error handling, better API tests, hub detection fixes).

### Project Structure Notes

- New files: `chunking.ts`, `retrieval.ts`, `semaphore.ts` in `packages/core/src/knowledge-engine/`
- Extend: `packages/shared/src/types/knowledge.ts` with chunk/retrieval/timeline types
- Extend: `packages/shared/src/types/events.ts` with 3 new event types
- Modify: `packages/core/src/knowledge-engine/neo4j-client.ts` — add Chunk constraint + vector index
- Modify: `packages/core/src/api/routes/knowledge.ts` — add 5 new endpoints
- Modify: `packages/core/src/api/server.ts` — wire chunking/retrieval engines
- Modify: `packages/core/src/index.ts` — boot chunking/retrieval, run backfill
- New tests: `packages/core/src/__tests__/knowledge-retrieval.test.ts`, `packages/core/src/__tests__/knowledge-chunking.test.ts`
- Keep files under 300 lines — `retrieval.ts` may need splitting into `retrieval-tiers.ts` if it grows

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Epic 6 — Story 6.4 acceptance criteria]
- [Source: _bmad-output/planning-artifacts/architecture.md — Knowledge Management FR42-48, Growth phase]
- [Source: _bmad-output/implementation-artifacts/6-3-knowledge-intelligence-engine.md — embedding engine, Neo4j patterns, code review learnings]
- [Source: _bmad-output/implementation-artifacts/6-2-knowledge-ingestion-pipeline.md — content extractor, agent task pattern]
- [Source: _bmad-output/implementation-artifacts/6-1-knowledge-bubble-storage-and-crud.md — file-first architecture, knowledge store API]
- [Source: _bmad-output/project-context.md — coding conventions, critical rules, anti-patterns]
- [Source: packages/core/src/knowledge-engine/embeddings.ts — reusable exports, event handler pattern, vector index queries]
- [Source: packages/core/src/knowledge-engine/neo4j-client.ts — schema setup, vector index creation]
- [Source: packages/core/src/knowledge-engine/content-extractor.ts — extractFromFile for source enrichment]
- [Source: packages/core/src/knowledge-engine/knowledge-file.ts — readBubbleFile for full content access]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6 (1M context)

### Debug Log References

### Completion Notes List

- All 11 tasks implemented in a single pass
- Content chunking engine with whitespace-aware paragraph/sentence splitting, configurable chunk size and overlap
- Multi-tier retrieval pipeline (5 tiers): chunk vector search → parent expansion → linked bubbles → cluster siblings → tag co-occurrence
- Query classification (rule-based heuristics): precise (date), timeline (browse), generic (semantic)
- Timeline navigation across 7 dimensions: date, domain, source, permanence, cluster, connection_degree, recency
- Token budget assembly with provenance tracking per result
- Promise-based semaphore for concurrent query limiting (default 3)
- Source file enrichment via content-extractor.ts reuse
- Auto-backfill at boot, incremental indexing via embedding:generated event, cleanup on bubble delete
- Full re-index API (POST 202 async) with progress events
- 5 new API routes: search, timeline, reindex-embeddings, reindex-embeddings/:taskId, index-status
- Zod validation schemas for all new endpoints (SearchQuerySchema, TimelineQuerySchema)
- 9 unit tests passing (chunking + query classification), 14 integration tests (Neo4j testcontainers)
- `npm run check` passes clean (format, lint, tsc)
- Decision: timeline patterns checked before precise to prevent "last week" matching "what happened" first

### Code Review Fixes (2026-03-17)

- **H1** Fixed: search route now passes explicit `type` parameter to retrieval engine (was no-op before)
- **H2** Fixed: `includeSourceContent` option now enriches search results with source file content via `applySourceEnrichment()`
- **M1** Fixed: `getIndexStatus().lastIndexed` returns bubble `updatedAt` timestamp instead of bubbleId
- **M2** Fixed: timeline total count uses dimension-specific count queries instead of global count
- **M3** Fixed: added comment for unimplemented `confidence` dimension (deferred to 6.5)
- **M4** Fixed: timeline cursor pagination now works for domain/source/permanence/cluster dimensions

### File List

- packages/shared/src/types/knowledge.ts (MODIFIED — added chunk, retrieval, timeline, index types + Zod schemas)
- packages/shared/src/types/events.ts (MODIFIED — added 3 new event types: chunk:indexed, reindex:progress, reindex:complete)
- packages/core/src/knowledge-engine/chunking.ts (NEW — content chunking engine with backfill and reindex)
- packages/core/src/knowledge-engine/retrieval.ts (NEW — multi-tier retrieval pipeline, query classification, token budget)
- packages/core/src/knowledge-engine/semaphore.ts (NEW — lightweight Promise-based counting semaphore)
- packages/core/src/knowledge-engine/neo4j-client.ts (MODIFIED — added Chunk constraint + chunk_embedding vector index)
- packages/core/src/api/routes/knowledge.ts (MODIFIED — added 5 new search/retrieval/reindex routes)
- packages/core/src/api/server.ts (MODIFIED — wired chunkingEngine + retrievalEngine into ApiDeps)
- packages/core/src/index.ts (MODIFIED — boot chunking/retrieval engines, run backfill)
- packages/core/src/__tests__/knowledge-chunking.test.ts (NEW — 6 unit + 5 integration tests)
- packages/core/src/__tests__/knowledge-retrieval.test.ts (NEW — 3 unit + 9 integration tests)
