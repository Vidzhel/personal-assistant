import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createSchedulePrefs } from '../scheduler/schedule-prefs.ts';

describe('schedule prefs', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'raven-schedprefs-'));
    db = new Database(join(dir, 't.db'));
    db.exec(
      'CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)',
    );
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns undefined when no override set', () => {
    const prefs = createSchedulePrefs(db);
    expect(prefs.getEnabledOverride('morning-digest')).toBeUndefined();
  });

  it('persists and reads an enabled override', () => {
    const prefs = createSchedulePrefs(db);
    prefs.setEnabledOverride('morning-digest', false);
    expect(prefs.getEnabledOverride('morning-digest')).toBe(false);
    prefs.setEnabledOverride('morning-digest', true);
    expect(prefs.getEnabledOverride('morning-digest')).toBe(true);
  });
});
