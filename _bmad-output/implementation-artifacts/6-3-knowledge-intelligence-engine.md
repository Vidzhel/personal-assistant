# Story 6.3: Knowledge Intelligence Engine

Status: review

## Story

As the system operator,
I want knowledge bubbles to have local embeddings, hierarchical tags, knowledge domains, inter-bubble links with clear distinction from tags, permanence levels, hub bubble splitting, and embedding-based similarity operations,
so that my knowledge base self-organizes at scale with proper structure, hierarchy, and knowledge quality signals.

## Acceptance Criteria

1. **Embedding generation**: Given a new knowledge bubble is created or updated, when the embedding pipeline runs, then a local vector embedding (384 dims) is generated via `@huggingface/transformers` (bge-small-en-v1.5) and stored in the database.

2. **Knowledge domains**: Given knowledge domains are configured (e.g., "health", "finances", "work") with classification rules in `config/knowledge-domains.json`, when a new bubble is ingested, then it is automatically assigned to matching domain(s) — a bubble can belong to multiple domains.

3. **Hierarchical tag tree**: Given tags are organized in a hierarchy (domain → category → specific), when a new tag is created during ingestion or suggestion, then it is placed in the correct position in the tag tree with parent-child relationships maintained.

4. **Tag tree rebalancing**: Given a tag subtree has many sparse tags (few bubbles each, weak content connections), when rebalancing runs, then sparse tags are merged or restructured based on content similarity of their bubbles.

5. **Inter-bubble linking (distinct from tags)**: Given two related knowledge bubbles exist, when embedding similarity exceeds threshold (default 0.7), then a bidirectional link suggestion is created with relationship type and confidence. Links are for specific semantic relationships between exactly two bubbles; tags are for reusable categorical metadata.

6. **Hub bubble splitting**: Given a knowledge bubble has 10+ direct links, when hub detection runs, then linked bubbles are clustered into groups, a synthesis bubble is created for each group, and synthesis bubbles are linked back to the hub — creating navigable hierarchy.

7. **Permanence levels**: Given a new bubble is created, when permanence classification runs, then the bubble is assigned a permanence level (`temporary`, `normal`, `robust`) defaulting to `normal`, adjustable by user via API.

8. **Embedding-based clustering**: Given 2+ knowledge bubbles have high embedding similarity, when clustering runs (triggered via API), then they are grouped into a cluster — embeddings for grouping, LLM only for label generation.

9. **Merge detection**: Given two bubbles have cosine similarity > 0.9, when merge detection runs, then they are flagged for user review — never auto-merged.

10. **Auto-tag suggestions**: Given a new knowledge bubble is created, when auto-tagging runs, then relevant tags are suggested from the hierarchical tag tree based on embedding similarity to existing bubbles — no LLM needed.

11. **Tag index API**: Given the user queries `GET /api/knowledge/tags`, then it shows all tags with bubble counts sorted by frequency. *(Already implemented in 6.1 — verify and extend with hierarchy.)*

## Tasks / Subtasks

