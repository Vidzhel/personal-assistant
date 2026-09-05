import { describe, it, expect, vi } from 'vitest';
import { createAgentResolver } from '../agent-registry/agent-resolver.ts';
import type { NamedAgent } from '@raven/shared';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CapabilityLibrary } from '../capability-library/capability-library.ts';

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
    getSkill: vi.fn((name: string) => ({ config: { name, mcps: [name], vendorSkills: [] } })),
    getMcp: vi.fn((name: string) => ({ name })),
    getVendorPath: vi.fn(() => undefined),
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
  function vendorFixture(reference: string) {
    const root = mkdtempSync(join(tmpdir(), 'raven-vendor-reference-'));
    const skillDir = join(root, 'library', 'skills', 'testing', 'notes');
    const vendorDir = join(root, 'library', 'vendor', 'fixture');
    mkdirSync(skillDir, { recursive: true });
    mkdirSync(vendorDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'config.json'),
      JSON.stringify({
        name: 'notes',
        displayName: 'notes',
        description: 'Fixture',
        vendorSkills: [reference],
      }),
    );
    writeFileSync(join(skillDir, 'skill.md'), 'Fixture instructions');
    return { root, vendorDir };
  }

  it.each(['skills/notes/SKILL.md', 'plugins/notes/.claude-plugin/plugin.json'])(
    'accepts an existing vendor definition at %s',
    async (definition) => {
      const reference = definition.startsWith('skills/')
        ? 'fixture/notes'
        : 'fixture/plugins/notes';
      const { root, vendorDir } = vendorFixture(reference);
      try {
        const parts = definition.split('/');
        const file = parts.pop()!;
        const directory = join(vendorDir, ...parts);
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          join(directory, file),
          file === 'SKILL.md' ? '# Fixture skill' : '{"name":"notes"}',
        );
        const library = new CapabilityLibrary();
        await library.load(join(root, 'library'));
        expect(
          createAgentResolver({ capabilityLibrary: library }).resolveAgentCapabilities(
            makeAgent({ skills: ['notes'] }),
          ).plugins,
        ).toEqual([{ type: 'local', path: vendorDir }]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    'missing-suffix',
    'empty-definition-directory',
    'symlink-escape',
    'traversal',
    'absolute',
    'root-only',
  ])('rejects %s despite an existing vendor root', async (kind) => {
    const reference =
      kind === 'traversal'
        ? 'fixture/../outside'
        : kind === 'absolute'
          ? '/fixture/notes'
          : kind === 'root-only'
            ? 'fixture'
            : 'fixture/notes';
    const { root, vendorDir } = vendorFixture(reference);
    try {
      if (kind === 'empty-definition-directory') mkdirSync(join(vendorDir, 'notes'));
      if (kind === 'symlink-escape') {
        const outside = join(root, 'outside');
        mkdirSync(outside);
        writeFileSync(join(outside, 'SKILL.md'), '# Outside this vendor');
        symlinkSync(outside, join(vendorDir, 'notes'));
      }
      const library = new CapabilityLibrary();
      await library.load(join(root, 'library'));
      const collect = vi.spyOn(library, 'collectMcpServers');
      expect(() =>
        createAgentResolver({ capabilityLibrary: library }).resolveAgentCapabilities(
          makeAgent({ skills: ['notes'] }),
        ),
      ).toThrow(/vendor skill/);
      expect(collect).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves only bound definitions and deduplicated vendor plugins from an actual temporary library', async () => {
    const root = mkdtempSync(join(tmpdir(), 'raven-resolver-library-'));
    try {
      mkdirSync(join(root, 'mcps'));
      for (const name of ['notes', 'unrelated']) {
        writeFileSync(
          join(root, 'mcps', `${name}.json`),
          JSON.stringify({
            name,
            displayName: name,
            command: 'unused-fixture-command',
            args: [],
          }),
        );
        const skillDir = join(root, 'skills', 'testing', name);
        mkdirSync(skillDir, { recursive: true });
        for (const suffix of ['one', 'two']) {
          const definitionDir = join(root, 'vendor', name, suffix);
          mkdirSync(definitionDir, { recursive: true });
          writeFileSync(join(definitionDir, 'SKILL.md'), `# ${name} ${suffix}`);
        }
        writeFileSync(
          join(skillDir, 'config.json'),
          JSON.stringify({
            name,
            displayName: name,
            description: name,
            mcps: [name],
            vendorSkills: [`${name}/one`, `${name}/two`],
          }),
        );
        writeFileSync(join(skillDir, 'skill.md'), `Instructions for ${name}`);
      }
      const library = new CapabilityLibrary();
      await library.load(root);
      const resolver = createAgentResolver({ capabilityLibrary: library });
      const capabilities = resolver.resolveAgentCapabilities(makeAgent({ skills: ['notes'] }));
      expect(Object.keys(capabilities.mcpServers)).toEqual(['notes']);
      expect(Object.keys(capabilities.agentDefinitions)).toEqual(['notes']);
      expect(capabilities.agentDefinitions.notes).toMatchObject({
        prompt: 'Instructions for notes',
        tools: ['mcp__notes__*'],
        mcpServers: ['notes'],
      });
      expect(capabilities.plugins).toEqual([
        { type: 'local', path: join(root, 'vendor', 'notes') },
      ]);
      expect(resolver.resolveAgentCapabilities(makeAgent()).agentDefinitions).toEqual({});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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

  it.each(['skill', 'mcp', 'vendor'])(
    'rejects missing %s references before returning bindings',
    (kind) => {
      const library = makeMockCapabilityLibrary();
      if (kind === 'skill') library.getSkill.mockReturnValue(undefined);
      if (kind === 'mcp') library.getMcp.mockReturnValue(undefined);
      if (kind === 'vendor')
        library.getSkill.mockReturnValue({
          config: { name: 'gmail', mcps: [], vendorSkills: ['missing/helper'] },
        });
      const resolver = createAgentResolver({ capabilityLibrary: library });
      expect(() => resolver.resolveAgentCapabilities(makeAgent({ skills: ['gmail'] }))).toThrow(
        /Unknown agent skill|unknown MCP|Unknown vendor/,
      );
      expect(library.collectAgentDefinitions).not.toHaveBeenCalled();
      expect(library.collectMcpServers).not.toHaveBeenCalled();
    },
  );

  it('returns fresh empty maps so callers cannot contaminate a later resolution', () => {
    const resolver = createAgentResolver({});
    const first = resolver.resolveAgentCapabilities(makeAgent());
    first.agentDefinitions.unwanted = { description: 'no', prompt: 'no' };
    expect(resolver.resolveAgentCapabilities(makeAgent()).agentDefinitions).toEqual({});
  });

  describe('no dependencies provided', () => {
    it('rejects configured skills when no library is provided', () => {
      const resolver = createAgentResolver({});
      expect(() => resolver.resolveAgentCapabilities(makeAgent({ skills: ['gmail'] }))).toThrow(
        'no capability library',
      );
    });
  });
});
