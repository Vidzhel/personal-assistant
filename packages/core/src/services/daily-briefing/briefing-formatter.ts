import { z } from 'zod';
import {
  generateId,
  createLogger,
  SUITE_DAILY_BRIEFING,
  type EventBusInterface,
  type DatabaseInterface,
  type NotificationDestination,
} from '@raven/shared';
import type { ServiceContext, RavenService } from '../types.ts';
import {
  getPendingBatched,
  markDeliveryOutcome,
  markIncludedInBriefing,
  releaseBatchedForDelivery,
  queuedReplyContext,
} from '../../notification-engine/notification-queue.ts';

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

type BatchedNotification = ReturnType<typeof getPendingBatched>[number];

function batchedDestination(item: BatchedNotification): NotificationDestination | undefined {
  if (item.destinationKind === 'project' && item.destinationProjectId) {
    return { kind: 'project' as const, projectId: item.destinationProjectId };
  }
  if (item.destinationKind === 'global' && item.destinationTopic) {
    return { kind: 'global' as const, topic: item.destinationTopic };
  }
  return undefined;
}

function failBatchedNotification(item: BatchedNotification, error: string): void {
  markDeliveryOutcome(db, { id: item.id, outcome: 'failed', error });
}

function releaseDestinationBatch(item: BatchedNotification): void {
  const destination = batchedDestination(item);
  if (!destination) {
    failBatchedNotification(item, 'Batched notification has no valid destination');
    return;
  }
  if (item.channel !== 'telegram' && item.channel !== 'all') {
    failBatchedNotification(item, 'Batched notification has no Telegram delivery channel');
    return;
  }
  releaseBatchedForDelivery(db, item.id);
  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SUITE_DAILY_BRIEFING,
    type: 'notification:deliver',
    payload: {
      queueId: item.id,
      channel: (item.channel ?? 'telegram') as 'telegram' | 'web' | 'all',
      title: item.title,
      body: item.body,
      filePath: item.filePath ?? undefined,
      actions: item.actionsJson ? JSON.parse(item.actionsJson) : undefined,
      destination,
      ...queuedReplyContext(item),
      urgencyTier: item.urgencyTier,
      deliveryMode: 'tell-when-active',
    },
  });
}

function getBatchedNotificationSections(): { sections: BriefingSection[]; includedIds: string[] } {
  try {
    const pending = getPendingBatched(db);
    pending
      .filter((item) => item.channel !== 'telegram' && item.channel !== 'all')
      .forEach(releaseDestinationBatch);
    pending
      .filter(
        (item) =>
          (item.channel === 'telegram' || item.channel === 'all') &&
          (item.destinationKind !== 'global' || item.destinationTopic !== 'general'),
      )
      .forEach(releaseDestinationBatch);
    const batched = pending.filter(
      (item) =>
        (item.channel === 'telegram' || item.channel === 'all') &&
        item.destinationKind === 'global' &&
        item.destinationTopic === 'general',
    );
    if (batched.length === 0) return { sections: [], includedIds: [] };

    const sections: BriefingSection[] = [];
    for (const item of batched) {
      sections.push({
        text: `\u2022 ${item.title}: ${item.body}`,
        actions: [],
      });
    }

    return { sections, includedIds: batched.map((item) => item.id) };
  } catch (err) {
    log.error(`Failed to load batched notifications: ${err}`);
    return { sections: [], includedIds: [] };
  }
}

type BriefingMessage = {
  title: string;
  body: string;
  actions: Array<{ label: string; action: string }>;
};

interface BriefingAccumulator {
  title: string;
  messages: BriefingMessage[];
  currentBody: string;
  currentActions: Array<{ label: string; action: string }>;
}

function appendSection(
  acc: BriefingAccumulator,
  sectionHeader: string | null,
  sections: BriefingSection[],
): void {
  if (sections.length === 0) return;

  const sectionBlock = sectionHeader ? `\n\n${sectionHeader}` : '';

  for (const section of sections) {
    const sectionText = sectionBlock ? `${sectionBlock}\n${section.text}` : `\n${section.text}`;
    const candidateBody = acc.currentBody + sectionText;

    if (candidateBody.length > TELEGRAM_MSG_LIMIT && acc.currentBody.length > 0) {
      // Flush current message
      acc.messages.push({ title: acc.title, body: acc.currentBody, actions: acc.currentActions });
      acc.currentBody = sectionText;
      acc.currentActions = [...section.actions];
    } else {
      acc.currentBody = candidateBody;
      acc.currentActions.push(...section.actions);
    }
  }
}

