import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, getDb, createDbInterface } from '../db/database.ts';
import {
  createSnooze,
  getActiveSnoozes,
  getSnoozeForCategory,
  removeSnooze,
  incrementHeldCount,
  expireSnoozes,
} from '../notification-engine/snooze-store.ts';
import type { DatabaseInterface } from '@raven/shared';

describe('snooze-store', () => {
  let tmpDir: string;
  let db: DatabaseInterface;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-snooze-test-'));
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

  describe('createSnooze', () => {
    it('creates a timed snooze with snoozed_until', () => {
      const record = createSnooze(db, { category: 'pipeline:*', duration: '1d' });
      expect(record.id).toBeTruthy();

      const row = db.get<any>('SELECT * FROM notification_snooze WHERE id = ?', record.id);
      expect(row).toBeTruthy();
      expect(row.category).toBe('pipeline:*');
      expect(row.snoozed_until).toBeTruthy();
      expect(row.held_count).toBe(0);
    });

    it('creates a mute with null snoozed_until', () => {
      const record = createSnooze(db, { category: 'email:triage:*', duration: 'mute' });

      const row = db.get<any>('SELECT * FROM notification_snooze WHERE id = ?', record.id);
      expect(row.snoozed_until).toBeNull();
    });

    it('supports 1h, 1d, 1w durations', () => {
      const rec1h = createSnooze(db, { category: 'cat1', duration: '1h' });
      const rec1d = createSnooze(db, { category: 'cat2', duration: '1d' });
      const rec1w = createSnooze(db, { category: 'cat3', duration: '1w' });

      const r1 = db.get<any>(
        'SELECT snoozed_until FROM notification_snooze WHERE id = ?',
        rec1h.id,
      );
      const r2 = db.get<any>(
        'SELECT snoozed_until FROM notification_snooze WHERE id = ?',
        rec1d.id,
      );
      const r3 = db.get<any>(
        'SELECT snoozed_until FROM notification_snooze WHERE id = ?',
        rec1w.id,
      );

      // All should have snoozed_until set (not null)
      expect(r1.snoozed_until).toBeTruthy();
      expect(r2.snoozed_until).toBeTruthy();
      expect(r3.snoozed_until).toBeTruthy();

      // 1w > 1d > 1h
      expect(new Date(r3.snoozed_until).getTime()).toBeGreaterThan(
        new Date(r2.snoozed_until).getTime(),
      );
      expect(new Date(r2.snoozed_until).getTime()).toBeGreaterThan(
        new Date(r1.snoozed_until).getTime(),
      );
    });
  });

  describe('getActiveSnoozes', () => {
    it('returns active (unexpired) snoozes', () => {
      createSnooze(db, { category: 'pipeline:*', duration: '1w' });
      createSnooze(db, { category: 'email:triage:*', duration: 'mute' });

      const active = getActiveSnoozes(db);
      expect(active).toHaveLength(2);
    });

    it('excludes expired snoozes', () => {
      const record = createSnooze(db, { category: 'pipeline:*', duration: '1h' });
      // Manually set snoozed_until to the past
      db.run(
        `UPDATE notification_snooze SET snoozed_until = '2020-01-01T00:00:00Z' WHERE id = ?`,
        record.id,
      );

      const active = getActiveSnoozes(db);
      expect(active).toHaveLength(0);
    });
  });

  describe('getSnoozeForCategory', () => {
    it('returns exact match', () => {
      createSnooze(db, { category: 'pipeline:complete', duration: '1d' });

      const snooze = getSnoozeForCategory(db, 'pipeline:complete');
      expect(snooze).toBeTruthy();
      expect(snooze!.category).toBe('pipeline:complete');
    });

    it('returns wildcard match', () => {
      createSnooze(db, { category: 'pipeline:*', duration: '1d' });

      const snooze = getSnoozeForCategory(db, 'pipeline:complete');
      expect(snooze).toBeTruthy();
      expect(snooze!.category).toBe('pipeline:*');
    });

    it('wildcard matches nested sources', () => {
      createSnooze(db, { category: 'email:*', duration: '1d' });

      const snooze = getSnoozeForCategory(db, 'email:triage:summary');
      expect(snooze).toBeTruthy();
    });

    it('returns null for non-matching source', () => {
      createSnooze(db, { category: 'pipeline:*', duration: '1d' });

      const snooze = getSnoozeForCategory(db, 'email:triage:summary');
      expect(snooze).toBeNull();
    });

    it('returns null for expired snooze', () => {
      const { id } = createSnooze(db, { category: 'pipeline:*', duration: '1h' });
      db.run(
        `UPDATE notification_snooze SET snoozed_until = '2020-01-01T00:00:00Z' WHERE id = ?`,
        id,
      );

      const snooze = getSnoozeForCategory(db, 'pipeline:complete');
      expect(snooze).toBeNull();
    });
  });

  describe('removeSnooze', () => {
    it('deletes existing snooze and returns true', () => {
      const { id } = createSnooze(db, { category: 'pipeline:*', duration: '1d' });

      const result = removeSnooze(db, id);
      expect(result).toBe(true);

      const active = getActiveSnoozes(db);
      expect(active).toHaveLength(0);
    });

    it('returns false for non-existent snooze', () => {
      const result = removeSnooze(db, 'non-existent-id');
      expect(result).toBe(false);
    });
  });

  describe('incrementHeldCount', () => {
    it('increments the held count', () => {
      const { id } = createSnooze(db, { category: 'pipeline:*', duration: '1d' });

      incrementHeldCount(db, id);
      incrementHeldCount(db, id);

      const row = db.get<any>('SELECT held_count FROM notification_snooze WHERE id = ?', id);
      expect(row.held_count).toBe(2);
    });
  });

  describe('expireSnoozes', () => {
    it('deletes expired snoozes and returns them', () => {
      const { id } = createSnooze(db, { category: 'pipeline:*', duration: '1h' });
      // Set to past
      db.run(
        `UPDATE notification_snooze SET snoozed_until = '2020-01-01T00:00:00Z' WHERE id = ?`,
        id,
      );

      const expired = expireSnoozes(db, new Date().toISOString());
      expect(expired).toHaveLength(1);
      expect(expired[0].category).toBe('pipeline:*');

      // Should be deleted
      const remaining = getActiveSnoozes(db);
      expect(remaining).toHaveLength(0);
    });

    it('does not expire muted (null snoozed_until) snoozes', () => {
      createSnooze(db, { category: 'email:triage:*', duration: 'mute' });

      const expired = expireSnoozes(db, new Date().toISOString());
      expect(expired).toHaveLength(0);

      const active = getActiveSnoozes(db);
      expect(active).toHaveLength(1);
    });

    it('does not expire future snoozes', () => {
      createSnooze(db, { category: 'pipeline:*', duration: '1w' });

      const expired = expireSnoozes(db, new Date().toISOString());
      expect(expired).toHaveLength(0);
    });
  });
});
