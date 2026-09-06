import { z } from 'zod';
import {
  generateId,
  createLogger,
  SUITE_TASK_MANAGEMENT,
  EVENT_TASK_MGMT_AUTONOMOUS_COMPLETED,
  EVENT_TASK_MGMT_AUTONOMOUS_FAILED,
  EVENT_TASK_MGMT_MANAGE_REQUEST,
  TaskManagementManageRequestPayloadSchema,
  type EventBusInterface,
} from '@raven/shared';
import type { ServiceContext, RavenService } from '../types.ts';
import {
  collectTickTickWorkload,
  type TickTickActionRequest,
  type TickTickActionResult,
  type TickTickWorkloadSnapshot,
} from './ticktick-workload.ts';
import { parseTickTickMutationEvidence, type TickTickOperation } from './ticktick-action-result.ts';

const log = createLogger('autonomous-manager');
const MAX_RECOMMENDATIONS = 20;
const MAX_ANALYSIS_RESULT_BYTES = 65_536;
const MAX_TASK_ID_LENGTH = 256;
const MAX_TASK_TITLE_LENGTH = 1_024;
const MAX_REASON_LENGTH = 4_096;

interface AgentManagerLike {
  executeAction(params: {
    actionName: string;
    skillName: string;
    details?: string;
    sessionId?: string;
  }): Promise<TickTickActionResult>;
}

interface ServiceState {
  eventBus: EventBusInterface;
  agentManager?: AgentManagerLike;
  controller: AbortController;
  activeRuns: Set<Promise<unknown>>;
  running: boolean;
  timeZone: string;
  releaseJob?: () => void;
  requestHandler: (event: unknown) => Promise<void>;
}

const RecommendedActionSchema = z.object({
  action: z.enum(['update-task', 'complete-task', 'delete-task']),
  taskId: z.string().min(1).max(MAX_TASK_ID_LENGTH),
  projectId: z.string().min(1).max(MAX_TASK_ID_LENGTH),
  taskTitle: z.string().min(1).max(MAX_TASK_TITLE_LENGTH),
  reason: z.string().min(1).max(MAX_REASON_LENGTH),
  confidence: z.enum(['low', 'medium', 'high']),
  changes: z
    .object({
      priority: z.number().optional(),
      dueDate: z.string().nullable().optional(),
      tags: z.array(z.string()).optional(),
    })
    .optional(),
});

type RecommendedAction = z.infer<typeof RecommendedActionSchema>;

interface ActionResult {
  action: string;
  taskTitle: string;
  reason: string;
  outcome: 'executed' | 'queued' | 'failed';
}

const ACTION_NAME_MAP: Record<string, string> = {
  'update-task': 'ticktick:update-task',
  'complete-task': 'ticktick:complete-task',
  'delete-task': 'ticktick:delete-task',
};

const ACTION_OPERATION_MAP: Record<string, TickTickOperation> = {
  'update-task': 'update-task',
  'complete-task': 'complete-task',
  'delete-task': 'delete-task',
};

let currentState: ServiceState | undefined;

function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason ?? new Error('Service stopped'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

async function requestAction(
  state: ServiceState,
  params: TickTickActionRequest,
): Promise<TickTickActionResult | undefined> {
  if (!state.agentManager || state.controller.signal.aborted) return undefined;
  return await awaitWithAbort(state.agentManager.executeAction(params), state.controller.signal);
}

function emitNotification(
  state: ServiceState,
  notification: { title: string; body: string; actions?: Array<{ label: string; action: string }> },
): void {
  if (state.controller.signal.aborted || currentState !== state) return;
  const { title, body, actions } = notification;
  state.eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SUITE_TASK_MANAGEMENT,
    type: 'notification',
    payload: {
      channel: 'telegram' as const,
      title,
      body,
      topicName: 'general',
      destination: { kind: 'global' as const, topic: 'general' as const },
      actions: actions && actions.length > 0 ? actions : undefined,
    },
  });
}

