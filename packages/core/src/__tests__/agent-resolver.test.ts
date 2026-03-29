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
    model: null,
    maxTurns: null,
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

function makeMockCapabilityLibrary() {
  return {
    collectMcpServers: vi.fn((skillNames?: string[]) => {
      const all: Record<string, any> = {
        ticktick: { command: 'ticktick-mcp', args: [] },
        gmail: { command: 'gmail-mcp', args: [] },
      };
      if (!skillNames) return all;
      const filtered: Record<string, any> = {};
      for (const name of skillNames) {
        if (all[name]) filtered[name] = all[name];
      }
      return filtered;
    }),
    collectAgentDefinitions: vi.fn((skillNames?: string[]) => {
      const all: Record<string, any> = {
        ticktick: { description: 'TickTick tasks', prompt: '...', tools: [] },
        gmail: { description: 'Gmail email', prompt: '...', tools: [] },
      };
      if (!skillNames) return all;
      const filtered: Record<string, any> = {};
      for (const name of skillNames) {
        if (all[name]) filtered[name] = all[name];
      }
      return filtered;
    }),
    resolveVendorPlugins: vi.fn((skillNames?: string[]) => {
      if (!skillNames) return [{ type: 'local' as const, path: '/plugins/all' }];
      return [];
    }),
  } as any;
}

describe('AgentResolver', () => {
  describe('SuiteRegistry fallback (legacy)', () => {
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

    it('falls back to suiteRegistry when agent has suiteIds but no skills', () => {
      const registry = makeMockSuiteRegistry();
      const library = makeMockCapabilityLibrary();
      const resolver = createAgentResolver({
        capabilityLibrary: library,
        suiteRegistry: registry,
      });
      const agent = makeAgent({ suiteIds: ['email'], skills: [] });

      resolver.resolveAgentCapabilities(agent);
      // capabilityLibrary should NOT be used — the default/all path catches this
      // since skills is empty and suiteIds is populated, but isDefault is false,
      // the default path won't fire (skills.length===0 && suiteIds.length===0 is false)
      // so it falls through to suiteRegistry
      expect(registry.collectMcpServers).toHaveBeenCalledWith(['email']);
      expect(library.collectMcpServers).not.toHaveBeenCalled();
    });
  });

  describe('CapabilityLibrary (skills-based)', () => {
    it('resolves MCPs from skills when agent has populated skills', () => {
      const library = makeMockCapabilityLibrary();
      const resolver = createAgentResolver({ capabilityLibrary: library });
      const agent = makeAgent({ skills: ['ticktick', 'gmail'] });

      const caps = resolver.resolveAgentCapabilities(agent);
      expect(library.collectMcpServers).toHaveBeenCalledWith(['ticktick', 'gmail']);
      expect(library.collectAgentDefinitions).toHaveBeenCalledWith(['ticktick', 'gmail']);
      expect(library.resolveVendorPlugins).toHaveBeenCalledWith(['ticktick', 'gmail']);
      expect(Object.keys(caps.mcpServers).length).toBe(2);
      expect(Object.keys(caps.agentDefinitions).length).toBe(2);
    });

    it('resolves only the specified skill when agent has a single skill', () => {
      const library = makeMockCapabilityLibrary();
      const resolver = createAgentResolver({ capabilityLibrary: library });
      const agent = makeAgent({ skills: ['ticktick'] });

      const caps = resolver.resolveAgentCapabilities(agent);
      expect(library.collectMcpServers).toHaveBeenCalledWith(['ticktick']);
      expect(Object.keys(caps.mcpServers)).toEqual(['ticktick']);
      expect(Object.keys(caps.agentDefinitions)).toEqual(['ticktick']);
    });

    it('resolves ALL capabilities for default agent with empty skills', () => {
      const library = makeMockCapabilityLibrary();
      const resolver = createAgentResolver({ capabilityLibrary: library });
      const agent = makeAgent({ isDefault: true, skills: [] });

      const caps = resolver.resolveAgentCapabilities(agent);
      expect(library.collectMcpServers).toHaveBeenCalledWith(undefined);
      expect(library.collectAgentDefinitions).toHaveBeenCalledWith(undefined);
      expect(library.resolveVendorPlugins).toHaveBeenCalledWith(undefined);
      expect(Object.keys(caps.mcpServers).length).toBe(2);
      expect(Object.keys(caps.agentDefinitions).length).toBe(2);
    });

    it('resolves ALL capabilities when both skills and suiteIds are empty', () => {
      const library = makeMockCapabilityLibrary();
      const resolver = createAgentResolver({ capabilityLibrary: library });
      const agent = makeAgent({ skills: [], suiteIds: [] });

      const caps = resolver.resolveAgentCapabilities(agent);
      expect(library.collectMcpServers).toHaveBeenCalledWith(undefined);
      expect(Object.keys(caps.mcpServers).length).toBe(2);
    });

    it('skills take priority over suiteIds when both are present', () => {
      const library = makeMockCapabilityLibrary();
      const registry = makeMockSuiteRegistry();
      const resolver = createAgentResolver({
        capabilityLibrary: library,
        suiteRegistry: registry,
      });
      const agent = makeAgent({ skills: ['ticktick'], suiteIds: ['email'] });

      const caps = resolver.resolveAgentCapabilities(agent);
      expect(library.collectMcpServers).toHaveBeenCalledWith(['ticktick']);
      expect(registry.collectMcpServers).not.toHaveBeenCalled();
      expect(Object.keys(caps.mcpServers)).toEqual(['ticktick']);
    });
  });

  describe('no dependencies provided', () => {
    it('returns empty capabilities when no library or registry is provided', () => {
      const resolver = createAgentResolver({});
      const agent = makeAgent({ suiteIds: ['email'] });

      const caps = resolver.resolveAgentCapabilities(agent);
      expect(caps.mcpServers).toEqual({});
      expect(caps.agentDefinitions).toEqual({});
      expect(caps.plugins).toEqual([]);
    });
  });
});
