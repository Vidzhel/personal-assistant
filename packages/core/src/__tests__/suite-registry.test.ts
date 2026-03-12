import { describe, it, expect } from 'vitest';
import { SuiteRegistry } from '../suite-registry/suite-registry.ts';
import type { McpServerConfig } from '@raven/shared';

function makeSuiteRegistry(
  suites: Array<{
    name: string;
    mcpServers?: Record<string, McpServerConfig>;
    agents?: Array<{
      name: string;
      description: string;
      prompt: string;
      tools: string[];
      model?: string;
    }>;
    schedules?: Array<{
      id: string;
      name: string;
      cron: string;
      taskType: string;
      enabled: boolean;
    }>;
  }> = [],
): SuiteRegistry {
  const registry = new SuiteRegistry();
  for (const suite of suites) {
    (registry as any).suites.set(suite.name, {
      manifest: {
        name: suite.name,
        displayName: suite.name,
        version: '1.0.0',
        description: `${suite.name} suite`,
        capabilities: [],
        requiresEnv: [],
        services: [],
      },
      agents: (suite.agents ?? []).map((a) => ({
        name: a.name,
        description: a.description,
        model: a.model ?? 'sonnet',
        tools: a.tools,
        maxTurns: 10,
        prompt: a.prompt,
      })),
      mcpServers: suite.mcpServers ?? {},
      actions: [],
      schedules: suite.schedules ?? [],
      suiteDir: '/tmp/test',
    });
  }
  return registry;
}

describe('SuiteRegistry', () => {
  it('getAllSuites returns all registered', () => {
    const registry = makeSuiteRegistry([{ name: 'a' }, { name: 'b' }]);

    expect(registry.getAllSuites()).toHaveLength(2);
  });

  it('getEnabledSuiteNames returns names', () => {
    const registry = makeSuiteRegistry([{ name: 'email' }, { name: 'task-management' }]);

    const names = registry.getEnabledSuiteNames();
    expect(names).toContain('email');
    expect(names).toContain('task-management');
  });

  it('collectMcpServers returns all servers', () => {
    const registry = makeSuiteRegistry([
      {
        name: 'email',
        mcpServers: {
          email_gmail: { command: 'node', args: ['gmail-mcp.js'] },
        },
      },
      {
        name: 'task-management',
        mcpServers: {
          'task-management_ticktick': { command: 'node', args: ['ticktick-mcp.js'] },
        },
      },
    ]);

    const servers = registry.collectMcpServers();
    expect(servers).toHaveProperty('email_gmail');
    expect(servers).toHaveProperty('task-management_ticktick');
  });

  it('collectMcpServers filters by suite names', () => {
    const registry = makeSuiteRegistry([
      {
        name: 'email',
        mcpServers: { email_gmail: { command: 'a', args: [] } },
      },
      {
        name: 'task-management',
        mcpServers: { 'task-management_ticktick': { command: 'b', args: [] } },
      },
    ]);

    const servers = registry.collectMcpServers(['email']);
    expect(Object.keys(servers)).toHaveLength(1);
    expect(servers).toHaveProperty('email_gmail');
  });

  it('collectAgentDefinitions aggregates from enabled suites', () => {
    const registry = makeSuiteRegistry([
      {
        name: 'email',
        agents: [
          { name: 'gmail-reader', description: 'Reads emails', prompt: 'Read emails', tools: [] },
        ],
      },
      {
        name: 'task-management',
        agents: [
          {
            name: 'ticktick-manager',
            description: 'Manages tasks',
            prompt: 'Manage tasks',
            tools: [],
          },
        ],
      },
    ]);

    const defs = registry.collectAgentDefinitions();
    expect(defs).toHaveProperty('gmail-reader');
    expect(defs).toHaveProperty('ticktick-manager');
  });

  it('collectAgentDefinitions rewrites local MCP tool patterns to namespaced', () => {
    const registry = makeSuiteRegistry([
      {
        name: 'task-management',
        mcpServers: {
          'task-management_ticktick': { command: 'node', args: ['mcp.js'], env: { TOKEN: 'xxx' } },
        },
        agents: [
          {
            name: 'ticktick-agent',
            description: 'Manages tasks',
            prompt: 'Manage tasks',
            tools: ['mcp__ticktick__*', 'Read', 'Grep'],
          },
        ],
      },
    ]);

    const defs = registry.collectAgentDefinitions();
    const agent = defs['ticktick-agent'];
    expect(agent.tools).toContain('mcp__task-management_ticktick__*');
    expect(agent.tools).toContain('Read');
    expect(agent.tools).toContain('Grep');
    expect(agent.mcpServers).toEqual(['task-management_ticktick']);
  });

  it('collectAgentDefinitions omits mcpServers when suite has no MCPs', () => {
    const registry = makeSuiteRegistry([
      {
        name: 'basic',
        agents: [{ name: 'basic-agent', description: 'Basic', prompt: 'Basic', tools: [] }],
      },
    ]);

    const defs = registry.collectAgentDefinitions();
    expect(defs['basic-agent'].mcpServers).toBeUndefined();
  });

  it('findSuiteForTaskType matches correct suite', () => {
    const registry = makeSuiteRegistry([
      {
        name: 'daily-briefing',
        schedules: [
          {
            id: 's1',
            name: 'Daily Digest',
            cron: '0 8 * * *',
            taskType: 'daily-digest',
            enabled: true,
          },
        ],
      },
      { name: 'email' },
    ]);

    const found = registry.findSuiteForTaskType('daily-digest');
    expect(found).toBeDefined();
    expect(found!.manifest.name).toBe('daily-briefing');

    const notFound = registry.findSuiteForTaskType('nonexistent');
    expect(notFound).toBeUndefined();
  });

  it('validateAgentTools passes when tool patterns match MCP servers', () => {
    const registry = makeSuiteRegistry([
      {
        name: 'myskill',
        mcpServers: { myskill_api: { command: 'node', args: ['api.js'] } },
        agents: [
          {
            name: 'myskill-agent',
            description: 'Test agent',
            prompt: 'Test',
            tools: ['mcp__api__*'],
          },
        ],
      },
    ]);

    // Tool pattern rewriting should make mcp__api__* → mcp__myskill_api__*
    // Validation checks the rewritten patterns
    expect(() => registry.validateAgentTools()).not.toThrow();
  });

  it('validateAgentTools throws when tool patterns reference nonexistent MCP server', () => {
    const registry = makeSuiteRegistry([
      {
        name: 'myskill',
        mcpServers: { myskill_api: { command: 'node', args: ['api.js'] } },
        agents: [
          {
            name: 'myskill-agent',
            description: 'Test agent',
            prompt: 'Test',
            tools: ['mcp__wrong__*'],
          },
        ],
      },
    ]);

    expect(() => registry.validateAgentTools()).toThrow(/no MCP server named "wrong" exists/);
  });
});
