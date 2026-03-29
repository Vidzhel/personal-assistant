import { describe, it, expect } from 'vitest';
import { AgentYamlSchema, ScheduleYamlSchema } from '../project/schemas.ts';

describe('AgentYamlSchema', () => {
  const validAgent = {
    name: 'research-agent',
    displayName: 'Research Agent',
    description: 'Helps with research tasks',
    isDefault: true,
    skills: ['web-search', 'summarize'],
    instructions: 'Focus on academic sources.',
    model: 'opus' as const,
    maxTurns: 20,
    bash: {
      access: 'sandboxed' as const,
      allowedCommands: ['grep', 'find', 'cat'],
      deniedCommands: ['rm'],
      allowedPaths: ['/home/user/data'],
      deniedPaths: ['/etc'],
      requireApproval: 'per-session' as const,
    },
    validation: {
      evaluator: true,
      evaluatorModel: 'sonnet' as const,
      qualityReview: true,
      qualityModel: 'opus' as const,
      qualityThreshold: 4,
      maxRetries: 3,
    },
  };

  it('accepts a valid agent with all fields', () => {
    const result = AgentYamlSchema.parse(validAgent);
    expect(result.name).toBe('research-agent');
    expect(result.model).toBe('opus');
    expect(result.maxTurns).toBe(20);
    expect(result.bash?.access).toBe('sandboxed');
    expect(result.bash?.allowedCommands).toEqual(['grep', 'find', 'cat']);
    expect(result.validation?.qualityThreshold).toBe(4);
  });

  it('applies defaults for optional fields', () => {
    const result = AgentYamlSchema.parse({
      name: 'minimal-agent',
      displayName: 'Minimal',
      description: 'A minimal agent',
    });
    expect(result.model).toBe('sonnet');
    expect(result.maxTurns).toBe(15);
    expect(result.isDefault).toBe(false);
    expect(result.skills).toEqual([]);
    expect(result.bash).toBeUndefined();
    expect(result.validation).toBeUndefined();
  });

  it('validates bash access config with sandboxed + allowedCommands', () => {
    const result = AgentYamlSchema.parse({
      name: 'sandbox-agent',
      displayName: 'Sandbox Agent',
      description: 'Agent with sandboxed bash',
      bash: {
        access: 'sandboxed',
        allowedCommands: ['ls', 'cat'],
      },
    });
    expect(result.bash?.access).toBe('sandboxed');
    expect(result.bash?.allowedCommands).toEqual(['ls', 'cat']);
    expect(result.bash?.deniedCommands).toEqual([]);
    expect(result.bash?.allowedPaths).toEqual([]);
    expect(result.bash?.deniedPaths).toEqual([]);
  });

  it('rejects invalid bash access level', () => {
    expect(() =>
      AgentYamlSchema.parse({
        name: 'bad-bash',
        displayName: 'Bad Bash',
        description: 'Invalid access level',
        bash: { access: 'root' },
      }),
    ).toThrow();
  });

  it('accepts underscore-prefixed system agent names', () => {
    const result = AgentYamlSchema.parse({
      name: '_evaluator',
      displayName: 'Task Evaluator',
      description: 'Validates task completion',
    });
    expect(result.name).toBe('_evaluator');
  });

  it('rejects non-kebab-case name', () => {
    expect(() =>
      AgentYamlSchema.parse({
        name: 'MyAgent',
        displayName: 'My Agent',
        description: 'Bad name',
      }),
    ).toThrow();
  });

  it('validates validation config with all fields', () => {
    const result = AgentYamlSchema.parse({
      name: 'validated-agent',
      displayName: 'Validated',
      description: 'Has validation config',
      validation: {
        evaluator: false,
        evaluatorModel: 'haiku',
        qualityReview: true,
        qualityModel: 'sonnet',
        qualityThreshold: 2,
        maxRetries: 1,
      },
    });
    expect(result.validation?.evaluator).toBe(false);
    expect(result.validation?.qualityReview).toBe(true);
    expect(result.validation?.qualityThreshold).toBe(2);
  });

  it('applies validation config defaults', () => {
    const result = AgentYamlSchema.parse({
      name: 'default-validation',
      displayName: 'Default Validation',
      description: 'Validation with defaults',
      validation: {},
    });
    expect(result.validation?.evaluator).toBe(true);
    expect(result.validation?.evaluatorModel).toBe('haiku');
    expect(result.validation?.qualityReview).toBe(false);
    expect(result.validation?.qualityModel).toBe('sonnet');
    expect(result.validation?.qualityThreshold).toBe(3);
    expect(result.validation?.maxRetries).toBe(2);
  });
});

describe('ScheduleYamlSchema', () => {
  const validSchedule = {
    name: 'daily-digest',
    cron: '0 9 * * *',
    timezone: 'America/New_York',
    template: 'Generate a daily summary of tasks.',
    params: { includeDone: true, limit: 10 },
    enabled: true,
  };

  it('accepts a valid schedule', () => {
    const result = ScheduleYamlSchema.parse(validSchedule);
    expect(result.name).toBe('daily-digest');
    expect(result.cron).toBe('0 9 * * *');
    expect(result.timezone).toBe('America/New_York');
    expect(result.template).toBe('Generate a daily summary of tasks.');
    expect(result.params).toEqual({ includeDone: true, limit: 10 });
  });

  it('applies defaults for optional fields', () => {
    const result = ScheduleYamlSchema.parse({
      name: 'weekly-report',
      cron: '0 0 * * MON',
      template: 'Weekly report.',
    });
    expect(result.timezone).toBe('UTC');
    expect(result.enabled).toBe(true);
    expect(result.params).toBeUndefined();
  });

  it('rejects missing cron', () => {
    expect(() =>
      ScheduleYamlSchema.parse({
        name: 'no-cron',
        template: 'Missing cron field.',
      }),
    ).toThrow();
  });

  it('rejects missing template', () => {
    expect(() =>
      ScheduleYamlSchema.parse({
        name: 'no-template',
        cron: '0 0 * * *',
      }),
    ).toThrow();
  });

  it('rejects non-kebab-case name', () => {
    expect(() =>
      ScheduleYamlSchema.parse({
        name: 'Bad_Name',
        cron: '0 0 * * *',
        template: 'Bad name.',
      }),
    ).toThrow();
  });
});
