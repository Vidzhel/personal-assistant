import { z } from 'zod';
import {
  generateId,
  createLogger,
  SUITE_DAILY_BRIEFING,
  type EventBusInterface,
  type DatabaseInterface,
} from '@raven/shared';
import type { ServiceContext, SuiteService } from '@raven/core/suite-registry/service-runner.ts';
import { getPendingBatched, markBatched } from '@raven/core/notification-engine/notification-queue.ts';

const log = createLogger('briefing-formatter');

const TELEGRAM_MSG_LIMIT = 4096;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

const BriefingTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  dueDate: z.string().nullable(),
  isOverdue: z.boolean(),
  project: z.string().nullable(),
});

const BriefingEmailSchema = z.object({
  id: z.string(),
  from: z.string(),
  subject: z.string(),
  snippet: z.string(),
  isUrgent: z.boolean(),
});

const BriefingResponseSchema = z.object({
  tasks: z.array(BriefingTaskSchema),
  emails: z.array(BriefingEmailSchema),
  systemStatus: z.string(),
});

type BriefingTask = z.infer<typeof BriefingTaskSchema>;
type BriefingEmail = z.infer<typeof BriefingEmailSchema>;
type BriefingResponse = z.infer<typeof BriefingResponseSchema>;

let eventBus: EventBusInterface;
let db: DatabaseInterface;

function buildTaskActions(taskId: string): Array<{ label: string; action: string }> {
  return [
    { label: 'Complete', action: `t:c:${taskId}` },
    { label: 'Snooze 1d', action: `t:s:${taskId}:1d` },
    { label: 'Snooze 1w', action: `t:s:${taskId}:1w` },
    { label: 'Drop', action: `t:d:${taskId}` },
  ];
}

function buildEmailActions(emailId: string): Array<{ label: string; action: string }> {
  return [
    { label: 'Reply', action: `e:r:${emailId}` },
    { label: 'Archive', action: `e:a:${emailId}` },
    { label: 'Flag', action: `e:f:${emailId}` },
  ];
}

interface BriefingSection {
  text: string;
  actions: Array<{ label: string; action: string }>;
}

