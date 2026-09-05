import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Neo4jContainer, type StartedNeo4jContainer } from '@testcontainers/neo4j';
import { createNeo4jClient } from '../knowledge-engine/neo4j-client.ts';
import { createKnowledgeStore } from '../knowledge-engine/knowledge-store.ts';
import type { KnowledgeStore } from '../knowledge-engine/knowledge-store.ts';
import type { Neo4jClient } from '../knowledge-engine/neo4j-client.ts';
import { readBubbleFile, sha256, writeBubbleFile } from '../knowledge-engine/knowledge-file.ts';
import {
  readPendingKnowledgeDeletions,
  writePendingKnowledgeDeletion,
} from '../knowledge-engine/knowledge-deletions.ts';

describe('KnowledgeStore', () => {
  let container: StartedNeo4jContainer;
  let neo4j: Neo4jClient;
  let tmpDir: string;
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
    try {
      if (neo4j) await neo4j.close();
    } finally {
      if (container) await container.stop();
    }
  });

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Clean graph state
    await neo4j.run('MATCH (n) DETACH DELETE n');
    tmpDir = mkdtempSync(join(tmpdir(), 'knowledge-store-'));
    knowledgeDir = join(tmpDir, 'knowledge');
    mkdirSync(knowledgeDir, { recursive: true });
    store = createKnowledgeStore({ neo4j, knowledgeDir });
  });

  it('reconciles actual Neo4j revisions, derived counts and file timestamps without writes', async () => {
    const bubble = await store.insert({
      title: 'Report fixture',
      content: 'Current body',
      tags: ['b', 'a'],
    });
    const before = readFileSync(join(knowledgeDir, bubble.filePath), 'utf8');
    const pending = await store.reconcile();
    expect(pending.issues).toEqual([
      expect.objectContaining({ code: 'stale-derived-index', id: bubble.id }),
    ]);
    await neo4j.run(
      `MATCH (b:Bubble {id: $id})
      SET b.embedding = $embedding, b.embeddingRevision = b.sourceRevision, b.chunkRevision = b.sourceRevision
      CREATE (b)-[:HAS_CHUNK]->(:Chunk {id: $chunkId, bubbleId: $id, text: 'Current body', embedding: $embedding})`,
      {
        id: bubble.id,
        chunkId: `${bubble.id}-chunk`,
        embedding: [1, ...Array<number>(383).fill(0)],
      },
    );
    expect((await store.reconcile()).issues).toEqual([]);
    await neo4j.run('MATCH (b:Bubble {id: $id}) SET b.updatedAt = $date', {
      id: bubble.id,
      date: '2000-01-01',
    });
    expect((await store.reconcile()).issues).toEqual([
      expect.objectContaining({ code: 'metadata-mismatch', id: bubble.id }),
    ]);
    expect(readFileSync(join(knowledgeDir, bubble.filePath), 'utf8')).toBe(before);
    await store.reindexAll();
    expect((await store.reconcile()).issues).toEqual([]);
  });

  describe('insert', () => {
    it('creates a markdown file with correct frontmatter', async () => {
      const bubble = await store.insert({
        title: 'SQLite Backup Strategies',
        content: 'WAL mode enables concurrent reads during backup...',
        tags: ['database', 'ops'],
        source: 'manual',
      });

      expect(bubble.id).toBeDefined();
      expect(bubble.title).toBe('SQLite Backup Strategies');
      expect(bubble.content).toBe('WAL mode enables concurrent reads during backup...');
      expect(bubble.tags).toEqual(['database', 'ops']);
      expect(bubble.source).toBe('manual');
      expect(bubble.filePath).toBe('sqlite-backup-strategies.md');
      expect(bubble.createdAt).toBeDefined();

      const filePath = join(knowledgeDir, bubble.filePath);
      expect(existsSync(filePath)).toBe(true);

      const raw = readFileSync(filePath, 'utf-8');
      expect(raw).toContain('title: SQLite Backup Strategies');
      expect(raw).toContain('WAL mode enables concurrent reads');
    });

    it('handles filename collisions by appending suffix', async () => {
      const b1 = await store.insert({ title: 'Test Title', content: 'First', tags: [] });
      const b2 = await store.insert({ title: 'Test Title', content: 'Second', tags: [] });

      expect(b1.filePath).toBe('test-title.md');
      expect(b2.filePath).toBe('test-title-2.md');
    });

    it('defaults source to null', async () => {
      const bubble = await store.insert({ title: 'No Source', content: '', tags: [] });
      expect(bubble.source).toBeNull();
    });
  });

  describe('getById', () => {
    it('returns bubble with full content', async () => {
      const created = await store.insert({
        title: 'Get Test',
        content: 'Full content here',
        tags: ['tag1'],
      });

      const found = await store.getById(created.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(created.id);
      expect(found!.content).toBe('Full content here');
      expect(found!.tags).toEqual(['tag1']);
    });

    it('returns undefined for nonexistent id', async () => {
      expect(await store.getById('nonexistent')).toBeUndefined();
    });
  });

  describe('update', () => {
    it('updates content', async () => {
      const created = await store.insert({ title: 'Update Test', content: 'Old', tags: [] });
      const updated = await store.update(created.id, { content: 'New content' });

      expect(updated).toBeDefined();
      expect(updated!.content).toBe('New content');
      expect(updated!.createdAt).toBe(created.createdAt);

      const read = await store.getById(created.id);
      expect(read!.content).toBe('New content');
    });

    it('renames file when title changes', async () => {
      const created = await store.insert({ title: 'Original Title', content: 'Content', tags: [] });
      expect(created.filePath).toBe('original-title.md');

      const updated = await store.update(created.id, { title: 'New Title' });
      expect(updated!.filePath).toBe('new-title.md');
      expect(existsSync(join(knowledgeDir, 'original-title.md'))).toBe(false);
      expect(existsSync(join(knowledgeDir, 'new-title.md'))).toBe(true);
    });

    it('updates tags', async () => {
      const created = await store.insert({ title: 'Tags Test', content: '', tags: ['old'] });
      const updated = await store.update(created.id, { tags: ['new1', 'new2'] });
      expect(updated!.tags).toEqual(['new1', 'new2']);
    });

    it('returns undefined for nonexistent id', async () => {
      expect(await store.update('nonexistent', { content: 'x' })).toBeUndefined();
    });
  });

  describe('remove', () => {
    it('deletes file and removes from index', async () => {
      const created = await store.insert({ title: 'Delete Test', content: 'Bye', tags: ['a'] });
      const result = await store.remove(created.id);

      expect(result).toBe(true);
      expect(existsSync(join(knowledgeDir, created.filePath))).toBe(false);
      expect(await store.getById(created.id)).toBeUndefined();
    });

    it('returns false for nonexistent id', async () => {
      expect(await store.remove('nonexistent')).toBe(false);
    });

    it('cascade removes tags from graph', async () => {
      const created = await store.insert({ title: 'Cascade', content: '', tags: ['unique-tag'] });
      await store.remove(created.id);
      const tags = await store.getAllTags();
      expect(tags.find((t) => t.tag === 'unique-tag')).toBeUndefined();
    });

    it('finishes a pending deletion after the graph record is already absent', async () => {
      const created = await store.insert({
        title: 'Pending retry',
        content: 'Retry this deletion',
        tags: [],
      });
      const path = join(knowledgeDir, created.filePath);
      const bytes = readFileSync(path, 'utf8');
      writePendingKnowledgeDeletion(knowledgeDir, {
        id: created.id,
        filePath: created.filePath,
        fileHash: sha256(bytes),
      });
      await neo4j.run('MATCH (b:Bubble {id: $id}) DETACH DELETE b', { id: created.id });

      expect(readPendingKnowledgeDeletions(knowledgeDir)).toHaveLength(1);
      expect(await store.remove(created.id)).toBe(true);
      expect(existsSync(path)).toBe(false);
      expect(readPendingKnowledgeDeletions(knowledgeDir)).toHaveLength(0);
    });
  });

  describe('list', () => {
    it('returns all bubbles with content preview', async () => {
      await store.insert({ title: 'A', content: 'Content A', tags: [] });
      await store.insert({ title: 'B', content: 'Content B', tags: [] });

      const results = await store.list({ limit: 50, offset: 0 });
      expect(results).toHaveLength(2);
      expect(results[0].contentPreview).toBeDefined();
    });

    it('filters by tag', async () => {
      await store.insert({ title: 'Tagged', content: '', tags: ['database'] });
      await store.insert({ title: 'Untagged', content: '', tags: ['other'] });

      const results = await store.list({ tag: 'database', limit: 50, offset: 0 });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Tagged');
    });

    it('filters by source', async () => {
      await store.insert({ title: 'Manual', content: '', tags: [], source: 'manual' });
      await store.insert({ title: 'Voice', content: '', tags: [], source: 'voice' });

      const results = await store.list({ source: 'manual', limit: 50, offset: 0 });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Manual');
    });

    it('respects limit and offset', async () => {
      for (let i = 0; i < 5; i++) {
        await store.insert({ title: `Bubble ${i}`, content: '', tags: [] });
      }

      const page1 = await store.list({ limit: 2, offset: 0 });
      const page2 = await store.list({ limit: 2, offset: 2 });

      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      expect(page1[0].id).not.toBe(page2[0].id);
    });
  });

  describe('search (fulltext)', () => {
    it('finds bubbles by title text', async () => {
      await store.insert({
        title: 'Event Driven Architecture',
        content: 'Some content about events',
        tags: [],
      });
      await store.insert({ title: 'Other Topic', content: 'Other', tags: [] });

      const results = await store.search('Event', 50, 0);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].title).toBe('Event Driven Architecture');
    });

    it('returns empty for no match', async () => {
      await store.insert({ title: 'Test', content: 'Content', tags: [] });
      const results = await store.search('nonexistentterm', 50, 0);
      expect(results).toHaveLength(0);
    });
  });

  describe('getAllTags', () => {
    it('returns tags with counts', async () => {
      await store.insert({ title: 'A', content: '', tags: ['db', 'ops'] });
      await store.insert({ title: 'B', content: '', tags: ['db'] });

      const tags = await store.getAllTags();
      const dbTag = tags.find((t) => t.tag === 'db');
      const opsTag = tags.find((t) => t.tag === 'ops');

      expect(dbTag?.count).toBe(2);
      expect(opsTag?.count).toBe(1);
    });
  });

  describe('reindexAll', () => {
    it('preserves an unmatched record without letting its stale path control a replacement file', async () => {
      const original = await store.insert({ title: 'Replaced', content: 'Original', tags: [] });
      const path = join(knowledgeDir, original.filePath);
      const parsed = readBubbleFile(path);
      writeBubbleFile(path, { ...parsed.meta, id: 'replacement' }, 'Replacement content');
      const replacementBytes = readFileSync(path, 'utf8');
      expect(await store.reindexAll()).toEqual({
        indexed: 1,
        errors: [],
        changedIds: ['replacement'],
      });
      expect((await store.getById('replacement'))?.content).toBe('Replacement content');
      await expect(store.getById(original.id)).rejects.toThrow('identity mismatch');
      await expect(store.update(original.id, { content: 'Overwrite' })).rejects.toThrow(
        'identity mismatch',
      );
      await expect(store.remove(original.id)).rejects.toThrow('identity mismatch');
      expect(readFileSync(path, 'utf8')).toBe(replacementBytes);
      expect(
        await neo4j.queryOne('MATCH (b:Bubble {id: $id}) RETURN b.id AS id', { id: original.id }),
      ).toEqual({ id: original.id });
    });

    it('rebuilds index from files on disk', async () => {
      const original = await store.insert({
        title: 'Persist',
        content: 'Will survive reindex',
        tags: ['test'],
      });

      // Clear Neo4j bubble nodes
      await neo4j.run('MATCH (b:Bubble) DETACH DELETE b');

      // Verify empty
      expect(await store.list({ limit: 50, offset: 0 })).toHaveLength(0);

      // Reindex
      const result = await store.reindexAll();
      expect(result.indexed).toBe(1);
      expect(result.errors).toHaveLength(0);
      expect(result.changedIds).toEqual([original.id]);

      const list = await store.list({ limit: 50, offset: 0 });
      expect(list).toHaveLength(1);
      expect(list[0].title).toBe('Persist');
      expect(list[0].id).toBe(original.id);
      expect(list[0].filePath).toBe(original.filePath);
    });

    it('generates id for files without one in frontmatter', async () => {
      const content = [
        '---',
        'title: Manual Note',
        'tags:',
        '  - test',
        'source: manual',
        'created_at: "2026-03-17T00:00:00.000Z"',
        'updated_at: "2026-03-17T00:00:00.000Z"',
        '---',
        '',
        'Hand-written note content',
      ].join('\n');
      writeFileSync(join(knowledgeDir, 'manual-note.md'), content, 'utf-8');

      const result = await store.reindexAll();
      expect(result.indexed).toBe(1);

      const raw = readFileSync(join(knowledgeDir, 'manual-note.md'), 'utf-8');
      expect(raw).toContain('id:');
    });

    async function graphSnapshot(includeTags = false) {
      const nodes = await neo4j.query(
        'MATCH (n) RETURN elementId(n) AS nodeId, labels(n) AS labels, properties(n) AS properties ORDER BY nodeId',
      );
      // HAS_TAG is a rebuildable file index. Every other edge owns durable
      // graph information and must retain both identity and properties.
      const relationships = await neo4j.query(
        `MATCH (a)-[r]->(b) WHERE $includeTags OR type(r) <> 'HAS_TAG'
         RETURN elementId(r) AS edgeId, elementId(a) AS sourceId, elementId(b) AS targetId,
                type(r) AS type, properties(r) AS properties ORDER BY edgeId`,
        { includeTags },
      );
      return { nodes, relationships };
    }

    async function seedLinkedBubbles() {
      const bubble = await store.insert({
        title: 'Linked Note',
        content: 'Original file content',
        tags: ['old'],
      });
      const other = await store.insert({
        title: 'Related Note',
        content: 'Related content',
        tags: ['related'],
      });
      const embedding = Array.from({ length: 384 }, (_, index) => (index === 0 ? 0.5 : 0.1));
      await neo4j.run(
        `MATCH (b:Bubble {id: $id}), (other:Bubble {id: $otherId})
         SET b.permanence = 'robust', b.lastAccessedAt = $accessedAt, b.embedding = $embedding,
             b.status = 'reviewed', b.snoozedUntil = $snoozedUntil
         CREATE (project:Project {id: 'project-fixture', name: 'Fixture project'})
         CREATE (domain:Domain {name: 'fixture-domain'})
         CREATE (chunk:Chunk {id: 'fixture-chunk', text: 'Original chunk'})
         CREATE (cluster:Cluster {id: 'fixture-cluster', name: 'Fixture cluster'})
         CREATE (b)-[:BELONGS_TO_PROJECT {linkedBy: 'owner', createdAt: $createdAt}]->(project)
         CREATE (b)-[:IN_DOMAIN]->(domain)
         CREATE (b)-[:HAS_CHUNK]->(chunk)
         CREATE (b)-[:IN_CLUSTER]->(cluster)
         CREATE (b)-[:LINKS_TO {id: 'accepted-link', relationshipType: 'supports',
           confidence: 0.9, autoSuggested: false, status: 'accepted', createdAt: $createdAt}]->(other)
         CREATE (other)-[:LINKS_TO {id: 'dismissed-link', relationshipType: 'contradicts',
           confidence: 0.4, autoSuggested: true, status: 'dismissed', createdAt: $createdAt}]->(b)`,
        {
          id: bubble.id,
          otherId: other.id,
          embedding,
          accessedAt: '2026-06-01T10:00:00Z',
          snoozedUntil: '2026-12-01T10:00:00Z',
          createdAt: '2026-05-01T10:00:00Z',
        },
      );
      await neo4j.run(
        `MATCH (:Bubble {id: $id})-[r:HAS_TAG]->(:Tag {name: 'old'})
         SET r.annotation = 'human-curated', r.weight = 7`,
        { id: bubble.id },
      );
      return { bubble, other, embedding };
    }

    it('repeated reindex preserves node identity, graph metadata, memberships and typed-link decisions', async () => {
      const { bubble, other, embedding } = await seedLinkedBubbles();
      const before = await graphSnapshot();
      for (let pass = 0; pass < 2; pass++) {
        expect(await store.reindexAll()).toEqual({
          indexed: 2,
          errors: [],
          changedIds: [bubble.id, other.id],
        });
        expect(await graphSnapshot()).toEqual(before);
      }
      expect((await store.list({ limit: 50, offset: 0 })).map((item) => item.id).sort()).toEqual(
        [bubble.id, other.id].sort(),
      );
      expect(
        await neo4j.queryOne(
          `MATCH (b:Bubble {id: $id}) RETURN b.permanence AS permanence,
         b.lastAccessedAt AS lastAccessedAt, b.embedding AS embedding, b.status AS status`,
          { id: bubble.id },
        ),
      ).toEqual({
        permanence: 'robust',
        lastAccessedAt: '2026-06-01T10:00:00Z',
        embedding,
        status: 'reviewed',
      });
      expect(
        await neo4j.queryOne('MATCH (:Bubble {id: $id})-[r:HAS_TAG]->() RETURN count(r) AS count', {
          id: bubble.id,
        }),
      ).toEqual({ count: 1 });
    });

    it('refreshes changed file fields and exact tags without duplicating tags or disturbing other edges', async () => {
      const { bubble, other, embedding } = await seedLinkedBubbles();
      const before = await graphSnapshot();
      const path = join(knowledgeDir, bubble.filePath);
      const parsed = readBubbleFile(path);
      writeBubbleFile(
        path,
        {
          ...parsed.meta,
          title: 'Edited on disk',
          tags: ['old', 'new', 'shared', 'new'],
          source: 'manual-edit',
          updated_at: '2026-07-01T10:00:00Z',
        },
        'Changed file content',
      );
      expect(await store.reindexAll()).toEqual({
        indexed: 2,
        errors: [],
        changedIds: [bubble.id, other.id],
      });
      expect(await store.reindexAll()).toEqual({
        indexed: 2,
        errors: [],
        changedIds: [bubble.id, other.id],
      });
      expect((await graphSnapshot()).relationships).toEqual(before.relationships);
      expect(
        await neo4j.queryOne(
          `MATCH (b:Bubble {id: $id}) RETURN b.title AS title, b.contentPreview AS preview,
         b.source AS source, b.updatedAt AS updatedAt, b.permanence AS permanence, b.embedding AS embedding`,
          { id: bubble.id },
        ),
      ).toEqual({
        title: 'Edited on disk',
        preview: 'Changed file content',
        source: 'manual-edit',
        updatedAt: '2026-07-01T10:00:00Z',
        permanence: 'robust',
        embedding,
      });
      expect(
        await neo4j.query(
          `MATCH (:Bubble {id: $id})-[r:HAS_TAG]->(t:Tag)
         RETURN t.name AS tag, count(r) AS count ORDER BY tag`,
          { id: bubble.id },
        ),
      ).toEqual([
        { tag: 'new', count: 1 },
        { tag: 'old', count: 1 },
        { tag: 'shared', count: 1 },
      ]);
      expect(
        await neo4j.query(
          `MATCH (:Bubble {id: $id})-[r:HAS_TAG]->(:Tag {name: 'old'})
           RETURN r.annotation AS annotation, r.weight AS weight`,
          { id: bubble.id },
        ),
      ).toEqual([{ annotation: 'human-curated', weight: 7 }]);
    });

    it.each(['empty', 'missing', 'malformed'])(
      'preserves unmatched graph records with a %s knowledge directory',
      async (kind) => {
        await seedLinkedBubbles();
        const before = await graphSnapshot(true);
        const alternateDir = join(tmpDir, kind);
        if (kind !== 'missing') mkdirSync(alternateDir);
        if (kind === 'malformed')
          writeFileSync(join(alternateDir, 'broken.md'), '---\ntitle: [unterminated\n---\nBroken');
        const alternate = createKnowledgeStore({ neo4j, knowledgeDir: alternateDir });
        const result = await alternate.reindexAll();
        expect(result.indexed).toBe(0);
        expect(result.errors).toHaveLength(kind === 'malformed' ? 1 : 0);
        expect(await graphSnapshot(true)).toEqual(before);
      },
    );

    it('rejects duplicate file IDs before changing any graph record, including otherwise valid edits', async () => {
      const { bubble, other } = await seedLinkedBubbles();
      const before = await graphSnapshot(true);
      const originalPath = join(knowledgeDir, bubble.filePath);
      writeFileSync(join(knowledgeDir, 'duplicate.md'), readFileSync(originalPath, 'utf8'));
      const otherPath = join(knowledgeDir, other.filePath);
      const parsed = readBubbleFile(otherPath);
      writeBubbleFile(
        otherPath,
        { ...parsed.meta, title: 'Must not reach graph' },
        'Uncommitted index refresh',
      );
      const result = await store.reindexAll();
      expect(result.indexed).toBe(0);
      expect(result.errors.join('\n')).toMatch(/duplicate/i);
      expect(await graphSnapshot(true)).toEqual(before);
    });
  });

  describe('getContentPreview', () => {
    it('returns content preview for existing bubble', async () => {
      const bubble = await store.insert({
        title: 'Preview Test',
        content: 'This is some content that should appear as preview',
        tags: [],
      });
      const preview = await store.getContentPreview(bubble.id);
      expect(preview).toContain('This is some content');
    });

    it('returns undefined for nonexistent bubble', async () => {
      expect(await store.getContentPreview('nonexistent')).toBeUndefined();
    });
  });
});
