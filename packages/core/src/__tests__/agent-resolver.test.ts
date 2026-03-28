import { describe, it, expect, vi } from 'vitest';
import { createAgentResolver } from '../agent-registry/agent-resolver.ts';
import type { NamedAgent } from '@raven/shared';

function makeAgent(overrides: Partial<NamedAgent> = {}): NamedAgent {
  return {
    id: 'test-id',
    name: 'test-agent',
    description: null,
    instructions: null,
    suiteIds: [],
    skills: [],
    isDefault: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeMockSuiteRegistry() {
  return {
    getEnabledSuiteNames: vi.fn(() => ['email', 'task-management', 'notifications']),
    collectMcpServers: vi.fn((names?: string[]) => {
      const all: Record<string, any> = {
        email_gmail: { command: 'gmail', args: [] },
        'task-management_ticktick': { command: 'ticktick', args: [] },
        notifications_telegram: { command: 'tg', args: [] },
      };
      if (!names) return all;
      const filtered: Record<string, any> = {};
      for (const name of names) {
        for (const [k, v] of Object.entries(all)) {
          if (k.startsWith(name)) filtered[k] = v;
        }
      }
      return filtered;
    }),
    collectAgentDefinitions: vi.fn((names?: string[]) => {
      const all: Record<string, any> = {
        'email-agent': { description: 'Email', prompt: '...', tools: [] },
        'task-agent': { description: 'Tasks', prompt: '...', tools: [] },
        'notif-agent': { description: 'Notifications', prompt: '...', tools: [] },
      };
      if (!names) return all;
      const mapping: Record<string, string> = {
        email: 'email-agent',
        'task-management': 'task-agent',
        notifications: 'notif-agent',
      };
      const filtered: Record<string, any> = {};
      for (const n of names) {
        const key = mapping[n];
        if (key && all[key]) filtered[key] = all[key];
      }
      return filtered;
    }),
    collectVendorPlugins: vi.fn(() => []),
  } as any;
}

describe('AgentResolver', () => {
  it('returns all suites for default agent', () => {
    const registry = makeMockSuiteRegistry();
    const resolver = createAgentResolver({ suiteRegistry: registry });
    const agent = makeAgent({ isDefault: true, suiteIds: [] });

    const caps = resolver.resolveAgentCapabilities(agent);
    expect(registry.collectMcpServers).toHaveBeenCalledWith();
    expect(registry.collectAgentDefinitions).toHaveBeenCalledWith();
    expect(Object.keys(caps.mcpServers).length).toBe(3);
    expect(Object.keys(caps.agentDefinitions).length).toBe(3);
  });

  it('returns all suites when suiteIds is empty', () => {
    const registry = makeMockSuiteRegistry();
    const resolver = createAgentResolver({ suiteRegistry: registry });
    const agent = makeAgent({ isDefault: false, suiteIds: [] });

    const caps = resolver.resolveAgentCapabilities(agent);
    expect(registry.collectMcpServers).toHaveBeenCalledWith();
    expect(Object.keys(caps.mcpServers).length).toBe(3);
  });

  it('filters to bound suites only', () => {
    const registry = makeMockSuiteRegistry();
    const resolver = createAgentResolver({ suiteRegistry: registry });
    const agent = makeAgent({ suiteIds: ['email'] });

    resolver.resolveAgentCapabilities(agent);
    expect(registry.collectMcpServers).toHaveBeenCalledWith(['email']);
    expect(registry.collectAgentDefinitions).toHaveBeenCalledWith(['email']);
  });

  it('warns about missing suites but still resolves valid ones', () => {
    const registry = makeMockSuiteRegistry();
    const resolver = createAgentResolver({ suiteRegistry: registry });
    const agent = makeAgent({ suiteIds: ['email', 'nonexistent-suite'] });

    const caps = resolver.resolveAgentCapabilities(agent);
    // Should only pass valid suite names to collect methods
    expect(registry.collectMcpServers).toHaveBeenCalledWith(['email']);
    expect(registry.collectAgentDefinitions).toHaveBeenCalledWith(['email']);
    expect(caps.mcpServers).toBeDefined();
  });

  it('returns empty when all suite_ids are invalid', () => {
    const registry = makeMockSuiteRegistry();
    const resolver = createAgentResolver({ suiteRegistry: registry });
    const agent = makeAgent({ suiteIds: ['nonexistent'] });

    resolver.resolveAgentCapabilities(agent);
    expect(registry.collectMcpServers).toHaveBeenCalledWith([]);
    expect(registry.collectAgentDefinitions).toHaveBeenCalledWith([]);
  });
});
