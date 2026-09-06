import { describe, it, expect } from 'vitest';
import { McpDefinitionSchema, SkillConfigSchema, LibraryIndexSchema } from '../library/schemas.ts';

describe('McpDefinitionSchema', () => {
  const validMcp = {
    name: 'ticktick',
    displayName: 'TickTick',
    command: 'npx',
    args: ['-y', '@alexarevalo.ai/mcp-server-ticktick'],
    env: { TICKTICK_TOKEN: '${TICKTICK_TOKEN}' },
  };

  it('accepts a valid MCP definition', () => {
    const result = McpDefinitionSchema.parse(validMcp);
    expect(result.name).toBe('ticktick');
    expect(result).toMatchObject({
      command: 'npx',
      args: ['-y', '@alexarevalo.ai/mcp-server-ticktick'],
    });
  });

  it('applies defaults for optional fields', () => {
    const result = McpDefinitionSchema.parse({
      name: 'my-mcp',
      displayName: 'My MCP',
      command: 'node',
    });
    expect(result).toMatchObject({ args: [], env: {} });
  });

  it('accepts an HTTP definition with environment-backed authorization', () => {
    expect(
      McpDefinitionSchema.parse({
        name: 'ticktick',
        displayName: 'TickTick',
        type: 'http',
        url: 'https://mcp.ticktick.com',
        headers: { Authorization: 'Bearer ${TICKTICK_MCP_TOKEN}' },
      }),
    ).toMatchObject({
      type: 'http',
      url: 'https://mcp.ticktick.com',
      headers: { Authorization: 'Bearer ${TICKTICK_MCP_TOKEN}' },
    });
  });

  it.each([
    {
      name: 'mixed transports',
      value: { ...validMcp, type: 'http', url: 'https://mcp.example.com' },
    },
    {
      name: 'embedded URL credentials',
      value: {
        name: 'remote',
        displayName: 'Remote',
        type: 'http',
        url: 'https://secret@example.com/mcp',
      },
    },
    {
      name: 'plaintext remote endpoint',
      value: {
        name: 'remote',
        displayName: 'Remote',
        type: 'http',
        url: 'http://mcp.example.com/mcp',
      },
    },
    {
      name: 'literal authorization secret',
      value: {
        name: 'remote',
        displayName: 'Remote',
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer committed-secret' },
      },
    },
    {
      name: 'control characters in headers',
      value: {
        name: 'remote',
        displayName: 'Remote',
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { 'X-Client': 'raven\nInjected: true' },
      },
    },
    {
      name: 'literal stdio secret',
      value: {
        name: 'local',
        displayName: 'Local',
        command: 'local-mcp',
        env: { API_TOKEN: 'committed-secret' },
      },
    },
    {
      name: 'partially malformed environment template',
      value: {
        name: 'local',
        displayName: 'Local',
        command: 'local-mcp',
        env: { API_TOKEN: '${VALID_TOKEN}:${not-valid}' },
      },
    },
  ])('rejects $name', ({ value }) => {
    expect(() => McpDefinitionSchema.parse(value)).toThrow();
  });

  it('rejects MCP without command', () => {
    expect(() =>
      McpDefinitionSchema.parse({
        name: 'bad-mcp',
        displayName: 'Bad',
      }),
    ).toThrow();
  });

  it('rejects non-kebab-case name', () => {
    expect(() =>
      McpDefinitionSchema.parse({
        name: 'BadName',
        displayName: 'Bad',
        command: 'node',
      }),
    ).toThrow();
  });
});

describe('SkillConfigSchema', () => {
  const validSkill = {
    name: 'task-management',
    displayName: 'Task Management',
    description: 'Manage tasks via TickTick',
    mcps: ['ticktick'],
    actions: [
      {
        name: 'task-management:create-task',
        description: 'Create a new task',
        defaultTier: 'yellow' as const,
        reversible: true,
      },
    ],
  };

  it('accepts a valid skill config', () => {
    const result = SkillConfigSchema.parse(validSkill);
    expect(result.name).toBe('task-management');
    expect(result.mcps).toEqual(['ticktick']);
    expect(result.actions).toHaveLength(1);
  });

  it('applies defaults for optional fields', () => {
    const result = SkillConfigSchema.parse({
      name: 'minimal-skill',
      displayName: 'Minimal',
      description: 'A minimal skill',
    });
    expect(result.model).toBe('sonnet');
    expect(result.maxTurns).toBe(10);
    expect(result.mcps).toEqual([]);
    expect(result.tools).toEqual([]);
    expect(result.vendorSkills).toEqual([]);
    expect(result.systemDeps).toEqual([]);
    expect(result.actions).toEqual([]);
    expect(result.expectedOutputs).toEqual([]);
  });

  it('rejects invalid model value', () => {
    expect(() =>
      SkillConfigSchema.parse({
        name: 'bad-skill',
        displayName: 'Bad',
        description: 'Bad model',
        model: 'invalid model',
      }),
    ).toThrow();
  });

  it('rejects non-kebab-case name', () => {
    expect(() =>
      SkillConfigSchema.parse({
        name: 'MySkill',
        displayName: 'My Skill',
        description: 'Bad name',
      }),
    ).toThrow();
  });

  it('rejects action with invalid name format', () => {
    expect(() =>
      SkillConfigSchema.parse({
        name: 'my-skill',
        displayName: 'My Skill',
        description: 'Bad action',
        actions: [
          {
            name: 'invalid-action-name',
            description: 'Missing colon separator',
            defaultTier: 'green',
            reversible: false,
          },
        ],
      }),
    ).toThrow();
  });
});

describe('LibraryIndexSchema', () => {
  it('accepts a valid library index', () => {
    const result = LibraryIndexSchema.parse({
      skills: [
        {
          name: 'task-management',
          path: 'skills/task-management',
          description: 'Manage tasks',
        },
      ],
      mcps: [{ name: 'ticktick', path: 'mcps/ticktick.json' }],
    });
    expect(result.skills).toHaveLength(1);
    expect(result.mcps).toHaveLength(1);
  });

  it('accepts empty arrays', () => {
    const result = LibraryIndexSchema.parse({ skills: [], mcps: [] });
    expect(result.skills).toEqual([]);
    expect(result.mcps).toEqual([]);
  });

  it('rejects missing skills field', () => {
    expect(() => LibraryIndexSchema.parse({ mcps: [] })).toThrow();
  });
});
