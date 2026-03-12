import { describe, it, expect } from 'vitest';
import { SuiteRegistry } from '../suite-registry/suite-registry.ts';
import type { SkillAction } from '@raven/shared';

function makeSuiteRegistryWithActions(suiteActions: Record<string, SkillAction[]>): SuiteRegistry {
  const registry = new SuiteRegistry();
  for (const [name, actions] of Object.entries(suiteActions)) {
    (registry as any).suites.set(name, {
      manifest: {
        name,
        displayName: name,
        version: '1.0.0',
        description: `${name} suite`,
        capabilities: [],
        requiresEnv: [],
        services: [],
      },
      agents: [],
      mcpServers: {},
      actions,
      schedules: [],
      suiteDir: '/tmp/test',
    });
  }
  return registry;
}

describe('SuiteRegistry.collectActions', () => {
  it('collects actions from all registered suites', () => {
    const registry = makeSuiteRegistryWithActions({
      ticktick: [
        {
          name: 'ticktick:get-tasks',
          description: 'Get tasks',
          defaultTier: 'green',
          reversible: true,
        },
      ],
      gmail: [
        {
          name: 'gmail:search-emails',
          description: 'Search emails',
          defaultTier: 'green',
          reversible: true,
        },
      ],
    });

    const actions = registry.collectActions();
    expect(actions).toHaveLength(2);
    expect(actions.map((a) => a.name)).toContain('ticktick:get-tasks');
    expect(actions.map((a) => a.name)).toContain('gmail:search-emails');
  });

  it('filters by suite names', () => {
    const registry = makeSuiteRegistryWithActions({
      ticktick: [
        {
          name: 'ticktick:get-tasks',
          description: 'Get tasks',
          defaultTier: 'green',
          reversible: true,
        },
      ],
      gmail: [
        {
          name: 'gmail:search-emails',
          description: 'Search emails',
          defaultTier: 'green',
          reversible: true,
        },
      ],
    });

    const actions = registry.collectActions(['gmail']);
    expect(actions).toHaveLength(1);
    expect(actions[0].name).toBe('gmail:search-emails');
  });

  it('returns empty array for suites with no actions', () => {
    const registry = makeSuiteRegistryWithActions({
      empty: [],
    });

    const actions = registry.collectActions();
    expect(actions).toHaveLength(0);
  });

  it('skips duplicate action names across suites', () => {
    const registry = makeSuiteRegistryWithActions({
      'suite-a': [
        {
          name: 'suite-a:do-thing',
          description: 'First declaration',
          defaultTier: 'green',
          reversible: true,
        },
      ],
      'suite-b': [
        {
          name: 'suite-a:do-thing',
          description: 'Duplicate from another suite',
          defaultTier: 'red',
          reversible: false,
        },
      ],
    });

    const actions = registry.collectActions();
    expect(actions).toHaveLength(1);
    expect(actions[0].description).toBe('First declaration');
  });
});

describe('Suite action declarations via registry', () => {
  it('collects ticktick-shaped actions with correct tier assignments', () => {
    const ticktickActions: SkillAction[] = [
      {
        name: 'ticktick:get-tasks',
        description: 'Retrieve tasks and lists',
        defaultTier: 'green',
        reversible: true,
      },
      {
        name: 'ticktick:get-task-details',
        description: 'Get details of a specific task',
        defaultTier: 'green',
        reversible: true,
      },
      {
        name: 'ticktick:create-task',
        description: 'Create a new task',
        defaultTier: 'yellow',
        reversible: true,
      },
      {
        name: 'ticktick:update-task',
        description: 'Update an existing task',
        defaultTier: 'yellow',
        reversible: true,
      },
      {
        name: 'ticktick:complete-task',
        description: 'Mark a task as complete',
        defaultTier: 'yellow',
        reversible: true,
      },
      {
        name: 'ticktick:delete-task',
        description: 'Permanently delete a task',
        defaultTier: 'red',
        reversible: false,
      },
    ];

    const registry = makeSuiteRegistryWithActions({ ticktick: ticktickActions });
    const actions = registry.collectActions();

    expect(actions).toHaveLength(6);
    expect(actions.find((a: SkillAction) => a.name === 'ticktick:get-tasks')?.defaultTier).toBe(
      'green',
    );
    expect(actions.find((a: SkillAction) => a.name === 'ticktick:create-task')?.defaultTier).toBe(
      'yellow',
    );
    expect(actions.find((a: SkillAction) => a.name === 'ticktick:delete-task')?.defaultTier).toBe(
      'red',
    );
  });

  it('collects gmail-shaped actions with correct tier assignments', () => {
    const gmailActions: SkillAction[] = [
      {
        name: 'gmail:search-emails',
        description: 'Search and read emails',
        defaultTier: 'green',
        reversible: true,
      },
      {
        name: 'gmail:get-email',
        description: 'Read a specific email',
        defaultTier: 'green',
        reversible: true,
      },
      {
        name: 'gmail:label-email',
        description: 'Apply labels to an email',
        defaultTier: 'yellow',
        reversible: true,
      },
      {
        name: 'gmail:archive-email',
        description: 'Archive an email',
        defaultTier: 'yellow',
        reversible: true,
      },
      {
        name: 'gmail:mark-read',
        description: 'Mark email as read',
        defaultTier: 'yellow',
        reversible: true,
      },
      {
        name: 'gmail:send-email',
        description: 'Send a new email',
        defaultTier: 'red',
        reversible: false,
      },
      {
        name: 'gmail:reply-email',
        description: 'Reply to an email',
        defaultTier: 'red',
        reversible: false,
      },
      {
        name: 'gmail:delete-email',
        description: 'Permanently delete an email',
        defaultTier: 'red',
        reversible: false,
      },
    ];

    const registry = makeSuiteRegistryWithActions({ gmail: gmailActions });
    const actions = registry.collectActions();

    expect(actions).toHaveLength(8);
    expect(actions.find((a: SkillAction) => a.name === 'gmail:search-emails')?.defaultTier).toBe(
      'green',
    );
    expect(actions.find((a: SkillAction) => a.name === 'gmail:label-email')?.defaultTier).toBe(
      'yellow',
    );
    expect(actions.find((a: SkillAction) => a.name === 'gmail:send-email')?.defaultTier).toBe(
      'red',
    );
    expect(actions.find((a: SkillAction) => a.name === 'gmail:delete-email')?.defaultTier).toBe(
      'red',
    );
  });

  it('merges actions from multiple suites into valid combined list', () => {
    const registry = makeSuiteRegistryWithActions({
      ticktick: [
        {
          name: 'ticktick:get-tasks',
          description: 'Get tasks',
          defaultTier: 'green',
          reversible: true,
        },
      ],
      gmail: [
        {
          name: 'gmail:search-emails',
          description: 'Search emails',
          defaultTier: 'green',
          reversible: true,
        },
      ],
      telegram: [
        {
          name: 'telegram:send-message',
          description: 'Send message',
          defaultTier: 'green',
          reversible: false,
        },
      ],
      digest: [
        {
          name: 'digest:compile-briefing',
          description: 'Compile briefing',
          defaultTier: 'green',
          reversible: true,
        },
      ],
    });

    const actions = registry.collectActions();
    expect(actions).toHaveLength(4);
    const names = actions.map((a: SkillAction) => a.name);
    expect(names).toContain('ticktick:get-tasks');
    expect(names).toContain('gmail:search-emails');
    expect(names).toContain('telegram:send-message');
    expect(names).toContain('digest:compile-briefing');
  });
});
