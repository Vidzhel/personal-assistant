import { z } from 'zod';

// ── Magic number constants ──────────────────────────────────────────────

const MIN_QUALITY_THRESHOLD = 1;
const MAX_QUALITY_THRESHOLD = 5;
const DEFAULT_QUALITY_THRESHOLD = 3;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BACKOFF_MS = 1000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

// ── TaskArtifact ────────────────────────────────────────────────────────

export const TaskArtifactSchema = z
  .object({
    type: z.enum(['file', 'data', 'reference']),
    label: z.string().min(1),
    filePath: z.string().min(1).optional(),
    sourceId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
      .optional(),
    data: z.record(z.string(), z.unknown()).optional(),
    referenceId: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((artifact, ctx) => {
    if (artifact.sourceId !== undefined && artifact.type !== 'file') {
      ctx.addIssue({ code: 'custom', message: 'Only file artifacts have a sourceId' });
    }
    const hasPayload =
      (artifact.type === 'file' && artifact.filePath !== undefined) ||
      (artifact.type === 'data' && artifact.data !== undefined) ||
      (artifact.type === 'reference' && artifact.referenceId !== undefined);
    if (!hasPayload) {
      ctx.addIssue({
        code: 'custom',
        message: `Artifact type ${artifact.type} requires its payload`,
      });
    }
  });

export type TaskArtifact = z.infer<typeof TaskArtifactSchema>;

// ── TaskValidationConfig ────────────────────────────────────────────────

export const TaskValidationConfigSchema = z
  .object({
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
    retryBackoffMs: z
      .number()
      .int()
      .min(0)
      .max(MAX_TIMER_DELAY_MS)
      .default(DEFAULT_RETRY_BACKOFF_MS),
    onMaxRetriesFailed: z.enum(['fail', 'escalate', 'skip']).default('escalate'),
  })
  .strict();

export type TaskValidationConfig = z.infer<typeof TaskValidationConfigSchema>;

// ── TaskTreeNode (discriminated union) ──────────────────────────────────

const baseNodeFields = {
  id: z.string().min(1),
  title: z.string().min(1),
  blockedBy: z.array(z.string()).default([]),
  runIf: z.string().optional(),
  validation: TaskValidationConfigSchema.optional(),
};

const AgentNodeSchema = z
  .object({
    ...baseNodeFields,
    type: z.literal('agent'),
    agent: z.string().optional(),
    prompt: z.string().min(1),
  })
  .strict();

const CodeNodeSchema = z
  .object({
    ...baseNodeFields,
    type: z.literal('code'),
    script: z.string().min(1),
    args: z.array(z.string()).default([]),
  })
  .strict();

const ConditionNodeSchema = z
  .object({
    ...baseNodeFields,
    type: z.literal('condition'),
    expression: z.string().min(1),
  })
  .strict();

const NotifyNodeSchema = z
  .object({
    ...baseNodeFields,
    type: z.literal('notify'),
    channel: z.string().min(1),
    message: z.string().min(1),
    attachments: z.array(z.string()).default([]),
  })
  .strict();

const DelayNodeSchema = z
  .object({
    ...baseNodeFields,
    type: z.literal('delay'),
    duration: z.string().min(1),
  })
  .strict();

const ApprovalNodeSchema = z
  .object({
    ...baseNodeFields,
    type: z.literal('approval'),
    message: z.string().min(1),
  })
  .strict();

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
  interrupted?: boolean;
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
  scheduleId?: string;
  status: TaskTreeStatus;
  tasks: Map<string, ExecutionTask>;
  plan?: string;
  createdAt: string;
  updatedAt: string;
  interrupted?: boolean;
}

const ExecutionValidationResultSchema = z
  .object({
    gate1Passed: z.boolean().optional(),
    gate2Passed: z.boolean().optional(),
    gate2Reason: z.string().optional(),
    gate3Passed: z.boolean().optional(),
    gate3Score: z.number().optional(),
    gate3Feedback: z.string().optional(),
  })
  .strict();

const ExecutableDurationSchema = z
  .string()
  .regex(/^\d+(ms|s|m|h|d)$/)
  .refine((duration) => {
    const match = duration.match(/^(\d+)(ms|s|m|h|d)$/);
    if (!match) return false;
    const unitMs = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
      match[2] as 'ms' | 's' | 'm' | 'h' | 'd'
    ];
    const milliseconds = Number(match[1]) * unitMs;
    return Number.isSafeInteger(milliseconds) && milliseconds <= MAX_TIMER_DELAY_MS;
  }, 'duration exceeds the supported timer limit');

/** Complete execution node representation stored in a tree document. */
export const ExecutionTaskRecordSchema = z
  .object({
    id: z.string().min(1),
    parentTaskId: z.string().min(1),
    node: TaskTreeNodeSchema,
    status: z.enum(ExecutionTaskStatusValues),
    agentTaskId: z.string().min(1).optional(),
    artifacts: z.array(TaskArtifactSchema),
    summary: z.string().optional(),
    retryCount: z.number().int().min(0),
    lastError: z.string().optional(),
    needsReplan: z.boolean().optional(),
    validationResult: ExecutionValidationResultSchema.optional(),
    startedAt: z
      .string()
      .pipe(z.iso.datetime({ offset: true }))
      .optional(),
    completedAt: z
      .string()
      .pipe(z.iso.datetime({ offset: true }))
      .optional(),
    interrupted: z.boolean().optional(),
  })
  .strict()
  .superRefine((task, context) => {
    if (task.node.type !== 'delay') return;
    const result = ExecutableDurationSchema.safeParse(task.node.duration);
    if (!result.success)
      context.addIssue({
        code: 'custom',
        path: ['node', 'duration'],
        message: 'Invalid delay duration or timer limit exceeded',
      });
  });

/** Whole-tree YAML document; the runtime Map is encoded as an array. */
export const TaskTreeRecordSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1).optional(),
    scheduleId: z.string().min(1).optional(),
    status: z.enum(TaskTreeStatusValues),
    plan: z.string().optional(),
    tasks: z.array(ExecutionTaskRecordSchema),
    createdAt: z.string().pipe(z.iso.datetime({ offset: true })),
    updatedAt: z.string().pipe(z.iso.datetime({ offset: true })),
    interrupted: z.boolean().optional(),
  })
  .strict();
