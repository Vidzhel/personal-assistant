import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, getDb, createDbInterface } from '../db/database.ts';
import { createPipelineStore } from '../pipeline-engine/pipeline-store.ts';
import type { PipelineStore } from '../pipeline-engine/pipeline-store.ts';
import type { PipelineRunRecord } from '@raven/shared';

describe('PipelineStore', () => {
  let tmpDir: string;
  let store: PipelineStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pipeline-store-'));
    initDatabase(join(tmpDir, 'test.db'));
    store = createPipelineStore({ db: createDbInterface() });
  });

  afterEach(() => {
    try {
      getDb().close();
    } catch {
      /* */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeRun(overrides: Partial<PipelineRunRecord> = {}): PipelineRunRecord {
    return {
      id: `run-${Math.random().toString(36).slice(2, 8)}`,
      pipeline_name: 'test-pipeline',
      trigger_type: 'manual',
      status: 'running',
      started_at: new Date().toISOString(),
      ...overrides,
    };
  }

  it('inserts and retrieves a run', () => {
    const run = makeRun({ id: 'run-1' });
    store.insertRun(run);

    const retrieved = store.getRun('run-1');
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe('run-1');
    expect(retrieved!.pipeline_name).toBe('test-pipeline');
    expect(retrieved!.status).toBe('running');
  });

  it('returns undefined for nonexistent run', () => {
    expect(store.getRun('nonexistent')).toBeUndefined();
  });

  it('updates a run', () => {
    const run = makeRun({ id: 'run-2' });
    store.insertRun(run);

    store.updateRun('run-2', {
      status: 'completed',
      completed_at: new Date().toISOString(),
      node_results: JSON.stringify({ a: { status: 'complete' } }),
    });

    const updated = store.getRun('run-2');
    expect(updated!.status).toBe('completed');
    expect(updated!.completed_at).toBeDefined();
    expect(updated!.node_results).toContain('complete');
  });

  it('updates error field on failure', () => {
    const run = makeRun({ id: 'run-3' });
    store.insertRun(run);

    store.updateRun('run-3', {
      status: 'failed',
      error: 'Something went wrong',
    });

    const updated = store.getRun('run-3');
    expect(updated!.status).toBe('failed');
    expect(updated!.error).toBe('Something went wrong');
  });

  it('getRecentRuns returns runs ordered by started_at DESC', () => {
    store.insertRun(makeRun({ id: 'run-old', started_at: '2026-01-01T00:00:00Z' }));
    store.insertRun(makeRun({ id: 'run-mid', started_at: '2026-02-01T00:00:00Z' }));
    store.insertRun(makeRun({ id: 'run-new', started_at: '2026-03-01T00:00:00Z' }));

    const runs = store.getRecentRuns('test-pipeline');
    expect(runs).toHaveLength(3);
    expect(runs[0].id).toBe('run-new');
    expect(runs[1].id).toBe('run-mid');
    expect(runs[2].id).toBe('run-old');
  });

  it('getRecentRuns respects limit', () => {
    store.insertRun(makeRun({ id: 'r1', started_at: '2026-01-01T00:00:00Z' }));
    store.insertRun(makeRun({ id: 'r2', started_at: '2026-02-01T00:00:00Z' }));
    store.insertRun(makeRun({ id: 'r3', started_at: '2026-03-01T00:00:00Z' }));

    const runs = store.getRecentRuns('test-pipeline', 2);
    expect(runs).toHaveLength(2);
    expect(runs[0].id).toBe('r3');
  });

  it('getRecentRuns filters by pipeline name', () => {
    store.insertRun(makeRun({ id: 'r1', pipeline_name: 'pipeline-a' }));
    store.insertRun(makeRun({ id: 'r2', pipeline_name: 'pipeline-b' }));

    const runs = store.getRecentRuns('pipeline-a');
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe('r1');
  });

  it('handles empty updates gracefully', () => {
    const run = makeRun({ id: 'run-noop' });
    store.insertRun(run);
    store.updateRun('run-noop', {});
    const retrieved = store.getRun('run-noop');
    expect(retrieved!.status).toBe('running');
  });
});
