import { z } from 'zod';

export const PipelineTriggerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('cron'),
    schedule: z.string(),
  }),
  z.object({
    type: z.literal('event'),
    event: z.string(),
    filter: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ type: z.literal('manual') }),
  z.object({
    type: z.literal('webhook'),
    path: z.string().optional(),
  }),
]);

// Pipeline retry defaults
const MAX_RETRY_ATTEMPTS = 10;
const DEFAULT_RETRY_ATTEMPTS = 3;
const MIN_BACKOFF_MS = 100;
const MAX_BACKOFF_MS = 60_000;
const DEFAULT_BACKOFF_MS = 5_000;

// Pipeline timeout defaults
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 3_600_000;
const DEFAULT_TIMEOUT_MS = 600_000;

export const PipelineRetrySchema = z.object({
  maxAttempts: z.number().int().min(1).max(MAX_RETRY_ATTEMPTS).default(DEFAULT_RETRY_ATTEMPTS),
  backoffMs: z.number().int().min(MIN_BACKOFF_MS).max(MAX_BACKOFF_MS).default(DEFAULT_BACKOFF_MS),
});

export const PipelineSettingsSchema = z.object({
  retry: PipelineRetrySchema.optional(),
  timeout: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
  onError: z
    .string()
    .regex(/^(stop|continue|goto:.+)$/)
    .default('stop'),
});

export const PipelineNodeSchema = z.object({
  skill: z.string().optional(),
  action: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  type: z.enum(['condition', 'switch', 'merge', 'delay', 'code']).optional(),
  expression: z.string().optional(),
  duration: z.number().optional(),
});

export const PipelineConnectionSchema = z.object({
  from: z.string(),
  to: z.string(),
  condition: z.string().optional(),
  errorPath: z.boolean().optional(),
  label: z.string().optional(),
});

export const PipelineConfigSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/),
  description: z.string().optional(),
  version: z.number().int().min(1).default(1),
  trigger: PipelineTriggerSchema,
  settings: PipelineSettingsSchema.optional(),
  nodes: z.record(z.string(), PipelineNodeSchema).refine((nodes) => Object.keys(nodes).length > 0, {
    message: 'Pipeline must have at least one node',
  }),
  connections: z.array(PipelineConnectionSchema).default([]),
  enabled: z.boolean().default(true),
});

export type PipelineTrigger = z.infer<typeof PipelineTriggerSchema>;
export type PipelineSettings = z.infer<typeof PipelineSettingsSchema>;
export type PipelineNode = z.infer<typeof PipelineNodeSchema>;
export type PipelineConnection = z.infer<typeof PipelineConnectionSchema>;
export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;

export interface PipelineRunRecord {
  id: string;
  pipeline_name: string;
  trigger_type: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  started_at: string;
  completed_at?: string;
  node_results?: string;
  error?: string;
}
