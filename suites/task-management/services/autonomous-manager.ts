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
import type { ServiceContext, SuiteService } from '@raven/core/suite-registry/service-runner.ts';

const log = createLogger('autonomous-manager');

interface AgentManagerLike {
  executeApprovedAction(params: {
    actionName: string;
    skillName: string;
    details?: string;
    sessionId?: string;
  }): Promise<{ success: boolean; result?: string; error?: string }>;
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

let eventBus: EventBusInterface | null = null;
let serviceConfig: Record<string, unknown> | null = null;
let isRunning = false;

function getAgentManager(): AgentManagerLike | null {
  const mgr = serviceConfig?.agentManager as AgentManagerLike | undefined;
  if (!mgr) {
    log.error('Agent manager not available in service config');
    return null;
  }
  return mgr;
}

function emitNotification(
  title: string,
  body: string,
  actions?: Array<{ label: string; action: string }>,
): void {
  if (!eventBus) return;
  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SUITE_TASK_MANAGEMENT,
    type: 'notification',
    payload: {
      channel: 'telegram' as const,
      title,
      body,
      topicName: 'general',
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
    'You are analyzing a user\'s TickTick task list for autonomous management. Review ALL tasks and recommend actions that would help the user stay organized and productive.',
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

async function runAutonomousManagement(): Promise<void> {
  const agentManager = getAgentManager();
  if (!agentManager) return;

  // Step 1: Fetch all open tasks
  let tasksJson: string;
  try {
    const fetchResult = await agentManager.executeApprovedAction({
      actionName: 'ticktick:get-tasks',
      skillName: 'task-management',
      details:
        'Get all open tasks across all projects. Return JSON array with fields: id, projectId, title, content, priority (0=none,1=low,3=medium,5=high), dueDate, startDate, tags, status. Use the get_all_tasks or filter_tasks MCP tool.',
    });

    if (!fetchResult.success || !fetchResult.result) {
      log.error(`Failed to fetch tasks: ${fetchResult.error ?? 'no result'}`);
      emitFailureEvent(fetchResult.error ?? 'Task fetch failed');
      return;
    }
    tasksJson = fetchResult.result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Error fetching tasks: ${msg}`);
    emitFailureEvent(msg);
    return;
  }

  // Step 2: Check for empty task list
  const firstBracket = tasksJson.indexOf('[');
  const lastBracket = tasksJson.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    try {
      const parsed = JSON.parse(tasksJson.slice(firstBracket, lastBracket + 1));
      if (Array.isArray(parsed) && parsed.length === 0) {
        log.info('No open tasks found');
        emitCompletionEvent([], [], []);
        return;
      }
    } catch {
      // Not parseable as array — proceed with analysis anyway
    }
  }

  // Step 3: AI analysis of tasks
  let recommendations: RecommendedAction[];
  try {
    const analysisResult = await agentManager.executeApprovedAction({
      actionName: 'ticktick:get-tasks',
      skillName: 'task-management',
      details: buildAnalysisPrompt(tasksJson),
    });

    if (!analysisResult.success || !analysisResult.result) {
      log.warn(`Task analysis failed: ${analysisResult.error ?? 'no result'}`);
      emitFailureEvent(analysisResult.error ?? 'Task analysis failed');
      return;
    }

    const parsed = parseRecommendations(analysisResult.result);
    if (parsed === null) {
      log.warn('Failed to parse AI analysis response as JSON');
      emitFailureEvent('Failed to parse task analysis response');
      return;
    }
    recommendations = parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Error analyzing tasks: ${msg}`);
    emitFailureEvent(msg);
    return;
  }

  // Step 4: Filter low-confidence recommendations
  const actionable = recommendations.filter((r) => r.confidence !== 'low');

  if (actionable.length === 0) {
    log.info('No actionable recommendations after confidence filtering');
    emitCompletionEvent([], [], []);
    return;
  }

  // Step 5: Execute each recommendation through permission gates
  const executed: ActionResult[] = [];
  const queued: ActionResult[] = [];
  const failed: ActionResult[] = [];

  for (const rec of actionable) {
    const actionName = ACTION_NAME_MAP[rec.action];
    if (!actionName) {
      log.warn(`Unknown action type: ${rec.action}`);
      failed.push({ action: rec.action, taskTitle: rec.taskTitle, reason: rec.reason, outcome: 'failed' });
      continue;
    }

    try {
      const result = await agentManager.executeApprovedAction({
        actionName,
        skillName: 'task-management',
        details: buildActionPrompt(rec),
      });

      if (result.success) {
        executed.push({ action: rec.action, taskTitle: rec.taskTitle, reason: rec.reason, outcome: 'executed' });
      } else if (result.error?.includes('queued')) {
        queued.push({ action: rec.action, taskTitle: rec.taskTitle, reason: rec.reason, outcome: 'queued' });
      } else {
        failed.push({ action: rec.action, taskTitle: rec.taskTitle, reason: rec.reason, outcome: 'failed' });
      }
    } catch (err) {
      log.error(`Error executing ${rec.action} for "${rec.taskTitle}": ${err instanceof Error ? err.message : err}`);
      failed.push({ action: rec.action, taskTitle: rec.taskTitle, reason: rec.reason, outcome: 'failed' });
    }
  }

  // Step 6: Summary notification (only if at least 1 action executed or queued)
  if (executed.length > 0 || queued.length > 0) {
    const parts: string[] = [];
    if (executed.length > 0) {
      const updates = executed.filter((a) => a.action === 'update-task').length;
      const completions = executed.filter((a) => a.action === 'complete-task').length;
      parts.push(`Completed ${executed.length} task actions: ${updates} updates, ${completions} completions.`);
    }
    if (queued.length > 0) {
      parts.push(`${queued.length} actions queued for approval.`);
    }

    emitNotification(
      'Autonomous Task Management',
      parts.join(' '),
      [{ label: 'View Tasks', action: 't:l:' }],
    );
  }

  // Step 7: Emit completion event
  emitCompletionEvent(executed, queued, failed);
}

function emitFailureEvent(error: string): void {
  if (!eventBus) return;
  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SUITE_TASK_MANAGEMENT,
    type: EVENT_TASK_MGMT_AUTONOMOUS_FAILED,
    payload: { error },
  });
}

