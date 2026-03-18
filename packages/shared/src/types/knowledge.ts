import { z } from 'zod';

const MAX_TITLE_LENGTH = 500;
const MAX_SOURCE_LENGTH = 100;
const MAX_TAG_LENGTH = 100;
const MAX_TAGS_COUNT = 50;
const MAX_QUERY_LIMIT = 200;
const DEFAULT_QUERY_LIMIT = 50;
const MAX_SOURCE_FILE_LENGTH = 500;

/** Full knowledge bubble — includes content read from markdown file */
export interface KnowledgeBubble {
  id: string;
  title: string;
  content: string;
  filePath: string;
  source: string | null;
  sourceFile: string | null;
  sourceUrl: string | null;
  tags: string[];
  domains: string[];
  permanence: Permanence;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string | null;
}

/** List response — content omitted, replaced with preview */
export interface KnowledgeBubbleSummary {
  id: string;
  title: string;
  contentPreview: string;
  filePath: string;
  source: string | null;
  sourceFile: string | null;
  sourceUrl: string | null;
  tags: string[];
  domains: string[];
  permanence: Permanence;
  createdAt: string;
  updatedAt: string;
}

export type Permanence = 'temporary' | 'normal' | 'robust';

export const PermanenceSchema = z.enum(['temporary', 'normal', 'robust']);

export interface TagTreeNode {
  tag: string;
  parentTag: string | null;
  level: number;
  domain: string | null;
  children: TagTreeNode[];
  bubbleCount?: number;
}

export const TagTreeNodeSchema = z.object({
  tag: z.string(),
  parentTag: z.string().nullable(),
  level: z.number(),
  domain: z.string().nullable(),
});

export interface KnowledgeLink {
  id: string;
  sourceBubbleId: string;
  targetBubbleId: string;
  relationshipType: string;
  confidence: number | null;
  autoSuggested: boolean;
  status: string;
  createdAt: string;
}

export const KnowledgeLinkSchema = z.object({
  sourceBubbleId: z.string(),
  targetBubbleId: z.string(),
  relationshipType: z
    .enum(['related', 'extends', 'contradicts', 'supports', 'derived-from'])
    .default('related'),
  confidence: z.number().min(0).max(1).nullable().optional(),
});

export const ResolveLinkSchema = z.object({
  action: z.enum(['accept', 'dismiss']),
});

export interface KnowledgeDomain {
  name: string;
  description: string;
  rules: {
    tags: string[];
    keywords: string[];
  };
}

export const KnowledgeDomainConfigSchema = z.array(
  z.object({
    name: z.string(),
    description: z.string(),
    rules: z.object({
      tags: z.array(z.string()),
      keywords: z.array(z.string()),
    }),
  }),
);

export interface KnowledgeCluster {
  id: string;
  label: string;
  description: string | null;
  memberCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeMergeSuggestion {
  id: string;
  bubbleId1: string;
  bubbleId2: string;
  overlapReason: string | null;
  confidence: number | null;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
}

export const ResolveMergeSchema = z.object({
  action: z.enum(['accept', 'dismiss']),
});

export interface SimilarBubble {
  bubbleId: string;
  similarity: number;
}

export const CreateKnowledgeBubbleSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
  content: z.string().default(''),
  source: z.string().max(MAX_SOURCE_LENGTH).optional(),
  tags: z.array(z.string().min(1).max(MAX_TAG_LENGTH)).max(MAX_TAGS_COUNT).default([]),
  sourceFile: z.string().max(MAX_SOURCE_FILE_LENGTH).nullable().optional(),
  sourceUrl: z.url().nullable().optional(),
  permanence: PermanenceSchema.optional(),
});

export const UpdateKnowledgeBubbleSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE_LENGTH).optional(),
  content: z.string().optional(),
  source: z.string().max(MAX_SOURCE_LENGTH).nullable().optional(),
  tags: z.array(z.string().min(1).max(MAX_TAG_LENGTH)).max(MAX_TAGS_COUNT).optional(),
  sourceFile: z.string().max(MAX_SOURCE_FILE_LENGTH).nullable().optional(),
  sourceUrl: z.url().nullable().optional(),
});

