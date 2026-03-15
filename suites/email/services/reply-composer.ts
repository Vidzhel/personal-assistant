import { z } from 'zod';
import {
  generateId,
  createLogger,
  SUITE_EMAIL,
  EVENT_EMAIL_REPLY_START,
  EVENT_EMAIL_REPLY_SEND,
  EVENT_EMAIL_REPLY_EDIT,
  EVENT_EMAIL_REPLY_CANCEL,
  EmailReplyStartPayloadSchema,
  EmailReplySendPayloadSchema,
  EmailReplyEditPayloadSchema,
  EmailReplyCancelPayloadSchema,
  type EventBusInterface,
} from '@raven/shared';
import type { ServiceContext, SuiteService } from '@raven/core/suite-registry/service-runner.ts';

const log = createLogger('reply-composer');

const SHORT_ID_LENGTH = 8;
const DRAFT_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface PendingDraft {
  emailId: string;
  compositionId: string;
  draftText: string;
  topicId?: number;
  topicName?: string;
  originalSubject?: string;
  originalFrom?: string;
  awaitingEdit?: boolean;
  createdAt: number;
}

interface AgentManagerLike {
  executeApprovedAction(params: {
    actionName: string;
    skillName: string;
    details?: string;
    sessionId?: string;
  }): Promise<{ success: boolean; result?: string; error?: string }>;
}

const DraftResultSchema = z.object({
  emailId: z.string(),
  to: z.string(),
  subject: z.string(),
  draftBody: z.string(),
  originalSnippet: z.string().optional(),
});

const pendingDrafts = new Map<string, PendingDraft>();
const pendingSendIds = new Set<string>();

let eventBus: EventBusInterface;
let serviceConfig: Record<string, unknown>;

function getShortId(compositionId: string): string {
  return compositionId.slice(0, SHORT_ID_LENGTH);
}

function getAgentManager(): AgentManagerLike | null {
  const mgr = serviceConfig.agentManager as AgentManagerLike | undefined;
  if (!mgr) {
    log.error('Agent manager not available in service config');
    return null;
  }
  return mgr;
}

function findDraftByShortId(shortId: string): PendingDraft | undefined {
  const draft = pendingDrafts.get(shortId);
  if (!draft) return undefined;
  if (Date.now() - draft.createdAt > DRAFT_TTL_MS) {
    pendingDrafts.delete(shortId);
    log.info(`Draft ${shortId} expired after TTL`);
    return undefined;
  }
  return draft;
}

function emitNotification(
  title: string,
  body: string,
  topicName?: string,
  actions?: Array<{ label: string; action: string }>,
): void {
  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SUITE_EMAIL,
    type: 'notification',
    payload: {
      channel: 'telegram' as const,
      title,
      body,
      topicName: topicName ?? 'General',
      actions: actions && actions.length > 0 ? actions : undefined,
    },
  });
}

function buildDraftActions(shortId: string): Array<{ label: string; action: string }> {
  return [
    { label: 'Send', action: `er:s:${shortId}` },
    { label: 'Edit', action: `er:e:${shortId}` },
    { label: 'Cancel', action: `er:c:${shortId}` },
  ];
}

function parseDraftResult(resultText: string): z.infer<typeof DraftResultSchema> | null {
  const firstBrace = resultText.indexOf('{');
  if (firstBrace < 0) return null;

  const lastBrace = resultText.lastIndexOf('}');
  if (lastBrace <= firstBrace) return null;

  try {
    const parsed = JSON.parse(resultText.slice(firstBrace, lastBrace + 1));
    const validated = DraftResultSchema.safeParse(parsed);
    if (!validated.success) {
      log.error(`Draft result validation failed: ${validated.error.message}`);
      return null;
    }
    return validated.data;
  } catch {
    log.error('Failed to parse draft result JSON');
    return null;
  }
}