function parseRecommendations(resultText: string): RecommendedAction[] | null {
  try {
    if (Buffer.byteLength(resultText, 'utf8') > MAX_ANALYSIS_RESULT_BYTES) return null;
    const trimmed = resultText.trim();
    const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
    const parsed = z
      .array(RecommendedActionSchema)
      .max(MAX_RECOMMENDATIONS)
      .safeParse(JSON.parse(fenced?.[1] ?? trimmed));
    if (!parsed.success) return null;
    const ids = parsed.data.map((item) => item.taskId);
    return new Set(ids).size === ids.length ? parsed.data : null;
  } catch {
    return null;
  }
}

function recommendationsMatchSnapshot(
  recommendations: RecommendedAction[],
  snapshot: TickTickWorkloadSnapshot,
): boolean {
  const observed = new Map(snapshot.tasks.map((task) => [task.id, task]));
  return recommendations.every((recommendation) => {
    const task = observed.get(recommendation.taskId);
    return (
      task !== undefined &&
      task.projectId === recommendation.projectId &&
      task.title === recommendation.taskTitle
    );
  });
}

function localDay(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function buildAnalysisPrompt(snapshotJson: string, timeZone = 'UTC'): string {
  const today = localDay(timeZone);
  return [
    'You are analyzing a bounded TickTick workload snapshot for task management. Review only the observed task records and recommend actions that would help the user stay organized and productive.',
    '',
    `Current date: ${today}`,
    '',
    'Observed query snapshot:',
    snapshotJson,
    '',
    'Analyze each task and recommend actions ONLY when clearly beneficial. Return ONLY a JSON array, no other text.',
    '',
    'Recommended action types:',
    '- "update-task": Adjust priority (overdue tasks should be higher priority), fix missing due dates if context implies one, add helpful tags',
    '- "complete-task": Only if the task content/title clearly indicates it\'s already done (e.g., "DONE: ...", past event dates)',
    '- "delete-task": Only for obvious duplicates or clearly obsolete tasks (use sparingly — this requires user approval)',
    '',
    'Return format:',
    '[',
    '  {',
    '    "action": "update-task" | "complete-task" | "delete-task",',
    '    "taskId": "task ID from the list",',
    '    "projectId": "project ID from the list",',
    '    "taskTitle": "original task title for logging",',
    '    "reason": "Brief explanation of why this action is recommended",',
    '    "confidence": "low" | "medium" | "high",',
    '    "changes": {',
    '      "priority": 0 | 1 | 3 | 5,',
    '      "dueDate": "YYYY-MM-DDTHH:mm:ssZ" or null,',
    '      "tags": ["tag1", "tag2"]',
    '    }',
    '  }',
    ']',
    '',
    'Rules:',
    '- Only recommend actions you are confident about — prefer fewer high-quality actions',
    '- Priority values: 0=none, 1=low, 3=medium, 5=high',
    '- "changes" only needed for "update-task" actions',
    '- If no actions recommended, return empty array []',
    '- Be conservative — user trust is earned through reliable, helpful actions',
    '- NEVER recommend deleting tasks unless they are exact duplicates',
    '- Do not claim this snapshot proves the whole account is complete',
    '- Preserve recurring schedules, time zones, all-day semantics, IDs, and unrelated fields',
  ].join('\n');
}

function buildActionPrompt(rec: RecommendedAction): string {
  const parts = [
    `Task: "${rec.taskTitle}" (id: ${rec.taskId}, project: ${rec.projectId})`,
    `Action: ${rec.action}`,
    `Reason: ${rec.reason}`,
    'First call get_task_by_id and verify the exact ID, project, and title still match.',
  ];

  if (rec.action === 'update-task' && rec.changes) {
    const changes: string[] = [];
    if (rec.changes.priority !== undefined) changes.push(`priority: ${rec.changes.priority}`);
    if (rec.changes.dueDate !== undefined) changes.push(`dueDate: ${rec.changes.dueDate}`);
    if (rec.changes.tags) changes.push(`tags: ${rec.changes.tags.join(', ')}`);
    parts.push(`Changes: ${changes.join(', ')}`);
  }

  if (rec.action === 'complete-task') {
    parts.push('Mark this task as completed.');
  }

  if (rec.action === 'delete-task') {
    parts.push('Delete this task permanently.');
  }

  parts.push(
    'Use the official mutation tool exactly once. Preserve unrelated fields.',
    'Read the task back after an update or completion. After deletion, verify it is absent.',
    'If the mutation outcome is uncertain, inspect the account and do not blindly retry.',
    'Report success only after the requested final state is verified.',
    `Return ONLY {"operation":"${rec.action}","outcome":"verified"|"uncertain"|"failed","taskId":${JSON.stringify(rec.taskId)},"projectId":${JSON.stringify(rec.projectId)},"details":"optional summary"}.`,
  );

  return parts.join('\n');
}

function actionResult(rec: RecommendedAction, outcome: ActionResult['outcome']): ActionResult {
  return { action: rec.action, taskTitle: rec.taskTitle, reason: rec.reason, outcome };
}

function coverageError(snapshot: TickTickWorkloadSnapshot): string {
  const scopes = snapshot.coverage.failedScopes.map((failure) => failure.scope).join(', ');
  return `TickTick workload coverage is partial (${scopes || 'unknown scopes'}); no changes were made`;
}

async function fetchWorkload(state: ServiceState): Promise<TickTickWorkloadSnapshot | null> {
  try {
    const snapshot = await collectTickTickWorkload({
      request: (request) => requestAction(state, request),
      signal: state.controller.signal,
      timeZone: state.timeZone,
    });
    if (snapshot.coverage.status === 'partial') {
      const error = coverageError(snapshot);
      log.warn(error);
      emitFailureEvent(state, error);
      emitNotification(state, { title: 'TickTick coverage incomplete', body: error });
      return null;
    }
    return snapshot;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Error fetching tasks: ${msg}`);
    if (!state.controller.signal.aborted) emitFailureEvent(state, msg);
    return null;
  }
}

async function analyzeTasksForRecommendations(
  state: ServiceState,
  tasksJson: string,
): Promise<RecommendedAction[] | null> {
  try {
    const analysisResult = await requestAction(state, {
      actionName: 'ticktick:filter-tasks',
      skillName: 'ticktick',
      details: buildAnalysisPrompt(tasksJson, state.timeZone),
    });
    if (!analysisResult) return null;

    if (!analysisResult.success || !analysisResult.result) {
      log.warn(`Task analysis failed: ${analysisResult.error ?? 'no result'}`);
      emitFailureEvent(state, analysisResult.error ?? 'Task analysis failed');
      return null;
    }

    const parsed = parseRecommendations(analysisResult.result);
    if (parsed === null) {
      log.warn('Failed to parse AI analysis response as JSON');
      emitFailureEvent(state, 'Failed to parse task analysis response');
      return null;
    }
    return parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Error analyzing tasks: ${msg}`);
    if (!state.controller.signal.aborted) emitFailureEvent(state, msg);
    return null;
  }
}

