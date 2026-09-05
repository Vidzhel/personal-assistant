import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { META_PROJECT_ID, type TaskTree } from '@raven/shared';
import { createProjectMemoryFixture } from './fixtures/project-memory.ts';
import { listPendingCandidates } from '../agent-memory/memory-candidates.ts';
import { runSystemRetrospective } from '../agent-memory/system-retrospective.ts';

const MS_PER_DAY = 86_400_000;

function makeTree(id: string, status: TaskTree['status'], updatedAt: string): TaskTree {
  return {
    id,
    status,
    tasks: new Map(),
    createdAt: updatedAt,
    updatedAt,
  };
}

describe('system retrospective execution tree query', () => {
  let projectsDir: string;
  let memoryStore: Awaited<ReturnType<typeof createProjectMemoryFixture>>['memoryStore'];

  beforeEach(async () => {
    projectsDir = mkdtempSync(join(tmpdir(), 'raven-system-retrospective-'));
    ({ memoryStore } = await createProjectMemoryFixture(projectsDir, ['system']));
  });

  afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
  });

  function makeDeps(trees: TaskTree[]) {
    return {
      memoryStore,
      executionEngine: { queryTrees: () => trees },
      executionLogger: {
        getTaskStats: vi.fn().mockReturnValue({
          total1h: 0,
          succeeded1h: 0,
          failed1h: 0,
          avgDurationMs: null,
          lastTaskAt: null,
        }),
        getPerSkillStats: vi.fn().mockReturnValue([]),
      } as any,
    };
  }

  it('counts every queried tree, including beyond the old UI page size', async () => {
    const now = Date.now();
    const trees = Array.from({ length: 60 }, (_, index) =>
      makeTree(
        index === 0 ? 'stuck-tree' : `fresh-tree-${String(index)}`,
        'running',
        new Date(now - (index === 0 ? 8 : 1) * MS_PER_DAY).toISOString(),
      ),
    );

    const result = await runSystemRetrospective(makeDeps(trees));

    expect(result).toMatchObject({ candidateWritten: true, stuckTreeCount: 1 });
    const candidates = await listPendingCandidates(memoryStore, META_PROJECT_ID);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].body).toContain('1 task tree(s)');
  });

  it('does not consult a SQL task tree cache when no queried tree is stuck', async () => {
    const trees = [makeTree('fresh-tree', 'running', new Date().toISOString())];

    const result = await runSystemRetrospective(makeDeps(trees));

    expect(result).toEqual({ candidateWritten: false, failureCount: 0, stuckTreeCount: 0 });
    expect(await listPendingCandidates(memoryStore, META_PROJECT_ID)).toEqual([]);
  });
  it('reports a failed candidate write as a failed job rather than nothing to report', async () => {
    vi.spyOn(memoryStore, 'withDirectory').mockRejectedValueOnce(new Error('Unavailable project'));
    const trees = [
      makeTree('stuck', 'running', new Date(Date.now() - 8 * MS_PER_DAY).toISOString()),
    ];
    await expect(runSystemRetrospective(makeDeps(trees))).rejects.toThrow('could not be saved');
  });
});
