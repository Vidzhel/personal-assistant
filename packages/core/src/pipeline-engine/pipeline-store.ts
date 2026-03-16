import type { DatabaseInterface, PipelineRunRecord } from '@raven/shared';

const DEFAULT_RUNS_LIMIT = 10;

export interface PipelineStore {
  insertRun: (run: PipelineRunRecord) => void;
  updateRun: (
    id: string,
    updates: Partial<Pick<PipelineRunRecord, 'status' | 'completed_at' | 'node_results' | 'error'>>,
  ) => void;
  getRun: (id: string) => PipelineRunRecord | undefined;
  getRecentRuns: (pipelineName: string, limit?: number) => PipelineRunRecord[];
}

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
  };
}
