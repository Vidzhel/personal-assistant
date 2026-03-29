import { z } from 'zod';
import { TaskTreeNodeSchema, TaskValidationConfigSchema } from './task-execution.ts';

// ── Constants ──────────────────────────────────────────────────────────

const KebabCaseRegex = /^[a-z][a-z0-9-]*$/;

// ── TemplateParam ──────────────────────────────────────────────────────

export const TemplateParamSchema = z.object({
  type: z.enum(['string', 'number', 'boolean']),
  required: z.boolean().default(true),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  description: z.string().optional(),
});

export type TemplateParam = z.infer<typeof TemplateParamSchema>;

// ── Triggers (discriminated union) ─────────────────────────────────────

const ManualTrigger = z.object({ type: z.literal('manual') });

const ScheduleTrigger = z.object({
  type: z.literal('schedule'),
  cron: z.string().min(1),
  timezone: z.string().default('UTC'),
});

const EventTrigger = z.object({
  type: z.literal('event'),
  eventType: z.string().min(1),
  filter: z.record(z.string(), z.unknown()).optional(),
});

export const TemplateTriggerSchema = z.discriminatedUnion('type', [
  ManualTrigger,
  ScheduleTrigger,
  EventTrigger,
]);

export type TemplateTrigger = z.infer<typeof TemplateTriggerSchema>;

// ── Template Task (TaskTreeNode + forEach extension) ───────────────────
//
// z.discriminatedUnion doesn't support .and() / z.intersection cleanly.
// Instead we use z.preprocess to validate both parts independently and
// merge the results.

const TemplateTaskExtensionSchema = z.object({
  forEach: z.string().optional(),
  forEachAs: z.string().default('item'),
});

export const TemplateTaskSchema = z.unknown().transform((val, ctx) => {
  // Parse the base TaskTreeNode fields
  const baseResult = TaskTreeNodeSchema.safeParse(val);
  if (!baseResult.success) {
    for (const issue of baseResult.error.issues) {
      ctx.addIssue({
        code: 'custom',
        message: issue.message,
        path: issue.path,
      });
    }
    return z.NEVER;
  }

  // Parse the extension fields
  const extResult = TemplateTaskExtensionSchema.safeParse(val);
  if (!extResult.success) {
    for (const issue of extResult.error.issues) {
      ctx.addIssue({
        code: 'custom',
        message: issue.message,
        path: issue.path,
      });
    }
    return z.NEVER;
  }

  return { ...baseResult.data, ...extResult.data };
});

export type TemplateTask = z.infer<typeof TemplateTaskSchema>;

// ── TaskTemplate ───────────────────────────────────────────────────────

export const TaskTemplateSchema = z.object({
  name: z.string().regex(KebabCaseRegex),
  displayName: z.string().min(1),
  description: z.string().optional(),
  params: z.record(z.string(), TemplateParamSchema).default({}),
  trigger: z.array(TemplateTriggerSchema).default([{ type: 'manual' as const }]),
  plan: z
    .object({
      approval: z.enum(['auto', 'manual']).default('manual'),
      parallel: z.boolean().default(true),
    })
    .default({ approval: 'manual', parallel: true }),
  tasks: z.array(TemplateTaskSchema).min(1),
});

export type TaskTemplate = z.infer<typeof TaskTemplateSchema>;

// Re-export for convenience
export { TaskValidationConfigSchema };
