import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Neo4jContainer, type StartedNeo4jContainer } from '@testcontainers/neo4j';
import { createNeo4jClient } from '../knowledge-engine/neo4j-client.ts';
import { createKnowledgeStore } from '../knowledge-engine/knowledge-store.ts';
import type { KnowledgeStore } from '../knowledge-engine/knowledge-store.ts';
import type { Neo4jClient } from '../knowledge-engine/neo4j-client.ts';

describe('KnowledgeStore', () => {
  let container: StartedNeo4jContainer;
  let neo4j: Neo4jClient;
  let tmpDir: string;
  let knowledgeDir: string;
  let store: KnowledgeStore;

  beforeAll(async () => {
    container = await new Neo4jContainer('neo4j:5-community').withApoc().start();
    neo4j = createNeo4jClient({
      uri: container.getBoltUri(),
      user: 'neo4j',
      password: container.getPassword(),
    });
    await neo4j.ensureSchema();
  }, 120_000);

  afterAll(async () => {
    await neo4j.close();
    await container.stop();
  });

  beforeEach(async () => {
    // Clean graph state
    await neo4j.run('MATCH (n) DETACH DELETE n');
    tmpDir = mkdtempSync(join(tmpdir(), 'knowledge-store-'));
    knowledgeDir = join(tmpDir, 'knowledge');
    mkdirSync(knowledgeDir, { recursive: true });
    store = createKnowledgeStore({ neo4j, knowledgeDir });
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
    it('rebuilds index from files on disk', async () => {
      await store.insert({ title: 'Persist', content: 'Will survive reindex', tags: ['test'] });

      // Clear Neo4j bubble nodes
      await neo4j.run('MATCH (b:Bubble) DETACH DELETE b');

      // Verify empty
      expect(await store.list({ limit: 50, offset: 0 })).toHaveLength(0);

      // Reindex
      const result = await store.reindexAll();
      expect(result.indexed).toBe(1);
      expect(result.errors).toHaveLength(0);

      const list = await store.list({ limit: 50, offset: 0 });
      expect(list).toHaveLength(1);
      expect(list[0].title).toBe('Persist');
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
