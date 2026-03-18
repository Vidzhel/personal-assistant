import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, getDb, createDbInterface } from '../db/database.ts';
import {
  computeSuppressionHash,
  insertInsight,
  getInsightsByStatus,
  updateInsightStatus,
  findRecentByHash,
} from '../insight-engine/insight-store.ts';
import type { DatabaseInterface } from '@raven/shared';

describe('insight-store', () => {
  let tmpDir: string;
  let db: DatabaseInterface;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-insight-test-'));
    const dbPath = join(tmpDir, 'test.db');
    initDatabase(dbPath);
    db = createDbInterface();
  });

  afterEach(() => {
    try {
      getDb().close();
    } catch {
      // ignore
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('computeSuppressionHash', () => {
    it('produces same hash for same pattern and key facts', () => {
      const h1 = computeSuppressionHash('meeting-overload', ['meetings:4', 'week:2026-W12']);
      const h2 = computeSuppressionHash('meeting-overload', ['meetings:4', 'week:2026-W12']);
      expect(h1).toBe(h2);
    });

    it('produces same hash regardless of keyFacts order', () => {
      const h1 = computeSuppressionHash('test-pattern', ['b:2', 'a:1', 'c:3']);
      const h2 = computeSuppressionHash('test-pattern', ['c:3', 'a:1', 'b:2']);
      expect(h1).toBe(h2);
    });

    it('produces different hash for different pattern keys', () => {
      const h1 = computeSuppressionHash('pattern-a', ['fact:1']);
      const h2 = computeSuppressionHash('pattern-b', ['fact:1']);
      expect(h1).not.toBe(h2);
    });

    it('produces different hash for different key facts', () => {
      const h1 = computeSuppressionHash('same-key', ['meetings:4']);
      const h2 = computeSuppressionHash('same-key', ['meetings:5']);
      expect(h1).not.toBe(h2);
    });

    it('returns a valid hex SHA-256 string', () => {
      const h = computeSuppressionHash('key', ['fact']);
      expect(h).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('insertInsight', () => {
    it('inserts an insight and returns an id', () => {
      const id = insertInsight(db, {
        patternKey: 'meeting-overload',
        title: 'Too many meetings',
        body: 'You have 8 meetings this week.',
        confidence: 0.85,
        status: 'queued',
        serviceSources: ['ticktick', 'gmail'],
        suppressionHash: 'abc123',
      });

      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
    });

    it('stores all fields correctly', () => {
      const id = insertInsight(db, {
        patternKey: 'task-backlog',
        title: 'Growing backlog',
        body: '15 overdue tasks detected.',
        confidence: 0.7,
        status: 'pending',
        serviceSources: ['ticktick'],
        suppressionHash: 'hash123',
      });

      const row = db.get<any>('SELECT * FROM insights WHERE id = ?', id);
      expect(row).toBeDefined();
      expect(row.pattern_key).toBe('task-backlog');
      expect(row.title).toBe('Growing backlog');
      expect(row.body).toBe('15 overdue tasks detected.');
      expect(row.confidence).toBe(0.7);
      expect(row.status).toBe('pending');
      expect(JSON.parse(row.service_sources)).toEqual(['ticktick']);
      expect(row.suppression_hash).toBe('hash123');
      expect(row.created_at).toBeTruthy();
      expect(row.delivered_at).toBeNull();
      expect(row.dismissed_at).toBeNull();
    });
  });

  describe('getInsightsByStatus', () => {
    it('returns insights filtered by status', () => {
      insertInsight(db, {
        patternKey: 'a',
        title: 'A',
        body: 'a',
        confidence: 0.8,
        status: 'queued',
        serviceSources: ['s'],
        suppressionHash: 'h1',
      });
      insertInsight(db, {
        patternKey: 'b',
        title: 'B',
        body: 'b',
        confidence: 0.5,
        status: 'pending',
        serviceSources: ['s'],
        suppressionHash: 'h2',
      });
      insertInsight(db, {
        patternKey: 'c',
        title: 'C',
        body: 'c',
        confidence: 0.9,
        status: 'queued',
        serviceSources: ['s'],
        suppressionHash: 'h3',
      });

      const queued = getInsightsByStatus(db, 'queued');
      expect(queued).toHaveLength(2);
      expect(queued.every((r) => r.status === 'queued')).toBe(true);

      const pending = getInsightsByStatus(db, 'pending');
      expect(pending).toHaveLength(1);
    });

    it('returns empty array when no insights match', () => {
      const result = getInsightsByStatus(db, 'delivered');
      expect(result).toEqual([]);
    });
  });

  describe('updateInsightStatus', () => {
    it('updates status field', () => {
      const id = insertInsight(db, {
        patternKey: 'test',
        title: 'T',
        body: 'b',
        confidence: 0.8,
        status: 'queued',
        serviceSources: ['s'],
        suppressionHash: 'h',
      });

      updateInsightStatus(db, id, 'delivered');

      const row = db.get<any>('SELECT * FROM insights WHERE id = ?', id);
      expect(row.status).toBe('delivered');
      expect(row.delivered_at).toBeTruthy();
    });

    it('sets dismissed_at when status is dismissed', () => {
      const id = insertInsight(db, {
        patternKey: 'test',
        title: 'T',
        body: 'b',
        confidence: 0.8,
        status: 'queued',
        serviceSources: ['s'],
        suppressionHash: 'h',
      });

      updateInsightStatus(db, id, 'dismissed');

      const row = db.get<any>('SELECT * FROM insights WHERE id = ?', id);
      expect(row.status).toBe('dismissed');
      expect(row.dismissed_at).toBeTruthy();
    });

    it('does not set timestamp fields for non-terminal statuses', () => {
      const id = insertInsight(db, {
        patternKey: 'test',
        title: 'T',
        body: 'b',
        confidence: 0.8,
        status: 'pending',
        serviceSources: ['s'],
        suppressionHash: 'h',
      });

      updateInsightStatus(db, id, 'queued');

      const row = db.get<any>('SELECT * FROM insights WHERE id = ?', id);
      expect(row.status).toBe('queued');
      expect(row.delivered_at).toBeNull();
      expect(row.dismissed_at).toBeNull();
    });
  });

  describe('findRecentByHash', () => {
    it('finds an insight with matching hash within window', () => {
      insertInsight(db, {
        patternKey: 'dup-test',
        title: 'T',
        body: 'b',
        confidence: 0.8,
        status: 'queued',
        serviceSources: ['s'],
        suppressionHash: 'dedup-hash',
      });

      const found = findRecentByHash(db, 'dedup-hash', 7);
      expect(found).toBeDefined();
      expect(found!.suppression_hash).toBe('dedup-hash');
    });

    it('returns undefined when hash not found', () => {
      const found = findRecentByHash(db, 'nonexistent', 7);
      expect(found).toBeUndefined();
    });

    it('returns undefined when matching hash is outside window', () => {
      // Insert then manually backdate the created_at
      const id = insertInsight(db, {
        patternKey: 'old',
        title: 'T',
        body: 'b',
        confidence: 0.8,
        status: 'queued',
        serviceSources: ['s'],
        suppressionHash: 'old-hash',
      });

      const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      db.run('UPDATE insights SET created_at = ? WHERE id = ?', oldDate, id);

      const found = findRecentByHash(db, 'old-hash', 7);
      expect(found).toBeUndefined();
    });
  });
});
