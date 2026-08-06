import { describe, it, expect, vi } from 'vitest';
import { registerCoreJobs } from '../scheduler/core-jobs.ts';
import { createJobRegistry } from '../scheduler/job-registry.ts';

describe('registerCoreJobs', () => {
  it('registers the three pure-code jobs and wires their deps', async () => {
    const reg = createJobRegistry();
    const taskStore = { archiveCompletedTasks: vi.fn().mockReturnValue(3) };
    const retrospective = { runFullRetrospective: vi.fn().mockResolvedValue(undefined) };
    const knowledgeConsolidation = { runConsolidation: vi.fn().mockResolvedValue(undefined) };

    registerCoreJobs(reg, {
      taskStore: taskStore as any,
      retrospective: retrospective as any,
      knowledgeConsolidation: knowledgeConsolidation as any,
    });

    expect(reg.list().sort()).toEqual([
      'knowledge-consolidation',
      'knowledge-retrospective',
      'task-archival',
    ]);

    const archival = await reg.get('task-archival')!({ scheduleName: 'task-archival', params: {} });
    expect(taskStore.archiveCompletedTasks).toHaveBeenCalled();
    expect(archival.summary).toMatch(/3/);

    await reg.get('knowledge-retrospective')!({ scheduleName: 'k', params: {} });
    expect(retrospective.runFullRetrospective).toHaveBeenCalled();

    await reg.get('knowledge-consolidation')!({ scheduleName: 'k', params: {} });
    expect(knowledgeConsolidation.runConsolidation).toHaveBeenCalled();
  });

  it('registers only task-archival when knowledge deps are undefined (Neo4j unavailable)', () => {
    const reg = createJobRegistry();
    const taskStore = { archiveCompletedTasks: vi.fn().mockReturnValue(0) };

    registerCoreJobs(reg, { taskStore: taskStore as any });

    expect(reg.list()).toEqual(['task-archival']);
    expect(reg.has('knowledge-retrospective')).toBe(false);
    expect(reg.has('knowledge-consolidation')).toBe(false);
  });
});
