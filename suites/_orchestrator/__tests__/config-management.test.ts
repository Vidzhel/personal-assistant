import { describe, it, expect, vi } from 'vitest';

vi.mock('@raven/shared', async () => {
  const actual = await vi.importActual<typeof import('@raven/shared')>('@raven/shared');
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
    generateId: () => 'test-id-123',
  };
});

// ---------- config-presenter ----------

describe('config-presenter', () => {
  it('should format create proposal with full content', async () => {
    const events: unknown[] = [];
    const mockEventBus = {
      emit: (e: unknown) => events.push(e),
      on: vi.fn(),
      off: vi.fn(),
    };

    const { presentConfigChange } = await import('../services/config-presenter.ts');

    const result = presentConfigChange(
      {
        action: 'create',
        resourceType: 'pipeline',
        resourceName: 'email-to-tasks',
        content: 'name: email-to-tasks\nversion: 1',
        description: 'Create a new pipeline',
      },
      mockEventBus,
    );

    expect(result.action).toBe('create');
    expect(result.resourceType).toBe('pipeline');
    expect(result.resourceName).toBe('email-to-tasks');
    expect(result.displayText).toContain('Create pipeline');
    expect(result.displayText).toContain('email-to-tasks');
    expect(events.length).toBe(1);
  });

  it('should generate diff for update proposals', async () => {
    const events: unknown[] = [];
    const mockEventBus = {
      emit: (e: unknown) => events.push(e),
      on: vi.fn(),
      off: vi.fn(),
    };

    const { presentConfigChange } = await import('../services/config-presenter.ts');

    const result = presentConfigChange(
      {
        action: 'update',
        resourceType: 'pipeline',
        resourceName: 'morning-briefing',
        currentContent: 'schedule: "0 6 * * *"',
        content: 'schedule: "0 9 * * 1-5"',
        description: 'Change schedule to weekdays at 9am',
      },
      mockEventBus,
    );

    expect(result.action).toBe('update');
    expect(result.diffText).toContain('--- current');
    expect(result.diffText).toContain('+++ proposed');
    expect(result.displayText).toContain('Update pipeline');
  });

  it('should format delete proposal with confirmation', async () => {
    const events: unknown[] = [];
    const mockEventBus = {
      emit: (e: unknown) => events.push(e),
      on: vi.fn(),
      off: vi.fn(),
    };

    const { presentConfigChange } = await import('../services/config-presenter.ts');

    const result = presentConfigChange(
      {
        action: 'delete',
        resourceType: 'schedule',
        resourceName: 'stale-nudge',
        description: 'Remove unused schedule',
      },
      mockEventBus,
    );

    expect(result.displayText).toContain('permanently remove');
    expect(result.displayText).toContain('stale-nudge');
  });

  it('should format view display', async () => {
    const events: unknown[] = [];
    const mockEventBus = {
      emit: (e: unknown) => events.push(e),
      on: vi.fn(),
      off: vi.fn(),
    };

    const { presentConfigChange } = await import('../services/config-presenter.ts');

    const result = presentConfigChange(
      {
        action: 'view',
        resourceType: 'agent',
        resourceName: 'my-agent',
        content: '{"name":"my-agent","description":"Test"}',
        description: 'View agent config',
      },
      mockEventBus,
    );

    expect(result.displayText).toContain('Current agent: my-agent');
    expect(result.displayText).toContain('my-agent');
  });
});

// ---------- config-applier ----------