async function executeRecommendation(
  state: ServiceState,
  rec: RecommendedAction,
): Promise<ActionResult> {
  const actionName = ACTION_NAME_MAP[rec.action];
  const operation = ACTION_OPERATION_MAP[rec.action];
  if (!actionName || !operation) {
    log.warn(`Unknown action type: ${rec.action}`);
    return actionResult(rec, 'failed');
  }

  try {
    const result = await requestAction(state, {
      actionName,
      skillName: 'ticktick',
      details: buildActionPrompt(rec),
    });
    if (!result) {
      return actionResult(rec, 'failed');
    }

    return actionResult(rec, classifyActionOutcome(result, rec, operation));
  } catch (err) {
    if (state.controller.signal.aborted) {
      return actionResult(rec, 'failed');
    }
    log.error(
      `Error executing ${rec.action} for "${rec.taskTitle}": ${err instanceof Error ? err.message : err}`,
    );
    return actionResult(rec, 'failed');
  }
}

function classifyActionOutcome(
  result: TickTickActionResult,
  rec: RecommendedAction,
  operation: TickTickOperation,
): ActionResult['outcome'] {
  const evidence = parseTickTickMutationEvidence(result.result, {
    operation,
    taskId: rec.taskId,
    projectId: rec.projectId,
  });
  if (result.success && evidence?.outcome === 'verified') return 'executed';
  return result.error?.includes('queued') ? 'queued' : 'failed';
}

