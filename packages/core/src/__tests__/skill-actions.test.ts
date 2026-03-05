import { describe, it, expect, vi } from 'vitest';
import { SkillRegistry, isValidActionName } from '../skill-registry/skill-registry.ts';
import type { RavenSkill, SkillContext, SkillAction } from '@raven/shared';

function makeSkill(name: string, actions: SkillAction[] = []): RavenSkill {
  return {
    manifest: {
      name,
      displayName: name,
      version: '1.0.0',
      description: `${name} skill`,
      capabilities: ['mcp-server'],
    },
    initialize: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    getMcpServers: () => ({}),
    getAgentDefinitions: () => ({}),
    getActions: () => actions,
    handleScheduledTask: vi.fn().mockResolvedValue(undefined),
  };
}

function makeContext(): Omit<SkillContext, 'config'> {
  return {
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
    db: { run: vi.fn(), get: vi.fn(), all: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    getSkillData: vi.fn().mockResolvedValue(null),
  };
}

describe('isValidActionName', () => {
  it('accepts valid kebab-case colon-separated names', () => {
    expect(isValidActionName('ticktick:create-task')).toBe(true);
    expect(isValidActionName('gmail:search-emails')).toBe(true);
    expect(isValidActionName('a:b')).toBe(true);
    expect(isValidActionName('skill123:action456')).toBe(true);
  });

  it('rejects names without colon', () => {
    expect(isValidActionName('ticktick-create-task')).toBe(false);
  });

  it('rejects names with uppercase', () => {
    expect(isValidActionName('TickTick:create')).toBe(false);
  });

  it('rejects names starting with number', () => {
    expect(isValidActionName('1skill:action')).toBe(false);
    expect(isValidActionName('skill:1action')).toBe(false);
  });

  it('rejects empty or whitespace', () => {
    expect(isValidActionName('')).toBe(false);
    expect(isValidActionName(' ')).toBe(false);
  });

  it('rejects multiple colons', () => {
    expect(isValidActionName('a:b:c')).toBe(false);
  });
});

describe('SkillRegistry.collectActions', () => {
  it('collects actions from all registered skills', async () => {
    const registry = new SkillRegistry();
    await registry.registerSkill(
      makeSkill('ticktick', [
        {
          name: 'ticktick:get-tasks',
          description: 'Get tasks',
          defaultTier: 'green',
          reversible: true,
        },
      ]),
      {},
      makeContext(),
    );
    await registry.registerSkill(
      makeSkill('gmail', [
        {
          name: 'gmail:search-emails',
          description: 'Search emails',
          defaultTier: 'green',
          reversible: true,
        },
      ]),
      {},
      makeContext(),
    );

    const actions = registry.collectActions();
    expect(actions).toHaveLength(2);
    expect(actions.map((a) => a.name)).toContain('ticktick:get-tasks');
    expect(actions.map((a) => a.name)).toContain('gmail:search-emails');
  });

  it('filters by skill names', async () => {
    const registry = new SkillRegistry();
    await registry.registerSkill(
      makeSkill('ticktick', [
        {
          name: 'ticktick:get-tasks',
          description: 'Get tasks',
          defaultTier: 'green',
          reversible: true,
        },
      ]),
      {},
      makeContext(),
    );
    await registry.registerSkill(
      makeSkill('gmail', [
        {
          name: 'gmail:search-emails',
          description: 'Search emails',
          defaultTier: 'green',
          reversible: true,
        },
      ]),
      {},
      makeContext(),
    );

    const actions = registry.collectActions(['gmail']);
    expect(actions).toHaveLength(1);
    expect(actions[0].name).toBe('gmail:search-emails');
  });

  it('returns empty array for skills with no actions', async () => {
    const registry = new SkillRegistry();
    await registry.registerSkill(makeSkill('empty'), {}, makeContext());

    const actions = registry.collectActions();
    expect(actions).toHaveLength(0);
  });

  it('skips duplicate action names across skills', async () => {
    const registry = new SkillRegistry();
    await registry.registerSkill(
      makeSkill('skill-a', [
        {
          name: 'skill-a:do-thing',
          description: 'First declaration',
          defaultTier: 'green',
          reversible: true,
        },
      ]),
      {},
      makeContext(),
    );
    await registry.registerSkill(
      makeSkill('skill-b', [
        {
          name: 'skill-a:do-thing',
          description: 'Duplicate from another skill',
          defaultTier: 'red',
          reversible: false,
        },
      ]),
      {},
      makeContext(),
    );

    const actions = registry.collectActions();
    expect(actions).toHaveLength(1);
    expect(actions[0].description).toBe('First declaration');
  });

  it('skips actions with invalid names', async () => {
    const registry = new SkillRegistry();
    await registry.registerSkill(
      makeSkill('bad', [
        { name: 'INVALID', description: 'Bad action', defaultTier: 'green', reversible: true },
        {
          name: 'bad:valid-action',
          description: 'Good action',
          defaultTier: 'green',
          reversible: true,
        },
      ]),
      {},
      makeContext(),
    );

    const actions = registry.collectActions();
    expect(actions).toHaveLength(1);
    expect(actions[0].name).toBe('bad:valid-action');
  });
});

describe('Skill action declarations via registry', () => {
  it('collects ticktick-shaped actions with correct tier assignments', async () => {
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

    const registry = new SkillRegistry();
    await registry.registerSkill(makeSkill('ticktick', ticktickActions), {}, makeContext());
    const actions = registry.collectActions();

    expect(actions).toHaveLength(6);
    for (const action of actions) {
      expect(isValidActionName(action.name)).toBe(true);
    }
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

  it('collects gmail-shaped actions with correct tier assignments', async () => {
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

    const registry = new SkillRegistry();
    await registry.registerSkill(makeSkill('gmail', gmailActions), {}, makeContext());
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

  it('collects telegram-shaped actions with all-green tiers', async () => {
    const telegramActions: SkillAction[] = [
      {
        name: 'telegram:send-message',
        description: 'Send a message to user',
        defaultTier: 'green',
        reversible: false,
      },
      {
        name: 'telegram:send-notification',
        description: 'Send a system notification',
        defaultTier: 'green',
        reversible: false,
      },
    ];

    const registry = new SkillRegistry();
    await registry.registerSkill(makeSkill('telegram', telegramActions), {}, makeContext());
    const actions = registry.collectActions();

    expect(actions).toHaveLength(2);
    for (const action of actions) {
      expect(action.defaultTier).toBe('green');
    }
  });

  it('collects digest-shaped actions with all-green tiers', async () => {
    const digestActions: SkillAction[] = [
      {
        name: 'digest:compile-briefing',
        description: 'Compile a digest briefing from skill data',
        defaultTier: 'green',
        reversible: true,
      },
    ];

    const registry = new SkillRegistry();
    await registry.registerSkill(makeSkill('digest', digestActions), {}, makeContext());
    const actions = registry.collectActions();

    expect(actions).toHaveLength(1);
    expect(actions[0].defaultTier).toBe('green');
  });

  it('merges actions from multiple skills into valid combined list', async () => {
    const registry = new SkillRegistry();
    await registry.registerSkill(
      makeSkill('ticktick', [
        {
          name: 'ticktick:get-tasks',
          description: 'Get tasks',
          defaultTier: 'green',
          reversible: true,
        },
      ]),
      {},
      makeContext(),
    );
    await registry.registerSkill(
      makeSkill('gmail', [
        {
          name: 'gmail:search-emails',
          description: 'Search emails',
          defaultTier: 'green',
          reversible: true,
        },
      ]),
      {},
      makeContext(),
    );
    await registry.registerSkill(
      makeSkill('telegram', [
        {
          name: 'telegram:send-message',
          description: 'Send message',
          defaultTier: 'green',
          reversible: false,
        },
      ]),
      {},
      makeContext(),
    );
    await registry.registerSkill(
      makeSkill('digest', [
        {
          name: 'digest:compile-briefing',
          description: 'Compile briefing',
          defaultTier: 'green',
          reversible: true,
        },
      ]),
      {},
      makeContext(),
    );

    const actions = registry.collectActions();
    expect(actions).toHaveLength(4);
    const names = actions.map((a: SkillAction) => a.name);
    expect(names).toContain('ticktick:get-tasks');
    expect(names).toContain('gmail:search-emails');
    expect(names).toContain('telegram:send-message');
    expect(names).toContain('digest:compile-briefing');
  });
});
