import type Database from 'better-sqlite3';
import { generateId } from '@raven/shared';

/** Every distinct outcome a schedule fire can end in. 'fired' covers
 * template-kind schedules, whose trigger only creates a task tree
 * (async, un-awaited execution) — 'completed'/'blocked' are job-kind
 * outcomes, mirroring RavenTask's terminal statuses. */
export type ScheduleFireStatus = 'completed' | 'blocked' | 'fired' | 'failed';

/** Durable, minimal per-fire log the self-test job reads to check "every
 * schedule's last fire reached a healthy terminal status" — schedule-engine.ts
 * didn't record anything queryable for template-kind fires before this. */
export interface ScheduleFireDetails {
  detail?: string;
  activationId?: string | null;
}

export interface ScheduleFireLog {
  record(scheduleName: string, status: ScheduleFireStatus, details?: ScheduleFireDetails): void;
}

export function createScheduleFireLog(db: Database.Database): ScheduleFireLog {
  return {
    record(
      scheduleName: string,
      status: ScheduleFireStatus,
      details: ScheduleFireDetails = {},
    ): void {
      db.prepare(
        `INSERT INTO schedule_fires (id, schedule_name, fired_at, status, detail, activation_id) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        generateId(),
        scheduleName,
        new Date().toISOString(),
        status,
        details.detail ?? null,
        details.activationId ?? null,
      );
    },
  };
}