export const KnowledgeQuerySchema = z.object({
  q: z.string().optional(),
  tag: z.string().optional(),
  source: z.string().optional(),
  sourceFile: z.string().optional(),
  sourceUrl: z.string().optional(),
  domain: z.string().optional(),
  permanence: PermanenceSchema.optional(),
  createdAfter: z.string().optional(),
  createdBefore: z.string().optional(),
  updatedAfter: z.string().optional(),
  updatedBefore: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_QUERY_LIMIT).default(DEFAULT_QUERY_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

export const IngestKnowledgeSchema = z
  .object({
    type: z.enum(['text', 'file', 'voice-memo', 'url']),
    content: z.string().optional(),
    filePath: z.string().optional(),
    url: z.url().optional(),
    title: z.string().min(1).max(MAX_TITLE_LENGTH).optional(),
    source: z.string().max(MAX_SOURCE_LENGTH).optional(),
    tags: z.array(z.string().min(1).max(MAX_TAG_LENGTH)).max(MAX_TAGS_COUNT).optional(),
  })
  .refine(
    (data) => {
      if (data.type === 'file') return !!data.filePath;
      if (data.type === 'url') return !!data.url;
      return !!data.content;
    },
    { message: 'file requires filePath; url requires url; text and voice-memo require content' },
  );

export type IngestKnowledge = z.infer<typeof IngestKnowledgeSchema>;

export interface IngestionResult {
  taskId: string;
  status: 'queued' | 'processing' | 'complete' | 'failed';
  bubbleId?: string;
  error?: string;
}

export type CreateKnowledgeBubble = z.infer<typeof CreateKnowledgeBubbleSchema>;
export type UpdateKnowledgeBubble = z.infer<typeof UpdateKnowledgeBubbleSchema>;
export type KnowledgeQuery = z.infer<typeof KnowledgeQuerySchema>;

// --- Story 6.6: Lifecycle & Retrospective Types ---

const MAX_SNOOZE_DAYS = 365;
const MAX_MERGE_BUBBLES = 10;
const MIN_MERGE_BUBBLES = 2;

export interface StaleBubble {
  id: string;
  title: string;
  permanence: Permanence;
  lastAccessedAt: string;
  daysSinceAccess: number;
  reason: 'temporary-expired' | 'normal-stale';
  tags: string[];
  domains: string[];
}

export interface RetrospectiveSummary {
  period: { since: string; until: string };
  bubblesCreated: { count: number; titles: string[] };
  bubblesUpdated: { count: number; titles: string[] };
  linksCreated: number;
  domainsChanged: number;
  tagsReorganized: number;
  staleBubbles: StaleBubble[];
  temporaryBubbles: StaleBubble[];
}

export const SnoozeSchema = z.object({
  days: z.number().int().min(1).max(MAX_SNOOZE_DAYS),
});

export const MergeBubblesSchema = z.object({
  bubbleIds: z.array(z.uuid()).min(MIN_MERGE_BUBBLES).max(MAX_MERGE_BUBBLES),
});

// --- Story 6.4: Chunk & Retrieval Types ---

export interface KnowledgeChunk {
  id: string;
  bubbleId: string;
  index: number;
  text: string;
  startOffset: number;
  endOffset: number;
}

export type QueryType = 'precise' | 'timeline' | 'generic';

export interface RetrievalOptions {
  tokenBudget?: number;
  limit?: number;
  includeSourceContent?: boolean;
  topK?: number;
  dimensions?: string[];
  type?: QueryType;
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

// --- Story 6.5: Context Injection Types ---

export interface KnowledgeReference {
  bubbleId: string;
  title: string;
  snippet: string;
  score: number;
  tierName: string;
  tags: string[];
}

export interface KnowledgeContext {
  references: KnowledgeReference[];
  tokenBudgetUsed: number;
  query: string;
}

export interface ContextInjectionOptions {
  tokenBudget?: number;
  minScore?: number;
}

const SEARCH_MIN_BUDGET = 100;
const SEARCH_MAX_BUDGET = 100_000;
const SEARCH_DEFAULT_BUDGET = 4000;
const SEARCH_MAX_LIMIT = 200;
const SEARCH_DEFAULT_LIMIT = 20;
const TIMELINE_MAX_LIMIT = 100;
const TIMELINE_DEFAULT_LIMIT = 20;

export const SearchQuerySchema = z.object({
  query: z.string().min(1),
  type: z.enum(['precise', 'timeline', 'generic', 'auto']).default('auto'),
  tokenBudget: z.coerce
    .number()
    .int()
    .min(SEARCH_MIN_BUDGET)
    .max(SEARCH_MAX_BUDGET)
    .default(SEARCH_DEFAULT_BUDGET),
  includeSourceContent: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(SEARCH_MAX_LIMIT).default(SEARCH_DEFAULT_LIMIT),
});

export const TimelineQuerySchema = z.object({
  dimension: z.string().min(1),
  cursor: z.string().optional(),
  direction: z.enum(['forward', 'backward']).default('forward'),
  limit: z.coerce.number().int().min(1).max(TIMELINE_MAX_LIMIT).default(TIMELINE_DEFAULT_LIMIT),
});

// --- Story 6.7: Knowledge Graph Visualization Types ---

export type GraphViewMode = 'links' | 'tags' | 'timeline' | 'clusters' | 'domains';

export const GraphViewModeSchema = z.enum(['links', 'tags', 'timeline', 'clusters', 'domains']);

export const GraphQuerySchema = z.object({
  view: GraphViewModeSchema.default('links'),
  tag: z.string().optional(),
  domain: z.string().optional(),
  permanence: PermanenceSchema.optional(),
});

export interface GraphNode {
  id: string;
  title: string;
  domain: string | null;
  permanence: Permanence;
  tags: string[];
  clusterLabel: string | null;
  connectionDegree: number;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string | null;
}

export interface GraphEdge {
  source: string;
  target: string;
  relationshipType: string;
  confidence: number | null;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  view: GraphViewMode;
}
