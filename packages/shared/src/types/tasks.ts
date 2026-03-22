import { z } from 'zod';

export const TaskStatusValues = ['todo', 'in_progress', 'completed', 'archived'] as const;
export type TaskStatus = (typeof TaskStatusValues)[number];

export const TaskSourceValues = ['manual', 'agent', 'template', 'ticktick', 'pipeline'] as const;
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

export interface TaskTemplate {
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
  assignedAgentId: z.string().optional(),
  projectId: z.string().optional(),
  pipelineId: z.string().optional(),
  scheduleId: z.string().optional(),
  parentTaskId: z.string().optional(),
  source: z.enum(TaskSourceValues).default('manual'),
  externalId: z.string().optional(),
  artifacts: z.array(z.string()).default([]),
});

export type TaskCreateInput = z.input<typeof TaskCreateInputSchema>;

export const TaskUpdateInputSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  prompt: z.string().optional(),
  status: z.enum(TaskStatusValues).optional(),
  assignedAgentId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  pipelineId: z.string().nullable().optional(),
  scheduleId: z.string().nullable().optional(),
  parentTaskId: z.string().nullable().optional(),
  artifacts: z.array(z.string()).optional(),
});

export type TaskUpdateInput = z.infer<typeof TaskUpdateInputSchema>;

export const TaskTemplateSchema = z.object({
  name: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  prompt: z.string().optional(),
  defaultAgentId: z.string().optional(),
  projectId: z.string().optional(),
});
