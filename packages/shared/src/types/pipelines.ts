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

export const PipelineRetrySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10).default(3),
  backoffMs: z.number().int().min(100).max(60000).default(5000),
});

export const PipelineSettingsSchema = z.object({
  retry: PipelineRetrySchema.optional(),
  timeout: z.number().int().min(1000).max(3600000).default(600000),
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
