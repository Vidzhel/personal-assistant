import { z } from 'zod';

const MAX_TITLE_LENGTH = 500;
const MAX_SOURCE_LENGTH = 100;
const MAX_TAG_LENGTH = 100;
const MAX_TAGS_COUNT = 50;
const MAX_QUERY_LIMIT = 200;
const DEFAULT_QUERY_LIMIT = 50;

/** Full knowledge bubble — includes content read from markdown file */
export interface KnowledgeBubble {
  id: string;
  title: string;
  content: string;
  filePath: string;
  source: string | null;
  tags: string[];
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
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export const CreateKnowledgeBubbleSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
  content: z.string().default(''),
  source: z.string().max(MAX_SOURCE_LENGTH).optional(),
  tags: z.array(z.string().min(1).max(MAX_TAG_LENGTH)).max(MAX_TAGS_COUNT).default([]),
});

export const UpdateKnowledgeBubbleSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE_LENGTH).optional(),
  content: z.string().optional(),
  source: z.string().max(MAX_SOURCE_LENGTH).nullable().optional(),
  tags: z.array(z.string().min(1).max(MAX_TAG_LENGTH)).max(MAX_TAGS_COUNT).optional(),
});

export const KnowledgeQuerySchema = z.object({
  q: z.string().optional(),
  tag: z.string().optional(),
  source: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_QUERY_LIMIT).default(DEFAULT_QUERY_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

export type CreateKnowledgeBubble = z.infer<typeof CreateKnowledgeBubbleSchema>;
export type UpdateKnowledgeBubble = z.infer<typeof UpdateKnowledgeBubbleSchema>;
export type KnowledgeQuery = z.infer<typeof KnowledgeQuerySchema>;
