import { z } from 'zod';
import {
  generateId,
  createLogger,
  SUITE_EMAIL,
  EVENT_EMAIL_TRIAGE_ACTION_ITEMS,
  EVENT_EMAIL_ACTION_EXTRACT_COMPLETED,
  EVENT_EMAIL_ACTION_EXTRACT_FAILED,
  EmailTriageActionItemsPayloadSchema,
  type EventBusInterface,
} from '@raven/shared';
import type { ServiceContext, SuiteService } from '@raven/core/suite-registry/service-runner.ts';

const log = createLogger('action-extractor');

interface AgentManagerLike {
  executeApprovedAction(params: {
    actionName: string;
    skillName: string;
    details?: string;
    sessionId?: string;
  }): Promise<{ success: boolean; result?: string; error?: string }>;
}

const ActionItemSchema = z.object({
  title: z.string().min(1),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
  context: z.string().default(''),
});

type ActionItem = z.infer<typeof ActionItemSchema>;

interface RetryEntry {
  emailId: string;
  items: ActionItem[];
  emailMeta: { from: string; subject: string; date: string };
  attempts: number;
  lastAttempt: number;
}

let eventBus: EventBusInterface | null = null;
let serviceConfig: Record<string, unknown> | null = null;
const retryQueue = new Map<string, RetryEntry>();
let retryInterval: ReturnType<typeof setInterval> | null = null;

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const RETRY_BACKOFF_MS = 60 * 1000;

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
    source: SUITE_EMAIL,
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