- [x] Task 1: Embedding infrastructure (AC: #1)
  - [x]1.1 Add `@huggingface/transformers` dependency to `packages/core/package.json`
  - [x]1.2 Create `packages/core/src/knowledge-engine/embeddings.ts` — factory function `createEmbeddingEngine(deps)`
  - [x]1.3 Implement `generateEmbedding(text: string): Promise<Float32Array>` — uses `pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5')` with pooling: 'mean', normalize: true
  - [x]1.4 Implement `cosineSimilarity(a: Float32Array, b: Float32Array): number`
  - [x]1.5 Implement `findSimilar(targetEmbedding, options: { limit, threshold }): SimilarBubble[]` — brute-force scan of all stored embeddings
  - [x]1.6 Lazy pipeline initialization — model loads on first call, not at boot (~45MB model download first run)
  - [x]1.7 Create `migrations/007-knowledge-intelligence.sql` — all new tables (see schema below)
  - [x]1.8 Hook into `knowledge:bubble:created` and `knowledge:bubble:updated` events — auto-generate and store embedding
  - [x]1.9 Export `BGE_DOC_PREFIX`, `BGE_QUERY_PREFIX`, `getPipeline()`, `cosineSimilarity()`, `serializeEmbedding()`, `deserializeEmbedding()` for story 6.4 reuse

- [x] Task 2: Hierarchical tag system (AC: #3, #4, #11)
  - [x]2.1 Add `knowledge_tag_tree` table to migration 007 — `tag TEXT PK, parent_tag TEXT, level INTEGER DEFAULT 0, domain TEXT` (level 0 = domain tags)
  - [x]2.2 Add `TagTreeNode` type and Zod schema to `packages/shared/src/types/knowledge.ts`
  - [x]2.3 Implement `getTagTree(): TagTreeNode[]` — returns full hierarchy as nested structure
  - [x]2.4 Implement `placeTagInTree(tag, bubble)` — when a tag is created, find best parent by checking existing tag hierarchy + content similarity of bubbles using that tag
  - [x]2.5 Implement `rebalanceTagTree()` — detect sparse subtrees (tags with < 2 bubbles, no siblings with shared content), merge or restructure based on embedding similarity
  - [x]2.6 Extend `GET /api/knowledge/tags` to return hierarchy (add `?tree=true` query param for nested structure, default flat for backward compat)
  - [x]2.7 Auto-place tags on bubble creation (after embedding generated)
  - [x]2.8 Add `POST /api/knowledge/tags/rebalance` — trigger rebalancing

- [x] Task 3: Knowledge domains — multi-domain assignment (AC: #2)
  - [x]3.1 Create `config/knowledge-domains.json` — array of `{ name, description, rules: { tags: string[], keywords: string[] } }`
  - [x]3.2 Add `KnowledgeDomain` type and `KnowledgeDomainConfig` Zod schema
  - [x]3.3 Add `knowledge_bubble_domains` junction table to migration 007 — `bubble_id TEXT, domain TEXT, PRIMARY KEY(bubble_id, domain)` (replaces single domain column — supports multi-domain)
  - [x]3.4 Implement `classifyDomains(bubble): string[]` — match by tag overlap first, then keyword presence; return all matching domains
  - [x]3.5 Auto-assign domains on bubble creation/update
  - [x]3.6 Add `?domain=` filter to `GET /api/knowledge` list endpoint
  - [x]3.7 Add `GET /api/knowledge/domains` — list configured domains with bubble counts
  - [x]3.8 Update `KnowledgeBubble` and `KnowledgeBubbleSummary` types with `domains: string[]`
  - [x]3.9 Domain tags are automatically level-0 entries in the tag tree

- [x] Task 4: Inter-bubble linking with link vs tag distinction (AC: #5)
  - [x]4.1 Add `knowledge_links` table to migration 007 — `id, source_bubble_id, target_bubble_id, relationship_type, confidence, auto_suggested, status, created_at`
  - [x]4.2 `relationship_type` values: `related` (general), `extends` (builds on), `contradicts` (conflicts with), `supports` (evidence for), `derived-from` (synthesized from)
  - [x]4.3 Add `KnowledgeLink` type and Zod schemas to shared types
  - [x]4.4 Implement `suggestLinks(bubbleId): KnowledgeLink[]` — find top-K similar by embedding, create link suggestions above threshold
  - [x]4.5 **Link vs Tag rule:** If only 2 bubbles would share a very specific concept → suggest a link. If 3+ bubbles share it → suggest a tag. Implement this heuristic in the suggestion logic.
  - [x]4.6 Auto-suggest links on bubble creation (after embedding generated)
  - [x]4.7 Add `GET /api/knowledge/:id/links` — get all links for a bubble (both directions)
  - [x]4.8 Add `POST /api/knowledge/links` — manually create a link
  - [x]4.9 Add `POST /api/knowledge/links/:id/resolve` — accept or dismiss a suggested link
  - [x]4.10 Emit `knowledge:links:suggested` event

- [x] Task 5: Hub bubble splitting (AC: #6)
  - [x]5.1 Implement `detectHubs(): { bubbleId, linkCount }[]` — find bubbles with 10+ direct links
  - [x]5.2 Implement `splitHub(hubBubbleId)` — load all linked bubbles, cluster them by embedding similarity into groups, for each group: create a synthesis bubble (LLM-generated summary + title), link synthesis to hub, link original members to synthesis
  - [x]5.3 Synthesis bubbles get special `source: 'synthesis'` type, permanence: `robust`, tags inherited from group members
  - [x]5.4 Add `POST /api/knowledge/detect-hubs` — list hub bubbles
  - [x]5.5 Add `POST /api/knowledge/:id/split-hub` — trigger splitting for a specific hub (async, 202)
  - [x]5.6 Hub splitting is manual-trigger only — never auto-executed (user should review)

- [x] Task 6: Permanence levels (AC: #7)
  - [x]6.1 Add `permanence` column to `knowledge_index` in migration 007 — `TEXT NOT NULL DEFAULT 'normal'` — values: `temporary`, `normal`, `robust`
  - [x]6.2 Add `Permanence` type to shared types, add to `KnowledgeBubble`/`KnowledgeBubbleSummary`
  - [x]6.3 Add `PATCH /api/knowledge/:id/permanence` — update permanence level
  - [x]6.4 Add `?permanence=` filter to `GET /api/knowledge` list endpoint
  - [x]6.5 Update `CreateKnowledgeBubbleSchema` to accept optional `permanence` field (default `normal`)
  - [x]6.6 Ingestion defaults to `normal`; source-based hints: voice-memo → `temporary`, manual → `normal`

- [x] Task 7: Embedding-based clustering and merge detection (AC: #8, #9)
  - [x]7.1 Create `packages/core/src/knowledge-engine/clustering.ts` — factory function `createClusteringEngine(deps)`
  - [x]7.2 Implement `runClustering()` — load all embeddings, agglomerative clustering (cosine threshold 0.6), group into clusters
  - [x]7.3 For each new/changed cluster, call LLM (via agent:task:request) for human-readable label — LLM is ONLY used here and in hub splitting
  - [x]7.4 Add `knowledge_clusters` and `knowledge_cluster_members` tables to migration 007
  - [x]7.5 Implement cluster CRUD: `getClusters()`, `getClusterMembers(clusterId)`, `deleteCluster()`
  - [x]7.6 Clustering is idempotent — re-running replaces previous assignments
  - [x]7.7 Implement `detectMerges()` — find bubble pairs with cosine similarity > 0.9, store in `knowledge_merge_suggestions`
  - [x]7.8 Add merge suggestion CRUD: `getMergeSuggestions(status?)`, `resolveMerge(id, resolution)`

- [x] Task 8: Auto-tag suggestions via embeddings (AC: #10)
  - [x]8.1 Implement `suggestTags(bubbleId): { tag: string, confidence: number, parentTag: string | null }[]` — find K nearest neighbors, collect their tags, rank by frequency weighted by similarity, include hierarchy position
  - [x]8.2 Hook into `knowledge:embedding:generated` → run suggestTags → emit `knowledge:tags:suggested`
  - [x]8.3 Tag suggestions include position in hierarchy — "this should be under health > nutrition"
  - [x]8.4 Tag suggestions delivered via event only — not auto-applied

- [x] Task 9: API routes and boot integration (AC: all)
  - [x]9.1 Add `POST /api/knowledge/cluster` — trigger clustering (202 + taskId)
  - [x]9.2 Add `GET /api/knowledge/clusters` — list clusters with member counts
  - [x]9.3 Add `GET /api/knowledge/clusters/:id` — cluster detail with member bubbles
  - [x]9.4 Add `POST /api/knowledge/detect-merges` — trigger merge detection (sync)
  - [x]9.5 Add `GET /api/knowledge/merges` — list pending merge suggestions
  - [x]9.6 Add `POST /api/knowledge/merges/:id/resolve` — accept or dismiss
  - [x]9.7 Wire embeddingEngine and clusteringEngine into boot sequence and API deps
  - [x]9.8 Embedding engine init: lazy (model loads on first embedding call, not boot)

- [x] Task 10: Tests (AC: all)
  - [x]10.1 Unit tests for embedding engine — cosine similarity, findSimilar, generateEmbedding (mock pipeline)
  - [x]10.2 Unit tests for hierarchical tag tree — placeTagInTree, rebalancing, tree structure
  - [x]10.3 Unit tests for multi-domain classification — tag match, keyword match, multi-domain assignment
  - [x]10.4 Unit tests for link vs tag heuristic — 2 bubbles → link, 3+ → tag
  - [x]10.5 Integration tests for hub detection and splitting (create hub with 10+ links, verify split)
  - [x]10.6 Integration tests for permanence levels (create with different levels, filter, update)
  - [x]10.7 Integration tests for clustering (mock embeddings, verify grouping)
  - [x]10.8 Integration tests for merge detection (similar embeddings → suggestion)
  - [x]10.9 Integration tests for auto-tag suggestions with hierarchy awareness
  - [x]10.10 API route tests for all new endpoints
  - [x]10.11 Test full event chain: bubble created → embedding → domains → links → tags → hub check

## Dev Notes

### Core Design: Embeddings Replace LLM for Similarity

LLM is used for exactly TWO things: (1) cluster label generation, (2) hub synthesis bubble content. Everything else is embedding-based or rule-based.

| Operation | Approach |
|-----------|----------|
| Clustering | Agglomerative on embedding vectors |
| Merge detection | Cosine similarity > 0.9 threshold |
| Tag suggestions | K-nearest neighbors' tag frequency |
| Link suggestions | Cosine similarity > 0.7 threshold |
| Domain assignment | Rule-based: tag overlap + keyword match |
| Hub splitting grouping | Embedding clustering of linked bubbles |
| Hub synthesis content | LLM generates summary |
| Cluster labels | LLM generates label |
| Tag hierarchy placement | Content similarity of tag's bubbles |
| Tag rebalancing | Embedding similarity of sparse tag members |

### Embedding Engine Design

**Library:** `@huggingface/transformers` v3.x (ESM, runs in Node.js via ONNX runtime)
**Model:** `Xenova/bge-small-en-v1.5` — 384-dim, instruction-tuned, 512 token context
**Why bge-small:** Instruction-tuned (doc/query prefixes for asymmetric retrieval), 512 tokens (2x MiniLM), metadata-aware. Forward-compatible with chunk-level search in story 6.4.

```typescript
// Instruction-tuned prefixes for asymmetric retrieval
const BGE_DOC_PREFIX = 'Represent this document for retrieval: ';
const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

function buildBubbleEmbeddingInput(bubble: KnowledgeBubbleSummary): string {
  const parts = [];
  if (bubble.tags.length > 0) parts.push(`Tags: ${bubble.tags.join(', ')}.`);
  if (bubble.domains.length > 0) parts.push(`Domains: ${bubble.domains.join(', ')}.`);
  parts.push(bubble.title);
  if (bubble.contentPreview) parts.push(bubble.contentPreview);
  return BGE_DOC_PREFIX + parts.join(' ');
}

function buildQueryEmbeddingInput(query: string): string {
  return BGE_QUERY_PREFIX + query;
}
```

**Lazy initialization** — ~45MB model download first run, ~2s load. Cache pipeline instance. Do NOT load at boot.

```typescript
import type { FeatureExtractionPipeline } from '@huggingface/transformers';

let pipelineInstance: FeatureExtractionPipeline | null = null;

async function getPipeline(): Promise<FeatureExtractionPipeline> {
  if (!pipelineInstance) {
    const { pipeline } = await import('@huggingface/transformers');
    pipelineInstance = await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5', {
      dtype: 'fp32',
    });
  }
  return pipelineInstance;
}
```

**Storage:** 384 float32 = 1,536 bytes per bubble. 10K bubbles = ~15MB. Brute-force is fine.

**Exports for story 6.4:** `BGE_DOC_PREFIX`, `BGE_QUERY_PREFIX`, `getPipeline()`, `cosineSimilarity()`, `serializeEmbedding()`, `deserializeEmbedding()`

```typescript
function serializeEmbedding(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

function deserializeEmbedding(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

### Hierarchical Tag Tree Design

```
health (domain - level 0)
├── nutrition (level 1)
│   ├── supplements (level 2)
│   ├── diet-plans (level 2)
│   └── macros (level 2)
├── fitness (level 1)
│   ├── cardio (level 2)
│   └── strength (level 2)
└── mental-health (level 1)
    ├── meditation (level 2)
    └── therapy (level 2)

finances (domain - level 0)
├── investing (level 1)
│   ├── crypto (level 2)
│   └── stocks (level 2)
└── budgeting (level 1)
```

**Placement logic** (no LLM needed):
1. New tag arrives with a bubble → check if tag already exists in tree → reuse
2. If new tag: find existing tags whose bubbles have highest embedding similarity to this bubble's embedding
3. Place new tag as sibling of most similar tag (same parent)
4. If no similar tags found → place under the matching domain (level 0) as level 1
5. If no domain match → place as orphan (parent: null) — will be organized on next rebalance

**Rebalancing logic:**
1. Find subtrees where leaf tags have < 2 bubbles each and siblings have low content similarity
2. Option A: merge sparse siblings into their parent tag (delete children, retag bubbles)
3. Option B: restructure — compute embedding centroids per tag, re-cluster, create new hierarchy
4. Rebalancing is manual trigger only (`POST /api/knowledge/tags/rebalance`)

### Links vs Tags — Clear Distinction

| Aspect | Tags | Links |
|--------|------|-------|
| **Purpose** | Categorical metadata | Specific relationship between two bubbles |
| **Cardinality** | Many bubbles per tag | Exactly two bubbles per link |
| **Creation** | On ingestion, tag suggestion | On similarity detection, manual creation |
| **Hierarchy** | Yes (parent-child tree) | No (flat graph) |
| **Types** | N/A | `related`, `extends`, `contradicts`, `supports`, `derived-from` |
| **Deletion** | Remove from tag tree + bubbles | Remove single link |
| **Use case** | "What's this about?" | "How do these specific bubbles relate?" |

**Heuristic for auto-suggestion:** When embedding similarity suggests a connection between bubbles:
- If only 2 bubbles share a very specific concept → suggest a **link**
- If 3+ bubbles share it → suggest a **tag** (and place in hierarchy)

### Hub Bubble Splitting

When a bubble becomes a hub (10+ direct links), it indicates the bubble is a broad topic that should be decomposed:

```
BEFORE:                          AFTER:

    B1  B2  B3                      [Synthesis A]──B1
     \  |  /                            /           B2
      \ | /                            /            B3
  B4───HUB───B5          HUB──────────
      / | \                            \
     /  |  \                            [Synthesis B]──B4
    B6  B7  B8                                         B5

                                       [Synthesis C]──B6
                                                       B7
                                                       B8
```

1. Get all linked bubbles for the hub
2. Cluster linked bubbles by embedding similarity (agglomerative, threshold 0.5)
3. For each group of 2+ bubbles:
   - Use LLM to generate a synthesis title and summary based on the group's content
   - Create synthesis bubble with `source: 'synthesis'`, `permanence: 'robust'`
   - Inherit tags from group members (union of all tags)
   - Link synthesis bubble to hub (type: `derived-from`)
   - Link original group members to synthesis (type: `related`)
4. Remove old direct links from hub to individual members
5. The hub now links to a manageable number of synthesis bubbles instead of 10+ individuals

### Permanence Levels

| Level | Default for | Retrieval boost | Stale detection | Retrospective behavior |
|-------|-------------|-----------------|-----------------|----------------------|
| `temporary` | voice-memos | -0.1 penalty | After 7 days | Always surfaced for review |
| `normal` | manual, file, URL | No modifier | After 30 days | Surfaced if unreferenced |
| `robust` | synthesis bubbles | +0.2 boost | Never flagged | Never flagged |

- Default: `normal`
- Source-based hints on ingestion: voice-memo → `temporary`, synthesis → `robust`
- User can override via `PATCH /api/knowledge/:id/permanence`
- Retrieval scoring in story 6.4 will use permanence as a weight factor

### Knowledge Domains Configuration

```json
// config/knowledge-domains.json
[
  {
    "name": "health",
    "description": "Physical health, mental health, fitness, nutrition, medical",
    "rules": {
      "tags": ["health", "fitness", "nutrition", "medical", "exercise", "mental-health", "sleep", "diet"],
      "keywords": ["doctor", "workout", "calories", "medication", "therapy", "symptom"]
    }
  },
  {
    "name": "finances",
    "description": "Money, investments, budgeting, banking, taxes",
    "rules": {
      "tags": ["finance", "money", "investment", "budget", "tax", "banking", "crypto", "savings"],
      "keywords": ["account", "payment", "portfolio", "expense", "income", "interest"]
    }
  },
  {
    "name": "work",
    "description": "Professional projects, career, colleagues, meetings",
    "rules": {
      "tags": ["work", "project", "career", "meeting", "team", "deadline", "client"],
      "keywords": ["sprint", "standup", "deploy", "review", "stakeholder", "milestone"]
    }
  }
]
```

**Multi-domain assignment:** A bubble about "workplace ergonomics" could match both `health` (keyword: therapy/symptom) and `work` (tag: work). Both domains are assigned. Domain tags are automatically level-0 entries in the tag tree.

### Database Schema (migration 007)

```sql
-- migrations/007-knowledge-intelligence.sql

-- Embeddings
CREATE TABLE knowledge_embeddings (
  bubble_id TEXT PRIMARY KEY,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL DEFAULT 'bge-small-en-v1.5',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Permanence + domain support on knowledge_index
ALTER TABLE knowledge_index ADD COLUMN permanence TEXT NOT NULL DEFAULT 'normal';
CREATE INDEX idx_knowledge_permanence ON knowledge_index(permanence);

-- Multi-domain assignment (junction table, replaces single domain column)
CREATE TABLE knowledge_bubble_domains (
  bubble_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  PRIMARY KEY (bubble_id, domain)
);
CREATE INDEX idx_bubble_domains_domain ON knowledge_bubble_domains(domain);

-- Hierarchical tag tree
CREATE TABLE knowledge_tag_tree (
  tag TEXT PRIMARY KEY,
  parent_tag TEXT,
  level INTEGER NOT NULL DEFAULT 0,
  domain TEXT
);
CREATE INDEX idx_tag_tree_parent ON knowledge_tag_tree(parent_tag);
CREATE INDEX idx_tag_tree_domain ON knowledge_tag_tree(domain);

-- Inter-bubble links
CREATE TABLE knowledge_links (
  id TEXT PRIMARY KEY,
  source_bubble_id TEXT NOT NULL,
  target_bubble_id TEXT NOT NULL,
  relationship_type TEXT NOT NULL DEFAULT 'related',
  confidence REAL,
  auto_suggested INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'accepted',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_bubble_id, target_bubble_id)
);
CREATE INDEX idx_knowledge_links_source ON knowledge_links(source_bubble_id);
CREATE INDEX idx_knowledge_links_target ON knowledge_links(target_bubble_id);
CREATE INDEX idx_knowledge_links_status ON knowledge_links(status);

-- Clusters
CREATE TABLE knowledge_clusters (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE knowledge_cluster_members (
  cluster_id TEXT NOT NULL REFERENCES knowledge_clusters(id) ON DELETE CASCADE,
  bubble_id TEXT NOT NULL,
  PRIMARY KEY (cluster_id, bubble_id)
);
CREATE INDEX idx_cluster_members_bubble ON knowledge_cluster_members(bubble_id);

-- Merge suggestions
CREATE TABLE knowledge_merge_suggestions (
  id TEXT PRIMARY KEY,
  bubble_id_1 TEXT NOT NULL,
  bubble_id_2 TEXT NOT NULL,
  overlap_reason TEXT,
  confidence REAL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX idx_merge_suggestions_status ON knowledge_merge_suggestions(status);
```

### Event Types to Add

```typescript
// In packages/shared/src/types/events.ts
type KnowledgeTagsSuggestedEvent = {
  type: 'knowledge:tags:suggested';
  payload: { bubbleId: string; suggestedTags: Array<{ tag: string; confidence: number; parentTag: string | null }>; };
};

type KnowledgeLinksSuggestedEvent = {
  type: 'knowledge:links:suggested';
  payload: { bubbleId: string; links: Array<{ targetBubbleId: string; confidence: number; relationshipType: string }>; };
};

type KnowledgeClusteringCompleteEvent = {
  type: 'knowledge:clustering:complete';
  payload: { clusterCount: number; clusteredBubbles: number; taskId: string };
};

type KnowledgeMergeDetectedEvent = {
  type: 'knowledge:merge:detected';
  payload: { mergeCount: number };
};

type KnowledgeEmbeddingGeneratedEvent = {
  type: 'knowledge:embedding:generated';
  payload: { bubbleId: string };
};

type KnowledgeHubDetectedEvent = {
  type: 'knowledge:hub:detected';
  payload: { bubbleId: string; linkCount: number };
};
```

### Event-Driven Processing Chain on Bubble Creation

```
knowledge:bubble:created
  → generateEmbedding(bubble) → store in knowledge_embeddings
  → emit knowledge:embedding:generated

knowledge:embedding:generated
  → classifyDomains(bubble) → insert into knowledge_bubble_domains
  → placeTagsInTree(bubble.tags) → update knowledge_tag_tree
  → suggestLinks(bubble) → insert knowledge_links (status: 'suggested')
  → suggestTags(bubble) → emit knowledge:tags:suggested
  → emit knowledge:links:suggested (if any)
  → checkHubStatus(bubble) → emit knowledge:hub:detected if 10+ links
```

This chain is async and non-blocking. Bubble creation API returns immediately.

### File Structure

```
packages/core/src/knowledge-engine/
├── knowledge-store.ts        # MODIFY — add permanence, domain filters, link queries
├── knowledge-file.ts         # MODIFY — add permanence to frontmatter
├── content-extractor.ts      # NO CHANGES
├── ingestion.ts              # MODIFY — set permanence based on source type
├── embeddings.ts             # NEW — embedding generation, similarity, tag tree, domain classification
└── clustering.ts             # NEW — clustering, merge detection, hub splitting
```

### Existing Code to Understand

| File | Why |
|------|-----|
| `packages/core/src/knowledge-engine/knowledge-store.ts` | CRUD, `getAllTags()`, `list()` — extend with permanence, domains, links |
| `packages/core/src/knowledge-engine/ingestion.ts` | Agent task pattern for LLM calls. JSON parser to reuse. |
| `packages/shared/src/types/knowledge.ts` | Types to extend with domains[], permanence, links, tag hierarchy, clusters |
| `packages/shared/src/types/events.ts` | Event conventions — add 6 new event types |
| `packages/core/src/api/routes/knowledge.ts` | Existing routes — add many new endpoints |
| `packages/core/src/api/server.ts` | API dep wiring |
| `packages/core/src/index.ts` | Boot sequence |
| `packages/core/src/config.ts` | Config loading pattern for knowledge-domains.json |

### AC #11 — Tag Index Needs Extension

`GET /api/knowledge/tags` exists from story 6.1 returning flat `{ tag, count }[]`. Extend it:
- Default: backward-compatible flat list sorted by count
- `?tree=true`: return hierarchical structure with parent-child relationships
- `?domain=health`: filter tags to a specific domain subtree

### What NOT to Build

- No dashboard UI — API only (visualization is story 6.7)
- No auto-merge — only flag for user review
- No scheduled clustering/rebalancing — manual trigger via API only
- No chunk-level embeddings — bubble-level only (chunking is story 6.4)
- No multi-tier retrieval — that's story 6.4
- No retrospective/stale detection — that's story 6.6
- No concurrent query support — that's story 6.4
- No external embedding APIs — local only

### Testing Approach

- **Mock `@huggingface/transformers`** — return deterministic fake embeddings (known Float32Arrays)
- **Mock `@anthropic-ai/claude-code`** — for cluster labels and hub synthesis
- Temp SQLite DBs with migration runner
- Test cosine similarity with known vectors
- Test tag tree: insertion, hierarchy, rebalancing with sparse subtrees
- Test multi-domain classification
- Test link vs tag heuristic (2 bubbles → link, 3+ → tag)
- Test hub detection (create 10+ links, verify detection)
- Test hub splitting (verify synthesis bubble creation, link restructuring)
- Test permanence levels (creation, filtering, source-based defaults)
- Test full event chain: bubble → embedding → domains → tag tree → links → tags suggested → hub check

### Previous Story Intelligence (from 6.2)

- Factory function pattern: `createIngestionProcessor(deps)` — follow for `createEmbeddingEngine(deps)` and `createClusteringEngine(deps)`
- Agent task request/response pattern in `ingestion.ts` — reuse for cluster labeling and hub synthesis only
- JSON parser handles clean/fenced/mixed formats — extract or import
- `knowledge-store.ts` is ~474 lines — keep new code in `embeddings.ts` and `clustering.ts`
- Event-driven architecture established — follow patterns for new events

### Project Structure Notes

- New: `packages/core/src/knowledge-engine/embeddings.ts`
- New: `packages/core/src/knowledge-engine/clustering.ts`
- Extend: `packages/shared/src/types/knowledge.ts`
- Extend: `packages/shared/src/types/events.ts`
- New migration: `migrations/007-knowledge-intelligence.sql`
- New config: `config/knowledge-domains.json`
- New tests: `packages/core/src/__tests__/knowledge-embeddings.test.ts`, `packages/core/src/__tests__/knowledge-clustering.test.ts`
- Route additions in existing `packages/core/src/api/routes/knowledge.ts`

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Epic 6 — Story 6.3 acceptance criteria]
- [Source: _bmad-output/planning-artifacts/architecture.md — Knowledge Management FR42-48, Growth phase]
- [Source: _bmad-output/implementation-artifacts/6-2-knowledge-ingestion-pipeline.md — agent task pattern, JSON parser, event patterns]
- [Source: _bmad-output/implementation-artifacts/6-1-knowledge-bubble-storage-and-crud.md — knowledge store, file-first architecture, tag index]
- [Source: _bmad-output/project-context.md — coding conventions and critical rules]
- [Source: packages/core/src/knowledge-engine/knowledge-store.ts — CRUD, getAllTags(), ~474 lines]
- [Source: packages/core/src/knowledge-engine/ingestion.ts — agent task pattern, JSON parser]
- [Source: packages/shared/src/types/knowledge.ts — KnowledgeBubble, KnowledgeBubbleSummary types]
- [Source: packages/shared/src/types/events.ts — event conventions, RavenEvent union]
- [Source: huggingface.co/docs/transformers.js/v3 — @huggingface/transformers v3.8.1, ESM, ONNX runtime]
- [Source: huggingface.co/Xenova/bge-small-en-v1.5 — 384-dim, 512 token max, instruction-tuned for retrieval]

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)

### Debug Log References
- Fixed tag placement logic: domain-rule check must precede embedding similarity check (orphan fallback was too early)
- Fixed Zod 4 `.default()` creating required output type — changed to `.optional()` for backward compat
- Fixed `@huggingface/transformers` pipeline type — used generic `PipelineFunction` type to avoid import() annotation lint error

### Completion Notes List
- ✅ Task 1: Embedding infrastructure — `@huggingface/transformers` with bge-small-en-v1.5, lazy pipeline init, cosine similarity, serialize/deserialize, event-driven embedding on bubble created/updated
- ✅ Task 2: Hierarchical tag tree — `knowledge_tag_tree` table, auto-placement under domain parents, rebalancing of sparse leaf tags
- ✅ Task 3: Knowledge domains — `config/knowledge-domains.json`, multi-domain assignment via junction table, tag/keyword rule matching
- ✅ Task 4: Inter-bubble linking — `knowledge_links` table, auto-suggest above 0.7 threshold, manual creation, accept/dismiss resolution
- ✅ Task 5: Hub bubble splitting — detect hubs with 10+ links, cluster linked bubbles, create synthesis links, LLM synthesis via agent task
- ✅ Task 6: Permanence levels — `permanence` column on knowledge_index, defaults to `normal`, source-based hints (voice-memo → temporary), PATCH API
- ✅ Task 7: Clustering and merge detection — agglomerative clustering, idempotent re-runs, merge suggestions for cosine > 0.9
- ✅ Task 8: Auto-tag suggestions — K-nearest neighbor tag frequency, excludes existing tags, emits knowledge:tags:suggested event
- ✅ Task 9: API routes and boot integration — 15+ new endpoints wired, embedding/clustering engines in boot sequence, lazy model init
- ✅ Task 10: Tests — 46 new tests across 2 test files covering all ACs: embeddings, cosine similarity, serialization, domain classification, tag tree, linking, permanence, clustering, merge detection, auto-tag suggestions, hub detection, event chain integration

### Change Log
- 2026-03-17: Implemented all 10 tasks for story 6.3 Knowledge Intelligence Engine

### File List
- `migrations/007-knowledge-intelligence.sql` — NEW: all new tables (embeddings, domains, tag tree, links, clusters, merges)
- `config/knowledge-domains.json` — NEW: domain classification rules
- `packages/shared/src/types/knowledge.ts` — MODIFIED: added Permanence, TagTreeNode, KnowledgeLink, KnowledgeDomain, KnowledgeCluster, KnowledgeMergeSuggestion types + Zod schemas; updated KnowledgeBubble/Summary with domains/permanence
- `packages/shared/src/types/events.ts` — MODIFIED: added 6 new event types (embedding:generated, tags:suggested, links:suggested, clustering:complete, merge:detected, hub:detected)
- `packages/core/src/knowledge-engine/embeddings.ts` — NEW: embedding generation, cosine similarity, findSimilar, event-driven auto-embedding
- `packages/core/src/knowledge-engine/clustering.ts` — NEW: domain classification, tag tree, inter-bubble linking, hub detection/splitting, agglomerative clustering, merge detection, auto-tag suggestions
- `packages/core/src/knowledge-engine/domain-config.ts` — NEW: knowledge domain config loader with Zod validation
- `packages/core/src/knowledge-engine/knowledge-store.ts` — MODIFIED: added permanence/domains fields, domain/permanence list filters
- `packages/core/src/knowledge-engine/ingestion.ts` — MODIFIED: source-based permanence defaults (voice-memo → temporary)
- `packages/core/src/api/routes/knowledge.ts` — MODIFIED: 15+ new endpoints for tags, domains, links, clusters, merges, hubs, permanence
- `packages/core/src/api/server.ts` — MODIFIED: wired embedding/clustering engines + DB interface to API deps
- `packages/core/src/index.ts` — MODIFIED: boot sequence for embedding engine, clustering engine, domain config
- `packages/core/package.json` — MODIFIED: added `@huggingface/transformers` dependency
- `packages/core/src/__tests__/knowledge-embeddings.test.ts` — NEW: 14 tests for embedding engine
- `packages/core/src/__tests__/knowledge-clustering.test.ts` — NEW: 32 tests for clustering engine
