import { z } from 'zod';

// ── Magic number constants ──────────────────────────────────────────────

const MIN_QUALITY_THRESHOLD = 1;
const MAX_QUALITY_THRESHOLD = 5;
const DEFAULT_QUALITY_THRESHOLD = 3;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BACKOFF_MS = 1000;

// ── TaskArtifact ────────────────────────────────────────────────────────

export const TaskArtifactSchema = z.object({
  type: z.enum(['file', 'data', 'reference']),
  label: z.string().min(1),
  filePath: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  referenceId: z.string().optional(),
});

export type TaskArtifact = z.infer<typeof TaskArtifactSchema>;

// ── TaskValidationConfig ────────────────────────────────────────────────

export const TaskValidationConfigSchema = z.object({
  requireArtifacts: z.boolean().default(true),
  evaluator: z.boolean().default(true),
  evaluatorModel: z.enum(['haiku', 'sonnet']).default('haiku'),
  evaluatorCriteria: z.string().optional(),
  qualityReview: z.boolean().default(false),
  qualityModel: z.enum(['sonnet', 'opus']).default('sonnet'),
  qualityThreshold: z
    .number()
    .int()
    .min(MIN_QUALITY_THRESHOLD)
    .max(MAX_QUALITY_THRESHOLD)
    .default(DEFAULT_QUALITY_THRESHOLD),
  maxRetries: z.number().int().min(0).default(DEFAULT_MAX_RETRIES),
  retryBackoffMs: z.number().int().min(0).default(DEFAULT_RETRY_BACKOFF_MS),
  onMaxRetriesFailed: z.enum(['fail', 'escalate', 'skip']).default('escalate'),
});

export type TaskValidationConfig = z.infer<typeof TaskValidationConfigSchema>;

// ── TaskTreeNode (discriminated union) ──────────────────────────────────

const baseNodeFields = {
  id: z.string().min(1),
  title: z.string().min(1),
  blockedBy: z.array(z.string()).default([]),
  runIf: z.string().optional(),
  validation: TaskValidationConfigSchema.optional(),
};

const AgentNodeSchema = z.object({
  ...baseNodeFields,
  type: z.literal('agent'),
  agent: z.string().optional(),
  prompt: z.string().min(1),
});

const CodeNodeSchema = z.object({
  ...baseNodeFields,
  type: z.literal('code'),
  script: z.string().min(1),
  args: z.array(z.string()).default([]),
});

const ConditionNodeSchema = z.object({
  ...baseNodeFields,
  type: z.literal('condition'),
  expression: z.string().min(1),
});

const NotifyNodeSchema = z.object({
  ...baseNodeFields,
  type: z.literal('notify'),
  channel: z.string().min(1),
  message: z.string().min(1),
  attachments: z.array(z.string()).default([]),
});

const DelayNodeSchema = z.object({
  ...baseNodeFields,
  type: z.literal('delay'),
  duration: z.string().min(1),
});

const ApprovalNodeSchema = z.object({
  ...baseNodeFields,
  type: z.literal('approval'),
  message: z.string().min(1),
});

export const TaskTreeNodeSchema = z.discriminatedUnion('type', [
  AgentNodeSchema,
  CodeNodeSchema,
  ConditionNodeSchema,
  NotifyNodeSchema,
  DelayNodeSchema,
  ApprovalNodeSchema,
]);

export type TaskTreeNode = z.infer<typeof TaskTreeNodeSchema>;

// ── Execution types ─────────────────────────────────────────────────────

export const ExecutionTaskStatusValues = [
  'pending_approval',
  'todo',
  'ready',
  'in_progress',
  'validating',
  'completed',
  'failed',
  'blocked',
  'skipped',
  'cancelled',
] as const;

export type ExecutionTaskStatus = (typeof ExecutionTaskStatusValues)[number];

export interface ExecutionTask {
  id: string;
  parentTaskId: string;
  node: TaskTreeNode;
  status: ExecutionTaskStatus;
  agentTaskId?: string;
  artifacts: TaskArtifact[];
  summary?: string;
  retryCount: number;
  lastError?: string;
  needsReplan?: boolean;
  validationResult?: {
    gate1Passed?: boolean;
    gate2Passed?: boolean;
    gate2Reason?: string;
    gate3Passed?: boolean;
    gate3Score?: number;
    gate3Feedback?: string;
  };
  startedAt?: string;
  completedAt?: string;
}

export const TaskTreeStatusValues = [
  'pending_approval',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;

export type TaskTreeStatus = (typeof TaskTreeStatusValues)[number];

export interface TaskTree {
  id: string;
  projectId?: string;
  status: TaskTreeStatus;
  tasks: Map<string, ExecutionTask>;
  plan?: string;
  createdAt: string;
  updatedAt: string;
}
