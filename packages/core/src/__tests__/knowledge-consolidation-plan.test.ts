import { describe, expect, it, vi } from 'vitest';
import type { KnowledgeBubble } from '@raven/shared';
import { createKnowledgeConsolidation } from '../knowledge-engine/knowledge-consolidation.ts';
import { runAgentTask } from '../agent-manager/agent-session.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import { fakeGraph, fakeKnowledgeStore } from './fixtures/knowledge-fixture.ts';

vi.mock('../agent-manager/agent-session.ts', () => ({ runAgentTask: vi.fn() }));

function fixture() {
  const neo4j = fakeGraph();
  const store = fakeKnowledgeStore();
  const bubbles = new Map<string, KnowledgeBubble>(
    ['one', 'two', 'three'].map((id) => [
      id,
      {
        id,
        title: `Current ${id}`,
        content: `Markdown ${id}`,
        tags: ['current'],
        filePath: `${id}.md`,
        source: 'auto-retrospective:session',
        sourceFile: null,
        sourceUrl: null,
        domains: [],
        permanence: 'normal',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        lastAccessedAt: null,
      },
    ]),
  );
  const memberships = new Map([['project', ['one', 'two', 'three']]]);
  vi.mocked(neo4j.query).mockImplementation(async (_cypher, params) => {
    if (params?.projectId)
      return (memberships.get(String(params.projectId)) ?? []).map((id) => ({
        id,
        projectId: params.projectId,
      })) as never;
    return [...memberships].flatMap(([projectId, ids]) =>
      ids.map((id) => ({ id, projectId, content: 'Stale graph body' })),
    ) as never;
  });
  vi.mocked(store.getById).mockImplementation(async (id) => bubbles.get(id));
  const embeddingEngine = { refreshBubble: vi.fn(async (_id: string) => {}) };
  const chunkingEngine = { indexBubble: vi.fn(async (_id: string) => {}) };
  const consolidation = createKnowledgeConsolidation({
    neo4j,
    knowledgeStore: store,
    eventBus: new EventBus(),
    embeddingEngine,
    chunkingEngine,
  });
  vi.mocked(runAgentTask).mockReset();
  vi.mocked(runAgentTask).mockResolvedValue({
    taskId: 'model',
    result: '{}',
    success: true,
    durationMs: 1,
  });
  const answer = (plan: unknown) =>
    vi.mocked(runAgentTask).mockResolvedValue({
      taskId: 'model',
      result: JSON.stringify(plan),
      success: true,
      durationMs: 1,
    });
  const assertNoWrites = () => {
    expect(store.mergeOwned).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
    expect(store.insert).not.toHaveBeenCalled();
    expect(neo4j.run).not.toHaveBeenCalled();
  };
  return {
    ...consolidation,
    neo4j,
    store,
    bubbles,
    memberships,
    answer,
    assertNoWrites,
    embeddingEngine,
    chunkingEngine,
  };
}

const validMerge = { keepId: 'one', removeIds: ['two'], mergedContent: 'Combined current content' };

