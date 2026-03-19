import type { KnowledgeContext, ContextInjectionOptions } from '@raven/shared';
import type { RetrievalEngine } from './retrieval.ts';

const DEFAULT_CONTEXT_BUDGET = 2000;
const DEFAULT_MIN_SCORE = 0.6;

interface ContextInjectorDeps {
  retrievalEngine: RetrievalEngine;
}

export type ContextInjector = ReturnType<typeof createContextInjector>;

export function createContextInjector(deps: ContextInjectorDeps): {
  retrieveContext: (
    query: string,
    options?: ContextInjectionOptions,
  ) => Promise<KnowledgeContext | null>;
  formatContext: (ctx: KnowledgeContext) => string;
} {
  const envBudget = process.env['RAVEN_KNOWLEDGE_CONTEXT_BUDGET'];
  const parsedEnvBudget = envBudget ? parseInt(envBudget, 10) : NaN;
  const configuredBudget = Number.isNaN(parsedEnvBudget) ? DEFAULT_CONTEXT_BUDGET : parsedEnvBudget;

  async function retrieveContext(
    query: string,
    options?: ContextInjectionOptions,
  ): Promise<KnowledgeContext | null> {
    const budget = options?.tokenBudget ?? configuredBudget;
    const minScore = options?.minScore ?? DEFAULT_MIN_SCORE;

    const result = await deps.retrievalEngine.search(query, {
      tokenBudget: budget,
      limit: 10,
    });

    const filtered = result.results.filter((r) => r.score >= minScore);
    if (filtered.length === 0) return null;

    return {
      references: filtered.map((r) => ({
        bubbleId: r.bubbleId,
        title: r.title,
        snippet: r.chunkText ?? r.contentPreview,
        score: r.score,
        tierName: r.provenance.tierName,
        tags: r.tags,
      })),
      tokenBudgetUsed: result.tokenBudgetUsed,
      query,
    };
  }

  function formatContext(ctx: KnowledgeContext): string {
    const lines: string[] = [];
    for (const item of ctx.references) {
      lines.push(`### ${item.title}`);
      lines.push(
        `Tags: ${item.tags.join(', ') || 'none'} | Score: ${item.score.toFixed(2)} | Source: ${item.tierName}`,
      );
      lines.push(item.snippet);
      lines.push(`[ref: ${item.bubbleId}]`);
      lines.push('');
    }
    return lines.join('\n');
  }

  return { retrieveContext, formatContext };
}
