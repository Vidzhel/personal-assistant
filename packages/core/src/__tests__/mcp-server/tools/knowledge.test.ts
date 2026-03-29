import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildKnowledgeTools } from '../../../mcp-server/tools/knowledge.ts';
import type { RavenMcpDeps } from '../../../mcp-server/types.ts';
import type { ScopeContext } from '../../../mcp-server/scope.ts';
import type { RetrievalEngine } from '../../../knowledge-engine/retrieval.ts';
import type { KnowledgeStore } from '../../../knowledge-engine/knowledge-store.ts';
import type { EventBus } from '../../../event-bus/event-bus.ts';

function makeResultItem(overrides: Record<string, unknown> = {}) {
  return {
    bubbleId: 'bubble-1',
    title: 'Test Bubble',
    contentPreview: 'Preview text',
    score: 0.85,
    provenance: { tier: 1, tierName: 'chunk_vector', rawScore: 0.85, permanenceWeight: 1.0 },
    tags: ['tag1', 'tag2'],
    domains: ['general'],
    permanence: 'normal' as const,
    ...overrides,
  };
}

function makeRetrievalResult(results: ReturnType<typeof makeResultItem>[] = []) {
  return {
    results,
    query: 'test',
    queryType: 'generic' as const,
    totalCandidates: results.length,
    tokenBudgetUsed: 100,
    tokenBudgetTotal: 4000,
  };
}

function findTool(tools: ReturnType<typeof buildKnowledgeTools>, name: string) {
  const t = tools.find((tool) => tool.name === name);
  if (!t) throw new Error(`Tool ${name} not found`);
  return t;
}

