import { z } from 'zod';

const KEBAB_CASE_RE = /^[a-z][a-z0-9-]*$/;

const MAX_QUALITY_THRESHOLD = 5;
const DEFAULT_QUALITY_THRESHOLD = 3;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_TURNS = 15;

// --- Bash Access ---

export const BashAccessSchema = z.object({
  access: z.enum(['none', 'sandboxed', 'scoped', 'full']).default('none'),
  allowedCommands: z.array(z.string()).default([]),
  deniedCommands: z.array(z.string()).default([]),
  allowedPaths: z.array(z.string()).default([]),
  deniedPaths: z.array(z.string()).default([]),
  requireApproval: z.enum(['per-session', 'per-command']).optional(),
});

// --- Validation Config ---

export const ValidationConfigSchema = z.object({
  evaluator: z.boolean().default(true),
  evaluatorModel: z.enum(['haiku', 'sonnet']).default('haiku'),
  qualityReview: z.boolean().default(false),
  qualityModel: z.enum(['sonnet', 'opus']).default('sonnet'),
  qualityThreshold: z
    .number()
    .int()
    .min(1)
    .max(MAX_QUALITY_THRESHOLD)
    .default(DEFAULT_QUALITY_THRESHOLD),
  maxRetries: z.number().int().min(0).default(DEFAULT_MAX_RETRIES),
});

// --- Agent YAML ---

export const AgentYamlSchema = z.object({
  name: z.string().regex(KEBAB_CASE_RE, 'Agent name must be lowercase kebab-case'),
  displayName: z.string().min(1),
  description: z.string().min(1),
  isDefault: z.boolean().default(false),
  skills: z.array(z.string()).default([]),
  instructions: z.string().optional(),
  model: z.enum(['haiku', 'sonnet', 'opus']).default('sonnet'),
  maxTurns: z.number().int().positive().default(DEFAULT_MAX_TURNS),
  bash: BashAccessSchema.optional(),
  validation: ValidationConfigSchema.optional(),
});

// --- Schedule YAML ---

export const ScheduleYamlSchema = z.object({
  name: z.string().regex(KEBAB_CASE_RE, 'Schedule name must be lowercase kebab-case'),
  cron: z.string().min(1),
  timezone: z.string().default('UTC'),
  template: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().default(true),
});