async function executeRecommendations(
  state: ServiceState,
  actionable: RecommendedAction[],
): Promise<{ executed: ActionResult[]; queued: ActionResult[]; failed: ActionResult[] }> {
  const executed: ActionResult[] = [];
  const queued: ActionResult[] = [];
  const failed: ActionResult[] = [];

  for (const rec of actionable) {
    if (state.controller.signal.aborted) break;
    const result = await executeRecommendation(state, rec);
    if (result.outcome === 'executed') {
      executed.push(result);
    } else if (result.outcome === 'queued') {
      queued.push(result);
    } else {
      failed.push(result);
    }
  }

  return { executed, queued, failed };
}

function emitActionSummaryNotification(
  state: ServiceState,
  summary: { executed: ActionResult[]; queued: ActionResult[] },
): void {
  const { executed, queued } = summary;
  const parts: string[] = [];
  if (executed.length > 0) {
    const updates = executed.filter((a) => a.action === 'update-task').length;
    const completions = executed.filter((a) => a.action === 'complete-task').length;
    parts.push(
      `Completed ${executed.length} task actions: ${updates} updates, ${completions} completions.`,
    );
  }
  if (queued.length > 0) {
    parts.push(`${queued.length} actions queued for approval.`);
  }

  emitNotification(state, {
    title: 'Autonomous Task Management',
    body: parts.join(' '),
  });
}

async function runAutonomousManagement(state: ServiceState): Promise<boolean> {
  if (!state.agentManager || state.controller.signal.aborted) return false;

  const snapshot = await fetchWorkload(state);
  if (snapshot === null) {
    state.controller.signal.throwIfAborted();
    return false;
  }
  state.controller.signal.throwIfAborted();

  if (snapshot.tasks.length === 0) {
    log.info('No open tasks found in the observed TickTick query scopes');
    emitCompletionEvent(state, { executed: [], queued: [], failed: [] });
    return true;
  }

  const recommendations = await analyzeTasksForRecommendations(state, JSON.stringify(snapshot));
  if (recommendations === null) {
    state.controller.signal.throwIfAborted();
    return false;
  }
  state.controller.signal.throwIfAborted();

  if (!recommendationsMatchSnapshot(recommendations, snapshot)) {
    emitFailureEvent(
      state,
      'Task analysis referenced records outside the observed TickTick snapshot',
    );
    return false;
  }

  const actionable = recommendations.filter((r) => r.confidence !== 'low');

  if (actionable.length === 0) {
    log.info('No actionable recommendations after confidence filtering');
    emitCompletionEvent(state, { executed: [], queued: [], failed: [] });
    return true;
  }

  const summary = await executeRecommendations(state, actionable);
  state.controller.signal.throwIfAborted();

  if (summary.executed.length > 0 || summary.queued.length > 0) {
    emitActionSummaryNotification(state, summary);
  }

  emitCompletionEvent(state, summary);
  return summary.failed.length === 0;
}