describe('whole consolidation plan admission', () => {
  it('uses canonical Markdown and artifact IDs from actual store outcomes', async () => {
    const f = fixture();
    f.answer({ merges: [validMerge], prunes: ['three'], digest: 'Useful project summary' });
    const result = await f.runConsolidation('project');
    expect(vi.mocked(runAgentTask).mock.calls[0][0].task.prompt).toContain('Markdown one');
    expect(vi.mocked(runAgentTask).mock.calls[0][0].task.prompt).not.toContain('Stale graph body');
    expect(result).toMatchObject({
      mergedCount: 1,
      prunedCount: 1,
      digestCreated: true,
      digestIds: ['saved'],
      mergedIds: ['saved'],
    });
    expect(f.store.mergeOwned).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Current one',
        content: validMerge.mergedContent,
        sources: [
          { id: 'one', revision: expect.any(String) },
          { id: 'two', revision: expect.any(String) },
        ],
      }),
    );
    expect(f.store.remove).toHaveBeenCalledWith(
      'three',
      expect.objectContaining({ expectedRevision: expect.any(String) }),
    );
    expect(f.store.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'consolidation-digest',
        content: 'Useful project summary',
      }),
      expect.objectContaining({ projectIds: ['project'] }),
    );
    expect(f.store.getById).toHaveBeenCalledWith('one', { trackAccess: false });
    expect(f.embeddingEngine.refreshBubble).toHaveBeenCalledWith('saved');
    expect(f.chunkingEngine.indexBubble).toHaveBeenCalledWith('saved');
    await f.stop();
  });

  it.each([
    { merges: [{ ...validMerge, removeIds: ['outside'] }] },
    { merges: [{ ...validMerge, removeIds: ['one'] }] },
    { merges: [validMerge], prunes: ['two'] },
    { merges: [validMerge, validMerge] },
    { prunes: ['three', 'three'] },
    { prunes: ['unknown'] },
    { merges: [{ ...validMerge, mergedContent: ' ' }] },
    { digest: ' ' },
  ])('rejects invalid/overlapping plans before any mutation: %j', async (plan) => {
    const f = fixture();
    f.answer(plan);
    await expect(f.runConsolidation()).rejects.toThrow();
    f.assertNoWrites();
    await f.stop();
  });

  it('validates later project plans before applying the first project', async () => {
    const f = fixture();
    f.memberships.set('project', ['one', 'two']);
    f.memberships.set('other', ['three']);
    vi.mocked(runAgentTask)
      .mockResolvedValueOnce({
        taskId: 'first',
        success: true,
        result: JSON.stringify({ merges: [validMerge] }),
        durationMs: 1,
      })
      .mockResolvedValueOnce({
        taskId: 'second',
        success: true,
        result: JSON.stringify({ prunes: ['one'] }),
        durationMs: 1,
      });
    await expect(f.runConsolidation()).rejects.toThrow('outside selected project other');
    f.assertNoWrites();
    await f.stop();
  });

  it.each(['content', 'membership'])(
    'rejects %s changes made while the model is working',
    async (changed) => {
      const f = fixture();
      vi.mocked(runAgentTask).mockImplementationOnce(async () => {
        if (changed === 'content') f.bubbles.get('one')!.content = 'Edited after prompt';
        else f.memberships.set('project', ['two', 'three']);
        return {
          taskId: 'model',
          success: true,
          result: JSON.stringify({ merges: [validMerge] }),
          durationMs: 1,
        };
      });
      await expect(f.runConsolidation()).rejects.toThrow('changed during consolidation');
      f.assertNoWrites();
      await f.stop();
    },
  );

  it('does not treat unsuccessful model output as an executable plan', async () => {
    const f = fixture();
    vi.mocked(runAgentTask).mockResolvedValue({
      taskId: 'model',
      success: false,
      errors: ['denied'],
      result: JSON.stringify({ prunes: ['one'] }),
      durationMs: 1,
    });
    await expect(f.runConsolidation()).rejects.toThrow('denied');
    f.assertNoWrites();
    await f.stop();
  });

  it('stops a failed merge before pruning or claiming a digest', async () => {
    const f = fixture();
    f.answer({ merges: [validMerge], prunes: ['three'], digest: 'Digest' });
    vi.mocked(f.store.mergeOwned).mockRejectedValueOnce(
      new Error('Unknown transaction outcome; pending recovery'),
    );
    await expect(f.runConsolidation()).rejects.toThrow('pending recovery');
    expect(f.store.remove).not.toHaveBeenCalled();
    expect(f.store.insert).not.toHaveBeenCalled();
    await f.stop();
  });

  it('reports committed digest identity when derived refresh fails', async () => {
    const f = fixture();
    f.answer({ digest: 'Digest' });
    f.embeddingEngine.refreshBubble.mockRejectedValueOnce(new Error('Embedding unavailable'));
    await expect(f.runConsolidation()).rejects.toThrow(/digests: saved.*Embedding unavailable/);
    expect(f.store.insert).toHaveBeenCalledTimes(1);
    await f.stop();
  });

  it('does not claim a digest if its insertion fails', async () => {
    const f = fixture();
    f.answer({ digest: 'Digest' });
    vi.mocked(f.store.insert).mockRejectedValueOnce(new Error('Graph unavailable'));
    await expect(f.runConsolidation()).rejects.toThrow(/digests: none.*Graph unavailable/);
    await f.stop();
  });

  it('ignores a file whose source metadata no longer marks it auto generated', async () => {
    const f = fixture();
    for (const bubble of f.bubbles.values()) bubble.source = 'manual';
    expect(await f.runConsolidation()).toMatchObject({
      mergedCount: 0,
      prunedCount: 0,
      digestCreated: false,
    });
    expect(runAgentTask).not.toHaveBeenCalled();
    f.assertNoWrites();
    await f.stop();
  });
});
