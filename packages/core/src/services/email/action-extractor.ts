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
import type { ServiceContext, RavenService } from '../types.ts';

const log = createLogger('action-extractor');

interface AgentManagerLike {
  executeAction(params: {
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

export type ActionItem = z.infer<typeof ActionItemSchema>;

interface RetryEntry {
  emailId: string;
  items: ActionItem[];
  emailMeta: { from: string; subject: string; date: string };
  attempts: number;
  lastAttempt: number;
}

interface FetchedEmail {
  from: string;
  subject: string;
  body: string;
  date: string;
  messageId: string;
}

let eventBus: EventBusInterface | null = null;
let serviceConfig: Record<string, unknown> | null = null;
const retryQueue = new Map<string, RetryEntry>();
let retryInterval: ReturnType<typeof setInterval> | null = null;

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_CHECK_INTERVAL_MS = 300000; // 5 minutes
const RETRY_BACKOFF_MS = 60000; // 1 minute
const SHORT_ID_LENGTH = 8;

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

function emitActionExtractFailed(emailId: string, error: string): void {
  if (!eventBus) return;
  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SUITE_EMAIL,
    type: EVENT_EMAIL_ACTION_EXTRACT_FAILED,
    payload: { emailId, error },
  });
}

function emitActionExtractCompleted(
  emailId: string,
  tasksCreated: number,
  actionItems: string[],
): void {
  if (!eventBus) return;
  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SUITE_EMAIL,
    type: EVENT_EMAIL_ACTION_EXTRACT_COMPLETED,
    payload: { emailId, tasksCreated, actionItems },
  });
}

function parseEmailResult(resultText: string): FetchedEmail | null {
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
      const result = await agentManager.executeAction({
        actionName: 'ticktick:create-task',
        // Library skill name — see callback-handler.ts's comment on the same fix.
        skillName: 'ticktick',
        details: prompt,
      });
      if (result.success) {
        succeeded.push(item);
      } else {
        failed.push(item);
      }
    } catch (err) {
      log.error(
        `Failed to create task "${item.title}": ${err instanceof Error ? err.message : err}`,
      );
      failed.push(item);
    }
  }

  return { succeeded, failed };
}

async function fetchEmailForActionItems(
  agentManager: AgentManagerLike,
  emailId: string,
): Promise<FetchedEmail | null> {
  try {
    const fetchResult = await agentManager.executeAction({
      actionName: 'gmail:get-email',
      // Library skill name — see callback-handler.ts's comment on the same fix.
      skillName: 'gmail',
      details: `Fetch the full email with messageId "${emailId}". Return JSON with fields: from, to, subject, body, date, messageId.`,
    });

    if (!fetchResult.success || !fetchResult.result) {
      log.error(`Failed to fetch email ${emailId}: ${fetchResult.error ?? 'no result'}`);
      emitActionExtractFailed(emailId, fetchResult.error ?? 'Email fetch failed');
      return null;
    }

    const emailParsed = parseEmailResult(fetchResult.result);
    if (!emailParsed) {
      log.error(`Failed to parse email fetch result for ${emailId}`);
      emitActionExtractFailed(emailId, 'Failed to parse email fetch result');
      return null;
    }
    return emailParsed;
  } catch (err) {
    log.error(`Error fetching email ${emailId}: ${err instanceof Error ? err.message : err}`);
    emitActionExtractFailed(emailId, err instanceof Error ? err.message : 'Unknown error');
    return null;
  }
}

