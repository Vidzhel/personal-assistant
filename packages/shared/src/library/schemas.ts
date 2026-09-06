import { z } from 'zod';
import { ModelEffortSchema, ModelIdSchema } from '../types/model-config.ts';

const KEBAB_CASE_RE = /^[a-z][a-z0-9-]*$/;
const ACTION_NAME_RE = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;

const DEFAULT_MAX_TURNS = 10;

const ENVIRONMENT_REFERENCE_RE = /\$\{[A-Z_][A-Z0-9_]*\}/u;
const ENVIRONMENT_REFERENCES_RE = /\$\{[A-Z_][A-Z0-9_]*\}/gu;
const HTTP_HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const SENSITIVE_HEADER_RE = /(?:authorization|api[-_]?key|token|password|secret)/iu;
const SENSITIVE_ENVIRONMENT_NAME_RE = /(?:authorization|api_?key|token|password|secret)/iu;
const LAST_C0_CONTROL_CHARACTER = 31;
const DELETE_CONTROL_CHARACTER = 127;
const LOOPBACK_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= LAST_C0_CONTROL_CHARACTER || code === DELETE_CONTROL_CHARACTER;
  });
}

const TemplateValueSchema = z
  .string()
  .refine((value) => !hasControlCharacter(value), 'Template must not contain control characters')
  .refine(
    (value) => !value.replace(ENVIRONMENT_REFERENCES_RE, '').includes('${'),
    'Environment references must use ${UPPER_CASE_NAME}',
  );

const McpBaseSchema = z.object({
  name: z.string().regex(KEBAB_CASE_RE, 'MCP name must be lowercase kebab-case'),
  displayName: z.string().min(1),
});

const McpEnvironmentSchema = z
  .record(z.string(), TemplateValueSchema)
  .superRefine((environment, context) => {
    for (const [name, value] of Object.entries(environment)) {
      if (SENSITIVE_ENVIRONMENT_NAME_RE.test(name) && !ENVIRONMENT_REFERENCE_RE.test(value)) {
        context.addIssue({
          code: 'custom',
          path: [name],
          message: 'Sensitive MCP environment values must reference an environment variable',
        });
      }
    }
  });

const McpStdioDefinitionSchema = McpBaseSchema.extend({
  type: z.literal('stdio').optional(),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: McpEnvironmentSchema.default({}),
}).strict();

const McpHttpDefinitionSchema = McpBaseSchema.extend({
  type: z.literal('http'),
  url: z.url().refine((value) => {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && LOOPBACK_HTTP_HOSTS.has(url.hostname))) &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  }, 'MCP URL must use HTTPS (or loopback HTTP) without credentials or a fragment'),
  headers: z
    .record(z.string().regex(HTTP_HEADER_NAME_RE, 'Invalid HTTP header name'), TemplateValueSchema)
    .default({})
    .superRefine((headers, context) => {
      for (const [name, value] of Object.entries(headers)) {
        if (SENSITIVE_HEADER_RE.test(name) && !ENVIRONMENT_REFERENCE_RE.test(value)) {
          context.addIssue({
            code: 'custom',
            path: [name],
            message: 'Sensitive MCP headers must reference an environment variable',
          });
        }
      }
    }),
}).strict();

// --- MCP Definition ---

export const McpDefinitionSchema = z.union([McpHttpDefinitionSchema, McpStdioDefinitionSchema]);

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
  model: ModelIdSchema.default('sonnet'),
  effort: ModelEffortSchema.optional(),
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
