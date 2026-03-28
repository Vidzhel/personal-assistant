import { z } from 'zod';

// --- Agent Definition ---

const DEFAULT_MAX_TURNS = 10;

const AgentDefinitionSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, 'Agent name must be lowercase kebab-case'),
  description: z.string().min(1),
  model: z.enum(['sonnet', 'opus', 'haiku']).default('sonnet'),
  tools: z.array(z.string()).default([]),
  mcpServers: z.array(z.string()).optional(),
  maxTurns: z.number().int().positive().default(DEFAULT_MAX_TURNS),
  prompt: z.string().min(1),
});

export type AgentDefinition = z.input<typeof AgentDefinitionSchema>;
export type ResolvedAgentDefinition = z.output<typeof AgentDefinitionSchema>;

export function defineAgent(def: AgentDefinition): ResolvedAgentDefinition {
  return AgentDefinitionSchema.parse(def);
}

// --- Suite Manifest ---

const SuiteCapability = z.enum([
  'mcp-server',
  'agent-definition',
  'event-source',
  'data-provider',
  'notification-sink',
  'services',
]);

const SuiteManifestSchema = z.object({
  name: z
    .string()
    .regex(/^_?[a-z][a-z0-9-]*$/, 'Suite name must be lowercase kebab-case (optional _ prefix)'),
  displayName: z.string().min(1),
  version: z.string().default('0.1.0'),
  description: z.string().min(1),
  capabilities: z.array(SuiteCapability).default([]),
  requiresEnv: z.array(z.string()).default([]),
  services: z.array(z.string()).default([]),
  vendorPlugins: z.array(z.string()).default([]),
});

export type SuiteManifest = z.input<typeof SuiteManifestSchema>;
export type ResolvedSuiteManifest = z.output<typeof SuiteManifestSchema>;

export function defineSuite(manifest: SuiteManifest): ResolvedSuiteManifest {
  return SuiteManifestSchema.parse(manifest);
}

// --- Prompt Helpers ---

export interface PromptParts {
  role: string;
  guidelines?: string;
  context?: string;
  instructions?: string;
}

export function buildPrompt(parts: PromptParts): string {
  const sections: string[] = [`You are a ${parts.role} within Raven.`];

  if (parts.guidelines) {
    sections.push(parts.guidelines);
  }
  if (parts.context) {
    sections.push(parts.context);
  }
  if (parts.instructions) {
    sections.push(parts.instructions);
  }

  return sections.join('\n\n');
}

// --- Action Definition ---

const SkillActionSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/, 'Action name must be suite:action format'),
  description: z.string().min(1),
  defaultTier: z.enum(['green', 'yellow', 'red']),
  reversible: z.boolean(),
});

export type ActionDefinition = z.infer<typeof SkillActionSchema>;

const ActionsArraySchema = z.array(SkillActionSchema);

export function parseActions(data: unknown): ActionDefinition[] {
  return ActionsArraySchema.parse(data);
}

// --- MCP Config ---

const McpServerEntrySchema = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
});

const McpConfigSchema = z.object({
  mcpServers: z.record(z.string(), McpServerEntrySchema),
});

export type McpConfig = z.infer<typeof McpConfigSchema>;

export function parseMcpConfig(data: unknown): McpConfig {
  return McpConfigSchema.parse(data);
}

/**
 * Resolves ${ENV_VAR} placeholders in MCP env values from process.env.
 * Throws if any referenced env vars are missing.
 */
export function resolveEnvVars(env: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  const missing: string[] = [];

  for (const [key, value] of Object.entries(env)) {
    resolved[key] = value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
      const val = process.env[varName];
      if (val === undefined) {
        missing.push(varName);
        return '';
      }
      return val;
    });
  }

  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${[...new Set(missing)].join(', ')}`);
  }

  return resolved;
}