describe('config-applier', () => {
  it('should call savePipeline for pipeline create', async () => {
    const savePipeline = vi.fn().mockReturnValue({ config: {} });
    const deps = {
      eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
      pipelineEngine: { savePipeline, deletePipeline: vi.fn() },
      suiteScaffolder: { scaffoldSuite: vi.fn() },
      namedAgentStore: { createAgent: vi.fn(), updateAgent: vi.fn(), deleteAgent: vi.fn(), getAgentByName: vi.fn() },
      scheduler: { addSchedule: vi.fn(), removeSchedule: vi.fn(), getSchedules: vi.fn().mockReturnValue([]) },
    };

    const { applyConfigChange } = await import('../services/config-applier.ts');

    const pipelineYaml = `name: test-pipe
version: 1
trigger:
  type: manual
nodes:
  do-thing:
    skill: test
    action: run
connections: []
enabled: true`;

    const result = applyConfigChange(deps, {
      changeId: 'test-1',
      action: 'create',
      resourceType: 'pipeline',
      resourceName: 'test-pipe',
      content: pipelineYaml,
    });

    expect(result.success).toBe(true);
    expect(savePipeline).toHaveBeenCalledWith('test-pipe', pipelineYaml);
  });

  it('should call deletePipeline for pipeline delete', async () => {
    const deletePipeline = vi.fn().mockReturnValue(true);
    const deps = {
      eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
      pipelineEngine: { savePipeline: vi.fn(), deletePipeline },
      suiteScaffolder: { scaffoldSuite: vi.fn() },
      namedAgentStore: { createAgent: vi.fn(), updateAgent: vi.fn(), deleteAgent: vi.fn(), getAgentByName: vi.fn() },
      scheduler: { addSchedule: vi.fn(), removeSchedule: vi.fn(), getSchedules: vi.fn().mockReturnValue([]) },
    };

    const { applyConfigChange } = await import('../services/config-applier.ts');

    const result = applyConfigChange(deps, {
      changeId: 'test-2',
      action: 'delete',
      resourceType: 'pipeline',
      resourceName: 'old-pipe',
    });

    expect(result.success).toBe(true);
    expect(deletePipeline).toHaveBeenCalledWith('old-pipe');
  });

  it('should call scaffoldSuite for suite create', async () => {
    const scaffoldSuite = vi.fn().mockReturnValue({ suitePath: '/suites/new-suite' });
    const deps = {
      eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
      pipelineEngine: { savePipeline: vi.fn(), deletePipeline: vi.fn() },
      suiteScaffolder: { scaffoldSuite },
      namedAgentStore: { createAgent: vi.fn(), updateAgent: vi.fn(), deleteAgent: vi.fn(), getAgentByName: vi.fn() },
      scheduler: { addSchedule: vi.fn(), removeSchedule: vi.fn(), getSchedules: vi.fn().mockReturnValue([]) },
    };

    const { applyConfigChange } = await import('../services/config-applier.ts');

    const result = applyConfigChange(deps, {
      changeId: 'test-3',
      action: 'create',
      resourceType: 'suite',
      resourceName: 'new-suite',
      content: JSON.stringify({ name: 'new-suite', displayName: 'New Suite', description: 'Test' }),
    });

    expect(result.success).toBe(true);
    expect(scaffoldSuite).toHaveBeenCalledWith(expect.objectContaining({ name: 'new-suite' }));
  });

  it('should call createAgent for agent create', async () => {
    const createAgent = vi.fn().mockReturnValue({ id: 'a1', name: 'test-agent' });
    const deps = {
      eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
      pipelineEngine: { savePipeline: vi.fn(), deletePipeline: vi.fn() },
      suiteScaffolder: { scaffoldSuite: vi.fn() },
      namedAgentStore: { createAgent, updateAgent: vi.fn(), deleteAgent: vi.fn(), getAgentByName: vi.fn() },
      scheduler: { addSchedule: vi.fn(), removeSchedule: vi.fn(), getSchedules: vi.fn().mockReturnValue([]) },
    };

    const { applyConfigChange } = await import('../services/config-applier.ts');

    const result = applyConfigChange(deps, {
      changeId: 'test-4',
      action: 'create',
      resourceType: 'agent',
      resourceName: 'test-agent',
      content: JSON.stringify({ name: 'test-agent', description: 'A test agent', suite_ids: ['email'] }),
    });

    expect(result.success).toBe(true);
    expect(createAgent).toHaveBeenCalled();
  });

  it('should call addSchedule for schedule create', async () => {
    const addSchedule = vi.fn();
    const deps = {
      eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
      pipelineEngine: { savePipeline: vi.fn(), deletePipeline: vi.fn() },
      suiteScaffolder: { scaffoldSuite: vi.fn() },
      namedAgentStore: { createAgent: vi.fn(), updateAgent: vi.fn(), deleteAgent: vi.fn(), getAgentByName: vi.fn() },
      scheduler: { addSchedule, removeSchedule: vi.fn(), getSchedules: vi.fn().mockReturnValue([]) },
    };

    const { applyConfigChange } = await import('../services/config-applier.ts');

    const result = applyConfigChange(deps, {
      changeId: 'test-5',
      action: 'create',
      resourceType: 'schedule',
      resourceName: 'test-schedule',
      content: JSON.stringify({ name: 'Test Schedule', cron: '0 9 * * 1-5', taskType: 'test', skillName: 'test' }),
    });

    expect(result.success).toBe(true);
    expect(addSchedule).toHaveBeenCalled();
  });

  it('should return error when content is missing for create', async () => {
    const deps = {
      eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
      pipelineEngine: { savePipeline: vi.fn(), deletePipeline: vi.fn() },
      suiteScaffolder: { scaffoldSuite: vi.fn() },
      namedAgentStore: { createAgent: vi.fn(), updateAgent: vi.fn(), deleteAgent: vi.fn(), getAgentByName: vi.fn() },
      scheduler: { addSchedule: vi.fn(), removeSchedule: vi.fn(), getSchedules: vi.fn().mockReturnValue([]) },
    };

    const { applyConfigChange } = await import('../services/config-applier.ts');

    const result = applyConfigChange(deps, {
      changeId: 'test-6',
      action: 'create',
      resourceType: 'pipeline',
      resourceName: 'empty',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('required');
  });
});

// ---------- simple diff ----------

describe('generateSimpleDiff', () => {
  it('should produce a unified-style diff', async () => {
    const { generateSimpleDiff } = await import('../services/config-presenter.ts');

    const diff = generateSimpleDiff('line1\nline2\nline3', 'line1\nchanged\nline3');

    expect(diff).toContain('--- current');
    expect(diff).toContain('+++ proposed');
    expect(diff).toContain('-line2');
    expect(diff).toContain('+changed');
    expect(diff).toContain(' line1');
    expect(diff).toContain(' line3');
  });
});
