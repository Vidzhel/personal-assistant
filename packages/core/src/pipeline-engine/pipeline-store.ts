import type { DatabaseInterface, PipelineRunRecord } from '@raven/shared';

const DEFAULT_RUNS_LIMIT = 10;
const PERCENT = 100;

export interface PipelineGlobalStats {
  total: number;
  succeeded: number;
  failed: number;
  successRate: number;
  avgDurationMs: number | null;
}

export interface PipelinePerPipelineStats {
  pipelineName: string;
  total: number;
  succeeded: number;
  failed: number;
  successRate: number;
  avgDurationMs: number | null;
}

interface RunStatsRow {
  total: number;
  succeeded: number;
  failed: number;
  avg_duration_ms: number | null;
}

interface PerPipelineRow extends RunStatsRow {
  pipeline_name: string;
}

function computeSuccessRate(succeeded: number, total: number): number {
  return total > 0 ? Math.round((succeeded / total) * PERCENT) : 0;
}

function roundDuration(avg: number | null): number | null {
  return avg !== null ? Math.round(avg) : null;
}

export interface PipelineStore {
  insertRun: (run: PipelineRunRecord) => void;
  updateRun: (
    id: string,
    updates: Partial<Pick<PipelineRunRecord, 'status' | 'completed_at' | 'node_results' | 'error'>>,
  ) => void;
  getRun: (id: string) => PipelineRunRecord | undefined;
  getRecentRuns: (pipelineName: string, limit?: number) => PipelineRunRecord[];
  getGlobalStats: (sinceMs: number) => PipelineGlobalStats;
  getPerPipelineStats: (sinceMs: number) => PipelinePerPipelineStats[];
}

const STATS_SQL = `SELECT
  COUNT(*) as total,
  SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as succeeded,
  SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
  AVG(CASE WHEN completed_at IS NOT NULL AND started_at IS NOT NULL
    THEN (julianday(completed_at) - julianday(started_at)) * 86400000 END) as avg_duration_ms
FROM pipeline_runs
WHERE started_at > ?`;

const PER_PIPELINE_SQL = `SELECT
  pipeline_name,
  COUNT(*) as total,
  SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as succeeded,
  SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
  AVG(CASE WHEN completed_at IS NOT NULL AND started_at IS NOT NULL
    THEN (julianday(completed_at) - julianday(started_at)) * 86400000 END) as avg_duration_ms
FROM pipeline_runs
WHERE started_at > ?
GROUP BY pipeline_name
ORDER BY total DESC`;

// eslint-disable-next-line max-lines-per-function -- factory function that initializes all pipeline store methods
export function createPipelineStore(deps: { db: DatabaseInterface }): PipelineStore {
  const { db } = deps;

  return {
    insertRun(run: PipelineRunRecord): void {
      db.run(
        `INSERT INTO pipeline_runs (id, pipeline_name, trigger_type, status, started_at, completed_at, node_results, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        run.id,
        run.pipeline_name,
        run.trigger_type,
        run.status,
        run.started_at,
        run.completed_at ?? null,
        run.node_results ?? null,
        run.error ?? null,
      );
    },

    updateRun(
      id: string,
      updates: Partial<
        Pick<PipelineRunRecord, 'status' | 'completed_at' | 'node_results' | 'error'>
      >,
    ): void {
      const fields: string[] = [];
      const values: unknown[] = [];

      if (updates.status !== undefined) {
        fields.push('status = ?');
        values.push(updates.status);
      }
      if (updates.completed_at !== undefined) {
        fields.push('completed_at = ?');
        values.push(updates.completed_at);
      }
      if (updates.node_results !== undefined) {
        fields.push('node_results = ?');
        values.push(updates.node_results);
      }
      if (updates.error !== undefined) {
        fields.push('error = ?');
        values.push(updates.error);
      }

      if (fields.length === 0) return;

      values.push(id);
      db.run(`UPDATE pipeline_runs SET ${fields.join(', ')} WHERE id = ?`, ...values);
    },

    getRun(id: string): PipelineRunRecord | undefined {
      return db.get<PipelineRunRecord>('SELECT * FROM pipeline_runs WHERE id = ?', id);
    },

    getRecentRuns(pipelineName: string, limit = DEFAULT_RUNS_LIMIT): PipelineRunRecord[] {
      return db.all<PipelineRunRecord>(
        'SELECT * FROM pipeline_runs WHERE pipeline_name = ? ORDER BY started_at DESC LIMIT ?',
        pipelineName,
        limit,
      );
    },

    getGlobalStats(sinceMs: number): PipelineGlobalStats {
      const cutoff = new Date(Date.now() - sinceMs).toISOString();
      const row = db.get<RunStatsRow>(STATS_SQL, cutoff);
      const total = row?.total ?? 0;
      const succeeded = row?.succeeded ?? 0;
      return {
        total,
        succeeded,
        failed: row?.failed ?? 0,
        successRate: computeSuccessRate(succeeded, total),
        avgDurationMs: roundDuration(row?.avg_duration_ms ?? null),
      };
    },

    getPerPipelineStats(sinceMs: number): PipelinePerPipelineStats[] {
      const cutoff = new Date(Date.now() - sinceMs).toISOString();
      const rows = db.all<PerPipelineRow>(PER_PIPELINE_SQL, cutoff);
      return rows.map((row) => ({
        pipelineName: row.pipeline_name,
        total: row.total,
        succeeded: row.succeeded,
        failed: row.failed,
        successRate: computeSuccessRate(row.succeeded, row.total),
        avgDurationMs: roundDuration(row.avg_duration_ms),
      }));
    },
  };
}
