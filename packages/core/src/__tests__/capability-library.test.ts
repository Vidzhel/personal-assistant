import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, afterEach } from 'vitest';

import { CapabilityLibrary } from '../capability-library/capability-library.ts';

let tempDir: string;
let lib: CapabilityLibrary;

function setup(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'cap-lib-'));
  lib = new CapabilityLibrary();
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data));
}

function validMcp(name: string, env?: Record<string, string>) {
  return {
    name,
    displayName: name,
    command: 'npx',
    args: ['-y', `@test/${name}`],
    ...(env ? { env } : {}),
  };
}

function validSkillConfig(name: string, overrides?: Record<string, unknown>) {
  return {
    name,
    displayName: name,
    description: `${name} skill`,
    ...overrides,
  };
}

function setupTestLibrary(opts?: {
  mcps?: Array<{ name: string; env?: Record<string, string> }>;
  skills?: Array<{
    name: string;
    domain?: string;
    mcps?: string[];
    tools?: string[];
    actions?: Array<{
      name: string;
      description: string;
      defaultTier: string;
      reversible: boolean;
    }>;
    vendorSkills?: string[];
    skillMd?: string;
    model?: string;
  }>;
  vendors?: string[];
}): string {
  const dir = setup();

  if (opts?.mcps?.length) {
    mkdirSync(join(dir, 'mcps'));
    for (const mcp of opts.mcps) {
      writeJson(join(dir, 'mcps', `${mcp.name}.json`), validMcp(mcp.name, mcp.env));
    }
  }

  if (opts?.skills?.length) {
    for (const skill of opts.skills) {
      const domain = skill.domain ?? 'default';
      const skillDir = join(dir, 'skills', domain, skill.name);
      mkdirSync(skillDir, { recursive: true });
      writeJson(
        join(skillDir, 'config.json'),
        validSkillConfig(skill.name, {
          mcps: skill.mcps,
          tools: skill.tools,
          actions: skill.actions,
          vendorSkills: skill.vendorSkills,
          model: skill.model,
        }),
      );
      if (skill.skillMd) {
        writeFileSync(join(skillDir, 'skill.md'), skill.skillMd);
      }
    }
  }

  if (opts?.vendors?.length) {
    for (const vendor of opts.vendors) {
      mkdirSync(join(dir, 'vendor', vendor), { recursive: true });
    }
  }

  return dir;
}

