import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { RavenMcpDeps } from '../types.ts';
import type { ScopeContext } from '../scope.ts';

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const TITLE_SLICE_LENGTH = 80;
const DEFAULT_CONTEXT_LIMIT = 5;
const MAX_CONTEXT_LIMIT = 20;

type TextContent = { content: [{ type: 'text'; text: string }]; isError?: true };

function errorResult(message: string): TextContent {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function okResult(data: unknown): TextContent {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

async function handleSearchKnowledge(
  deps: RavenMcpDeps,
  args: { query: string; limit?: number },
): Promise<TextContent> {
  const limit = args.limit ?? DEFAULT_SEARCH_LIMIT;

  if (deps.retrievalEngine) {
    const retrieved = await deps.retrievalEngine.search(args.query, { limit });
    const results = retrieved.results.map((item) => ({
      id: item.bubbleId,
      title: item.title,
      content: item.chunkText ?? item.contentPreview,
      tags: item.tags,
      score: item.score,
    }));
    return okResult({ results });
  }

  if (deps.knowledgeStore) {
    const summaries = await deps.knowledgeStore.search(args.query, limit, 0);
    const results = summaries.map((s) => ({
      id: s.id,
      title: s.title,
      content: s.contentPreview,
      tags: s.tags,
      score: 0,
    }));
    return okResult({ results });
  }

  return errorResult('No knowledge backend available — retrievalEngine or knowledgeStore required');
}

const SearchKnowledgeSchema = {
  query: z.string().describe('Search query'),
  tags: z.array(z.string()).optional().describe('Filter by tags'),
  domain: z.string().optional().describe('Filter by domain'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_SEARCH_LIMIT)
    .optional()
    .describe('Maximum results (1-50, default 10)'),
};

function buildSearchKnowledgeTool(
  deps: RavenMcpDeps,
): SdkMcpToolDefinition<typeof SearchKnowledgeSchema> {
  return tool(
    'search_knowledge',
    'Search the knowledge base for relevant information.',
    SearchKnowledgeSchema,
    async (args): Promise<TextContent> => handleSearchKnowledge(deps, args),
    { annotations: { readOnlyHint: true, idempotentHint: true } },
  );
}

const SaveKnowledgeSchema = {
  content: z.string().describe('The knowledge content to save'),
  title: z
    .string()
    .optional()
    .describe('Title for the bubble (defaults to first 80 chars of content)'),
  tags: z.array(z.string()).optional().describe('Tags to associate with this bubble'),
  domain: z.string().optional().describe('Domain to categorize this bubble'),
  permanence: z
    .enum(['temporary', 'normal', 'robust'])
    .optional()
    .describe('Permanence level (default: normal)'),
};

function buildSaveKnowledgeTool(
  deps: RavenMcpDeps,
): SdkMcpToolDefinition<typeof SaveKnowledgeSchema> {
  return tool(
    'save_knowledge',
    'Save a new piece of knowledge to the knowledge base.',
    SaveKnowledgeSchema,
    async (args): Promise<TextContent> => {
      if (!deps.knowledgeStore) {
        return errorResult('No knowledgeStore available — cannot save knowledge');
      }

      const bubble = await deps.knowledgeStore.insert({
        title: args.title ?? args.content.slice(0, TITLE_SLICE_LENGTH),
        content: args.content,
        tags: args.tags ?? [],
        permanence: args.permanence,
      });

      return okResult({ id: bubble.id });
    },
  );
}

const GetKnowledgeContextSchema = {
  query: z.string().describe('Query to retrieve context for'),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(MAX_CONTEXT_LIMIT)
    .optional()
    .describe('Maximum results (1-20, default 5)'),
};

function buildGetKnowledgeContextTool(
  deps: RavenMcpDeps,
): SdkMcpToolDefinition<typeof GetKnowledgeContextSchema> {
  return tool(
    'get_knowledge_context',
    'Retrieve formatted knowledge context for a query, suitable for injecting into prompts.',
    GetKnowledgeContextSchema,
    async (args): Promise<TextContent> => {
      if (!deps.retrievalEngine) {
        return errorResult('No retrievalEngine available — cannot get knowledge context');
      }

      const limit = args.maxResults ?? DEFAULT_CONTEXT_LIMIT;
      const retrieved = await deps.retrievalEngine.search(args.query, { limit });
      const blocks = retrieved.results.map(
        (item) => `## ${item.title}\n${item.chunkText ?? item.contentPreview}`,
      );
      const context = blocks.join('\n\n');

      return okResult({ context, resultCount: retrieved.results.length });
    },
    {
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
  );
}

// Heterogeneous collection: each builder above keeps its own concrete,
// zod-inferred schema type (no `any`); only this array — which must hold
// tools with different schemas side by side, and whose elements are called
// with per-tool concrete args in the test suite via `.find()` — needs the
// erasure, matching the SDK's own `Array<SdkMcpToolDefinition<any>>` field
// on `createSdkMcpServer`.
export function buildKnowledgeTools(
  deps: RavenMcpDeps,
  _scope: ScopeContext,
): Array<SdkMcpToolDefinition<any>> {
  return [
    buildSearchKnowledgeTool(deps),
    buildSaveKnowledgeTool(deps),
    buildGetKnowledgeContextTool(deps),
  ];
}