function buildActionExtractionPrompt(emailData: {
  from: string;
  subject: string;
  body: string;
  date: string;
}): string {
  return [
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
}

async function extractActionItemsForEmail(
  agentManager: AgentManagerLike,
  emailId: string,
  emailData: { from: string; subject: string; body: string; date: string },
): Promise<ActionItem[] | null> {
  try {
    const extractionPrompt = buildActionExtractionPrompt(emailData);

    const extractResult = await agentManager.executeAction({
      actionName: 'gmail:search-emails',
      // Library skill name — see callback-handler.ts's comment on the same fix.
      skillName: 'gmail',
      details: extractionPrompt,
    });

    if (!extractResult.success || !extractResult.result) {
      log.warn(
        `Action item extraction failed for email ${emailId}: ${extractResult.error ?? 'no result'}`,
      );
      emitActionExtractFailed(emailId, 'Extraction agent returned no result');
      return null;
    }

    return parseActionItems(extractResult.result);
  } catch (err) {
    log.error(
      `Error extracting action items for email ${emailId}: ${err instanceof Error ? err.message : err}`,
    );
    emitActionExtractFailed(emailId, err instanceof Error ? err.message : 'Unknown error');
    return null;
  }
}

async function finalizeActionItems(
  emailId: string,
  emailMeta: { from: string; subject: string; date: string },
  actionItems: ActionItem[],
): Promise<void> {
  const result = await createTasksFromItems(actionItems, emailMeta);

  if (result.failed.length > 0) {
    retryQueue.set(emailId, {
      emailId,
      items: result.failed,
      emailMeta,
      attempts: 1,
      lastAttempt: Date.now(),
    });
    log.warn(
      `${result.failed.length} task creation(s) failed for email ${emailId}, queued for retry`,
    );
  }

  if (result.succeeded.length > 0) {
    const pendingNote = result.failed.length > 0 ? ` (${result.failed.length} pending retry)` : '';
    emitNotification(
      'Tasks from Email',
      `Created ${result.succeeded.length} task(s) from email: ${emailMeta.from} — "${emailMeta.subject}"${pendingNote}`,
      [{ label: 'View Tasks', action: 't:l:' }],
    );

    emitActionExtractCompleted(
      emailId,
      result.succeeded.length,
      result.succeeded.map((i) => i.title),
    );
  }
}

async function processRetryEntry(emailId: string, entry: RetryEntry, now: number): Promise<void> {
  if (entry.attempts >= MAX_RETRY_ATTEMPTS) {
    emitNotification(
      'Task Creation Failed',
      `Failed to create tasks from email: ${entry.emailMeta.from} — "${entry.emailMeta.subject}". Please review manually.`,
      [{ label: 'View Email', action: `e:v:${emailId.slice(0, SHORT_ID_LENGTH)}` }],
    );
    emitActionExtractFailed(emailId, `Max retry attempts (${MAX_RETRY_ATTEMPTS}) exhausted`);
    retryQueue.delete(emailId);
    return;
  }

  if (now - entry.lastAttempt < RETRY_BACKOFF_MS) return;

  const result = await createTasksFromItems(entry.items, entry.emailMeta);

  if (result.failed.length === 0) {
    log.info(`Retry succeeded for email ${emailId}: ${result.succeeded.length} tasks created`);
    emitNotification(
      'Tasks from Email',
      `Created ${result.succeeded.length} task(s) from email: ${entry.emailMeta.from} — "${entry.emailMeta.subject}"`,
      [{ label: 'View Tasks', action: 't:l:' }],
    );
    emitActionExtractCompleted(
      emailId,
      result.succeeded.length,
      entry.items.map((i) => i.title),
    );
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
    log.warn(
      `Retry partial: ${result.succeeded.length} succeeded, ${result.failed.length} still failing for email ${emailId}`,
    );
  } else {
    entry.attempts++;
    entry.lastAttempt = now;
    log.warn(`Retry attempt ${entry.attempts}/${MAX_RETRY_ATTEMPTS} failed for email ${emailId}`);
  }
}

async function processRetryQueue(): Promise<void> {
  const agentManager = getAgentManager();
  if (!agentManager) return;

  const now = Date.now();
  for (const [emailId, entry] of retryQueue) {
    await processRetryEntry(emailId, entry, now);
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
  const emailData = await fetchEmailForActionItems(agentManager, emailId);
  if (!emailData) return;

  // Step 2: Extract action items via AI
  const actionItems = await extractActionItemsForEmail(agentManager, emailId, emailData);
  if (!actionItems) return;

  if (actionItems.length === 0) {
    log.info(`No action items found in email ${emailId}`);
    emitActionExtractCompleted(emailId, 0, []);
    return;
  }

  // Step 3-5: Create TickTick tasks, queue retries, notify success
  const emailMeta = { from: emailData.from, subject: emailData.subject, date: emailData.date };
  await finalizeActionItems(emailId, emailMeta, actionItems);
}

const service: RavenService = {
  async start(context: ServiceContext): Promise<void> {
    eventBus = context.eventBus;
    serviceConfig = context.config;

    eventBus.on(EVENT_EMAIL_TRIAGE_ACTION_ITEMS, handleActionItems as (event: unknown) => void);

    retryInterval = setInterval(() => {
      processRetryQueue().catch((err) => {
        log.error(`Retry queue error: ${err instanceof Error ? err.message : err}`);
      });
    }, RETRY_CHECK_INTERVAL_MS);

    log.info('Action extractor service started');
  },

  async stop(): Promise<void> {
    if (eventBus) {
      eventBus.off(EVENT_EMAIL_TRIAGE_ACTION_ITEMS, handleActionItems as (event: unknown) => void);
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
