import { z } from 'zod';

const KEBAB_CASE_RE = /^[a-z][a-z0-9-]*$/;
const ACTION_NAME_RE = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;

const DEFAULT_MAX_TURNS = 10;

// --- MCP Definition ---

export const McpDefinitionSchema = z.object({
  name: z.string().regex(KEBAB_CASE_RE, 'MCP name must be lowercase kebab-case'),
  displayName: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
});

// --- Skill Config ---

const ActionSchema = z.object({
  name: z.string().regex(ACTION_NAME_RE, 'Action name must be skill:action format'),
  description: z.string().min(1),
  defaultTier: z.enum(['green', 'yellow', 'red']),
  reversible: z.boolean(),
});

const ExpectedOutputSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  mimeType: z.string().default('text/plain'),
});

export const SkillConfigSchema = z.object({
  name: z.string().regex(KEBAB_CASE_RE, 'Skill name must be lowercase kebab-case'),
  displayName: z.string().min(1),
  description: z.string().min(1),
  mcps: z.array(z.string()).default([]),
  vendorSkills: z.array(z.string()).default([]),
  tools: z.array(z.string()).default([]),
  systemDeps: z.array(z.string()).default([]),
  model: z.enum(['haiku', 'sonnet', 'opus']).default('sonnet'),
  maxTurns: z.number().int().positive().default(DEFAULT_MAX_TURNS),
  actions: z.array(ActionSchema).default([]),
  expectedOutputs: z.array(ExpectedOutputSchema).default([]),
});

// --- Library Index ---

export const SkillIndexEntrySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  description: z.string().min(1),
});

export const McpIndexEntrySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
});

export const LibraryIndexSchema = z.object({
  skills: z.array(SkillIndexEntrySchema),
  mcps: z.array(McpIndexEntrySchema),
});
