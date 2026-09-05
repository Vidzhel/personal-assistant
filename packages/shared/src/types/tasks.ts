import { z } from 'zod';

export const TaskStatusValues = [
  'pending_approval',
  'todo',
  'in_progress',
  'completed',
  'blocked',
  'archived',
] as const;
export type TaskStatus = (typeof TaskStatusValues)[number];

export const TaskSourceValues = [
  'manual',
  'agent',
  'template',
  'ticktick',
  'pipeline',
  'scheduled',
] as const;
export type TaskSource = (typeof TaskSourceValues)[number];

export interface RavenTask {
  id: string;
  title: string;
  description?: string;
  prompt?: string;
  status: TaskStatus;
  assignedAgentId?: string;
  projectId?: string;
  pipelineId?: string;
  scheduleId?: string;
  parentTaskId?: string;
  source: TaskSource;
  externalId?: string;
  artifacts: string[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

/** Strict on-disk representation for project-local board task files. */
export const TaskRecordSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    prompt: z.string().optional(),
    status: z.enum(TaskStatusValues),
    assignedAgentId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    pipelineId: z.string().min(1).optional(),
    scheduleId: z.string().min(1).optional(),
    parentTaskId: z.string().min(1).optional(),
    source: z.enum(TaskSourceValues),
    externalId: z.string().min(1).optional(),
    artifacts: z.array(z.string()),
    createdAt: z.string().pipe(z.iso.datetime({ offset: true })),
    updatedAt: z.string().pipe(z.iso.datetime({ offset: true })),
    completedAt: z
      .string()
      .pipe(z.iso.datetime({ offset: true }))
      .optional(),
  })
  .strict();

/** Simple task template (see templates.ts for the unified pipeline template format) */
export interface SimpleTaskTemplate {
  name: string;
  title: string;
  description?: string;
  prompt?: string;
  defaultAgentId?: string;
  projectId?: string;
}

export const TaskCreateInputSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  prompt: z.string().optional(),
  status: z.enum(TaskStatusValues).default('todo'),
  assignedAgentId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  pipelineId: z.string().min(1).optional(),
  scheduleId: z.string().min(1).optional(),
  parentTaskId: z.string().min(1).optional(),
  source: z.enum(TaskSourceValues).default('manual'),
  externalId: z.string().min(1).optional(),
  artifacts: z.array(z.string()).default([]),
});

export type TaskCreateInput = z.input<typeof TaskCreateInputSchema>;

export const TaskUpdateInputSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  prompt: z.string().optional(),
  status: z.enum(TaskStatusValues).optional(),
  assignedAgentId: z.string().min(1).nullable().optional(),
  projectId: z.string().min(1).nullable().optional(),
  pipelineId: z.string().min(1).nullable().optional(),
  scheduleId: z.string().min(1).nullable().optional(),
  parentTaskId: z.string().min(1).nullable().optional(),
  artifacts: z.array(z.string()).optional(),
});

export type TaskUpdateInput = z.infer<typeof TaskUpdateInputSchema>;

export const TaskCompletionInputSchema = z
  .object({ artifacts: z.array(z.string()).optional() })
  .strict();

/** Simple task template schema (see templates.ts for the unified pipeline template format) */
export const SimpleTaskTemplateSchema = z.object({
  name: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  prompt: z.string().optional(),
  defaultAgentId: z.string().optional(),
  projectId: z.string().min(1).optional(),
});
