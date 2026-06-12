import { describe, it, expect, vi } from 'vitest';
import { createTemplateScheduler } from '../template-engine/template-scheduler.ts';
import type { TaskTemplate } from '@raven/shared';

const template = {
  name: 'morning-digest',
  displayName: 'Morning Digest',
  description: 'digest',
  params: {},
  trigger: [{ type: 'manual' }],
  plan: { approval: 'auto', parallel: true },
  tasks: [{ id: 't1', type: 'agent', title: 'do', prompt: 'do', blockedBy: [] }],
} as unknown as TaskTemplate;

function makeDeps() {
  const createTree = vi.fn();
  const startTree = vi.fn().mockResolvedValue(undefined);
  return {
    templateRegistry: { getTemplate: vi.fn().mockReturnValue(template), getAllTemplates: () => [] },
    executionEngine: { createTree, startTree },
    eventBus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
    createTree,
  };
}

describe('triggerTemplate scheduleId stamping', () => {
  it('passes scheduleId through to createTree', async () => {
    const d = makeDeps();
    const scheduler = createTemplateScheduler(d as any);
    await scheduler.triggerTemplate('morning-digest', { scheduleId: 'morning-digest' });
    expect(d.createTree).toHaveBeenCalledTimes(1);
    const arg = d.createTree.mock.calls[0][0];
    expect(arg.scheduleId).toBe('morning-digest');
    expect(Array.isArray(arg.tasks)).toBe(true);
  });

  it('works with no options (back-compat, no scheduleId)', async () => {
    const d = makeDeps();
    const scheduler = createTemplateScheduler(d as any);
    await scheduler.triggerTemplate('morning-digest');
    const arg = d.createTree.mock.calls[0][0];
    expect(arg.scheduleId).toBeUndefined();
  });
});