describe('CapabilityLibrary', () => {
  describe('getSkillNames', () => {
    it('returns all loaded skill names', async () => {
      const dir = setupTestLibrary({
        skills: [
          { name: 'alpha', domain: 'a' },
          { name: 'beta', domain: 'b' },
          { name: 'gamma', domain: 'c' },
        ],
      });

      await lib.load(dir);
      const names = lib.getSkillNames();

      expect(names).toHaveLength(3);
      expect(names).toContain('alpha');
      expect(names).toContain('beta');
      expect(names).toContain('gamma');
    });
  });

  describe('collectMcpServers', () => {
    it('returns MCPs for given skills only', async () => {
      const dir = setupTestLibrary({
        mcps: [{ name: 'ticktick' }, { name: 'gmail' }],
        skills: [
          { name: 'tasks', domain: 'prod', mcps: ['ticktick'] },
          { name: 'email', domain: 'comm', mcps: ['gmail'] },
        ],
      });

      await lib.load(dir);
      const servers = lib.collectMcpServers(['tasks']);

      expect(Object.keys(servers)).toEqual(['ticktick']);
      expect(servers['ticktick'].command).toBe('npx');
    });

    it('returns all MCPs when no skills specified', async () => {
      const dir = setupTestLibrary({
        mcps: [{ name: 'ticktick' }, { name: 'gmail' }],
        skills: [
          { name: 'tasks', domain: 'prod', mcps: ['ticktick'] },
          { name: 'email', domain: 'comm', mcps: ['gmail'] },
        ],
      });

      await lib.load(dir);
      const servers = lib.collectMcpServers();

      expect(Object.keys(servers)).toHaveLength(2);
      expect(servers).toHaveProperty('ticktick');
      expect(servers).toHaveProperty('gmail');
    });

    it('deduplicates when multiple skills reference the same MCP', async () => {
      const dir = setupTestLibrary({
        mcps: [{ name: 'shared-mcp' }],
        skills: [
          { name: 'skill-a', domain: 'a', mcps: ['shared-mcp'] },
          { name: 'skill-b', domain: 'b', mcps: ['shared-mcp'] },
        ],
      });

      await lib.load(dir);
      const servers = lib.collectMcpServers();

      expect(Object.keys(servers)).toEqual(['shared-mcp']);
    });

    it('resolves env var placeholders from process.env', async () => {
      process.env['TEST_CAP_LIB_TOKEN'] = 'secret-123';
      const dir = setupTestLibrary({
        mcps: [
          {
            name: 'authed',
            env: { API_TOKEN: '${TEST_CAP_LIB_TOKEN}' },
          },
        ],
        skills: [{ name: 'uses-auth', domain: 'x', mcps: ['authed'] }],
      });

      await lib.load(dir);
      const servers = lib.collectMcpServers();

      expect(servers['authed'].env).toEqual({ API_TOKEN: 'secret-123' });
      delete process.env['TEST_CAP_LIB_TOKEN'];
    });
  });

  describe('collectAgentDefinitions', () => {
    it('builds SubAgentDefinition from skills', async () => {
      const dir = setupTestLibrary({
        skills: [
          {
            name: 'my-skill',
            domain: 'test',
            skillMd: '# My Skill\nDoes things.',
            model: 'sonnet',
          },
        ],
      });

      await lib.load(dir);
      const defs = lib.collectAgentDefinitions(['my-skill']);

      expect(defs['my-skill']).toBeDefined();
      expect(defs['my-skill'].description).toBe('my-skill skill');
      expect(defs['my-skill'].prompt).toBe('# My Skill\nDoes things.');
      expect(defs['my-skill'].model).toBe('sonnet');
    });

    it('includes MCP tool patterns in tools', async () => {
      const dir = setupTestLibrary({
        mcps: [{ name: 'ticktick' }],
        skills: [
          {
            name: 'tasks',
            domain: 'prod',
            mcps: ['ticktick'],
            tools: ['Read', 'Write'],
          },
        ],
      });

      await lib.load(dir);
      const defs = lib.collectAgentDefinitions(['tasks']);

      expect(defs['tasks'].tools).toContain('Read');
      expect(defs['tasks'].tools).toContain('Write');
      expect(defs['tasks'].tools).toContain('mcp__ticktick__*');
    });

    it('sets mcpServers from skill config', async () => {
      const dir = setupTestLibrary({
        mcps: [{ name: 'gmail' }],
        skills: [{ name: 'email', domain: 'comm', mcps: ['gmail'] }],
      });

      await lib.load(dir);
      const defs = lib.collectAgentDefinitions(['email']);

      expect(defs['email'].mcpServers).toEqual(['gmail']);
    });

    it('returns all agent definitions when no skills specified', async () => {
      const dir = setupTestLibrary({
        skills: [
          { name: 'a', domain: 'x' },
          { name: 'b', domain: 'y' },
        ],
      });

      await lib.load(dir);
      const defs = lib.collectAgentDefinitions();

      expect(Object.keys(defs)).toHaveLength(2);
      expect(defs).toHaveProperty('a');
      expect(defs).toHaveProperty('b');
    });
  });

  describe('collectActions', () => {
    it('returns actions from specified skills', async () => {
      const dir = setupTestLibrary({
        skills: [
          {
            name: 'tasks',
            domain: 'prod',
            actions: [
              {
                name: 'tasks:create',
                description: 'Create a task',
                defaultTier: 'green',
                reversible: true,
              },
            ],
          },
          {
            name: 'email',
            domain: 'comm',
            actions: [
              {
                name: 'email:send',
                description: 'Send email',
                defaultTier: 'yellow',
                reversible: false,
              },
            ],
          },
        ],
      });

      await lib.load(dir);
      const actions = lib.collectActions(['tasks']);

      expect(actions).toHaveLength(1);
      expect(actions[0].name).toBe('tasks:create');
    });

    it('returns all actions when no skills specified', async () => {
      const dir = setupTestLibrary({
        skills: [
          {
            name: 'tasks',
            domain: 'prod',
            actions: [
              {
                name: 'tasks:create',
                description: 'Create a task',
                defaultTier: 'green',
                reversible: true,
              },
            ],
          },
          {
            name: 'email',
            domain: 'comm',
            actions: [
              {
                name: 'email:send',
                description: 'Send email',
                defaultTier: 'yellow',
                reversible: false,
              },
            ],
          },
        ],
      });

      await lib.load(dir);
      const actions = lib.collectActions();

      expect(actions).toHaveLength(2);
      expect(actions.map((a) => a.name)).toContain('tasks:create');
      expect(actions.map((a) => a.name)).toContain('email:send');
    });

    it('deduplicates actions by name', async () => {
      const dir = setupTestLibrary({
        skills: [
          {
            name: 'skill-a',
            domain: 'x',
            actions: [
              {
                name: 'shared:action',
                description: 'A shared action',
                defaultTier: 'green',
                reversible: true,
              },
            ],
          },
          {
            name: 'skill-b',
            domain: 'y',
            actions: [
              {
                name: 'shared:action',
                description: 'Duplicate action',
                defaultTier: 'red',
                reversible: false,
              },
            ],
          },
        ],
      });

      await lib.load(dir);
      const actions = lib.collectActions();

      expect(actions).toHaveLength(1);
      expect(actions[0].name).toBe('shared:action');
    });
  });

  describe('resolveVendorPlugins', () => {
    it('returns paths for skills with vendorSkills', async () => {
      const dir = setupTestLibrary({
        skills: [
          {
            name: 'my-skill',
            domain: 'test',
            vendorSkills: ['claude-code/something'],
          },
        ],
        vendors: ['claude-code'],
      });

      await lib.load(dir);
      const plugins = lib.resolveVendorPlugins(['my-skill']);

      expect(plugins).toHaveLength(1);
      expect(plugins[0].type).toBe('local');
      expect(plugins[0].path).toBe(join(dir, 'vendor', 'claude-code'));
    });

    it('deduplicates vendor plugins', async () => {
      const dir = setupTestLibrary({
        skills: [
          {
            name: 'skill-a',
            domain: 'a',
            vendorSkills: ['claude-code/foo'],
          },
          {
            name: 'skill-b',
            domain: 'b',
            vendorSkills: ['claude-code/bar'],
          },
        ],
        vendors: ['claude-code'],
      });

      await lib.load(dir);
      const plugins = lib.resolveVendorPlugins();

      expect(plugins).toHaveLength(1);
    });

    it('returns empty array when no vendorSkills', async () => {
      const dir = setupTestLibrary({
        skills: [{ name: 'plain', domain: 'test' }],
      });

      await lib.load(dir);
      const plugins = lib.resolveVendorPlugins();

      expect(plugins).toEqual([]);
    });
  });

  describe('getSkillCatalog', () => {
    it('returns formatted skill catalog text', async () => {
      const dir = setupTestLibrary({
        skills: [
          { name: 'tasks', domain: 'prod' },
          { name: 'email', domain: 'comm' },
        ],
      });

      await lib.load(dir);
      const catalog = lib.getSkillCatalog();

      expect(catalog).toContain('## Available Skills');
      expect(catalog).toContain('- **tasks** — tasks skill');
      expect(catalog).toContain('- **email** — email skill');
    });

    it('filters by skill names when provided', async () => {
      const dir = setupTestLibrary({
        skills: [
          { name: 'tasks', domain: 'prod' },
          { name: 'email', domain: 'comm' },
        ],
      });

      await lib.load(dir);
      const catalog = lib.getSkillCatalog(['tasks']);

      expect(catalog).toContain('- **tasks** — tasks skill');
      expect(catalog).not.toContain('email');
    });
  });

  describe('error handling', () => {
    it('throws when accessing before load()', () => {
      const unloaded = new CapabilityLibrary();
      expect(() => unloaded.getSkillNames()).toThrow('not loaded');
    });
  });
});
