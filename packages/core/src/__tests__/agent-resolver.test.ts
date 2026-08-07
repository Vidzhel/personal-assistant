import { describe, it, expect, vi } from 'vitest';
import { createAgentResolver } from '../agent-registry/agent-resolver.ts';
import type { NamedAgent } from '@raven/shared';

function makeAgent(overrides: Partial<NamedAgent> = {}): NamedAgent {
  return {
    id: 'test-id',
    name: 'test-agent',
    description: null,
    instructions: null,
    skills: [],
    model: null,
    maxTurns: null,
    isDefault: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
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
  describe('empty skills means NOTHING', () => {
    it('returns empty capabilities for a default agent with no bindings', () => {
      const library = makeMockCapabilityLibrary();
      const resolver = createAgentResolver({ capabilityLibrary: library });
      const agent = makeAgent({ isDefault: true, skills: [] });

      const caps = resolver.resolveAgentCapabilities(agent);
      expect(library.collectMcpServers).not.toHaveBeenCalled();
      expect(caps.mcpServers).toEqual({});
      expect(caps.agentDefinitions).toEqual({});
      expect(caps.plugins).toEqual([]);
    });

    it('returns empty capabilities for a non-default agent with no bindings', () => {
      const library = makeMockCapabilityLibrary();
      const resolver = createAgentResolver({ capabilityLibrary: library });
      const agent = makeAgent({ isDefault: false, skills: [] });

      const caps = resolver.resolveAgentCapabilities(agent);
      expect(library.collectMcpServers).not.toHaveBeenCalled();
      expect(caps.mcpServers).toEqual({});
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

    it('resolves NOTHING for a default agent with empty skills (empty skills means none)', () => {
      const library = makeMockCapabilityLibrary();
      const resolver = createAgentResolver({ capabilityLibrary: library });
      const agent = makeAgent({ isDefault: true, skills: [] });

      const caps = resolver.resolveAgentCapabilities(agent);
      expect(library.collectMcpServers).not.toHaveBeenCalled();
      expect(caps.mcpServers).toEqual({});
      expect(caps.agentDefinitions).toEqual({});
      expect(caps.plugins).toEqual([]);
    });
  });

  describe('no dependencies provided', () => {
    it('returns empty capabilities when no library is provided', () => {
      const resolver = createAgentResolver({});
      const agent = makeAgent({ skills: ['gmail'] });

      const caps = resolver.resolveAgentCapabilities(agent);
      expect(caps.mcpServers).toEqual({});
      expect(caps.agentDefinitions).toEqual({});
      expect(caps.plugins).toEqual([]);
    });
  });
});
