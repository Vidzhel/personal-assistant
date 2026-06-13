import type { Database } from 'better-sqlite3';

const PREFIX = 'schedule:enabled:';

export interface SchedulePrefs {
  getEnabledOverride(name: string): boolean | undefined;
  setEnabledOverride(name: string, enabled: boolean): void;
}

export function createSchedulePrefs(db: Database): SchedulePrefs {
  return {
    getEnabledOverride(name: string): boolean | undefined {
      const row = db.prepare('SELECT value FROM preferences WHERE key = ?').get(`${PREFIX}${name}`) as
        | { value: string }
        | undefined;
      if (!row) return undefined;
      return row.value === 'true';
    },
    setEnabledOverride(name: string, enabled: boolean): void {
      db.prepare(
        `INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(`${PREFIX}${name}`, enabled ? 'true' : 'false', Date.now());
    },
  };
}
