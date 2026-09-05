import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reindexKnowledgeFiles } from '../knowledge-engine/knowledge-reindex.ts';
import { readBubbleFile, sha256 } from '../knowledge-engine/knowledge-file.ts';
import { knowledgeRevision } from '../knowledge-engine/knowledge-revision.ts';
import { writePendingKnowledgeDeletion } from '../knowledge-engine/knowledge-deletions.ts';
import { createKnowledgeStore } from '../knowledge-engine/knowledge-store.ts';
import { deferred, fakeGraph } from './fixtures/knowledge-fixture.ts';
import type { Neo4jClient } from '../knowledge-engine/neo4j-client.ts';

const roots: string[] = [];
function fixture() {
  const knowledgeDir = mkdtempSync(join(tmpdir(), 'raven-reindex-'));
  roots.push(knowledgeDir);
  const run = vi.fn(async (..._args: unknown[]) => ({}));
  const query = vi.fn(async (..._args: unknown[]) => []);
  const withTransaction = vi.fn(async (operation: (tx: { run: typeof run }) => Promise<void>) =>
    operation({ run }),
  );
  const neo4j = { query, withTransaction } as unknown as Neo4jClient;
  return { knowledgeDir, neo4j, run, query, withTransaction };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('knowledge file reindex preflight and identity', () => {
  it('does not overwrite a later identity-less file edited while an earlier graph write awaits', async () => {
    const deps = fixture();
    const first = join(deps.knowledgeDir, 'a.md');
    const second = join(deps.knowledgeDir, 'z.md');
    writeFileSync(first, '---\nid: first\n---\nFirst body');
    writeFileSync(second, 'Original second body');
    const pending = deferred<undefined>();
    deps.withTransaction.mockImplementationOnce(async () => pending.promise);
    const indexing = reindexKnowledgeFiles(deps);
    await vi.waitFor(() => expect(deps.withTransaction).toHaveBeenCalledOnce());
    writeFileSync(second, 'Newer second body');
    pending.resolve(undefined);
    const result = await indexing;
    expect(result.indexed).toBe(1);
    expect(result.errors).toEqual([
      expect.stringContaining('Knowledge file changed during indexing'),
    ]);
    expect(readFileSync(second, 'utf8')).toBe('Newer second body');
    expect(deps.withTransaction).toHaveBeenCalledOnce();
  });

  it('does not touch the graph for an empty or missing directory', async () => {
    const deps = fixture();
    expect(await reindexKnowledgeFiles(deps)).toEqual({ indexed: 0, errors: [], changedIds: [] });
    expect(
      await reindexKnowledgeFiles({ ...deps, knowledgeDir: join(deps.knowledgeDir, 'missing') }),
    ).toEqual({ indexed: 0, errors: [], changedIds: [] });
    expect(deps.withTransaction).not.toHaveBeenCalled();
  });

  it.each(['---\nid: 42\n---\nInvalid identity', '---\ntags: [unfinished\n---\nBad YAML'])(
    'rejects malformed input before any graph or identity writes',
    async (invalid) => {
      const deps = fixture();
      const valid = join(deps.knowledgeDir, 'a-valid.md');
      writeFileSync(valid, '# A valid file without an identity\n');
      writeFileSync(join(deps.knowledgeDir, 'z-invalid.md'), invalid);
      const result = await reindexKnowledgeFiles(deps);
      expect(result.indexed).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('z-invalid.md');
      expect(deps.withTransaction).not.toHaveBeenCalled();
      expect(readFileSync(valid, 'utf8')).toBe('# A valid file without an identity\n');
    },
  );

  it('rejects duplicate identities before indexing any files', async () => {
    const deps = fixture();
    for (const name of ['a.md', 'b.md']) {
      writeFileSync(join(deps.knowledgeDir, name), '---\nid: same\n---\nBody\n');
    }
    const result = await reindexKnowledgeFiles(deps);
    expect(result.indexed).toBe(0);
    expect(result.errors).toEqual([expect.stringContaining('Duplicate knowledge identity same')]);
    expect(deps.withTransaction).not.toHaveBeenCalled();
  });

  it('persists a generated identity before a failed transaction and reuses it on retry', async () => {
    const deps = fixture();
    const path = join(deps.knowledgeDir, 'legacy.md');
    writeFileSync(path, '---\ncustom: retained\n---\nLegacy body\n');
    deps.withTransaction.mockRejectedValueOnce(new Error('Graph temporarily unavailable'));
    const failed = await reindexKnowledgeFiles(deps);
    expect(failed.indexed).toBe(0);
    expect(failed.errors[0]).toContain('Graph temporarily unavailable');
    const saved = readBubbleFile(path);
    expect(saved.meta.id).toEqual(expect.any(String));
    expect(saved.meta).toHaveProperty('custom', 'retained');
    expect(saved.content).toBe('Legacy body');
    expect(await reindexKnowledgeFiles(deps)).toMatchObject({ indexed: 1, errors: [] });
    expect(deps.run.mock.calls[0][1]).toMatchObject({ id: saved.meta.id });
    expect(readBubbleFile(path).meta.id).toBe(saved.meta.id);
  });

  it('accepts legacy nullable defaults and YAML timestamps', async () => {
    const deps = fixture();
    writeFileSync(
      join(deps.knowledgeDir, 'legacy.md'),
      '---\nid: retained\ntitle: null\ntags: null\ncreated_at: 2026-01-01T00:00:00Z\n---\nBody\n',
    );
    expect(await reindexKnowledgeFiles(deps)).toMatchObject({ indexed: 1, errors: [] });
    expect(deps.run.mock.calls[0][1]).toMatchObject({
      id: 'retained',
      title: 'legacy',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('returns source edits and stale derived revisions for processor refresh', async () => {
    const deps = fixture();
    writeFileSync(
      join(deps.knowledgeDir, 'fresh.md'),
      '---\nid: fresh\ntitle: Fresh\ntags: [one]\n---\nFresh body\n',
    );
    writeFileSync(
      join(deps.knowledgeDir, 'stale.md'),
      '---\nid: stale\ntitle: Stale\ntags: [one]\n---\nStale body\n',
    );
    const staleRevision = knowledgeRevision({
      title: 'Stale',
      content: 'Stale body',
      tags: ['one'],
    });
    vi.mocked(deps.neo4j.query).mockResolvedValue([
      {
        id: 'fresh',
        sourceRevision: knowledgeRevision({ title: 'Fresh', content: 'Fresh body', tags: ['one'] }),
        embeddingRevision: 'old-embedding',
        chunkRevision: 'old-chunks',
      },
      {
        id: 'stale',
        sourceRevision: staleRevision,
        embeddingRevision: null,
        chunkRevision: staleRevision,
      },
    ]);

    const result = await reindexKnowledgeFiles(deps);

    expect(result).toMatchObject({ indexed: 2, errors: [], changedIds: ['fresh', 'stale'] });
    expect(deps.withTransaction).toHaveBeenCalledTimes(2);
    expect(deps.run.mock.calls[0][1]).toMatchObject({
      id: 'fresh',
      sourceRevision: expect.any(String),
    });
  });

  it('keeps an unchanged bubble out of the refresh set', async () => {
    const deps = fixture();
    writeFileSync(join(deps.knowledgeDir, 'same.md'), '---\nid: same\n---\nSame body\n');
    const sourceRevision = knowledgeRevision({ title: 'same', content: 'Same body', tags: [] });
    vi.mocked(deps.neo4j.query).mockResolvedValue([
      {
        id: 'same',
        sourceRevision,
        embeddingRevision: sourceRevision,
        chunkRevision: sourceRevision,
      },
    ]);

    const result = await reindexKnowledgeFiles(deps);

    expect(result.changedIds).toEqual([]);
    expect(result.indexed).toBe(1);
  });

  it('marks missing derived data stale even when revision properties match', async () => {
    const deps = fixture();
    writeFileSync(
      join(deps.knowledgeDir, 'missing-derived.md'),
      '---\nid: missing-derived\n---\nBody\n',
    );
    const sourceRevision = knowledgeRevision({
      title: 'missing-derived',
      content: 'Body',
      tags: [],
    });
    vi.mocked(deps.neo4j.query).mockResolvedValue([
      {
        id: 'missing-derived',
        sourceRevision,
        embeddingRevision: sourceRevision,
        chunkRevision: sourceRevision,
        embeddingCount: 0,
        chunkCount: 0,
      },
    ]);

    const result = await reindexKnowledgeFiles(deps);

    expect(result.changedIds).toEqual(['missing-derived']);
  });

  it('does not resurrect a bubble protected by a pending deletion intent', async () => {
    const deps = fixture();
    const raw = '---\nid: retiring\n---\nRetiring body\n';
    writeFileSync(join(deps.knowledgeDir, 'retiring.md'), raw);
    writePendingKnowledgeDeletion(deps.knowledgeDir, {
      id: 'retiring',
      filePath: 'retiring.md',
      fileHash: sha256(raw),
    });

    const result = await reindexKnowledgeFiles(deps);

    expect(result).toMatchObject({ indexed: 0, changedIds: [] });
    expect(result.errors).toEqual([expect.stringContaining('Pending deletion protects')]);
    expect(deps.neo4j.query).not.toHaveBeenCalled();
    expect(deps.withTransaction).not.toHaveBeenCalled();
  });

  it('fails closed when a pending deletion record is malformed', async () => {
    const deps = fixture();
    writeFileSync(join(deps.knowledgeDir, 'retiring.md'), '---\nid: retiring\n---\nBody\n');
    mkdirSync(join(deps.knowledgeDir, '.raven-pending-deletions'));
    writeFileSync(join(deps.knowledgeDir, '.raven-pending-deletions/bad.yaml'), 'id: [bad]\n');

    const result = await reindexKnowledgeFiles(deps);

    expect(result.indexed).toBe(0);
    expect(result.errors[0]).toContain('Pending knowledge deletion records are invalid');
    expect(deps.neo4j.query).not.toHaveBeenCalled();
    expect(deps.withTransaction).not.toHaveBeenCalled();
  });
});

describe('knowledge store disposal checkpoints', () => {
  it.each(['read', 'update', 'remove'])(
    'rejects a retained graph record whose file now belongs to another identity (%s)',
    async (operation) => {
      const { knowledgeDir } = fixture();
      const path = join(knowledgeDir, 'replaced.md');
      const replacement = '---\nid: replacement\n---\nReplacement body\n';
      writeFileSync(path, replacement);
      const neo4j = fakeGraph();
      vi.mocked(neo4j.queryOne).mockResolvedValue({
        filePath: 'replaced.md',
        node: { id: 'orphan', title: 'Orphan', filePath: 'replaced.md' },
      });
      const store = createKnowledgeStore({ neo4j, knowledgeDir });
      const action =
        operation === 'read'
          ? store.getById('orphan')
          : operation === 'update'
            ? store.update('orphan', { content: 'Overwrite' })
            : store.remove('orphan');
      await expect(action).rejects.toThrow('Knowledge file identity mismatch');
      expect(readFileSync(path, 'utf8')).toBe(replacement);
      expect(neo4j.run).not.toHaveBeenCalled();
      expect(neo4j.withTransaction).not.toHaveBeenCalled();
    },
  );

  it('does not rewrite or rename a file when its graph read completes after disposal', async () => {
    const { knowledgeDir } = fixture();
    const path = join(knowledgeDir, 'original.md');
    const original = '---\nid: original\ntitle: Original\n---\nOriginal body\n';
    writeFileSync(path, original);
    const neo4j = fakeGraph();
    const node = { id: 'original', title: 'Original', filePath: 'original.md' };
    const pendingRead = deferred<{ node: typeof node }>();
    vi.mocked(neo4j.queryOne).mockImplementation(() => pendingRead.promise);
    const controller = new AbortController();
    const store = createKnowledgeStore({ neo4j, knowledgeDir, signal: controller.signal });
    const update = store.update('original', { title: 'Renamed', content: 'Changed body' });
    const rejected = expect(update).rejects.toThrow();
    await vi.waitFor(() => expect(neo4j.queryOne).toHaveBeenCalledOnce());
    controller.abort();
    pendingRead.resolve({ node });
    await rejected;
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(neo4j.withTransaction).not.toHaveBeenCalled();
  });

  it('keeps the durable insert file if the graph transaction rejects after disposal', async () => {
    const { knowledgeDir } = fixture();
    const neo4j = fakeGraph();
    const pending = deferred<undefined>();
    vi.mocked(neo4j.withTransaction).mockImplementation(async () => {
      await pending.promise;
      throw new Error('Graph closed');
    });
    const controller = new AbortController();
    const store = createKnowledgeStore({ neo4j, knowledgeDir, signal: controller.signal });
    const insert = store.insert({ title: 'Recovery', content: 'Durable content', tags: [] });
    const rejected = expect(insert).rejects.toThrow('Graph closed');
    await vi.waitFor(() => expect(neo4j.withTransaction).toHaveBeenCalledOnce());
    controller.abort();
    pending.resolve(undefined);
    await rejected;
    expect(readBubbleFile(join(knowledgeDir, 'recovery.md')).content).toBe('Durable content');
  });

  it('does not delete a file after a pending graph delete completes during disposal', async () => {
    const { knowledgeDir } = fixture();
    const path = join(knowledgeDir, 'retained.md');
    writeFileSync(path, '---\nid: retained\n---\nRetained body');
    const neo4j = fakeGraph();
    vi.mocked(neo4j.queryOne).mockResolvedValue({ filePath: 'retained.md' });
    const pending = deferred<undefined>();
    vi.mocked(neo4j.withTransaction).mockImplementation(() => pending.promise);
    const controller = new AbortController();
    const store = createKnowledgeStore({ neo4j, knowledgeDir, signal: controller.signal });
    const remove = store.remove('retained');
    const rejected = expect(remove).rejects.toThrow();
    await vi.waitFor(() => expect(neo4j.withTransaction).toHaveBeenCalledOnce());
    controller.abort();
    pending.resolve(undefined);
    await rejected;
    expect(readBubbleFile(path).content).toBe('Retained body');
  });
});
