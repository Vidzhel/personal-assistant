import { createLogger, generateId } from '@raven/shared';
import type { SessionIdleEvent } from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { AppConfig } from '../config.ts';
import { getDb } from '../db/database.ts';

const log = createLogger('idle-detector');

const MS_PER_MINUTE = 60000;
const SCAN_INTERVAL_MS = MS_PER_MINUTE;

interface IdleDetectorDeps {
  eventBus: EventBus;
  config: AppConfig;
}

interface IdleSessionRow {
  id: string;
  project_id: string;
  last_active_at: number;
}

export interface IdleDetector {
  start: () => void;
  stop: () => void;
  scan: () => void;
}

// eslint-disable-next-line max-lines-per-function -- factory with scan logic, start/stop lifecycle
export function createIdleDetector(deps: IdleDetectorDeps): IdleDetector {
  const { eventBus, config } = deps;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  const processed = new Set<string>();

  function scan(): void {
    if (!config.RAVEN_AUTO_RETROSPECTIVE_ENABLED) return;

    const db = getDb();
    const cutoff = Date.now() - config.RAVEN_SESSION_IDLE_TIMEOUT_MS;

    const rows = db
      .prepare(
        `SELECT id, project_id, last_active_at FROM sessions
         WHERE status = 'idle'
           AND last_active_at < ?
           AND summary IS NULL
           AND turn_count > 0`,
      )
      .all(cutoff) as IdleSessionRow[];

    for (const row of rows) {
      if (processed.has(row.id)) continue;
      processed.add(row.id);

      const idleMinutes = Math.round((Date.now() - row.last_active_at) / MS_PER_MINUTE);
      log.info(`Session ${row.id} idle for ${idleMinutes}min — triggering retrospective`);

      // Mark session as completed
      db.prepare("UPDATE sessions SET status = 'completed' WHERE id = ?").run(row.id);

      const event: SessionIdleEvent = {
        id: generateId(),
        timestamp: Date.now(),
        source: 'idle-detector',
        projectId: row.project_id,
        type: 'session:idle',
        payload: {
          sessionId: row.id,
          projectId: row.project_id,
          idleMinutes,
        },
      };

      eventBus.emit(event);
    }
  }

  return {
    start(): void {
      if (intervalId) return;
      log.info(
        `Starting idle detector (timeout: ${config.RAVEN_SESSION_IDLE_TIMEOUT_MS}ms, scan: ${SCAN_INTERVAL_MS}ms)`,
      );
      intervalId = setInterval(scan, SCAN_INTERVAL_MS);
    },

    stop(): void {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
        log.info('Idle detector stopped');
      }
    },

    scan,
  };
}