function appendSystemStatus(acc: BriefingAccumulator, systemStatus: string): void {
  const statusText = `\n\n\ud83d\udd27 System Status\n${systemStatus}`;
  if ((acc.currentBody + statusText).length > TELEGRAM_MSG_LIMIT && acc.currentBody.length > 0) {
    acc.messages.push({ title: acc.title, body: acc.currentBody, actions: acc.currentActions });
    acc.currentBody = statusText;
    acc.currentActions = [];
  } else {
    acc.currentBody += statusText;
  }
}

function buildBriefingMessages(briefing: BriefingResponse): {
  messages: BriefingMessage[];
  includedIds: string[];
} {
  const dateStr = formatDateHeader();
  const title = `\u2600\ufe0f Morning Briefing — ${dateStr}`;
  const acc: BriefingAccumulator = { title, messages: [], currentBody: '', currentActions: [] };

  // Tasks section
  const taskSections = buildTaskSections(briefing.tasks);
  if (taskSections.length > 0) {
    appendSection(acc, '\ud83d\udccb Tasks', taskSections);
  }

  // Emails section
  const emailSections = buildEmailSections(briefing.emails);
  if (emailSections.length > 0) {
    appendSection(acc, '\ud83d\udce7 Emails', emailSections);
  }

  // Queued updates (batched notifications from notification queue)
  const batched = getBatchedNotificationSections();
  if (batched.sections.length > 0) {
    appendSection(acc, '\ud83d\udce6 Queued Updates', batched.sections);
  }

  // System status
  if (briefing.systemStatus) {
    appendSystemStatus(acc, briefing.systemStatus);
  }

  // Flush remaining
  if (acc.currentBody.length > 0) {
    acc.messages.push({ title: acc.title, body: acc.currentBody, actions: acc.currentActions });
  }

  return { messages: acc.messages, includedIds: batched.includedIds };
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
          destination: { kind: 'global' as const, topic: 'general' as const },
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
        message:
          'Morning briefing delivery failed after 3 retries. Briefing queued for next active period.',
      },
    });
  } catch {
    log.error('Failed to emit system health alert');
  }
  throw new Error('Briefing delivery failed after all retries');
}

function parseBriefingResult(payload: Record<string, unknown>): BriefingResponse | undefined {
  if (payload.taskType !== 'morning-digest' || !payload.success) return undefined;
  const resultStr = payload.result as string;
  if (!resultStr) return undefined;
  try {
    let jsonStr = resultStr;
    const firstBrace = resultStr.indexOf('{');
    if (firstBrace >= 0) {
      const lastBrace = resultStr.lastIndexOf('}');
      if (lastBrace > firstBrace) {
        jsonStr = resultStr.slice(firstBrace, lastBrace + 1);
      }
    }

    const parsed = BriefingResponseSchema.safeParse(JSON.parse(jsonStr));
    if (!parsed.success) {
      log.error(`Invalid briefing response structure: ${parsed.error.message}`);
      return undefined;
    }
    return parsed.data;
  } catch {
    log.error('Failed to parse briefing result as JSON');
    return undefined;
  }
}

async function handleTaskComplete(event: unknown): Promise<void> {
  try {
    const e = event as Record<string, unknown>;
    const briefing = parseBriefingResult(e.payload as Record<string, unknown>);
    if (!briefing) return;

    const { messages, includedIds } = buildBriefingMessages(briefing);
    log.info(`Formatted briefing into ${messages.length} message(s)`);

    await Promise.all(messages.map((msg) => emitNotification(msg.title, msg.body, msg.actions)));
    if (includedIds.length > 0) {
      markIncludedInBriefing(db, includedIds);
      log.info(`Included ${includedIds.length} batched notification(s) in morning briefing`);
    }
  } catch (err) {
    log.error(`Failed to process briefing: ${err}`);
  }
}

const service: RavenService = {
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
