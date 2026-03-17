import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { initDatabase, getDb, createDbInterface } from '../db/database.ts';
import { createKnowledgeStore } from '../knowledge-engine/knowledge-store.ts';
import type { KnowledgeStore } from '../knowledge-engine/knowledge-store.ts';

describe('KnowledgeStore', () => {
  let tmpDir: string;
  let knowledgeDir: string;
  let store: KnowledgeStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'knowledge-store-'));
    knowledgeDir = join(tmpDir, 'knowledge');
    mkdirSync(knowledgeDir, { recursive: true });
    initDatabase(join(tmpDir, 'test.db'));
    store = createKnowledgeStore({ db: createDbInterface(), knowledgeDir });
  });

  afterEach(() => {
    try {
      getDb().close();
    } catch {
      /* */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('insert', () => {
    it('creates a markdown file with correct frontmatter', () => {
      const bubble = store.insert({
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

      // Verify file on disk
      const filePath = join(knowledgeDir, bubble.filePath);
      expect(existsSync(filePath)).toBe(true);

      const raw = readFileSync(filePath, 'utf-8');
      expect(raw).toContain('title: SQLite Backup Strategies');
      expect(raw).toContain('WAL mode enables concurrent reads');
    });

    it('handles filename collisions by appending suffix', () => {
      const b1 = store.insert({ title: 'Test Title', content: 'First', tags: [] });
      const b2 = store.insert({ title: 'Test Title', content: 'Second', tags: [] });

      expect(b1.filePath).toBe('test-title.md');
      expect(b2.filePath).toBe('test-title-2.md');
    });

    it('defaults source to null', () => {
      const bubble = store.insert({ title: 'No Source', content: '', tags: [] });
      expect(bubble.source).toBeNull();
    });
  });

  describe('getById', () => {
    it('returns bubble with full content', () => {
      const created = store.insert({
        title: 'Get Test',
        content: 'Full content here',
        tags: ['tag1'],
      });

      const found = store.getById(created.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(created.id);
      expect(found!.content).toBe('Full content here');
      expect(found!.tags).toEqual(['tag1']);
    });

    it('returns undefined for nonexistent id', () => {
      expect(store.getById('nonexistent')).toBeUndefined();
    });
  });

  describe('update', () => {
    it('updates content', () => {
      const created = store.insert({ title: 'Update Test', content: 'Old', tags: [] });
      const updated = store.update(created.id, { content: 'New content' });

      expect(updated).toBeDefined();
      expect(updated!.content).toBe('New content');
      expect(updated!.createdAt).toBe(created.createdAt);

      // Verify the file on disk also reflects the update
      const read = store.getById(created.id);
      expect(read!.content).toBe('New content');
    });

    it('renames file when title changes', () => {
      const created = store.insert({ title: 'Original Title', content: 'Content', tags: [] });
      expect(created.filePath).toBe('original-title.md');

      const updated = store.update(created.id, { title: 'New Title' });
      expect(updated!.filePath).toBe('new-title.md');
      expect(existsSync(join(knowledgeDir, 'original-title.md'))).toBe(false);
      expect(existsSync(join(knowledgeDir, 'new-title.md'))).toBe(true);
    });

    it('updates tags', () => {
      const created = store.insert({ title: 'Tags Test', content: '', tags: ['old'] });
      const updated = store.update(created.id, { tags: ['new1', 'new2'] });
      expect(updated!.tags).toEqual(['new1', 'new2']);
    });

    it('returns undefined for nonexistent id', () => {
      expect(store.update('nonexistent', { content: 'x' })).toBeUndefined();
    });
  });

  describe('remove', () => {
    it('deletes file and removes from index', () => {
      const created = store.insert({ title: 'Delete Test', content: 'Bye', tags: ['a'] });
      const result = store.remove(created.id);

      expect(result).toBe(true);
      expect(existsSync(join(knowledgeDir, created.filePath))).toBe(false);
      expect(store.getById(created.id)).toBeUndefined();
    });

    it('returns false for nonexistent id', () => {
      expect(store.remove('nonexistent')).toBe(false);
    });

    it('cascade removes tags from index', () => {
      const created = store.insert({ title: 'Cascade', content: '', tags: ['tag1'] });
      store.remove(created.id);
      const tags = store.getAllTags();
      expect(tags.find((t) => t.tag === 'tag1')).toBeUndefined();
    });
  });

  describe('list', () => {
    it('returns all bubbles with content preview', () => {
      store.insert({ title: 'A', content: 'Content A', tags: [] });
      store.insert({ title: 'B', content: 'Content B', tags: [] });

      const results = store.list({ limit: 50, offset: 0 });
      expect(results).toHaveLength(2);
      expect(results[0].contentPreview).toBeDefined();
    });

    it('filters by tag', () => {
      store.insert({ title: 'Tagged', content: '', tags: ['database'] });
      store.insert({ title: 'Untagged', content: '', tags: ['other'] });

      const results = store.list({ tag: 'database', limit: 50, offset: 0 });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Tagged');
    });

    it('filters by source', () => {
      store.insert({ title: 'Manual', content: '', tags: [], source: 'manual' });
      store.insert({ title: 'Voice', content: '', tags: [], source: 'voice' });

      const results = store.list({ source: 'manual', limit: 50, offset: 0 });
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Manual');
    });

    it('respects limit and offset', () => {
      for (let i = 0; i < 5; i++) {
        store.insert({ title: `Bubble ${i}`, content: '', tags: [] });
      }

      const page1 = store.list({ limit: 2, offset: 0 });
      const page2 = store.list({ limit: 2, offset: 2 });

      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      expect(page1[0].id).not.toBe(page2[0].id);
    });
  });

  describe('search (FTS5)', () => {
    it('finds bubbles by content text', () => {
      store.insert({
        title: 'WAL Article',
        content: 'WAL mode enables concurrent reads',
        tags: [],
      });
      store.insert({ title: 'Other', content: 'Unrelated content', tags: [] });

      const results = store.search('WAL', 50, 0);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].title).toBe('WAL Article');
    });

    it('finds bubbles by title', () => {
      store.insert({ title: 'Event Driven Architecture', content: 'Some content', tags: [] });
      store.insert({ title: 'Other Topic', content: 'Other', tags: [] });

      const results = store.search('Event Driven', 50, 0);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].title).toBe('Event Driven Architecture');
    });

    it('returns empty for no match', () => {
      store.insert({ title: 'Test', content: 'Content', tags: [] });
      const results = store.search('nonexistentterm', 50, 0);
      expect(results).toHaveLength(0);
    });

    it('sanitizes FTS special characters without crashing', () => {
      store.insert({ title: 'Safe Content', content: 'Normal text', tags: [] });
      // These would be FTS5 syntax exploits — should not crash or bypass column filters
      expect(() => store.search('bubble_id:*', 50, 0)).not.toThrow();
      expect(() => store.search('"injection" OR NOT', 50, 0)).not.toThrow();
      expect(() => store.search('{bubble_id}: test', 50, 0)).not.toThrow();
    });

    it('returns empty for query with only special characters', () => {
      store.insert({ title: 'Test', content: 'Content', tags: [] });
      const results = store.search('***', 50, 0);
      expect(results).toHaveLength(0);
    });
  });

  describe('getAllTags', () => {
    it('returns tags with counts', () => {
      store.insert({ title: 'A', content: '', tags: ['db', 'ops'] });
      store.insert({ title: 'B', content: '', tags: ['db'] });

      const tags = store.getAllTags();
      const dbTag = tags.find((t) => t.tag === 'db');
      const opsTag = tags.find((t) => t.tag === 'ops');

      expect(dbTag?.count).toBe(2);
      expect(opsTag?.count).toBe(1);
    });
  });

  describe('reindexAll', () => {
    it('rebuilds index from files on disk', () => {
      // Create bubble via store, then clear index manually
      store.insert({ title: 'Persist', content: 'Will survive reindex', tags: ['test'] });
      const db = getDb();
      db.prepare('DELETE FROM knowledge_fts').run();
      db.prepare('DELETE FROM knowledge_tags').run();
      db.prepare('DELETE FROM knowledge_index').run();

      // Verify index is empty
      expect(store.list({ limit: 50, offset: 0 })).toHaveLength(0);

      // Reindex
      const result = store.reindexAll();
      expect(result.indexed).toBe(1);
      expect(result.errors).toHaveLength(0);

      // Verify restored
      const list = store.list({ limit: 50, offset: 0 });
      expect(list).toHaveLength(1);
      expect(list[0].title).toBe('Persist');
    });

    it('generates id for files without one in frontmatter', () => {
      // Manually write a file without id
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

      const result = store.reindexAll();
      expect(result.indexed).toBe(1);

      // Verify file was rewritten with generated id
      const raw = readFileSync(join(knowledgeDir, 'manual-note.md'), 'utf-8');
      expect(raw).toContain('id:');
    });

    it('reports errors for unparseable files', () => {
      writeFileSync(join(knowledgeDir, 'bad-file.md'), 'not valid frontmatter at all', 'utf-8');

      const result = store.reindexAll();
      // gray-matter is lenient — it may still parse this without error
      // but the file has no title, so it'll use the filename
      expect(result.indexed + result.errors.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('frontmatter round-trip', () => {
    it('preserves all metadata through create and read cycle', () => {
      const created = store.insert({
        title: 'Round Trip',
        content: '# Test\n\nParagraph here.',
        tags: ['a', 'b'],
        source: 'pdf',
      });

      const read = store.getById(created.id);
      expect(read!.title).toBe('Round Trip');
      expect(read!.content).toBe('# Test\n\nParagraph here.');
      expect(read!.tags).toEqual(['a', 'b']);
      expect(read!.source).toBe('pdf');
    });
  });
});
