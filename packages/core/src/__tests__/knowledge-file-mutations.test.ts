import { describe, expect, it, vi } from 'vitest';
import type * as Fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ManagedTransaction, QueryResult } from 'neo4j-driver';
import { createKnowledgeStore } from '../knowledge-engine/knowledge-store.ts';
import type { Neo4jClient } from '../knowledge-engine/neo4j-client.ts';
import { readBubbleFile, writeBubbleFile } from '../knowledge-engine/knowledge-file.ts';
import { readPendingKnowledgeDeletions } from '../knowledge-engine/knowledge-deletions.ts';

const fsFaults = vi.hoisted(() => ({ write: false, rename: false }));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof Fs>('node:fs');
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (fsFaults.write) {
        fsFaults.write = false;
        throw new Error('injected knowledge write fault');
      }
      return actual.writeFileSync(...args);
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (fsFaults.rename) {
        fsFaults.rename = false;
        throw new Error('injected knowledge rename fault');
      }
      return actual.renameSync(...args);
    },
  };
});

interface BubbleNode {
  id: string;
  title: string;
  filePath: string;
  source: string | null;
  sourceFile: string | null;
  sourceUrl: string | null;
  permanence: string;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string | null;
  sourceRevision?: string;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FakeGraph implements Neo4jClient {
  readonly nodes = new Map<string, BubbleNode>();
  readonly tags = new Map<string, string[]>();
  failDelete = false;
  failUpdate = false;
  holdNextTransaction?: { promise: Promise<void>; resolve: () => void };
  transactionHeld?: Promise<void>;

  async run(cypher: string, params: Record<string, unknown> = {}): Promise<QueryResult> {
    const id = params.id as string | undefined;
    if (cypher.includes('SET b.lastAccessedAt')) {
      const node = this.nodes.get(id!);
      if (node) node.lastAccessedAt = params.now as string;
    } else if (cypher.includes('DETACH DELETE b')) {
      if (this.failDelete) {
        this.failDelete = false;
        throw new Error('injected graph delete fault');
      }
      this.nodes.delete(id!);
      this.tags.delete(id!);
    }
    return { records: [] } as unknown as QueryResult;
  }

  async query<T>(cypher: string, params: Record<string, unknown> = {}): Promise<T[]> {
    if (cypher.includes('HAS_TAG')) {
      return (this.tags.get(params.id as string) ?? []).map((name) => ({ name })) as T[];
    }
    if (cypher.includes('IN_DOMAIN')) return [];
    return [...this.nodes.values()].map((node) => ({ node, ...node })) as T[];
  }

  async queryOne<T>(cypher: string, params: Record<string, unknown> = {}): Promise<T | undefined> {
    const id = params.id as string | undefined;
    const node = id === undefined ? undefined : this.nodes.get(id);
    if (node === undefined) return undefined;
    if (cypher.includes('filePath') && !cypher.includes('node'))
      return { filePath: node.filePath } as T;
    return { node: { ...node } } as T;
  }

  async withTransaction<T>(fn: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
    if (this.failUpdate) {
      this.failUpdate = false;
      throw new Error('injected graph update fault');
    }
    const held = this.holdNextTransaction;
    this.holdNextTransaction = undefined;
    if (held) {
      this.transactionHeld = held.promise;
      await held.promise;
      this.transactionHeld = undefined;
    }
    const tx = {
      run: async (cypher: string, params: Record<string, unknown> = {}) => {
        const id = params.id as string | undefined;
        if (cypher.includes('CREATE (b:Bubble')) {
          this.nodes.set(id!, {
            id: id!,
            title: params.title as string,
            filePath: params.filePath as string,
            source: params.source as string | null,
            sourceFile: params.sourceFile as string | null,
            sourceUrl: params.sourceUrl as string | null,
            permanence: params.permanence as string,
            createdAt: params.createdAt as string,
            updatedAt: params.updatedAt as string,
            lastAccessedAt: params.lastAccessedAt as string,
            sourceRevision: params.sourceRevision as string,
          });
        } else if (cypher.includes('SET b.title')) {
          const node = this.nodes.get(id!);
          if (node)
            Object.assign(node, {
              title: params.title,
              filePath: params.filePath,
              source: params.source,
              sourceFile: params.sourceFile,
              sourceUrl: params.sourceUrl,
              updatedAt: params.updatedAt,
              sourceRevision: params.sourceRevision,
            });
        } else if (cypher.includes('WHERE NOT t.name IN')) {
          const current = this.tags.get(id!) ?? [];
          this.tags.set(
            id!,
            current.filter((tag) => (params.tags as string[]).includes(tag)),
          );
        } else if (cypher.includes('MERGE (t:Tag')) {
          const current = this.tags.get(params.bubbleId as string) ?? [];
          if (!current.includes(params.tag as string)) current.push(params.tag as string);
          this.tags.set(params.bubbleId as string, current);
        } else if (cypher.includes('DETACH DELETE b')) {
          if (this.failDelete) {
            this.failDelete = false;
            throw new Error('injected graph delete fault');
          }
          this.nodes.delete(id!);
          this.tags.delete(id!);
        }
        return { records: [] } as unknown as QueryResult;
      },
    };
    return fn(tx as unknown as ManagedTransaction);
  }

  async ensureSchema(): Promise<void> {}
  async close(): Promise<void> {}
}

function setup(): {
  root: string;
  graph: FakeGraph;
  store: ReturnType<typeof createKnowledgeStore>;
} {
  const root = mkdtempSync(join(tmpdir(), 'raven-knowledge-files-'));
  const knowledgeDir = join(root, 'knowledge');
  mkdirSync(knowledgeDir);
  const graph = new FakeGraph();
  return { root, graph, store: createKnowledgeStore({ neo4j: graph, knowledgeDir }) };
}

describe('knowledge file authority and mutations', () => {
  it('returns edited title, content, timestamps, source and tags from Markdown', async () => {
    const state = setup();
    try {
      const created = await state.store.insert({
        title: 'Original',
        content: 'old',
        tags: ['old'],
      });
      const path = join(state.root, 'knowledge', created.filePath);
      const parsed = readBubbleFile(path);
      writeBubbleFile(
        path,
        {
          ...parsed.meta,
          title: 'Edited title',
          tags: ['new'],
          updated_at: '2026-09-05T00:00:00.000Z',
        },
        'edited body',
      );
      const found = await state.store.getById(created.id, { trackAccess: false });
      expect(found).toMatchObject({ title: 'Edited title', content: 'edited body', tags: ['new'] });
      expect(found?.updatedAt).toBe('2026-09-05T00:00:00.000Z');
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('updates through an atomic replacement and preserves retained graph tags', async () => {
    const state = setup();
    try {
      const created = await state.store.insert({
        title: 'Rename me',
        content: 'old',
        tags: ['keep', 'drop'],
      });
      await state.store.update(created.id, {
        title: 'Renamed',
        content: 'new',
        tags: ['keep', 'add'],
      });
      expect(existsSync(join(state.root, 'knowledge', created.filePath))).toBe(false);
      expect(existsSync(join(state.root, 'knowledge', 'renamed.md'))).toBe(true);
      expect(state.graph.tags.get(created.id)).toEqual(['keep', 'add']);
      expect(readFileSync(join(state.root, 'knowledge', 'renamed.md'), 'utf8')).toContain('new');
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('retains both source versions when graph update fails', async () => {
    const state = setup();
    try {
      const created = await state.store.insert({
        title: 'Graph failure',
        content: 'old',
        tags: [],
      });
      state.graph.failUpdate = true;
      await expect(
        state.store.update(created.id, { title: 'New title', content: 'new' }),
      ).rejects.toThrow('injected graph update fault');
      expect(existsSync(join(state.root, 'knowledge', created.filePath))).toBe(true);
      expect(existsSync(join(state.root, 'knowledge', 'new-title.md'))).toBe(true);
      await expect(state.store.update(created.id, { content: 'recovered' })).resolves.toMatchObject(
        {
          content: 'recovered',
        },
      );
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('serializes update and removal while a graph transaction is held', async () => {
    const state = setup();
    try {
      const created = await state.store.insert({
        title: 'Queued mutation',
        content: 'old',
        tags: [],
      });
      const gate = deferred();
      state.graph.holdNextTransaction = gate;
      const update = state.store.update(created.id, { title: 'Queued rename', content: 'new' });
      await expect.poll(() => state.graph.transactionHeld !== undefined).toBe(true);
      const remove = state.store.remove(created.id);
      await Promise.resolve();
      expect(state.graph.nodes.has(created.id)).toBe(true);
      expect(readPendingKnowledgeDeletions(join(state.root, 'knowledge'))).toEqual([]);
      gate.resolve();
      await expect(update).resolves.toMatchObject({ title: 'Queued rename' });
      await expect(remove).resolves.toBe(true);
      expect(state.graph.nodes.has(created.id)).toBe(false);
      expect(readPendingKnowledgeDeletions(join(state.root, 'knowledge'))).toEqual([]);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('keeps original bytes when atomic knowledge replacement fails at write or rename', async () => {
    const state = setup();
    try {
      const created = await state.store.insert({
        title: 'Atomic source',
        content: 'original',
        tags: [],
      });
      const path = join(state.root, 'knowledge', created.filePath);
      const before = readFileSync(path, 'utf8');
      fsFaults.write = true;
      await expect(state.store.update(created.id, { content: 'new' })).rejects.toThrow(
        'injected knowledge write fault',
      );
      expect(readFileSync(path, 'utf8')).toBe(before);
      fsFaults.rename = true;
      await expect(state.store.update(created.id, { content: 'new' })).rejects.toThrow(
        'injected knowledge rename fault',
      );
      expect(readFileSync(path, 'utf8')).toBe(before);
      await state.store.update(created.id, { content: 'new' });
      expect(readFileSync(path, 'utf8')).toContain('new');
    } finally {
      fsFaults.write = false;
      fsFaults.rename = false;
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('records deletion before graph mutation and retries after graph failure', async () => {
    const state = setup();
    try {
      const created = await state.store.insert({
        title: 'Pending delete',
        content: 'keep',
        tags: [],
      });
      state.graph.failDelete = true;
      await expect(state.store.remove(created.id)).rejects.toThrow('injected graph delete fault');
      expect(readPendingKnowledgeDeletions(join(state.root, 'knowledge'))).toEqual([
        expect.objectContaining({ id: created.id, filePath: created.filePath }),
      ]);
      expect(existsSync(join(state.root, 'knowledge', created.filePath))).toBe(true);
      state.graph.nodes.delete(created.id);
      expect(await state.store.remove(created.id)).toBe(true);
      expect(existsSync(join(state.root, 'knowledge', created.filePath))).toBe(false);
      expect(readPendingKnowledgeDeletions(join(state.root, 'knowledge'))).toEqual([]);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });

  it('never deletes a source modified after a pending deletion was written', async () => {
    const state = setup();
    try {
      const created = await state.store.insert({
        title: 'Modified delete',
        content: 'original',
        tags: [],
      });
      state.graph.failDelete = true;
      await expect(state.store.remove(created.id)).rejects.toThrow('injected graph delete fault');
      const path = join(state.root, 'knowledge', created.filePath);
      const parsed = readBubbleFile(path);
      writeBubbleFile(path, parsed.meta, 'external edit');
      state.graph.nodes.delete(created.id);
      await expect(state.store.remove(created.id)).rejects.toThrow('changed before deletion');
      expect(readFileSync(path, 'utf8')).toContain('external edit');
      expect(readPendingKnowledgeDeletions(join(state.root, 'knowledge'))).toHaveLength(1);
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  });
});
