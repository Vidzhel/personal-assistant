import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Neo4jContainer, type StartedNeo4jContainer } from '@testcontainers/neo4j';
import { createNeo4jClient, type Neo4jClient } from '../knowledge-engine/neo4j-client.ts';
import { createKnowledgeStore, type KnowledgeStore } from '../knowledge-engine/knowledge-store.ts';
import { createKnowledgeConsolidation } from '../knowledge-engine/knowledge-consolidation.ts';
import { createKnowledgeLifecycle } from '../knowledge-engine/knowledge-lifecycle.ts';
import { runAgentTask } from '../agent-manager/agent-session.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import { readPendingKnowledgeDeletions } from '../knowledge-engine/knowledge-deletions.ts';
import { readBubbleFile, writeBubbleFile } from '../knowledge-engine/knowledge-file.ts';
import type { EmbeddingEngine } from '../knowledge-engine/embeddings.ts';
import type { ChunkingEngine } from '../knowledge-engine/chunking.ts';
import type { AgentTaskRequestEvent } from '@raven/shared';

vi.mock('../agent-manager/agent-session.ts', () => ({ runAgentTask: vi.fn() }));

describe('canonical consolidation and manual merge with disposable Neo4j', () => {
  let container: StartedNeo4jContainer;
  let neo4j: Neo4jClient;
  let root: string;
  let store: KnowledgeStore;
  beforeAll(async () => {
    container = await new Neo4jContainer('neo4j:5-community').start();
    neo4j = createNeo4jClient({
      uri: container.getBoltUri(),
      user: 'neo4j',
      password: container.getPassword(),
    });
    await neo4j.ensureSchema();
  }, 120_000);
  beforeEach(async () => {
    await neo4j.run('MATCH (n) DETACH DELETE n');
    root = mkdtempSync(join(tmpdir(), 'raven-consolidation-files-'));
    store = createKnowledgeStore({ neo4j, knowledgeDir: root });
    vi.mocked(runAgentTask).mockReset();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  afterAll(async () => {
    try {
      await neo4j?.close();
    } finally {
      await container?.stop();
    }
  });

  async function source(title: string) {
    return store.insert(
      {
        title,
        content: `Current ${title} body`,
        tags: ['source'],
        source: 'auto-retrospective:session',
      },
      { projectIds: ['project'] },
    );
  }

  function processors() {
    return {
      embeddingEngine: { refreshBubble: vi.fn(async (_id: string) => {}) },
      chunkingEngine: { indexBubble: vi.fn(async (_id: string) => {}) },
    };
  }

  it('saves merge/digest Markdown, preserves memberships and typed links, and never resurrects pruned sources', async () => {
    const first = await source('First');
    const second = await source('Second');
    const obsolete = await source('Obsolete');
    const secondFile = readBubbleFile(join(root, second.filePath));
    writeBubbleFile(
      join(root, second.filePath),
      { ...secondFile.meta, tags: ['source', 'fresh-file-tag'] },
      secondFile.content,
    );
    await neo4j.run('MATCH (b:Bubble {id:$id}) SET b.permanence="robust"', { id: second.id });
    const outside = await store.insert({ title: 'Outside', content: 'Separate context', tags: [] });
    await neo4j.run(
      `MATCH (a:Bubble {id:$outside}),(b:Bubble {id:$source})
      CREATE (a)-[:LINKS_TO {id:'durable-link',relationshipType:'contradicts',status:'accepted',confidence:0.9,annotation:'owner detail',createdAt:'2026-01-01'}]->(b)`,
      { outside: outside.id, source: second.id },
    );
    vi.mocked(runAgentTask).mockResolvedValue({
      taskId: 'model',
      success: true,
      durationMs: 1,
      result: JSON.stringify({
        merges: [
          { keepId: first.id, removeIds: [second.id], mergedContent: 'Combined canonical facts' },
        ],
        prunes: [obsolete.id],
        digest: 'A real saved project digest',
      }),
    });
    const derived = processors();
    const consolidation = createKnowledgeConsolidation({
      neo4j,
      knowledgeStore: store,
      eventBus: new EventBus(),
      ...derived,
    });
    try {
      const result = await consolidation.runConsolidation('project');
      expect(result).toMatchObject({ mergedCount: 1, prunedCount: 1, digestCreated: true });
      expect(result.mergedIds).toHaveLength(1);
      expect(result.digestIds).toHaveLength(1);
      const merged = await store.getById(result.mergedIds[0], { trackAccess: false });
      const digest = await store.getById(result.digestIds[0], { trackAccess: false });
      expect(merged?.content).toBe('Combined canonical facts');
      expect(merged?.permanence).toBe('robust');
      expect(merged?.tags).toContain('fresh-file-tag');
      expect(await store.getAllTags()).toContainEqual({ tag: 'fresh-file-tag', count: 1 });
      expect(digest?.content).toBe('A real saved project digest');
      expect(readFileSync(join(root, digest!.filePath), 'utf8')).toContain(
        'A real saved project digest',
      );
      const membership = await neo4j.query<{ id: string }>(
        'MATCH (b:Bubble)-[:BELONGS_TO_PROJECT]->(:Project {id:"project"}) RETURN DISTINCT b.id AS id',
      );
      expect(membership.map((row) => row.id).sort()).toEqual(
        [...result.mergedIds, ...result.digestIds].sort(),
      );
      const links = await neo4j.query<{ target: string; props: Record<string, unknown> }>(
        'MATCH ()-[r:LINKS_TO {id:"durable-link"}]->(b:Bubble) RETURN b.id AS target, properties(r) AS props',
      );
      expect(links).toEqual([
        {
          target: merged!.id,
          props: {
            id: 'durable-link',
            relationshipType: 'contradicts',
            status: 'accepted',
            confidence: 0.9,
            annotation: 'owner detail',
            createdAt: '2026-01-01',
          },
        },
      ]);
      await store.reindexAll();
      for (const id of [first.id, second.id, obsolete.id])
        expect(await store.getById(id)).toBeUndefined();
      expect(readPendingKnowledgeDeletions(root)).toEqual([]);
      expect(derived.embeddingEngine.refreshBubble.mock.calls.map(([id]) => id)).toEqual([
        ...result.mergedIds,
        ...result.digestIds,
      ]);
    } finally {
      await consolidation.stop();
    }
  });

  it('rejects an external Markdown edit during model work without changing graph membership or source files', async () => {
    const first = await source('First');
    const second = await source('Second');
    const secondBefore = readFileSync(join(root, second.filePath), 'utf8');
    vi.mocked(runAgentTask).mockImplementation(async () => {
      const path = join(root, first.filePath);
      const original = readBubbleFile(path);
      writeBubbleFile(path, original.meta, 'Owner edited this while the model was running');
      return {
        taskId: 'model',
        success: true,
        durationMs: 1,
        result: JSON.stringify({
          merges: [{ keepId: first.id, removeIds: [second.id], mergedContent: 'Stale synthesis' }],
        }),
      };
    });
    const consolidation = createKnowledgeConsolidation({
      neo4j,
      knowledgeStore: store,
      eventBus: new EventBus(),
      ...processors(),
    });
    try {
      await expect(consolidation.runConsolidation('project')).rejects.toThrow(
        'changed during consolidation',
      );
      expect((await store.getById(first.id, { trackAccess: false }))?.content).toContain(
        'Owner edited',
      );
      expect(readFileSync(join(root, second.filePath), 'utf8')).toBe(secondBefore);
      expect(readPendingKnowledgeDeletions(root)).toEqual([]);
      expect((await neo4j.query('MATCH (b:Bubble) RETURN b.id')).length).toBe(2);
    } finally {
      await consolidation.stop();
    }
  });

  it('manual merging uses the same file-owned operation and rejects unsuccessful synthesis', async () => {
    const first = await source('First');
    const second = await source('Second');
    const eventBus = new EventBus();
    let success = false;
    eventBus.on<AgentTaskRequestEvent>('agent:task:request', (request) =>
      eventBus.emit({
        id: 'reply',
        timestamp: Date.now(),
        source: 'fake-provider',
        type: 'agent:task:complete',
        payload: {
          taskId: request.payload.taskId,
          success,
          result: 'Current combined synthesis',
          durationMs: 1,
          errors: success ? undefined : ['Provider denied'],
        },
      }),
    );
    const derived = processors();
    const lifecycle = createKnowledgeLifecycle({
      neo4j,
      knowledgeStore: store,
      eventBus,
      knowledgeDir: root,
      embeddingEngine: derived.embeddingEngine as unknown as EmbeddingEngine,
      chunkingEngine: derived.chunkingEngine as unknown as ChunkingEngine,
    });
    try {
      await expect(lifecycle.mergeBubbles([first.id, second.id])).rejects.toThrow(
        'Provider denied',
      );
      expect(await store.getById(first.id, { trackAccess: false })).toBeDefined();
      expect(readPendingKnowledgeDeletions(root)).toEqual([]);
      success = true;
      const id = await lifecycle.mergeBubbles([first.id, second.id]);
      expect((await store.getById(id, { trackAccess: false }))?.content).toBe(
        'Current combined synthesis',
      );
      await store.reindexAll();
      expect(await store.getById(first.id)).toBeUndefined();
      expect(await store.getById(second.id)).toBeUndefined();
    } finally {
      await lifecycle.stop();
    }
  });
});