function emitFailureEvent(state: ServiceState, error: string): void {
  if (state.controller.signal.aborted || currentState !== state) return;
  state.eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SUITE_TASK_MANAGEMENT,
    type: EVENT_TASK_MGMT_AUTONOMOUS_FAILED,
    payload: { error },
  });
}

function emitCompletionEvent(
  state: ServiceState,
  summary: { executed: ActionResult[]; queued: ActionResult[]; failed: ActionResult[] },
): void {
  if (state.controller.signal.aborted || currentState !== state) return;
  state.eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SUITE_TASK_MANAGEMENT,
    type: EVENT_TASK_MGMT_AUTONOMOUS_COMPLETED,
    payload: {
      executedCount: summary.executed.length,
      queuedCount: summary.queued.length,
      failedCount: summary.failed.length,
      actions: [...summary.executed, ...summary.queued, ...summary.failed],
    },
  });
}

async function handleManageRequest(state: ServiceState, event: unknown): Promise<void> {
  const e = event as { payload: unknown };
  const parsed = TaskManagementManageRequestPayloadSchema.safeParse(e.payload);
  if (!parsed.success) {
    log.warn(`Invalid manage-request payload: ${parsed.error.message}`);
    return;
  }

  if (state.controller.signal.aborted || currentState !== state) return;
  if (state.running) {
    log.warn('Autonomous management already running — skipping manual trigger');
    return;
  }

  try {
    await startRun(state);
  } catch (err) {
    if (!state.controller.signal.aborted) log.error(`Autonomous management failed: ${String(err)}`);
  }
}

function startRun(state: ServiceState): Promise<boolean> {
  if (state.controller.signal.aborted || currentState !== state || state.running) {
    return Promise.resolve(false);
  }
  state.running = true;
  const run = (async () => {
    try {
      return await runAutonomousManagement(state);
    } finally {
      state.running = false;
    }
  })();
  state.activeRuns.add(run);
  void run.then(
    () => state.activeRuns.delete(run),
    () => state.activeRuns.delete(run),
  );
  return run;
}

const service: RavenService = {
  async start(context: ServiceContext): Promise<void> {
    if (currentState) await service.stop();
    const state = {
      eventBus: context.eventBus,
      agentManager: context.config.agentManager as AgentManagerLike | undefined,
      controller: new AbortController(),
      activeRuns: new Set<Promise<unknown>>(),
      running: false,
      timeZone:
        typeof context.config.RAVEN_TIMEZONE === 'string' ? context.config.RAVEN_TIMEZONE : 'UTC',
    } as ServiceState;
    state.requestHandler = (event: unknown) => handleManageRequest(state, event);
    state.releaseJob = context.jobRegistry.register('autonomous-task-management', async () => {
      if (state.controller.signal.aborted || currentState !== state) {
        throw new Error('Autonomous task management stopped');
      }
      if (state.running) throw new Error('Autonomous task management already running');
      const completed = await startRun(state);
      if (!completed) throw new Error('Autonomous task management failed');
      return { summary: 'Autonomous task management complete' };
    });
    currentState = state;
    state.eventBus.on(
      EVENT_TASK_MGMT_MANAGE_REQUEST,
      state.requestHandler as (event: unknown) => void,
    );

    log.info('Autonomous manager service started');
  },

  async stop(): Promise<void> {
    const state = currentState;
    if (!state) return;
    currentState = undefined;
    state.releaseJob?.();
    state.releaseJob = undefined;
    state.controller.abort(new Error('Autonomous manager stopped'));
    state.eventBus.off(
      EVENT_TASK_MGMT_MANAGE_REQUEST,
      state.requestHandler as (event: unknown) => void,
    );
    await Promise.allSettled([...state.activeRuns]);
    log.info('Autonomous manager service stopped');
  },
};

export default service;

// Export for testing
export {
  handleManageRequest,
  runAutonomousManagement,
  parseRecommendations,
  buildAnalysisPrompt,
  buildActionPrompt,
};
