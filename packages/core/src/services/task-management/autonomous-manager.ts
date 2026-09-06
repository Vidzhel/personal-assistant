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

const log = createLogger('autonomous-manager');

interface AgentManagerLike {
  executeAction(params: {
    actionName: string;
    skillName: string;
    details?: string;
    sessionId?: string;
  }): Promise<AgentActionResult>;
}

interface AgentActionResult {
  success: boolean;
  result?: string;
  error?: string;
}

interface ServiceState {
  eventBus: EventBusInterface;
  agentManager?: AgentManagerLike;
  controller: AbortController;
  activeRuns: Set<Promise<unknown>>;
  running: boolean;
  releaseJob?: () => void;
  requestHandler: (event: unknown) => Promise<void>;
}

const RecommendedActionSchema = z.object({
  action: z.enum(['update-task', 'complete-task', 'delete-task']),
  taskId: z.string().min(1),
  projectId: z.string().min(1),
  taskTitle: z.string().min(1),
  reason: z.string().min(1),
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
  params: { actionName: string; skillName: string; details: string },
): Promise<AgentActionResult | undefined> {
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
  const firstBracket = resultText.indexOf('[');
  if (firstBracket < 0) return null;
  const lastBracket = resultText.lastIndexOf(']');
  if (lastBracket <= firstBracket) return null;

  try {
    const raw = JSON.parse(resultText.slice(firstBracket, lastBracket + 1));
    if (!Array.isArray(raw)) return null;
    const items: RecommendedAction[] = [];
    for (const entry of raw) {
      const result = RecommendedActionSchema.safeParse(entry);
      if (result.success) {
        items.push(result.data);
      }
    }
    return items;
  } catch {
    return null;
  }
}

function buildAnalysisPrompt(tasksJson: string): string {
  const today = new Date().toISOString().split('T')[0];
  return [
    "You are analyzing a user's TickTick task list for autonomous management. Review ALL tasks and recommend actions that would help the user stay organized and productive.",
    '',
    `Current date: ${today}`,
    '',
    'Tasks:',
    tasksJson,
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
  ].join('\n');
}

function buildActionPrompt(rec: RecommendedAction): string {
  const parts = [
    `Task: "${rec.taskTitle}" (id: ${rec.taskId}, project: ${rec.projectId})`,
    `Action: ${rec.action}`,
    `Reason: ${rec.reason}`,
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

  return parts.join('\n');
}

function actionResult(rec: RecommendedAction, outcome: ActionResult['outcome']): ActionResult {
  return { action: rec.action, taskTitle: rec.taskTitle, reason: rec.reason, outcome };
}

async function fetchOpenTasksJson(state: ServiceState): Promise<string | null> {
  try {
    const fetchResult = await requestAction(state, {
      actionName: 'ticktick:get-tasks',
      skillName: 'ticktick',
      details:
        'Get all open tasks across all projects. Return JSON array with fields: id, projectId, title, content, priority (0=none,1=low,3=medium,5=high), dueDate, startDate, tags, status. Use the get_all_tasks or filter_tasks MCP tool.',
    });
    if (!fetchResult) return null;

    if (!fetchResult.success || !fetchResult.result) {
      log.error(`Failed to fetch tasks: ${fetchResult.error ?? 'no result'}`);
      emitFailureEvent(state, fetchResult.error ?? 'Task fetch failed');
      return null;
    }
    return fetchResult.result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Error fetching tasks: ${msg}`);
    if (!state.controller.signal.aborted) emitFailureEvent(state, msg);
    return null;
  }
}

function hasNoOpenTasks(tasksJson: string): boolean {
  const firstBracket = tasksJson.indexOf('[');
  const lastBracket = tasksJson.lastIndexOf(']');
  if (firstBracket < 0 || lastBracket <= firstBracket) return false;

  try {
    const parsed = JSON.parse(tasksJson.slice(firstBracket, lastBracket + 1));
    return Array.isArray(parsed) && parsed.length === 0;
  } catch {
    // Not parseable as array — proceed with analysis anyway
    return false;
  }
}

async function analyzeTasksForRecommendations(
  state: ServiceState,
  tasksJson: string,
): Promise<RecommendedAction[] | null> {
  try {
    const analysisResult = await requestAction(state, {
      actionName: 'ticktick:get-tasks',
      skillName: 'ticktick',
      details: buildAnalysisPrompt(tasksJson),
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
  if (!actionName) {
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

    if (result.success) {
      return actionResult(rec, 'executed');
    }
    if (result.error?.includes('queued')) {
      return actionResult(rec, 'queued');
    }
    return actionResult(rec, 'failed');
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
    actions: [{ label: 'View Tasks', action: 't:l:' }],
  });
}

async function runAutonomousManagement(state: ServiceState): Promise<boolean> {
  if (!state.agentManager || state.controller.signal.aborted) return false;

  // Step 1: Fetch all open tasks
  const tasksJson = await fetchOpenTasksJson(state);
  if (tasksJson === null) {
    state.controller.signal.throwIfAborted();
    return false;
  }
  state.controller.signal.throwIfAborted();

  // Step 2: Check for empty task list
  if (hasNoOpenTasks(tasksJson)) {
    log.info('No open tasks found');
    emitCompletionEvent(state, { executed: [], queued: [], failed: [] });
    return true;
  }

  // Step 3: AI analysis of tasks
  const recommendations = await analyzeTasksForRecommendations(state, tasksJson);
  if (recommendations === null) {
    state.controller.signal.throwIfAborted();
    return false;
  }
  state.controller.signal.throwIfAborted();

  // Step 4: Filter low-confidence recommendations
  const actionable = recommendations.filter((r) => r.confidence !== 'low');

  if (actionable.length === 0) {
    log.info('No actionable recommendations after confidence filtering');
    emitCompletionEvent(state, { executed: [], queued: [], failed: [] });
    return true;
  }

  // Step 5: Execute each recommendation through permission gates
  const summary = await executeRecommendations(state, actionable);
  state.controller.signal.throwIfAborted();

  // Step 6: Summary notification (only if at least 1 action executed or queued)
  if (summary.executed.length > 0 || summary.queued.length > 0) {
    emitActionSummaryNotification(state, summary);
  }

  // Step 7: Emit completion event
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