function parseEmailResult(resultText: string): {
  from: string;
  subject: string;
  body: string;
  date: string;
  messageId: string;
} | null {
  const firstBrace = resultText.indexOf('{');
  if (firstBrace < 0) return null;
  const lastBrace = resultText.lastIndexOf('}');
  if (lastBrace <= firstBrace) return null;

  try {
    const parsed = JSON.parse(resultText.slice(firstBrace, lastBrace + 1));
    if (!parsed.from || !parsed.subject || !parsed.body) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseActionItems(resultText: string): ActionItem[] {
  const firstBracket = resultText.indexOf('[');
  if (firstBracket < 0) return [];
  const lastBracket = resultText.lastIndexOf(']');
  if (lastBracket <= firstBracket) return [];

  try {
    const raw = JSON.parse(resultText.slice(firstBracket, lastBracket + 1));
    if (!Array.isArray(raw)) return [];
    const items: ActionItem[] = [];
    for (const entry of raw) {
      const result = ActionItemSchema.safeParse(entry);
      if (result.success) {
        items.push(result.data);
      }
    }
    return items;
  } catch {
    return [];
  }
}

async function createTasksFromItems(
  items: ActionItem[],
  emailMeta: { from: string; subject: string; date: string },
): Promise<{ succeeded: ActionItem[]; failed: ActionItem[] }> {
  const agentManager = getAgentManager();
  if (!agentManager) return { succeeded: [], failed: items };

  const succeeded: ActionItem[] = [];
  const failed: ActionItem[] = [];

  for (const item of items) {
    const dueDateStr = item.dueDate ? `, due: ${item.dueDate}` : '';
    const prompt = `Create a task: "${item.title}"${dueDateStr}, priority: ${item.priority}. Note: From email by ${emailMeta.from} — "${emailMeta.subject}" (${emailMeta.date}). Context: ${item.context}`;

    try {
      const result = await agentManager.executeApprovedAction({
        actionName: 'ticktick:create-task',
        skillName: 'task-management',
        details: prompt,
      });
      if (result.success) {
        succeeded.push(item);
      } else {
        failed.push(item);
      }
    } catch (err) {
      log.error(`Failed to create task "${item.title}": ${err instanceof Error ? err.message : err}`);
      failed.push(item);
    }
  }

  return { succeeded, failed };
}

async function processRetryQueue(): Promise<void> {
  const agentManager = getAgentManager();
  if (!agentManager) return;

  const now = Date.now();
  for (const [emailId, entry] of retryQueue) {
    if (entry.attempts >= MAX_RETRY_ATTEMPTS) {
      emitNotification(
        'Task Creation Failed',
        `Failed to create tasks from email: ${entry.emailMeta.from} — "${entry.emailMeta.subject}". Please review manually.`,
        [{ label: 'View Email', action: `e:v:${emailId.slice(0, 8)}` }],
      );
      if (eventBus) {
        eventBus.emit({
          id: generateId(),
          timestamp: Date.now(),
          source: SUITE_EMAIL,
          type: EVENT_EMAIL_ACTION_EXTRACT_FAILED,
          payload: { emailId, error: `Max retry attempts (${MAX_RETRY_ATTEMPTS}) exhausted` },
        });
      }
      retryQueue.delete(emailId);
      continue;
    }

    if (now - entry.lastAttempt < RETRY_BACKOFF_MS) continue;

    const result = await createTasksFromItems(entry.items, entry.emailMeta);

    if (result.failed.length === 0) {
      log.info(`Retry succeeded for email ${emailId}: ${result.succeeded.length} tasks created`);
      emitNotification(
        'Tasks from Email',
        `Created ${result.succeeded.length} task(s) from email: ${entry.emailMeta.from} — "${entry.emailMeta.subject}"`,
        [{ label: 'View Tasks', action: 't:l:' }],
      );
      if (eventBus) {
        eventBus.emit({
          id: generateId(),
          timestamp: Date.now(),
          source: SUITE_EMAIL,
          type: EVENT_EMAIL_ACTION_EXTRACT_COMPLETED,
          payload: {
            emailId,
            tasksCreated: result.succeeded.length,
            actionItems: entry.items.map((i) => i.title),
          },
        });
      }
      retryQueue.delete(emailId);
    } else if (result.succeeded.length > 0) {
      // Partial success: notify for succeeded, re-queue only failed items
      emitNotification(
        'Tasks from Email',
        `Created ${result.succeeded.length} task(s) from email: ${entry.emailMeta.from} — "${entry.emailMeta.subject}" (${result.failed.length} pending retry)`,
        [{ label: 'View Tasks', action: 't:l:' }],
      );
      entry.items = result.failed;
      entry.attempts++;
      entry.lastAttempt = now;
      log.warn(`Retry partial: ${result.succeeded.length} succeeded, ${result.failed.length} still failing for email ${emailId}`);
    } else {
      entry.attempts++;
      entry.lastAttempt = now;
      log.warn(`Retry attempt ${entry.attempts}/${MAX_RETRY_ATTEMPTS} failed for email ${emailId}`);
    }
  }
}

async function handleActionItems(event: unknown): Promise<void> {
  const e = event as { payload: unknown };
  const parsed = EmailTriageActionItemsPayloadSchema.safeParse(e.payload);
  if (!parsed.success) {
    log.warn(`Invalid email:triage:action-items payload: ${parsed.error.message}`);
    return;
  }

  const { emailId } = parsed.data;
  const agentManager = getAgentManager();
  if (!agentManager) return;

  // Step 1: Fetch full email
  let emailData: { from: string; subject: string; body: string; date: string; messageId: string };
  try {
    const fetchResult = await agentManager.executeApprovedAction({
      actionName: 'gmail:get-email',
      skillName: 'email',
      details: `Fetch the full email with messageId "${emailId}". Return JSON with fields: from, to, subject, body, date, messageId.`,
    });

    if (!fetchResult.success || !fetchResult.result) {
      log.error(`Failed to fetch email ${emailId}: ${fetchResult.error ?? 'no result'}`);
      if (eventBus) {
        eventBus.emit({
          id: generateId(),
          timestamp: Date.now(),
          source: SUITE_EMAIL,
          type: EVENT_EMAIL_ACTION_EXTRACT_FAILED,
          payload: { emailId, error: fetchResult.error ?? 'Email fetch failed' },
        });
      }
      return;
    }

    const emailParsed = parseEmailResult(fetchResult.result);
    if (!emailParsed) {
      log.error(`Failed to parse email fetch result for ${emailId}`);
      if (eventBus) {
        eventBus.emit({
          id: generateId(),
          timestamp: Date.now(),
          source: SUITE_EMAIL,
          type: EVENT_EMAIL_ACTION_EXTRACT_FAILED,
          payload: { emailId, error: 'Failed to parse email fetch result' },
        });
      }
      return;
    }
    emailData = emailParsed;
  } catch (err) {
    log.error(`Error fetching email ${emailId}: ${err instanceof Error ? err.message : err}`);
    if (eventBus) {
      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: SUITE_EMAIL,
        type: EVENT_EMAIL_ACTION_EXTRACT_FAILED,
        payload: { emailId, error: err instanceof Error ? err.message : 'Unknown error' },
      });
    }
    return;
  }

  // Step 2: Extract action items via AI
  let actionItems: ActionItem[];
  try {
    const extractionPrompt = [
      'Analyze the following email and extract ALL action items — tasks, requests, deadlines, or things the recipient needs to do. Return ONLY a JSON array, no other text.',
      '',
      `From: ${emailData.from}`,
      `Subject: ${emailData.subject}`,
      `Date: ${emailData.date}`,
      `Body:`,
      emailData.body,
      '',
      'Return format:',
      '[',
      '  {',
      '    "title": "Short, actionable task title",',
      '    "dueDate": "YYYY-MM-DD" or null if no deadline mentioned,',
      '    "priority": "low" | "medium" | "high" based on urgency/importance,',
      '    "context": "Brief note about why this task exists"',
      '  }',
      ']',
      '',
      'Rules:',
      '- Only extract genuine action items (things someone needs to DO)',
      '- Ignore FYI-only content, signatures, disclaimers',
      '- If no action items found, return empty array []',
      '- Due dates: "by Friday" → next Friday\'s date, "by end of month" → last day of current month, "ASAP" → today',
      '- Priority: "urgent"/"ASAP" → high, normal requests → medium, "when you get a chance" → low',
    ].join('\n');

    const extractResult = await agentManager.executeApprovedAction({
      actionName: 'gmail:search-emails',
      skillName: 'email',
      details: extractionPrompt,
    });

    if (!extractResult.success || !extractResult.result) {
      log.warn(`Action item extraction failed for email ${emailId}: ${extractResult.error ?? 'no result'}`);
      if (eventBus) {
        eventBus.emit({
          id: generateId(),
          timestamp: Date.now(),
          source: SUITE_EMAIL,
          type: EVENT_EMAIL_ACTION_EXTRACT_FAILED,
          payload: { emailId, error: 'Extraction agent returned no result' },
        });
      }
      return;
    }

    actionItems = parseActionItems(extractResult.result);
  } catch (err) {
    log.error(`Error extracting action items for email ${emailId}: ${err instanceof Error ? err.message : err}`);
    if (eventBus) {
      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: SUITE_EMAIL,
        type: EVENT_EMAIL_ACTION_EXTRACT_FAILED,
        payload: { emailId, error: err instanceof Error ? err.message : 'Unknown error' },
      });
    }
    return;
  }

  if (actionItems.length === 0) {
    log.info(`No action items found in email ${emailId}`);
    if (eventBus) {
      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: SUITE_EMAIL,
        type: EVENT_EMAIL_ACTION_EXTRACT_COMPLETED,
        payload: { emailId, tasksCreated: 0, actionItems: [] },
      });
    }
    return;
  }

  // Step 3: Create TickTick tasks
  const emailMeta = { from: emailData.from, subject: emailData.subject, date: emailData.date };
  const result = await createTasksFromItems(actionItems, emailMeta);

  // Step 4: Queue failed items for retry (AC #4 — handles both full and partial failure)
  if (result.failed.length > 0) {
    retryQueue.set(emailId, {
      emailId,
      items: result.failed,
      emailMeta,
      attempts: 1,
      lastAttempt: Date.now(),
    });
    log.warn(`${result.failed.length} task creation(s) failed for email ${emailId}, queued for retry`);
  }

  // Step 5: Notify success (only if at least one task succeeded)
  if (result.succeeded.length > 0) {
    const pendingNote = result.failed.length > 0
      ? ` (${result.failed.length} pending retry)`
      : '';
    emitNotification(
      'Tasks from Email',
      `Created ${result.succeeded.length} task(s) from email: ${emailData.from} — "${emailData.subject}"${pendingNote}`,
      [{ label: 'View Tasks', action: 't:l:' }],
    );

    if (eventBus) {
      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: SUITE_EMAIL,
        type: EVENT_EMAIL_ACTION_EXTRACT_COMPLETED,
        payload: {
          emailId,
          tasksCreated: result.succeeded.length,
          actionItems: result.succeeded.map((i) => i.title),
        },
      });
    }
  }
}

