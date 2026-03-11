import { describe, it, expect, vi } from 'vitest';
import { SkillRegistry } from '../skill-registry/skill-registry.ts';
import type { RavenSkill, SkillContext, McpServerConfig, SubAgentDefinition } from '@raven/shared';

function makeSkill(
  name: string,
  opts: {
    mcpServers?: Record<string, McpServerConfig>;
    agentDefs?: Record<string, SubAgentDefinition>;
    schedules?: Array<{
      id: string;
      name: string;
      cron: string;
      taskType: string;
      enabled: boolean;
    }>;
  } = {},
): RavenSkill {
  return {
    manifest: {
      name,
      displayName: name,
      version: '1.0.0',
      description: `${name} skill`,
      capabilities: ['mcp-server'],
      defaultSchedules: opts.schedules,
    },
    initialize: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    getMcpServers: () => opts.mcpServers ?? {},
    getAgentDefinitions: () => opts.agentDefs ?? {},
    getActions: () => [],
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

describe('SkillRegistry', () => {
  it('registers and retrieves skills', async () => {
    const registry = new SkillRegistry();
    const skill = makeSkill('ticktick');
    await registry.registerSkill(skill, {}, makeContext());

    expect(registry.getSkill('ticktick')).toBe(skill);
    expect(registry.getSkill('nonexistent')).toBeUndefined();
  });

  it('getAllSkills returns all registered', async () => {
    const registry = new SkillRegistry();
    await registry.registerSkill(makeSkill('a'), {}, makeContext());
    await registry.registerSkill(makeSkill('b'), {}, makeContext());

    expect(registry.getAllSkills()).toHaveLength(2);
  });

  it('getEnabledSkillNames returns names', async () => {
    const registry = new SkillRegistry();
    await registry.registerSkill(makeSkill('gmail'), {}, makeContext());
    await registry.registerSkill(makeSkill('ticktick'), {}, makeContext());

    const names = registry.getEnabledSkillNames();
    expect(names).toContain('gmail');
    expect(names).toContain('ticktick');
  });

  it('collectMcpServers namespaces correctly', async () => {
    const registry = new SkillRegistry();
    const skill = makeSkill('gmail', {
      mcpServers: {
        api: { command: 'node', args: ['gmail-mcp.js'] },
        imap: { command: 'node', args: ['imap-mcp.js'] },
      },
    });
    await registry.registerSkill(skill, {}, makeContext());

    const servers = registry.collectMcpServers();
    expect(servers).toHaveProperty('gmail_api');
    expect(servers).toHaveProperty('gmail_imap');
    expect(servers['gmail_api'].command).toBe('node');
  });

  it('collectMcpServers filters by skill names', async () => {
    const registry = new SkillRegistry();
    await registry.registerSkill(
      makeSkill('gmail', { mcpServers: { api: { command: 'a', args: [] } } }),
      {},
      makeContext(),
    );
    await registry.registerSkill(
      makeSkill('ticktick', { mcpServers: { api: { command: 'b', args: [] } } }),
      {},
      makeContext(),
    );

    const servers = registry.collectMcpServers(['gmail']);
    expect(Object.keys(servers)).toHaveLength(1);
    expect(servers).toHaveProperty('gmail_api');
  });

  it('collectAgentDefinitions aggregates from enabled skills', async () => {
    const registry = new SkillRegistry();
    await registry.registerSkill(
      makeSkill('gmail', {
        agentDefs: {
          'gmail-reader': { description: 'Reads emails', prompt: 'Read emails', tools: [] },
        },
      }),
      {},
      makeContext(),
    );
    await registry.registerSkill(
      makeSkill('ticktick', {
        agentDefs: {
          'ticktick-manager': { description: 'Manages tasks', prompt: 'Manage tasks', tools: [] },
        },
      }),
      {},
      makeContext(),
    );

    const defs = registry.collectAgentDefinitions();
    expect(defs).toHaveProperty('gmail-reader');
    expect(defs).toHaveProperty('ticktick-manager');
  });

  it('findSkillForTaskType matches correct skill', async () => {
    const registry = new SkillRegistry();
    await registry.registerSkill(
      makeSkill('digest', {
        schedules: [
          {
            id: 's1',
            name: 'Daily Digest',
            cron: '0 8 * * *',
            taskType: 'daily-digest',
            enabled: true,
          },
        ],
      }),
      {},
      makeContext(),
    );
    await registry.registerSkill(makeSkill('gmail'), {}, makeContext());

    const found = registry.findSkillForTaskType('daily-digest');
    expect(found).toBeDefined();
    expect(found!.manifest.name).toBe('digest');

    const notFound = registry.findSkillForTaskType('nonexistent');
    expect(notFound).toBeUndefined();
  });

  it('validateAgentTools passes when tool patterns match MCP servers', async () => {
    const registry = new SkillRegistry();
    await registry.registerSkill(
      makeSkill('myskill', {
        mcpServers: { api: { command: 'node', args: ['api.js'] } },
        agentDefs: {
          'myskill-agent': {
            description: 'Test agent',
            prompt: 'Test',
            tools: ['mcp__myskill_api__*'],
          },
        },
      }),
      {},
      makeContext(),
    );

    expect(() => registry.validateAgentTools()).not.toThrow();
  });

  it('validateAgentTools throws when tool patterns reference nonexistent MCP server', async () => {
    const registry = new SkillRegistry();
    await registry.registerSkill(
      makeSkill('myskill', {
        mcpServers: { api: { command: 'node', args: ['api.js'] } },
        agentDefs: {
          'myskill-agent': {
            description: 'Test agent',
            prompt: 'Test',
            tools: ['mcp__wrong__*'],
          },
        },
      }),
      {},
      makeContext(),
    );

    expect(() => registry.validateAgentTools()).toThrow(/no MCP server named "wrong" exists/);
  });

  it('shutdown calls shutdown on all skills in reverse order', async () => {
    const registry = new SkillRegistry();
    const skillA = makeSkill('a');
    const skillB = makeSkill('b');
    await registry.registerSkill(skillA, {}, makeContext());
    await registry.registerSkill(skillB, {}, makeContext());

    await registry.shutdown();

    expect(skillB.shutdown).toHaveBeenCalled();
    expect(skillA.shutdown).toHaveBeenCalled();
    expect(registry.getAllSkills()).toHaveLength(0);
  });
});