describe('buildKnowledgeTools', () => {
  const scope: ScopeContext = { role: 'knowledge' };
  let searchMock: ReturnType<typeof vi.fn>;
  let retrievalEngine: RetrievalEngine;
  let knowledgeStore: KnowledgeStore;
  let deps: RavenMcpDeps;

  beforeEach(() => {
    searchMock = vi.fn();
    retrievalEngine = {
      search: searchMock,
      retrieveTimeline: vi.fn(),
      getIndexStatus: vi.fn(),
      enrichWithSource: vi.fn(),
    } as unknown as RetrievalEngine;

    knowledgeStore = {
      insert: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      getById: vi.fn(),
      getContentPreview: vi.fn(),
      list: vi.fn(),
      search: vi.fn(),
      getAllTags: vi.fn(),
      reindexAll: vi.fn(),
    } as unknown as KnowledgeStore;

    deps = {
      eventBus: { emit: vi.fn(), on: vi.fn() } as unknown as EventBus,
      retrievalEngine,
      knowledgeStore,
    };
  });

  it('returns 3 tools with correct names', () => {
    const tools = buildKnowledgeTools(deps, scope);
    expect(tools).toHaveLength(3);
    const names = tools.map((t) => t.name);
    expect(names).toContain('search_knowledge');
    expect(names).toContain('save_knowledge');
    expect(names).toContain('get_knowledge_context');
  });

  describe('search_knowledge', () => {
    it('queries retrieval engine and returns results', async () => {
      const item = makeResultItem();
      searchMock.mockResolvedValue(makeRetrievalResult([item]));

      const tools = buildKnowledgeTools(deps, scope);
      const searchTool = findTool(tools, 'search_knowledge');
      const result = await searchTool.handler({ query: 'test query' }, {});

      expect(searchMock).toHaveBeenCalledWith('test query', expect.objectContaining({ limit: 10 }));
      expect(result.isError).toBeUndefined();
      const data = JSON.parse((result.content[0] as any).text);
      expect(data.results).toHaveLength(1);
      expect(data.results[0].id).toBe('bubble-1');
      expect(data.results[0].title).toBe('Test Bubble');
      expect(data.results[0].score).toBe(0.85);
    });

    it('respects limit and passes it to retrieval engine', async () => {
      searchMock.mockResolvedValue(makeRetrievalResult([]));

      const tools = buildKnowledgeTools(deps, scope);
      const searchTool = findTool(tools, 'search_knowledge');
      await searchTool.handler({ query: 'test', limit: 25 }, {});

      expect(searchMock).toHaveBeenCalledWith('test', expect.objectContaining({ limit: 25 }));
    });

    it('falls back to knowledgeStore.search when no retrievalEngine', async () => {
      const storeDeps: RavenMcpDeps = { ...deps, retrievalEngine: undefined };
      const storeSearch = vi.mocked(knowledgeStore.search);
      storeSearch.mockResolvedValue([
        {
          id: 'store-1',
          title: 'Store Result',
          contentPreview: 'preview',
          filePath: '/path/to/file',
          source: null,
          sourceFile: null,
          sourceUrl: null,
          tags: [],
          domains: [],
          permanence: 'normal',
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01',
        },
      ]);

      const tools = buildKnowledgeTools(storeDeps, scope);
      const searchTool = findTool(tools, 'search_knowledge');
      const result = await searchTool.handler({ query: 'hello' }, {});

      expect(storeSearch).toHaveBeenCalled();
      const data = JSON.parse((result.content[0] as any).text);
      expect(data.results[0].id).toBe('store-1');
    });

    it('returns error when neither retrievalEngine nor knowledgeStore available', async () => {
      const emptyDeps: RavenMcpDeps = {
        ...deps,
        retrievalEngine: undefined,
        knowledgeStore: undefined,
      };

      const tools = buildKnowledgeTools(emptyDeps, scope);
      const searchTool = findTool(tools, 'search_knowledge');
      const result = await searchTool.handler({ query: 'test' }, {});

      expect(result.isError).toBe(true);
    });

    it('has readOnlyHint and idempotentHint annotations', () => {
      const tools = buildKnowledgeTools(deps, scope);
      const searchTool = findTool(tools, 'search_knowledge');
      expect(searchTool.annotations?.readOnlyHint).toBe(true);
      expect(searchTool.annotations?.idempotentHint).toBe(true);
    });
  });

  describe('save_knowledge', () => {
    it('creates a bubble via knowledgeStore and returns id', async () => {
      const insertMock = vi.mocked(knowledgeStore.insert);
      insertMock.mockResolvedValue({
        id: 'new-bubble-id',
        title: 'My Note',
        content: 'Some content',
        filePath: '/path',
        source: null,
        sourceFile: null,
        sourceUrl: null,
        tags: ['note'],
        domains: [],
        permanence: 'normal',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        lastAccessedAt: null,
      });

      const tools = buildKnowledgeTools(deps, scope);
      const saveTool = findTool(tools, 'save_knowledge');
      const result = await saveTool.handler(
        { content: 'Some content', title: 'My Note', tags: ['note'] },
        {},
      );

      expect(insertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Some content',
          title: 'My Note',
          tags: ['note'],
        }),
      );
      const data = JSON.parse((result.content[0] as any).text);
      expect(data.id).toBe('new-bubble-id');
    });

    it('uses content slice as title when title not provided', async () => {
      const insertMock = vi.mocked(knowledgeStore.insert);
      insertMock.mockResolvedValue({
        id: 'new-id',
        title: 'Some long conte',
        content: 'Some long content here',
        filePath: '/path',
        source: null,
        sourceFile: null,
        sourceUrl: null,
        tags: [],
        domains: [],
        permanence: 'normal',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        lastAccessedAt: null,
      });

      const tools = buildKnowledgeTools(deps, scope);
      const saveTool = findTool(tools, 'save_knowledge');
      await saveTool.handler({ content: 'Some long content here' }, {});

      expect(insertMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Some long content here' }),
      );
    });

    it('returns error when knowledgeStore not available', async () => {
      const noDeps: RavenMcpDeps = { ...deps, knowledgeStore: undefined };
      const tools = buildKnowledgeTools(noDeps, scope);
      const saveTool = findTool(tools, 'save_knowledge');
      const result = await saveTool.handler({ content: 'test' }, {});

      expect(result.isError).toBe(true);
    });
  });

  describe('get_knowledge_context', () => {
    it('returns formatted context string from retrieval results', async () => {
      const items = [
        makeResultItem({ bubbleId: 'b1', title: 'First Topic', contentPreview: 'First content' }),
        makeResultItem({ bubbleId: 'b2', title: 'Second Topic', contentPreview: 'Second content' }),
      ];
      searchMock.mockResolvedValue(makeRetrievalResult(items));

      const tools = buildKnowledgeTools(deps, scope);
      const contextTool = findTool(tools, 'get_knowledge_context');
      const result = await contextTool.handler({ query: 'some query', maxResults: 5 }, {});

      expect(result.isError).toBeUndefined();
      const data = JSON.parse((result.content[0] as any).text);
      expect(data.resultCount).toBe(2);
      expect(data.context).toContain('## First Topic');
      expect(data.context).toContain('First content');
      expect(data.context).toContain('## Second Topic');
      expect(data.context).toContain('Second content');
    });

    it('passes maxResults as limit to retrieval engine', async () => {
      searchMock.mockResolvedValue(makeRetrievalResult([]));

      const tools = buildKnowledgeTools(deps, scope);
      const contextTool = findTool(tools, 'get_knowledge_context');
      await contextTool.handler({ query: 'test', maxResults: 3 }, {});

      expect(searchMock).toHaveBeenCalledWith('test', expect.objectContaining({ limit: 3 }));
    });

    it('uses default maxResults of 5 when not specified', async () => {
      searchMock.mockResolvedValue(makeRetrievalResult([]));

      const tools = buildKnowledgeTools(deps, scope);
      const contextTool = findTool(tools, 'get_knowledge_context');
      await contextTool.handler({ query: 'test' }, {});

      expect(searchMock).toHaveBeenCalledWith('test', expect.objectContaining({ limit: 5 }));
    });

    it('returns error when retrievalEngine not available', async () => {
      const noDeps: RavenMcpDeps = { ...deps, retrievalEngine: undefined };
      const tools = buildKnowledgeTools(noDeps, scope);
      const contextTool = findTool(tools, 'get_knowledge_context');
      const result = await contextTool.handler({ query: 'test' }, {});

      expect(result.isError).toBe(true);
    });

    it('has readOnlyHint and idempotentHint annotations', () => {
      const tools = buildKnowledgeTools(deps, scope);
      const contextTool = findTool(tools, 'get_knowledge_context');
      expect(contextTool.annotations?.readOnlyHint).toBe(true);
      expect(contextTool.annotations?.idempotentHint).toBe(true);
    });
  });
});