const service: SuiteService = {
  async start(context: ServiceContext): Promise<void> {
    eventBus = context.eventBus;
    serviceConfig = context.config;

    eventBus.on(
      EVENT_EMAIL_TRIAGE_ACTION_ITEMS,
      handleActionItems as (event: unknown) => void,
    );

    retryInterval = setInterval(() => {
      processRetryQueue().catch((err) => {
        log.error(`Retry queue error: ${err instanceof Error ? err.message : err}`);
      });
    }, RETRY_CHECK_INTERVAL_MS);

    log.info('Action extractor service started');
  },

  async stop(): Promise<void> {
    if (eventBus) {
      eventBus.off(
        EVENT_EMAIL_TRIAGE_ACTION_ITEMS,
        handleActionItems as (event: unknown) => void,
      );
    }
    if (retryInterval) {
      clearInterval(retryInterval);
      retryInterval = null;
    }
    retryQueue.clear();
    eventBus = null;
    serviceConfig = null;
    log.info('Action extractor service stopped');
  },
};

export default service;

// Export for testing
export {
  handleActionItems,
  parseEmailResult,
  parseActionItems,
  createTasksFromItems,
  processRetryQueue,
  retryQueue,
  MAX_RETRY_ATTEMPTS,
  RETRY_BACKOFF_MS,
};