function emitCompletionEvent(
  executed: ActionResult[],
  queued: ActionResult[],
  failed: ActionResult[],
): void {
  if (!eventBus) return;
  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SUITE_TASK_MANAGEMENT,
    type: EVENT_TASK_MGMT_AUTONOMOUS_COMPLETED,
    payload: {
      executedCount: executed.length,
      queuedCount: queued.length,
      failedCount: failed.length,
      actions: [...executed, ...queued, ...failed],
    },
  });
}

const ScheduleTriggerPayloadSchema = z.object({
  taskType: z.string(),
});

async function handleScheduleTrigger(event: unknown): Promise<void> {
  const e = event as { payload?: unknown };
  const parsed = ScheduleTriggerPayloadSchema.safeParse(e.payload);
  if (!parsed.success || parsed.data.taskType !== 'autonomous-task-management') return;

  if (isRunning) {
    log.warn('Autonomous management already running — skipping');
    return;
  }

  isRunning = true;
  try {
    await runAutonomousManagement();
  } finally {
    isRunning = false;
  }
}

async function handleManageRequest(event: unknown): Promise<void> {
  const e = event as { payload: unknown };
  const parsed = TaskManagementManageRequestPayloadSchema.safeParse(e.payload);
  if (!parsed.success) {
    log.warn(`Invalid manage-request payload: ${parsed.error.message}`);
    return;
  }

  if (isRunning) {
    log.warn('Autonomous management already running — skipping manual trigger');
    return;
  }

  isRunning = true;
  try {
    await runAutonomousManagement();
  } finally {
    isRunning = false;
  }
}

const service: SuiteService = {
  async start(context: ServiceContext): Promise<void> {
    eventBus = context.eventBus;
    serviceConfig = context.config;

    eventBus.on('schedule:triggered', handleScheduleTrigger as (event: unknown) => void);
    eventBus.on(EVENT_TASK_MGMT_MANAGE_REQUEST, handleManageRequest as (event: unknown) => void);

    log.info('Autonomous manager service started');
  },

  async stop(): Promise<void> {
    if (eventBus) {
      eventBus.off('schedule:triggered', handleScheduleTrigger as (event: unknown) => void);
      eventBus.off(EVENT_TASK_MGMT_MANAGE_REQUEST, handleManageRequest as (event: unknown) => void);
    }
    eventBus = null;
    serviceConfig = null;
    isRunning = false;
    log.info('Autonomous manager service stopped');
  },
};

export default service;

// Export for testing
export {
  handleScheduleTrigger,
  handleManageRequest,
  runAutonomousManagement,
  parseRecommendations,
  buildAnalysisPrompt,
  buildActionPrompt,
};
