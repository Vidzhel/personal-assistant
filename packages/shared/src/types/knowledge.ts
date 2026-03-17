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
  domain: z.string().optional(),
  permanence: PermanenceSchema.optional(),
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
