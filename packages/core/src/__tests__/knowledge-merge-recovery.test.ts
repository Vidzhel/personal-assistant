import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Neo4jContainer, type StartedNeo4jContainer } from '@testcontainers/neo4j';
import type { KnowledgeBubble } from '@raven/shared';
import { createKnowledgeStore, type KnowledgeStore } from '../knowledge-engine/knowledge-store.ts';
import { knowledgeRevision } from '../knowledge-engine/knowledge-revision.ts';
import {
  readPendingKnowledgeDeletions,
  removePendingKnowledgeDeletion,
} from '../knowledge-engine/knowledge-deletions.ts';
import { createNeo4jClient, type Neo4jClient } from '../knowledge-engine/neo4j-client.ts';

describe('file-owned knowledge merge recovery', () => {
  let container: StartedNeo4jContainer;
  let neo4j: Neo4jClient;
  let root: string;
  let knowledgeDir: string;
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

  afterAll(async () => {
    if (neo4j) await neo4j.close();
    if (container) await container.stop();
  });

  beforeEach(async () => {
    await neo4j.run('MATCH (n) DETACH DELETE n');
    root = mkdtempSync(join(tmpdir(), 'raven-knowledge-merge-recovery-'));
    knowledgeDir = join(root, 'knowledge');
    mkdirSync(knowledgeDir, { recursive: true });
    store = createKnowledgeStore({ neo4j, knowledgeDir });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  function revision(bubble: KnowledgeBubble): string {
    return knowledgeRevision({ title: bubble.title, content: bubble.content, tags: bubble.tags });
  }

  async function sources(): Promise<[KnowledgeBubble, KnowledgeBubble]> {
    return [
      await store.insert({ title: 'First source', content: 'one', tags: ['one'] }),
      await store.insert({ title: 'Second source', content: 'two', tags: ['two'] }),
    ];
  }

  async function failMerge(
    input: { sources: KnowledgeBubble[]; title?: string; content?: string },
    phase: 'before' | 'after',
  ): Promise<{ targetId: string; records: ReturnType<typeof readPendingKnowledgeDeletions> }> {
    const original = neo4j.withTransaction.bind(neo4j);
    vi.spyOn(neo4j, 'withTransaction').mockImplementation(async (fn, mode) => {
      if (phase === 'before') {
        return original(async (tx) => {
          await fn(tx);
          throw new Error('injected transaction rollback');
        }, mode);
      }
      const result = await original(fn, mode);
      throw new Error(`injected unknown outcome: ${String(result)}`);
    });

    await expect(
      store.mergeOwned({
        sources: input.sources.map((bubble) => ({ id: bubble.id, revision: revision(bubble) })),
        title: input.title ?? 'Recovered merge',
        content: input.content ?? 'merged content',
      }),
    ).rejects.toThrow();
    const records = readPendingKnowledgeDeletions(knowledgeDir).filter((record) =>
      input.sources.some((source) => record.mergeSourceIds?.includes(source.id)),
    );
    const targetId = records[0]?.mergeTargetId;
    if (!targetId) throw new Error('merge failure did not leave a target identity');
    vi.restoreAllMocks();
    return { targetId, records };
  }

  async function bubbleCounts(
    targetId: string,
    sourceIds: string[],
  ): Promise<{
    target: number;
    sources: number;
  }> {
    const rows = await neo4j.query<{ target: number; sources: number }>(
      `OPTIONAL MATCH (target:Bubble {id: $targetId})
       WITH count(target) AS target
       OPTIONAL MATCH (source:Bubble) WHERE source.id IN $sourceIds
       RETURN target, count(source) AS sources`,
      { targetId, sourceIds },
    );
    return rows[0] ?? { target: 0, sources: 0 };
  }

  it('rolls back a transaction failure and removes prepared files during explicit recovery', async () => {
    const input = await sources();
    const originalBytes = input.map((bubble) =>
      readFileSync(join(knowledgeDir, bubble.filePath), 'utf8'),
    );
    const failed = await failMerge({ sources: input }, 'before');

    expect(
      input.map((bubble) => readFileSync(join(knowledgeDir, bubble.filePath), 'utf8')),
    ).toEqual(originalBytes);
    expect(existsSync(join(knowledgeDir, failed.records[0].mergeTargetFilePath!))).toBe(true);
    expect(
      await bubbleCounts(
        failed.targetId,
        input.map((bubble) => bubble.id),
      ),
    ).toEqual({ target: 0, sources: 2 });

    await expect(store.update(input[0].id, { content: 'blocked' })).rejects.toThrow('pending');
    await expect(store.remove(input[0].id)).rejects.toThrow('pending');
    await expect(store.update(failed.targetId, { content: 'blocked' })).rejects.toThrow(
      'pending merge target',
    );
    await expect(store.remove(failed.targetId)).rejects.toThrow('pending merge target');

    const reindex = await store.reindexAll();
    expect(reindex.indexed).toBe(0);
    expect(reindex.errors.join('\n')).toEqual(expect.stringContaining(input[0].id));
    expect(reindex.errors.join('\n')).toEqual(expect.stringContaining(input[1].id));
    expect(reindex.errors.join('\n')).toEqual(expect.stringContaining(failed.targetId));
    expect(
      await bubbleCounts(
        failed.targetId,
        input.map((bubble) => bubble.id),
      ),
    ).toEqual({ target: 0, sources: 2 });

    await expect(store.recoverMerge(failed.targetId)).resolves.toEqual({
      status: 'rolled-back',
      targetId: failed.targetId,
    });
    expect(readPendingKnowledgeDeletions(knowledgeDir)).toEqual([]);
    expect(existsSync(join(knowledgeDir, failed.records[0].mergeTargetFilePath!))).toBe(false);
    expect(
      await bubbleCounts(
        failed.targetId,
        input.map((bubble) => bubble.id),
      ),
    ).toEqual({ target: 0, sources: 2 });
  });

  it('completes recovery after an unknown post-commit outcome', async () => {
    const input = await sources();
    const failed = await failMerge({ sources: input }, 'after');
    expect(
      await bubbleCounts(
        failed.targetId,
        input.map((bubble) => bubble.id),
      ),
    ).toEqual({ target: 1, sources: 0 });
    expect(existsSync(join(knowledgeDir, input[0].filePath))).toBe(true);

    await expect(store.recoverMerge(failed.targetId)).resolves.toEqual({
      status: 'completed',
      targetId: failed.targetId,
    });
    expect(readPendingKnowledgeDeletions(knowledgeDir)).toEqual([]);
    expect(existsSync(join(knowledgeDir, input[0].filePath))).toBe(false);
    expect(existsSync(join(knowledgeDir, input[1].filePath))).toBe(false);
    expect(existsSync(join(knowledgeDir, failed.records[0].mergeTargetFilePath!))).toBe(true);
    expect(
      await bubbleCounts(
        failed.targetId,
        input.map((bubble) => bubble.id),
      ),
    ).toEqual({ target: 1, sources: 0 });
  });

  it('recovers a rollback with a partial intent set', async () => {
    const input = await sources();
    const failed = await failMerge({ sources: input }, 'before');
    removePendingKnowledgeDeletion(knowledgeDir, input[1].id);

    await expect(store.update(input[1].id, { content: 'blocked' })).rejects.toThrow('pending');
    await expect(store.remove(input[1].id)).rejects.toThrow('pending');
    await expect(
      store.mergeOwned({
        sources: input.map((bubble) => ({ id: bubble.id, revision: revision(bubble) })),
        title: 'Blocked second merge',
        content: 'must not start',
      }),
    ).rejects.toThrow('pending');
    const reindex = await store.reindexAll();
    expect(reindex.indexed).toBe(0);
    expect(reindex.errors.join('\n')).toContain(input[1].id);

    await expect(store.recoverMerge(failed.targetId)).resolves.toEqual({
      status: 'rolled-back',
      targetId: failed.targetId,
    });
    expect(readPendingKnowledgeDeletions(knowledgeDir)).toEqual([]);
    expect(existsSync(join(knowledgeDir, failed.records[0].mergeTargetFilePath!))).toBe(false);
    expect(
      await bubbleCounts(
        failed.targetId,
        input.map((bubble) => bubble.id),
      ),
    ).toEqual({ target: 0, sources: 2 });
  });

  it('does not clean remaining files when a source disappears before graph mutation', async () => {
    const input = await sources();
    const original = neo4j.withTransaction.bind(neo4j);
    vi.spyOn(neo4j, 'withTransaction').mockImplementation(async (fn, mode) => {
      await neo4j.run('MATCH (b:Bubble {id: $id}) DETACH DELETE b', { id: input[0].id });
      return original(fn, mode);
    });

    await expect(
      store.mergeOwned({
        sources: input.map((bubble) => ({ id: bubble.id, revision: revision(bubble) })),
        title: 'Missing source merge',
        content: 'must not partially clean',
      }),
    ).rejects.toThrow();
    const records = readPendingKnowledgeDeletions(knowledgeDir);
    expect(records).toHaveLength(2);
    expect(readFileSync(join(knowledgeDir, input[0].filePath), 'utf8')).toContain('one');
    expect(readFileSync(join(knowledgeDir, input[1].filePath), 'utf8')).toContain('two');
    expect(
      await bubbleCounts(
        records[0].mergeTargetId!,
        input.map((bubble) => bubble.id),
      ),
    ).toEqual({
      target: 0,
      sources: 1,
    });
    vi.restoreAllMocks();
    await expect(store.recoverMerge(records[0].mergeTargetId!)).rejects.toThrow('ambiguous');
    expect(readPendingKnowledgeDeletions(knowledgeDir)).toHaveLength(2);
  });

  it('retains distinct membership properties and file-only tags in the target', async () => {
    const input = await sources();
    await neo4j.run(
      `MATCH (a:Bubble {id: $a}), (b:Bubble {id: $b})
       CREATE (p:Project {id: 'shared-project'})
       CREATE (a)-[:BELONGS_TO_PROJECT {linkedBy: 'human', createdAt: '2026-01-01'}]->(p)
       CREATE (b)-[:BELONGS_TO_PROJECT {linkedBy: 'agent', createdAt: '2026-01-02'}]->(p)
       REMOVE a.embedding, b.embedding
       SET a.permanence = 'normal', b.permanence = 'robust'`,
      { a: input[0].id, b: input[1].id },
    );
    const firstPath = join(knowledgeDir, input[0].filePath);
    const firstText = readFileSync(firstPath, 'utf8').replace(
      'tags:\n  - one',
      'tags:\n  - file-only',
    );
    writeFileSync(firstPath, firstText);

    const result = await store.mergeOwned({
      sources: [
        {
          id: input[0].id,
          revision: knowledgeRevision({
            title: input[0].title,
            content: input[0].content,
            tags: ['file-only'],
          }),
        },
        { id: input[1].id, revision: revision(input[1]) },
      ],
      title: 'Membership merge',
      content: 'combined',
    });
    expect(result.tags).toEqual(['file-only', 'two']);
    expect(result.permanence).toBe('robust');
    expect(
      await neo4j.query(
        `MATCH (b:Bubble {id: $id})-[r:BELONGS_TO_PROJECT]->(p)
         RETURN p.id AS projectId, properties(r) AS props ORDER BY props.createdAt`,
        { id: result.id },
      ),
    ).toEqual([
      { projectId: 'shared-project', props: { linkedBy: 'human', createdAt: '2026-01-01' } },
      { projectId: 'shared-project', props: { linkedBy: 'agent', createdAt: '2026-01-02' } },
    ]);
    expect(
      await neo4j.query(
        `MATCH (b:Bubble {id: $id})-[:HAS_TAG]->(t) RETURN t.name AS name ORDER BY name`,
        { id: result.id },
      ),
    ).toEqual([{ name: 'file-only' }, { name: 'two' }]);
  });

  it('finishes cleanup when one already-processed intent is missing', async () => {
    const input = await sources();
    const failed = await failMerge({ sources: input }, 'after');
    removePendingKnowledgeDeletion(knowledgeDir, input[1].id);
    unlinkSync(join(knowledgeDir, input[1].filePath));

    await expect(store.recoverMerge(failed.targetId)).resolves.toEqual({
      status: 'completed',
      targetId: failed.targetId,
    });
    expect(readPendingKnowledgeDeletions(knowledgeDir)).toEqual([]);
    expect(existsSync(join(knowledgeDir, input[0].filePath))).toBe(false);
    expect(existsSync(join(knowledgeDir, input[1].filePath))).toBe(false);
  });

  it('retains a committed merge when the target or a source file changed', async () => {
    const targetCase = await sources();
    const targetFailure = await failMerge({ sources: targetCase }, 'after');
    const targetPath = join(knowledgeDir, targetFailure.records[0].mergeTargetFilePath!);
    writeFileSync(targetPath, `${readFileSync(targetPath, 'utf8')}edited\n`);
    await expect(store.recoverMerge(targetFailure.targetId)).rejects.toThrow('target file changed');
    expect(readFileSync(targetPath, 'utf8')).toContain('edited');
    expect(readPendingKnowledgeDeletions(knowledgeDir)).not.toEqual([]);

    vi.restoreAllMocks();
    await neo4j.run('MATCH (n) DETACH DELETE n');
    const sourceCase = await sources();
    const sourceFailure = await failMerge({ sources: sourceCase }, 'after');
    const sourcePath = join(knowledgeDir, sourceCase[0].filePath);
    writeFileSync(sourcePath, `${readFileSync(sourcePath, 'utf8')}edited\n`);
    await expect(store.recoverMerge(sourceFailure.targetId)).rejects.toThrow('source changed');
    expect(readFileSync(sourcePath, 'utf8')).toContain('edited');
    expect(existsSync(join(knowledgeDir, sourceCase[1].filePath))).toBe(true);
    expect(readPendingKnowledgeDeletions(knowledgeDir)).not.toEqual([]);
  });

  it('rejects a missing committed target file without clearing evidence', async () => {
    const input = await sources();
    const failed = await failMerge({ sources: input }, 'after');
    unlinkSync(join(knowledgeDir, failed.records[0].mergeTargetFilePath!));

    await expect(store.recoverMerge(failed.targetId)).rejects.toThrow('regular file');
    expect(readPendingKnowledgeDeletions(knowledgeDir)).not.toEqual([]);
    expect(
      await bubbleCounts(
        failed.targetId,
        input.map((bubble) => bubble.id),
      ),
    ).toEqual({ target: 1, sources: 0 });
  });

  it('does not mutate after an operation is aborted inside its graph transaction', async () => {
    const input = await sources();
    const entered = Promise.withResolvers<true>();
    const release = Promise.withResolvers<true>();
    const original = neo4j.withTransaction.bind(neo4j);
    vi.spyOn(neo4j, 'withTransaction').mockImplementation((fn, mode) =>
      original(async (tx) => {
        entered.resolve(true);
        await release.promise;
        return fn(tx);
      }, mode),
    );
    const controller = new AbortController();
    const merge = store.mergeOwned({
      sources: input.map((bubble) => ({ id: bubble.id, revision: revision(bubble) })),
      title: 'Aborted merge',
      content: 'must not commit',
      signal: controller.signal,
    });
    await entered.promise;
    controller.abort();
    release.resolve(true);
    await expect(merge).rejects.toThrow();
    expect(
      await bubbleCounts(
        'never-created',
        input.map((bubble) => bubble.id),
      ),
    ).toEqual({ target: 0, sources: 2 });
    expect(readPendingKnowledgeDeletions(knowledgeDir)).toHaveLength(2);
  });

  it('leaves recovery evidence unchanged when its graph-state read is aborted', async () => {
    const input = await sources();
    const failed = await failMerge({ sources: input }, 'before');
    const pendingBefore = readPendingKnowledgeDeletions(knowledgeDir);
    const bytesBefore = [
      ...input.map((bubble) => readFileSync(join(knowledgeDir, bubble.filePath), 'utf8')),
      ...pendingBefore.map((record) =>
        readFileSync(join(knowledgeDir, '.raven-pending-deletions', `${record.id}.yaml`), 'utf8'),
      ),
      readFileSync(join(knowledgeDir, failed.records[0].mergeTargetFilePath!), 'utf8'),
    ];
    const controller = new AbortController();
    const recoveryStore = createKnowledgeStore({ neo4j, knowledgeDir, signal: controller.signal });
    const entered = Promise.withResolvers<true>();
    const release = Promise.withResolvers<true>();
    const original = neo4j.withTransaction.bind(neo4j);
    vi.spyOn(neo4j, 'withTransaction').mockImplementation((fn, mode) =>
      original(async (tx) => {
        entered.resolve(true);
        await release.promise;
        return fn(tx);
      }, mode),
    );

    const recovery = recoveryStore.recoverMerge(failed.targetId);
    await entered.promise;
    controller.abort();
    release.resolve(true);
    await expect(recovery).rejects.toThrow();
    expect(readPendingKnowledgeDeletions(knowledgeDir)).toEqual(pendingBefore);
    const bytesAfter = [
      ...input.map((bubble) => readFileSync(join(knowledgeDir, bubble.filePath), 'utf8')),
      ...pendingBefore.map((record) =>
        readFileSync(join(knowledgeDir, '.raven-pending-deletions', `${record.id}.yaml`), 'utf8'),
      ),
      readFileSync(join(knowledgeDir, failed.records[0].mergeTargetFilePath!), 'utf8'),
    ];
    expect(bytesAfter).toEqual(bytesBefore);
  });
});