async function handleReplyStart(event: unknown): Promise<void> {
  const e = event as { payload: unknown };
  const parsed = EmailReplyStartPayloadSchema.safeParse(e.payload);
  if (!parsed.success) {
    log.error(`Invalid email:reply:start payload: ${parsed.error.message}`);
    return;
  }

  const { emailId, userIntent, topicId, topicName } = parsed.data;
  const agentManager = getAgentManager();
  if (!agentManager) return;

  const compositionId = generateId();
  const shortId = getShortId(compositionId);

  pendingDrafts.set(shortId, {
    emailId,
    compositionId,
    draftText: '',
    topicId,
    topicName,
    createdAt: Date.now(),
  });

  log.info(`Starting reply composition ${shortId} for email ${emailId}`);

  const prompt = userIntent
    ? [
        `Fetch the email with ID "${emailId}" using the Gmail tools.`,
        `Then compose a professional reply based on these instructions: ${userIntent}`,
        `Return ONLY a JSON object: { "emailId": "...", "to": "...", "subject": "...", "draftBody": "...", "originalSnippet": "..." }`,
      ].join('\n')
    : [
        `Fetch the email with ID "${emailId}" using the Gmail tools.`,
        `Then compose a contextual, professional reply to this email.`,
        `Return ONLY a JSON object: { "emailId": "...", "to": "...", "subject": "...", "draftBody": "...", "originalSnippet": "..." }`,
      ].join('\n');

  try {
    const result = await agentManager.executeApprovedAction({
      actionName: 'gmail:get-email',
      skillName: SUITE_EMAIL,
      details: prompt,
    });

    if (!result.success || !result.result) {
      log.error(`Draft composition failed: ${result.error ?? 'no result'}`);
      emitNotification(
        'Reply Failed',
        'Could not compose a reply. The email may not be accessible.',
        topicName,
      );
      pendingDrafts.delete(shortId);
      return;
    }

    const draftData = parseDraftResult(result.result);
    if (!draftData) {
      log.error('Failed to parse agent draft response');
      emitNotification(
        'Reply Failed',
        'Could not parse the composed draft. Please try again.',
        topicName,
      );
      pendingDrafts.delete(shortId);
      return;
    }

    const draft = pendingDrafts.get(shortId);
    if (!draft) {
      log.warn(`Draft ${shortId} was cancelled during composition`);
      return;
    }

    draft.draftText = draftData.draftBody;
    draft.originalSubject = draftData.subject;
    draft.originalFrom = draftData.to;

    emitNotification(
      `Draft Reply: ${draftData.subject}`,
      `To: ${draftData.to}\n\n${draftData.draftBody}`,
      topicName,
      buildDraftActions(shortId),
    );

    log.info(`Draft composed for ${shortId}, awaiting user action`);
  } catch (err) {
    log.error(`Reply composition error: ${err instanceof Error ? err.message : err}`);
    emitNotification(
      'Reply Failed',
      'An error occurred while composing the reply.',
      topicName,
    );
    pendingDrafts.delete(shortId);
  }
}

async function handleReplySend(event: unknown): Promise<void> {
  const e = event as { payload: unknown };
  const parsed = EmailReplySendPayloadSchema.safeParse(e.payload);
  if (!parsed.success) {
    log.error(`Invalid email:reply:send payload: ${parsed.error.message}`);
    return;
  }

  const { compositionId } = parsed.data;
  const draft = findDraftByShortId(compositionId);
  if (!draft) {
    log.warn(`No pending draft found for compositionId: ${compositionId}`);
    return;
  }

  const agentManager = getAgentManager();
  if (!agentManager) return;

  log.info(`Sending reply for draft ${compositionId}`);

  const sendPrompt = [
    `Reply to email "${draft.emailId}".`,
    `To: ${draft.originalFrom}`,
    `Subject: ${draft.originalSubject}`,
    `Body:\n${draft.draftText}`,
    `Send this reply using the Gmail reply tool.`,
  ].join('\n');

  try {
    const result = await agentManager.executeApprovedAction({
      actionName: 'gmail:reply-email',
      skillName: SUITE_EMAIL,
      details: sendPrompt,
    });

    if (result.success) {
      emitNotification(
        'Reply Sent',
        `Your reply to "${draft.originalSubject}" has been sent.`,
        draft.topicName,
      );
      pendingDrafts.delete(compositionId);
      pendingSendIds.delete(compositionId);
      log.info(`Reply sent for draft ${compositionId}`);
    } else {
      // Track this draft as pending approval for permission:denied correlation
      pendingSendIds.add(compositionId);
      log.info(`Reply send result: ${result.error ?? 'pending approval'}`);
    }
  } catch (err) {
    log.error(`Reply send error: ${err instanceof Error ? err.message : err}`);
    emitNotification(
      'Reply Failed',
      'An error occurred while sending the reply.',
      draft.topicName,
    );
  }
}