function formatDateHeader(): string {
  const now = new Date();
  return now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function buildTaskSections(tasks: BriefingTask[]): BriefingSection[] {
  const sections: BriefingSection[] = [];
  const overdueTasks = tasks.filter((t) => t.isOverdue);
  const todayTasks = tasks.filter((t) => !t.isOverdue);

  // Each overdue task gets its own section (with buttons)
  for (const task of overdueTasks) {
    const projectInfo = task.project ? ` [${task.project}]` : '';
    sections.push({
      text: `\u26a0\ufe0f Overdue: ${task.title}${projectInfo}`,
      actions: buildTaskActions(task.id),
    });
  }

  // Today tasks are grouped (no buttons needed)
  if (todayTasks.length > 0) {
    const lines = todayTasks.map((t) => {
      const projectInfo = t.project ? ` [${t.project}]` : '';
      return `\ud83d\udccc Today: ${t.title}${projectInfo}`;
    });
    sections.push({ text: lines.join('\n'), actions: [] });
  }

  return sections;
}

function buildEmailSections(emails: BriefingEmail[]): BriefingSection[] {
  const sections: BriefingSection[] = [];

  for (const email of emails) {
    const urgentMarker = email.isUrgent ? '\ud83d\udd34 ' : '\ud83d\udcec ';
    const text = `${urgentMarker}${email.from}: ${email.subject}`;
    sections.push({ text, actions: buildEmailActions(email.id) });
  }

  return sections;
}

function getBatchedNotificationSections(): BriefingSection[] {
  try {
    const batched = getPendingBatched(db);
    if (batched.length === 0) return [];

    const sections: BriefingSection[] = [];
    for (const item of batched) {
      sections.push({
        text: `\u2022 ${item.title}: ${item.body}`,
        actions: [],
      });
    }

    // Mark all as delivered
    markBatched(
      db,
      batched.map((b) => b.id),
    );

    log.info(`Included ${batched.length} batched notification(s) in morning briefing`);
    return sections;
  } catch (err) {
    log.error(`Failed to load batched notifications: ${err}`);
    return [];
  }
}

function buildBriefingMessages(briefing: BriefingResponse): Array<{
  title: string;
  body: string;
  actions: Array<{ label: string; action: string }>;
}> {
  const dateStr = formatDateHeader();
  const title = `\u2600\ufe0f Morning Briefing — ${dateStr}`;

  const messages: Array<{ title: string; body: string; actions: Array<{ label: string; action: string }> }> = [];
  let currentBody = '';
  let currentActions: Array<{ label: string; action: string }> = [];

  const addSection = (sectionHeader: string | null, sections: BriefingSection[]): void => {
    if (sections.length === 0) return;

    const sectionBlock = sectionHeader ? `\n\n${sectionHeader}` : '';

    for (const section of sections) {
      const sectionText = sectionBlock
        ? `${sectionBlock}\n${section.text}`
        : `\n${section.text}`;
      const candidateBody = currentBody + sectionText;

      if (candidateBody.length > TELEGRAM_MSG_LIMIT && currentBody.length > 0) {
        // Flush current message
        messages.push({ title, body: currentBody, actions: currentActions });
        currentBody = sectionText;
        currentActions = [...section.actions];
      } else {
        currentBody = candidateBody;
        currentActions.push(...section.actions);
      }
    }
  };

  // Tasks section
  const taskSections = buildTaskSections(briefing.tasks);
  if (taskSections.length > 0) {
    addSection('\ud83d\udccb Tasks', taskSections);
  }

  // Emails section
  const emailSections = buildEmailSections(briefing.emails);
  if (emailSections.length > 0) {
    addSection('\ud83d\udce7 Emails', emailSections);
  }

  // Queued updates (batched notifications from notification queue)
  const batchedItems = getBatchedNotificationSections();
  if (batchedItems.length > 0) {
    addSection('\ud83d\udce6 Queued Updates', batchedItems);
  }

  // System status
  if (briefing.systemStatus) {
    const statusText = `\n\n\ud83d\udd27 System Status\n${briefing.systemStatus}`;
    if ((currentBody + statusText).length > TELEGRAM_MSG_LIMIT && currentBody.length > 0) {
      messages.push({ title, body: currentBody, actions: currentActions });
      currentBody = statusText;
      currentActions = [];
    } else {
      currentBody += statusText;
    }
  }

  // Flush remaining
  if (currentBody.length > 0) {
    messages.push({ title, body: currentBody, actions: currentActions });
  }

  return messages;
}

// NOTE: This retry covers event bus emit failures (e.g., broken bus state).
// Telegram-level delivery retry is handled by sendMessageWithFallback in telegram-bot.ts.
// True end-to-end delivery confirmation would require a notification:delivered/failed event pattern.
async function emitNotification(
  title: string,
  body: string,
  actions: Array<{ label: string; action: string }>,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: SUITE_DAILY_BRIEFING,
        type: 'notification',
        payload: {
          channel: 'telegram' as const,
          title,
          body,
          topicName: 'General',
          actions: actions.length > 0 ? actions : undefined,
        },
      });
      return;
    } catch (err) {
      log.warn(`Briefing emit attempt ${attempt}/${MAX_RETRIES} failed: ${err}`);
      if (attempt < MAX_RETRIES) {
        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }

  // All retries exhausted
  log.error('Briefing delivery failed after all retries');
  try {
    eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: SUITE_DAILY_BRIEFING,
      type: 'system:health:alert',
      payload: {
        severity: 'warning' as const,
        source: 'briefing-formatter',
        message: 'Morning briefing delivery failed after 3 retries. Briefing queued for next active period.',
      },
    });
  } catch {
    log.error('Failed to emit system health alert');
  }
}

function handleTaskComplete(event: unknown): void {
  try {
    const e = event as Record<string, unknown>;
    const payload = e.payload as Record<string, unknown>;

    // Only process morning-digest task completions
    if (payload.taskType !== 'morning-digest') return;
    if (!payload.success) return;

    const resultStr = payload.result as string;
    if (!resultStr) return;

    // Try to parse JSON from the result (agent may include surrounding text).
    // Find the outermost balanced JSON object by locating the first '{' and
    // attempting to parse progressively from the end of the string.
    let jsonStr = resultStr;
    const firstBrace = resultStr.indexOf('{');
    if (firstBrace >= 0) {
      const lastBrace = resultStr.lastIndexOf('}');
      if (lastBrace > firstBrace) {
        jsonStr = resultStr.slice(firstBrace, lastBrace + 1);
      }
    }

    let briefingData: unknown;
    try {
      briefingData = JSON.parse(jsonStr);
    } catch {
      log.error('Failed to parse briefing result as JSON');
      return;
    }

    const parsed = BriefingResponseSchema.safeParse(briefingData);
    if (!parsed.success) {
      log.error(`Invalid briefing response structure: ${parsed.error.message}`);
      return;
    }

    const messages = buildBriefingMessages(parsed.data);
    log.info(`Formatted briefing into ${messages.length} message(s)`);

    for (const msg of messages) {
      emitNotification(msg.title, msg.body, msg.actions).catch((err) => {
        log.error(`Briefing emit error: ${err}`);
      });
    }
  } catch (err) {
    log.error(`Failed to process briefing: ${err}`);
  }
}

const service: SuiteService = {
  async start(context: ServiceContext): Promise<void> {
    eventBus = context.eventBus;
    db = context.db;
    eventBus.on('agent:task:complete', handleTaskComplete);
    log.info('Briefing formatter service started');
  },

  async stop(): Promise<void> {
    eventBus.off('agent:task:complete', handleTaskComplete);
    log.info('Briefing formatter service stopped');
  },
};

export default service;