async function handleReplyEdit(event: unknown): Promise<void> {
  const e = event as { payload: unknown };
  const parsed = EmailReplyEditPayloadSchema.safeParse(e.payload);
  if (!parsed.success) {
    log.error(`Invalid email:reply:edit payload: ${parsed.error.message}`);
    return;
  }

  const { compositionId, newInstructions } = parsed.data;
  const draft = findDraftByShortId(compositionId);
  if (!draft) {
    log.warn(`No pending draft found for compositionId: ${compositionId}`);
    return;
  }

  if (!newInstructions.trim()) {
    draft.awaitingEdit = true;
    log.info(`Draft ${compositionId} marked as awaiting edit instructions`);
    return;
  }

  const agentManager = getAgentManager();
  if (!agentManager) return;

  log.info(`Re-composing draft ${compositionId} with new instructions`);

  const editPrompt = [
    `Fetch the email with ID "${draft.emailId}" using the Gmail tools.`,
    `The previous draft was:\n${draft.draftText}`,
    `The user wants these changes: ${newInstructions}`,
    `Compose an updated reply incorporating the user's corrections.`,
    `Return ONLY a JSON object: { "emailId": "...", "to": "...", "subject": "...", "draftBody": "...", "originalSnippet": "..." }`,
  ].join('\n');

  try {
    const result = await agentManager.executeApprovedAction({
      actionName: 'gmail:get-email',
      skillName: SUITE_EMAIL,
      details: editPrompt,
    });

    if (!result.success || !result.result) {
      log.error(`Draft re-composition failed: ${result.error ?? 'no result'}`);
      emitNotification(
        'Edit Failed',
        'Could not re-compose the draft. Please try again.',
        draft.topicName,
      );
      return;
    }

    const draftData = parseDraftResult(result.result);
    if (!draftData) {
      log.error('Failed to parse re-composed draft');
      emitNotification(
        'Edit Failed',
        'Could not parse the updated draft.',
        draft.topicName,
      );
      return;
    }

    draft.draftText = draftData.draftBody;
    draft.originalSubject = draftData.subject;
    draft.originalFrom = draftData.to;

    emitNotification(
      `Updated Draft: ${draftData.subject}`,
      `To: ${draftData.to}\n\n${draftData.draftBody}`,
      draft.topicName,
      buildDraftActions(getShortId(draft.compositionId)),
    );

    log.info(`Draft re-composed for ${compositionId}`);
  } catch (err) {
    log.error(`Draft edit error: ${err instanceof Error ? err.message : err}`);
    emitNotification(
      'Edit Failed',
      'An error occurred while editing the draft.',
      draft.topicName,
    );
  }
}

function handleUserChatForEdit(event: unknown): void {
  const e = event as { payload: { message?: string } };
  const message = e.payload?.message;
  if (!message?.trim()) return;

  for (const [shortId, draft] of pendingDrafts) {
    if (draft.awaitingEdit) {
      draft.awaitingEdit = false;
      log.info(`Received edit instructions for draft ${shortId}`);
      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: SUITE_EMAIL,
        type: EVENT_EMAIL_REPLY_EDIT,
        payload: {
          compositionId: shortId,
          newInstructions: message,
        },
      });
      return;
    }
  }
}

function handleReplyCancel(event: unknown): void {
  const e = event as { payload: unknown };
  const parsed = EmailReplyCancelPayloadSchema.safeParse(e.payload);
  if (!parsed.success) {
    log.error(`Invalid email:reply:cancel payload: ${parsed.error.message}`);
    return;
  }

  const { compositionId } = parsed.data;
  const draft = findDraftByShortId(compositionId);
  if (!draft) {
    log.warn(`No pending draft found for compositionId: ${compositionId}`);
    return;
  }

  const topicName = draft.topicName;
  pendingDrafts.delete(compositionId);
  log.info(`Draft ${compositionId} cancelled`);

  emitNotification(
    'Reply Cancelled',
    'The draft reply has been discarded.',
    topicName,
  );
}

function handlePermissionDenied(event: unknown): void {
  const e = event as { payload: { actionName: string; approvalId: string } };
  if (e.payload.actionName !== 'gmail:reply-email') return;

  // Find the specific draft that was pending send approval
  for (const shortId of pendingSendIds) {
    const draft = pendingDrafts.get(shortId);
    if (draft) {
      emitNotification(
        'Reply Cancelled',
        'Reply cancelled by approval denial.',
        draft.topicName,
      );
      pendingDrafts.delete(shortId);
      pendingSendIds.delete(shortId);
      log.info(`Draft ${shortId} cancelled due to approval denial`);
      return;
    }
  }
}

const service: SuiteService = {
  async start(context: ServiceContext): Promise<void> {
    eventBus = context.eventBus;
    serviceConfig = context.config;
    eventBus.on(EVENT_EMAIL_REPLY_START, handleReplyStart as (event: unknown) => void);
    eventBus.on(EVENT_EMAIL_REPLY_SEND, handleReplySend as (event: unknown) => void);
    eventBus.on(EVENT_EMAIL_REPLY_EDIT, handleReplyEdit as (event: unknown) => void);
    eventBus.on(EVENT_EMAIL_REPLY_CANCEL, handleReplyCancel);
    eventBus.on('permission:denied', handlePermissionDenied);
    eventBus.on('user:chat:message', handleUserChatForEdit);
    log.info('Reply composer service started');
  },

  async stop(): Promise<void> {
    eventBus.off(EVENT_EMAIL_REPLY_START, handleReplyStart as (event: unknown) => void);
    eventBus.off(EVENT_EMAIL_REPLY_SEND, handleReplySend as (event: unknown) => void);
    eventBus.off(EVENT_EMAIL_REPLY_EDIT, handleReplyEdit as (event: unknown) => void);
    eventBus.off(EVENT_EMAIL_REPLY_CANCEL, handleReplyCancel);
    eventBus.off('permission:denied', handlePermissionDenied);
    eventBus.off('user:chat:message', handleUserChatForEdit);
    pendingDrafts.clear();
    pendingSendIds.clear();
    log.info('Reply composer service stopped');
  },
};

export default service;

// Export for testing
export { pendingDrafts, pendingSendIds, parseDraftResult, getShortId, buildDraftActions };
