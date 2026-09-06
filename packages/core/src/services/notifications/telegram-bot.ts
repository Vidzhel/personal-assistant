import { notificationFileUrl } from './file-link.ts';
import { Bot, InlineKeyboard, InputFile, type Context, type Filter } from 'grammy';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import {
  generateId,
  SOURCE_TELEGRAM,
  PROJECT_TELEGRAM_DEFAULT,
  META_PROJECT_ID,
  type EventBusInterface,
  type LoggerInterface,
  type DatabaseInterface,
  type NotificationDeliverEvent,
  type SystemHealthAlertEvent,
  type AgentTaskCompleteEvent,
  type AgentMessageEvent,
  type PermissionBlockedEvent,
  type VoiceReceivedEvent,
  type MediaReceivedEvent,
  type ChatTransportOrigin,
  type UserChatAcceptedEvent,
  type UserChatRejectedEvent,
} from '@raven/shared';
import type { ServiceContext, RavenService } from '../types.ts';
import {
  beginDeliveryAttempt,
  claimNotificationDelivery,
  finishDeliveryAttempt,
  markDeliveryOutcome,
  reconcileInterruptedDeliveries,
  enqueueNotification,
  getPendingTellNowNotifications,
  getAcceptedTelegramRepliesMissingBinding,
  queuedReplyContext,
  type DeliveryAttemptOutcome,
} from '../../notification-engine/notification-queue.ts';
import {
  getStoredTopic,
  saveStoredTopic,
  deleteStoredTopic,
  getStoredProjectForTopic,
  listStoredProjectTopics,
  bindProjectTopic,
} from './topic-store.ts';
import {
  getTelegramConversation,
  getTelegramMessageBinding,
  ensureTelegramConversation,
  deleteTelegramIncomingBinding,
  saveTelegramConversation,
  saveTelegramConversationIfRevision,
  saveTelegramMessageBinding,
} from './telegram-conversation-store.ts';
import { parseCallbackData, handleCallback } from './callback-handler.ts';
import type { CallbackDeps, CallbackAction, CallbackResult } from './callback-handler.ts';
import type { ModelCatalog } from '../../agent-registry/model-catalog.ts';
import type { ConversationModelResolver } from '../../agent-registry/conversation-models.ts';
import type { SessionManager } from '../../session-manager/session-manager.ts';
import {
  formatTelegramModelStatus,
  parseTelegramModelCommand,
  type TelegramModelCommand,
} from './telegram-model-command.ts';

type OperatingMode = 'group' | 'direct';

interface TopicConfig {
  generalTopicId?: number;
  systemTopicId?: number;
  topicMap: Record<string, number>;
  reverseMap: Record<number, string>;
  topicToProject: Record<string, string>;
}

let bot: Bot | null = null;
let chatId: string;
let groupId: string;
let operatingMode: OperatingMode = 'direct';
let topicConfig: TopicConfig = { topicMap: {}, reverseMap: {}, topicToProject: {} };
let eventBus: EventBusInterface;
let logger: LoggerInterface;
let dbRef: DatabaseInterface;
let acceptingSends = false;
let runtimeGeneration = 0;
let telegramAbortController = new AbortController();
let runtimeProjectRoot = process.cwd();
type TelegramRequestSignal = Parameters<Bot<Context>['api']['sendMessage']>[3];
const pendingSends = new Set<Promise<void>>();
const ownedWorkGeneration = new AsyncLocalStorage<number>();
const STOP_DRAIN_TIMEOUT_MS = 5000;

function telegramRequestSignal(): TelegramRequestSignal {
  // grammY exposes the abort-controller package's structural signal type while
  // Node provides the runtime signal. Both implement the Fetch API contract.
  return telegramAbortController.signal as unknown as TelegramRequestSignal;
}

// Config handed to start(); mirrored at module scope so handlers registered
// outside start() (e.g. resolveCallbackDeps) can read it without a closure.
let serviceConfig: Record<string, unknown> = {};

// Track topicId per projectId so responses can route back to source topic
const projectTopicMap = new Map<string, number>();

// Track status messages for edit-in-place during agent processing
interface StatusMessage {
  messageId: number;
  chatId: string;
  threadId: number | undefined;
  lastEditAt: number;
}
const statusMessages = new Map<string, StatusMessage>();
interface PendingOrigin {
  origin: ChatTransportOrigin;
  conversationRevision: number;
}
const pendingOrigins = new Map<string, PendingOrigin>();
const incomingMessageKeys = new Set<string>();
const STATUS_EDIT_THROTTLE_MS = 2000;

function trackSend(work: () => Promise<void>): void {
  void runOwnedWork(work).catch(() => undefined);
}

async function runOwnedWork<T>(work: () => Promise<T>): Promise<T | undefined> {
  if (!acceptingSends) return undefined;
  const generation = runtimeGeneration;
  const operation = Promise.resolve().then(() => ownedWorkGeneration.run(generation, work));
  const pending = operation.then(
    () => undefined,
    () => undefined,
  );
  pendingSends.add(pending);
  void operation
    .catch((error: unknown) =>
      logger.error(`Telegram delivery failed: ${sanitizeTelegramError(error)}`),
    )
    .finally(() => pendingSends.delete(pending));
  return operation;
}

function canRecordOwnedOutcome(): boolean {
  const generation = ownedWorkGeneration.getStore();
  return generation === undefined ? acceptingSends : generation === runtimeGeneration;
}

function canDispatchProvider(): boolean {
  return acceptingSends && !telegramAbortController.signal.aborted && canRecordOwnedOutcome();
}

async function waitBounded(work: Promise<unknown>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), STOP_DRAIN_TIMEOUT_MS);
      timer.unref?.();
    });
    const result = await Promise.race([
      work.then(
        () => 'done' as const,
        (error: unknown) => {
          logger.warn(`${label} failed: ${sanitizeTelegramError(error)}`);
          return 'failed' as const;
        },
      ),
      timeout,
    ]);
    if (result === 'timeout') logger.warn(`${label} exceeded ${String(STOP_DRAIN_TIMEOUT_MS)}ms`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Callback handler deps (injected lazily via config after boot)
let callbackDeps: CallbackDeps | null = null;

const APPROVAL_KEYBOARD_COLUMNS = 3;
const TASK_KEYBOARD_COLUMNS = 2;

export function buildInlineKeyboard(
  actions: Array<{ label: string; action: string }>,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  // Detect layout: approval actions get 3 per row, task actions get 2 per row
  const isApproval = actions.some((a) => a.action.startsWith('a:'));
  const perRow = isApproval ? APPROVAL_KEYBOARD_COLUMNS : TASK_KEYBOARD_COLUMNS;

  for (let i = 0; i < actions.length; i++) {
    if (i > 0 && i % perRow === 0) keyboard.row();
    keyboard.text(actions[i].label, actions[i].action);
  }

  return keyboard;
}

export function escapeMarkdown(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

const MAX_TELEGRAM_LENGTH = 4000;
const THREAD_NOT_FOUND_RE = /thread not found/i;
const LOG_MESSAGE_PREVIEW_LENGTH = 100;
const MAX_SANITIZED_ERROR_LENGTH = 500;
const PROJECT_CHOICE_LIMIT = 50;

// Telegram Bot API limits file downloads (voice/photo/document) to 20MB
const TELEGRAM_FILE_DOWNLOAD_LIMIT_BYTES = 20_971_520; // 20 * 1024 * 1024
// Telegram Bot API limits file sends (e.g. sendDocument) to 50MB
const TELEGRAM_FILE_SEND_LIMIT_BYTES = 52_428_800; // 50 * 1024 * 1024

// Unicode Private Use Area placeholders — Telegram preserves these but never displays them
const PUA_BOLD_START = '';
const PUA_BOLD_END = '';
const PUA_ITALIC_START = '';
const PUA_ITALIC_END = '';
const PUA_CODE_START = '';
const PUA_CODE_END = '';

export function convertToMarkdownV2(text: string): string {
  // Preserve inline code spans by replacing them with PUA-delimited placeholders
  const codeSpans: string[] = [];
  let processed = text.replace(/`([^`]+)`/g, (_match, code: string) => {
    codeSpans.push(code);
    return `${PUA_CODE_START}${codeSpans.length - 1}${PUA_CODE_END}`;
  });

  // Convert markdown constructs before escaping
  // Headings → bold
  processed = processed.replace(/^#{1,6}\s+(.+)$/gm, '**$1**');
  // Bold **text** → *text* (MarkdownV2 bold)
  processed = processed.replace(/\*\*(.+?)\*\*/g, `${PUA_BOLD_START}$1${PUA_BOLD_END}`);
  // Blockquotes > text → italic
  processed = processed.replace(/^>\s+(.+)$/gm, `${PUA_ITALIC_START}$1${PUA_ITALIC_END}`);
  // Bullet lists
  processed = processed.replace(/^[-*]\s+/gm, '• ');

  // Escape remaining special chars
  processed = escapeMarkdown(processed);

  // Restore bold markers
  processed = processed.replace(new RegExp(PUA_BOLD_START, 'g'), '*');
  processed = processed.replace(new RegExp(PUA_BOLD_END, 'g'), '*');
  // Restore italic markers
  processed = processed.replace(new RegExp(PUA_ITALIC_START, 'g'), '_');
  processed = processed.replace(new RegExp(PUA_ITALIC_END, 'g'), '_');
  // Restore code spans
  processed = processed.replace(
    new RegExp(`${PUA_CODE_START}(\\d+)${PUA_CODE_END}`, 'g'),
    (_match, idx: string) => {
      return '`' + escapeMarkdown(codeSpans[Number(idx)]) + '`';
    },
  );

  return processed.slice(0, MAX_TELEGRAM_LENGTH);
}

// Parses TELEGRAM_TOPIC_MAP (JSON Record<string, number>), warning and
// falling back to {} on malformed JSON or an invalid structure.
function parseTopicMapEnv(mapStr: string | undefined): Record<string, number> {
  if (!mapStr) return {};

  const topicMapSchema = z.record(z.string(), z.number());
  try {
    const parsed: unknown = JSON.parse(mapStr);
    const result = topicMapSchema.safeParse(parsed);
    if (result.success) {
      return result.data;
    }
    logger?.warn(
      'TELEGRAM_TOPIC_MAP has invalid structure (expected Record<string, number>), ignoring',
    );
    return {};
  } catch {
    logger?.warn('TELEGRAM_TOPIC_MAP is not valid JSON, ignoring');
    return {};
  }
}

export function parseTopicConfig(): TopicConfig {
  const generalStr = process.env.TELEGRAM_TOPIC_GENERAL;
  const systemStr = process.env.TELEGRAM_TOPIC_SYSTEM;
  const generalTopicId = generalStr ? Number(generalStr) : undefined;
  const systemTopicId = systemStr ? Number(systemStr) : undefined;

  const topicMap = parseTopicMapEnv(process.env.TELEGRAM_TOPIC_MAP);

  // Build reverse map: topicId → topicName
  const reverseMap: Record<number, string> = {};
  for (const [name, id] of Object.entries(topicMap)) {
    reverseMap[id] = name;
  }
  if (generalTopicId !== undefined) {
    reverseMap[generalTopicId] = 'General';
  }
  if (systemTopicId !== undefined) {
    reverseMap[systemTopicId] = 'System';
  }

  // Build topicName → projectId mapping (topic names map to project IDs)
  const topicToProject: Record<string, string> = {};
  for (const name of Object.keys(topicMap)) {
    topicToProject[name] = `telegram-${name.toLowerCase()}`;
  }

  return { generalTopicId, systemTopicId, topicMap, reverseMap, topicToProject };
}

export function getTopicThreadId(topicName: string): number | undefined {
  if (topicName === 'General') return topicConfig.generalTopicId;
  if (topicName === 'System') return topicConfig.systemTopicId;
  return topicConfig.topicMap[topicName];
}

interface SendMessageOptions {
  parseMode?: 'MarkdownV2' | 'HTML';
  messageThreadId?: number;
  replyMarkup?: InlineKeyboard;
  replyToMessageId?: number;
}

interface TelegramSendOutcome {
  outcome: DeliveryAttemptOutcome;
  providerMessageId?: string;
  error?: string;
  attempts: number;
}

interface SendAttemptRecorder {
  begin(): string;
  finish(
    id: string,
    result: { outcome: DeliveryAttemptOutcome; providerMessageId?: string; error?: string },
  ): void;
}

function sanitizeTelegramError(error: unknown): string {
  return String(error)
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[redacted]')
    .replace(/https?:\/\/\S+/g, '[url]')
    .slice(0, MAX_SANITIZED_ERROR_LENGTH);
}

function classifySendError(error: unknown): DeliveryAttemptOutcome {
  const value = String(error).toLowerCase();
  if (
    /bad request|forbidden|unauthorized|too many requests|parse entities|thread not found|chat not found|bot is not running|\b(?:400|401|403|404|409|429):/.test(
      value,
    )
  ) {
    return 'failed';
  }
  return 'unknown';
}

function recordAttemptResult(
  recorder: SendAttemptRecorder | undefined,
  attemptId: string | undefined,
  result: { outcome: DeliveryAttemptOutcome; providerMessageId?: string; error?: string },
): void {
  if (!recorder || !attemptId || !canRecordOwnedOutcome()) return;
  try {
    recorder.finish(attemptId, result);
  } catch (error) {
    logger.error(
      `Telegram delivery evidence could not be finalized: ${sanitizeTelegramError(error)}`,
    );
  }
}

function isFormattingRejection(error: unknown): boolean {
  return /parse entities|can't parse|markdown|entity/i.test(String(error));
}

async function sendMessage(
  text: string,
  options: SendMessageOptions = {},
): Promise<{ message_id?: number }> {
  if (!bot) throw new Error('Telegram bot is not running');
  const { parseMode, messageThreadId, replyMarkup, replyToMessageId } = options;

  const targetChatId = operatingMode === 'group' ? groupId : chatId;
  const apiOptions: Record<string, unknown> = {};
  if (parseMode) apiOptions.parse_mode = parseMode;
  if (messageThreadId !== undefined && operatingMode === 'group') {
    apiOptions.message_thread_id = messageThreadId;
  }
  if (replyMarkup) apiOptions.reply_markup = replyMarkup;
  if (replyToMessageId !== undefined) {
    apiOptions.reply_parameters = { message_id: replyToMessageId };
  }

  return bot.api.sendMessage(targetChatId, text, apiOptions, telegramRequestSignal());
}

async function sendMessageWithFallback(
  text: string,
  options: SendMessageOptions = {},
  recorder?: SendAttemptRecorder,
): Promise<TelegramSendOutcome> {
  const first = await attemptTelegramMessage(text, options, recorder);
  if (first.outcome === 'accepted') {
    return first;
  }
  const firstError = first.error ?? 'Telegram rejected the message';
  if (options.messageThreadId !== undefined && THREAD_NOT_FOUND_RE.test(firstError)) {
    invalidateTopicByThreadId(options.messageThreadId);
  }
  if (!shouldAttemptPlainTextFallback(first, options, firstError)) {
    logger.error(`Telegram send ${first.outcome}: ${firstError}`);
    return first;
  }
  if (!canDispatchProvider()) return first;
  const fallback = await attemptTelegramMessage(
    text,
    { ...options, parseMode: undefined },
    recorder,
  );
  if (fallback.outcome !== 'accepted') {
    logger.error(`Telegram plain-text fallback ${fallback.outcome}: ${fallback.error}`);
  }
  return { ...fallback, attempts: first.attempts + fallback.attempts };
}

function shouldAttemptPlainTextFallback(
  first: TelegramSendOutcome,
  options: SendMessageOptions,
  error: string,
): boolean {
  if (first.outcome === 'unknown' || !options.parseMode) return false;
  return isFormattingRejection(error);
}

async function attemptTelegramMessage(
  text: string,
  options: SendMessageOptions,
  recorder?: SendAttemptRecorder,
): Promise<TelegramSendOutcome> {
  if (!canDispatchProvider()) {
    return {
      outcome: 'unknown',
      error: 'Telegram service stopped before provider dispatch',
      attempts: 0,
    };
  }
  const attemptId = recorder?.begin();
  try {
    const sent = await sendMessage(text, options);
    const result = {
      outcome: 'accepted' as const,
      providerMessageId: sent.message_id === undefined ? undefined : String(sent.message_id),
      attempts: 1,
    };
    recordAttemptResult(recorder, attemptId, result);
    return result;
  } catch (error) {
    const result = {
      outcome: classifySendError(error),
      error: sanitizeTelegramError(error),
      attempts: 1,
    };
    recordAttemptResult(recorder, attemptId, result);
    return result;
  }
}

function resolveTopicName(messageThreadId: number | undefined): string | undefined {
  if (messageThreadId === undefined) return undefined;
  return topicConfig.reverseMap[messageThreadId];
}

function resolveProjectId(topicId: number | undefined): string | undefined {
  if (topicConfig.systemTopicId !== undefined && topicId === topicConfig.systemTopicId) {
    return META_PROJECT_ID;
  }
  if (
    topicId === undefined ||
    (topicConfig.generalTopicId !== undefined && topicId === topicConfig.generalTopicId)
  ) {
    return PROJECT_TELEGRAM_DEFAULT;
  }
  if (!canUseStore()) return undefined;
  return getStoredProjectForTopic(dbRef, groupId, topicId);
}

function isSupportedDocumentType(mimeType: string, fileName: string): boolean {
  return mimeType === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf');
}

function sanitizeMediaFileName(fileName: string): string {
  return basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
}

// ---------------------------------------------------------------------------
// message:text handler
// ---------------------------------------------------------------------------

type TextMessageCtx = Filter<Context, 'message:text'>;

function canUseStore(): boolean {
  return Boolean(dbRef && typeof dbRef.get === 'function' && typeof dbRef.run === 'function');
}

function statusKey(origin: ChatTransportOrigin): string {
  return `${origin.chatId}:${origin.messageId}`;
}

function resolveReplyBinding(
  targetChatId: string,
  topicId: number | undefined,
  replyToMessageId: number | undefined,
): { projectId: string; sessionId: string } | undefined {
  if (!canUseStore() || replyToMessageId === undefined) return undefined;
  const binding = getTelegramMessageBinding(dbRef, targetChatId, replyToMessageId);
  if (!binding?.sessionId || binding.topicId !== topicId) return undefined;
  if (operatingMode === 'group' && resolveProjectId(topicId) !== binding.projectId) {
    return undefined;
  }
  return { projectId: binding.projectId, sessionId: binding.sessionId };
}

function isProjectAvailable(projectId: string): boolean {
  if (projectId === META_PROJECT_ID) return true;
  const registry = serviceConfig.projectRegistry as
    | {
        listProjects(): Array<{ id: string; isMeta?: boolean; metadata?: { id?: string } }>;
      }
    | undefined;
  if (registry) {
    return registry
      .listProjects()
      .some((project) => !project.isMeta && (project.metadata?.id ?? project.id) === projectId);
  }
  return (
    !canUseStore() ||
    Boolean(dbRef.get('SELECT 1 FROM projects WHERE id = ? AND fs_path IS NOT NULL', projectId))
  );
}

function emitTelegramChat(params: {
  requestId: string;
  origin: ChatTransportOrigin;
  projectId: string;
  sessionId?: string;
  text: string;
  topicId?: number;
  topicName?: string;
  messageId: number;
  replyToMessageId?: number;
}): string {
  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SOURCE_TELEGRAM,
    type: 'user:chat:message',
    projectId: params.projectId,
    payload: {
      requestId: params.requestId,
      projectId: params.projectId,
      sessionId: params.sessionId,
      message: params.text,
      topicId: params.topicId,
      topicName: params.topicName,
      transportOrigin: params.origin,
    },
  });
  return params.requestId;
}

function createTelegramOrigin(params: {
  topicId?: number;
  messageId: number;
  replyToMessageId?: number;
}): ChatTransportOrigin {
  return {
    transport: 'telegram',
    chatId: operatingMode === 'group' ? groupId : chatId,
    ...params,
  };
}

type IncomingReservation = 'reserved' | 'duplicate' | 'uncertain';

function reserveIncoming(origin: ChatTransportOrigin): IncomingReservation {
  const key = statusKey(origin);
  if (incomingMessageKeys.has(key)) return 'duplicate';
  if (canUseStore()) {
    const binding = getTelegramMessageBinding(dbRef, origin.chatId, origin.messageId);
    if (binding) return binding.sessionId ? 'duplicate' : 'uncertain';
  }
  incomingMessageKeys.add(key);
  return 'reserved';
}

async function admitIncoming(
  ctx: { reply: VoiceMessageCtx['reply'] },
  origin: ChatTransportOrigin,
  topicId?: number,
): Promise<boolean> {
  const reservation = reserveIncoming(origin);
  if (reservation === 'reserved') return true;
  if (reservation === 'uncertain') {
    await replyInThread(
      ctx,
      'Raven already admitted this message, but its prior processing outcome is unknown. Send a new message to continue without duplicating work.',
      topicId,
    );
  }
  return false;
}

function releaseIncomingReservation(origin: ChatTransportOrigin): void {
  incomingMessageKeys.delete(statusKey(origin));
}

function registerIncoming(
  origin: ChatTransportOrigin,
  projectId: string,
  sessionId: string | undefined,
): string {
  const requestId = generateId();
  try {
    let conversationRevision = 0;
    if (canUseStore()) {
      const conversation = ensureTelegramConversation(dbRef, {
        chatId: origin.chatId,
        topicId: origin.topicId,
        projectId,
        sessionId,
      });
      conversationRevision = conversation.revision ?? 1;
      saveTelegramMessageBinding(dbRef, {
        chatId: origin.chatId,
        messageId: origin.messageId,
        topicId: origin.topicId,
        projectId,
        sessionId,
        requestId,
        direction: 'incoming',
      });
    }
    pendingOrigins.set(requestId, { origin, conversationRevision });
    releaseIncomingReservation(origin);
    return requestId;
  } catch (error) {
    releaseIncomingReservation(origin);
    throw error;
  }
}

function createTelegramSession(projectId: string): string | undefined {
  const manager = serviceConfig.sessionManager as
    { createAdditionalSession(id: string): { id: string } } | undefined;
  return manager?.createAdditionalSession(projectId).id;
}

async function recordProcessingStatus(
  ctx: TextMessageCtx,
  origin: ChatTransportOrigin,
  topicId?: number,
): Promise<void> {
  const replyOpts: Record<string, unknown> = { disable_notification: true };
  if (topicId !== undefined && operatingMode === 'group') replyOpts.message_thread_id = topicId;
  try {
    const statusMsg = await ctx.reply('Processing...', replyOpts);
    statusMessages.set(statusKey(origin), {
      messageId: statusMsg.message_id,
      chatId: origin.chatId,
      threadId: topicId,
      lastEditAt: 0,
    });
  } catch (error) {
    logger.warn(`Telegram processing acknowledgement failed: ${sanitizeTelegramError(error)}`);
  }
}

async function prepareIncomingDispatch(
  ctx: TextMessageCtx,
  params: {
    origin: ChatTransportOrigin;
    projectId: string;
    sessionId?: string;
    topicId?: number;
  },
): Promise<string> {
  try {
    await recordProcessingStatus(ctx, params.origin, params.topicId);
    return registerIncoming(params.origin, params.projectId, params.sessionId);
  } catch (error) {
    releaseIncomingReservation(params.origin);
    throw error;
  }
}

function formatProjectChoices(): string {
  const registry = serviceConfig.projectRegistry as
    | {
        listProjects(): Array<{
          id: string;
          name: string;
          isMeta?: boolean;
          metadata?: { id?: string; displayName?: string };
        }>;
      }
    | undefined;
  const projects = registry
    ? registry
        .listProjects()
        .filter((project) => !project.isMeta)
        .map((project) => ({
          id: project.metadata?.id ?? project.id,
          name: project.metadata?.displayName ?? project.name,
        }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
        .slice(0, PROJECT_CHOICE_LIMIT)
    : canUseStore()
      ? dbRef.all<{ id: string; name: string }>(
          'SELECT id, name FROM projects WHERE is_meta = 0 AND fs_path IS NOT NULL ORDER BY name, id LIMIT 50',
        )
      : [];
  return projects.length === 0
    ? 'No Raven projects are available.'
    : ['Available Raven projects:', ...projects.map((p) => `• ${p.name} — ${p.id}`)].join('\n');
}

async function handleGroupProjectCommand(
  ctx: TextMessageCtx,
  topicId: number | undefined,
  text: string,
): Promise<boolean> {
  const parsed = parseProjectCommand(text);
  if (!parsed.matched) return false;
  const projectId = parsed.projectId;
  if (!projectId) {
    await replyInThread(ctx, formatProjectChoices(), topicId);
    return true;
  }
  if (!canBindCurrentTopic(topicId)) {
    await ctx.reply('Run /project <project-id> inside the forum topic you want to bind.');
    return true;
  }
  if (isReservedTopic(topicId)) {
    await ctx.reply('General and System are reserved Raven topics and cannot be rebound.', {
      message_thread_id: topicId,
    });
    return true;
  }
  const project = dbRef.get<{ name: string }>(
    'SELECT name FROM projects WHERE id = ? AND is_meta = 0',
    projectId,
  );
  if (!project || !isProjectAvailable(projectId)) {
    await ctx.reply(`Project "${projectId}" is unavailable.\n\n${formatProjectChoices()}`, {
      message_thread_id: topicId,
    });
    return true;
  }
  bindProjectTopic(dbRef, { groupId, topicId, projectId });
  for (const [mappedProjectId, mappedTopicId] of projectTopicMap) {
    if (mappedProjectId === projectId || mappedTopicId === topicId) {
      projectTopicMap.delete(mappedProjectId);
    }
  }
  projectTopicMap.set(projectId, topicId);
  topicConfig.reverseMap[topicId] = project.name;
  saveTelegramConversation(dbRef, { chatId: groupId, topicId, projectId });
  await ctx.reply(`Bound this topic to ${project.name} (${projectId}).`, {
    message_thread_id: topicId,
  });
  return true;
}

function canBindCurrentTopic(topicId: number | undefined): topicId is number {
  return topicId !== undefined && canUseStore();
}

function isReservedTopic(topicId: number): boolean {
  return topicId === topicConfig.generalTopicId || topicId === topicConfig.systemTopicId;
}

function parseProjectCommand(text: string): { matched: boolean; projectId?: string } {
  const match = /^\/project(?:@[a-z0-9_]+)?(?:\s+(.+))?$/i.exec(text.trim());
  if (!match) return { matched: false };
  const projectId = match[1]?.trim();
  return projectId ? { matched: true, projectId } : { matched: true };
}

function isCommandAddressedToAnotherBot(ctx: TextMessageCtx, text: string): boolean {
  const addressed = /^\/(?:project|new|model)@([a-z0-9_]+)(?:\s|$)/i.exec(text.trim());
  if (!addressed) return false;
  const currentUsername = ctx.me?.username;
  return !currentUsername || addressed[1].toLowerCase() !== currentUsername.toLowerCase();
}

interface ModelCommandRoute {
  projectId: string;
  sessionId?: string;
  conversationRevision?: number;
  replyToMessageId?: number;
}

interface TelegramModelDeps {
  catalog: ModelCatalog;
  resolveModel: ConversationModelResolver;
  sessions: SessionManager;
}

function getTelegramModelDeps(): TelegramModelDeps | undefined {
  const catalog = serviceConfig.modelCatalog as ModelCatalog | undefined;
  const resolveModel = serviceConfig.resolveModel as ConversationModelResolver | undefined;
  const sessions = serviceConfig.sessionManager as SessionManager | undefined;
  return catalog && resolveModel && sessions ? { catalog, resolveModel, sessions } : undefined;
}

function sameModelCommandRoute(left: ModelCommandRoute, right: ModelCommandRoute): boolean {
  return (
    left.projectId === right.projectId &&
    left.sessionId === right.sessionId &&
    left.conversationRevision === right.conversationRevision &&
    left.replyToMessageId === right.replyToMessageId
  );
}

interface PreparedModelCommand {
  deps: TelegramModelDeps;
  route: ModelCommandRoute;
  session: ReturnType<SessionManager['getSession']>;
  snapshot: ReturnType<ModelCatalog['getSnapshot']>;
  resolveCurrentRoute: () => ModelCommandRoute | undefined;
}

type ModelMutationCommand = Extract<TelegramModelCommand, { action: 'set' | 'reset' }>;

async function prepareModelCommand(
  ctx: TextMessageCtx,
  params: {
    route: ModelCommandRoute;
    topicId?: number;
    resolveCurrentRoute: () => ModelCommandRoute | undefined;
  },
): Promise<PreparedModelCommand | undefined> {
  const deps = getTelegramModelDeps();
  if (!deps) {
    await replyInThread(
      ctx,
      'Raven model settings are unavailable. Try again after restart.',
      params.topicId,
    );
    return undefined;
  }
  const generation = runtimeGeneration;
  let snapshot = deps.catalog.getSnapshot();
  if (catalogNeedsRefresh(snapshot)) {
    snapshot = await deps.catalog.refresh(telegramAbortController.signal);
  }
  if (!isCurrentModelCommandGeneration(generation)) return undefined;
  const currentRoute = params.resolveCurrentRoute();
  if (modelCommandRouteChanged(params.route, currentRoute)) {
    await replyInThread(
      ctx,
      'The selected Raven conversation changed while model choices were loading. Run /model again.',
      params.topicId,
    );
    return undefined;
  }
  const session = currentRoute?.sessionId
    ? deps.sessions.getSession(currentRoute.sessionId)
    : undefined;
  if (!currentRoute || modelCommandSessionIsUnavailable(currentRoute, session)) {
    await replyInThread(ctx, 'The selected Raven session is no longer available.', params.topicId);
    return undefined;
  }
  return {
    deps,
    route: currentRoute,
    session,
    snapshot,
    resolveCurrentRoute: params.resolveCurrentRoute,
  };
}

function catalogNeedsRefresh(snapshot: ReturnType<ModelCatalog['getSnapshot']>): boolean {
  return snapshot.stale || snapshot.models.length === 0;
}

function modelCommandRouteChanged(
  expected: ModelCommandRoute,
  current: ModelCommandRoute | undefined,
): boolean {
  return !current || !sameModelCommandRoute(expected, current);
}

function modelCommandSessionIsUnavailable(
  route: ModelCommandRoute,
  session: ReturnType<SessionManager['getSession']>,
): boolean {
  return Boolean(route.sessionId && session?.projectId !== route.projectId);
}

function isCurrentModelCommandGeneration(generation: number): boolean {
  return (
    acceptingSends && !telegramAbortController.signal.aborted && generation === runtimeGeneration
  );
}

async function showTelegramModelStatus(
  ctx: TextMessageCtx,
  prepared: PreparedModelCommand,
  topicId?: number,
): Promise<void> {
  try {
    const effective = prepared.deps.resolveModel({
      projectId: prepared.route.projectId,
      sessionId: prepared.route.sessionId,
    });
    await replyInThread(
      ctx,
      formatTelegramModelStatus({
        sessionId: prepared.route.sessionId,
        effective,
        snapshot: prepared.snapshot,
      }),
      topicId,
    );
  } catch (error) {
    const status = formatTelegramModelStatus({
      sessionId: prepared.route.sessionId,
      snapshot: prepared.snapshot,
    });
    await replyInThread(
      ctx,
      `Current model settings are unavailable: ${sanitizeTelegramError(error)}\n\n${status}`,
      topicId,
    );
  }
}

async function updateTelegramSessionModel(
  ctx: TextMessageCtx,
  command: ModelMutationCommand,
  params: { prepared: PreparedModelCommand; topicId?: number },
): Promise<void> {
  const { prepared, topicId } = params;
  const target = currentModelMutationTarget(prepared);
  if (!target.ok) {
    await replyInThread(ctx, target.error, topicId);
    return;
  }
  const { sessionId } = target;
  const modelConfig = command.action === 'reset' ? null : command.config;
  let effective: ReturnType<ConversationModelResolver>;
  try {
    effective = prepared.deps.resolveModel({
      projectId: prepared.route.projectId,
      sessionId,
      session: modelConfig,
    });
  } catch (error) {
    await replyInThread(ctx, `Model setting rejected: ${sanitizeTelegramError(error)}`, topicId);
    return;
  }
  prepared.deps.sessions.updateSession(sessionId, { modelConfig });
  const result =
    command.action === 'reset'
      ? 'Session model override cleared.'
      : 'Session model updated for future turns.';
  await replyInThread(
    ctx,
    `${result}\n\n${formatTelegramModelStatus({ sessionId, effective, snapshot: prepared.snapshot })}`,
    topicId,
  );
}

function currentModelMutationTarget(
  prepared: PreparedModelCommand,
): { ok: true; sessionId: string } | { ok: false; error: string } {
  const sessionId = prepared.route.sessionId;
  if (!prepared.session || !sessionId) {
    return {
      ok: false,
      error:
        'No Raven session is selected. Send a message or use /new before setting a session model.',
    };
  }
  const currentRoute = prepared.resolveCurrentRoute();
  const currentSession = currentRoute?.sessionId
    ? prepared.deps.sessions.getSession(currentRoute.sessionId)
    : undefined;
  if (
    modelCommandRouteChanged(prepared.route, currentRoute) ||
    !currentRoute ||
    modelCommandSessionIsUnavailable(currentRoute, currentSession)
  ) {
    return { ok: false, error: 'The selected Raven conversation changed. Run /model again.' };
  }
  return { ok: true, sessionId };
}

async function handleModelCommand(
  ctx: TextMessageCtx,
  params: {
    text: string;
    route: ModelCommandRoute;
    topicId?: number;
    resolveCurrentRoute: () => ModelCommandRoute | undefined;
  },
): Promise<boolean> {
  const command = parseTelegramModelCommand(params.text);
  if (!command.matched) return false;
  if (command.action === 'invalid') {
    await replyInThread(ctx, command.error, params.topicId);
    return true;
  }
  if (command.action !== 'show' && !params.route.sessionId) {
    await replyInThread(
      ctx,
      'No Raven session is selected. Send a message or use /new before setting a session model.',
      params.topicId,
    );
    return true;
  }
  const prepared = await prepareModelCommand(ctx, params);
  if (!prepared) return true;
  if (command.action === 'show') {
    await showTelegramModelStatus(ctx, prepared, params.topicId);
    return true;
  }
  await updateTelegramSessionModel(ctx, command, { prepared, topicId: params.topicId });
  return true;
}

async function handleNewConversationCommand(
  ctx: TextMessageCtx,
  params: {
    text: string;
    projectId: string;
    targetChatId: string;
    topicId?: number;
    origin: ChatTransportOrigin;
  },
): Promise<boolean> {
  if (!/^\/new(?:@[a-z0-9_]+)?$/i.test(params.text.trim())) return false;
  if (reserveIncoming(params.origin) !== 'reserved') return true;
  try {
    if (!isProjectAvailable(params.projectId)) {
      await ctx.reply('This Raven project is no longer available. Select another with /project.');
      return true;
    }
    const sessionId = createTelegramSession(params.projectId);
    const replyOptions = params.topicId === undefined ? {} : { message_thread_id: params.topicId };
    if (!sessionId) {
      await ctx.reply(
        'Raven session service is unavailable. Try again after restart.',
        replyOptions,
      );
      return true;
    }
    if (canUseStore()) {
      saveTelegramConversation(dbRef, {
        chatId: params.targetChatId,
        topicId: params.topicId,
        projectId: params.projectId,
        sessionId,
      });
      saveTelegramMessageBinding(dbRef, {
        chatId: params.origin.chatId,
        messageId: params.origin.messageId,
        topicId: params.origin.topicId,
        projectId: params.projectId,
        sessionId,
        requestId: `telegram-command:new:${params.origin.chatId}:${String(params.origin.messageId)}`,
        direction: 'incoming',
      });
    }
    await ctx.reply('Started a new Raven conversation for this project.', replyOptions);
    return true;
  } finally {
    releaseIncomingReservation(params.origin);
  }
}

async function rejectUnknownGroupTopic(ctx: TextMessageCtx, topicId?: number): Promise<void> {
  await ctx.reply(
    `This topic is not bound to a Raven project.\n\n${formatProjectChoices()}\n\nRun /project <project-id> here to bind it.`,
    topicId === undefined ? {} : { message_thread_id: topicId },
  );
}

function isAuthorizedGroupTextMessage(ctx: TextMessageCtx): boolean {
  return String(ctx.chat.id) === groupId && String(ctx.from?.id) === chatId;
}

function storedConversationSession(chat: string, topicId?: number): string | undefined {
  if (!canUseStore()) return undefined;
  return getTelegramConversation(dbRef, chat, topicId)?.sessionId;
}

function resolveMediaConversationRoute(
  targetChatId: string,
  topicId: number | undefined,
  replyBinding: { projectId: string; sessionId: string } | undefined,
): { projectId?: string; sessionId?: string } {
  if (replyBinding) return replyBinding;
  if (operatingMode === 'direct') {
    const conversation = getOrCreateDirectConversation();
    return {
      projectId: conversation?.projectId ?? PROJECT_TELEGRAM_DEFAULT,
      sessionId: conversation?.sessionId,
    };
  }
  return {
    projectId: resolveProjectId(topicId),
    sessionId: storedConversationSession(targetChatId, topicId),
  };
}

async function routeAuthorizedGroupTextMessage(ctx: TextMessageCtx): Promise<void> {
  const text = ctx.message.text;
  if (isCommandAddressedToAnotherBot(ctx, text)) return;
  const messageThreadId = ctx.message.message_thread_id;
  const topicName = resolveTopicName(messageThreadId);
  const topicId = messageThreadId;
  if (await handleGroupProjectCommand(ctx, topicId, text)) return;
  const replyToMessageId = ctx.message.reply_to_message?.message_id;
  const origin = createTelegramOrigin({
    topicId,
    messageId: ctx.message.message_id,
    replyToMessageId,
  });
  const route = resolveGroupConversationRoute(topicId, replyToMessageId);
  if (!route) {
    await rejectUnknownGroupTopic(ctx, topicId);
    return;
  }
  if (
    await handleModelCommand(ctx, {
      text,
      route,
      topicId,
      resolveCurrentRoute: () => resolveGroupConversationRoute(topicId, replyToMessageId),
    })
  )
    return;
  if (
    await handleNewConversationCommand(ctx, {
      text,
      projectId: route.projectId,
      targetChatId: groupId,
      topicId,
      origin,
    })
  )
    return;

  await dispatchGroupChat(ctx, {
    origin,
    projectId: route.projectId,
    replyBinding: route.replyBinding,
    topicId,
    topicName,
  });
}

function resolveGroupConversationRoute(
  topicId: number | undefined,
  replyToMessageId: number | undefined,
): (ModelCommandRoute & { replyBinding?: { projectId: string; sessionId: string } }) | undefined {
  const replyBinding = resolveReplyBinding(groupId, topicId, replyToMessageId);
  const projectId = resolveGroupMessageProject(replyBinding, topicId);
  if (!projectId) return undefined;
  const conversation = canUseStore() ? getTelegramConversation(dbRef, groupId, topicId) : undefined;
  return {
    projectId,
    sessionId: replyBinding?.sessionId ?? conversation?.sessionId,
    conversationRevision: conversation?.revision,
    replyToMessageId,
    replyBinding,
  };
}

async function dispatchGroupChat(
  ctx: TextMessageCtx,
  params: {
    origin: ChatTransportOrigin;
    projectId: string;
    replyBinding?: { projectId: string; sessionId: string };
    topicId?: number;
    topicName?: string;
  },
): Promise<void> {
  const { origin, projectId, replyBinding, topicId, topicName } = params;
  const text = ctx.message.text;
  logger.info(
    `Telegram group message [${topicName ?? 'unknown'}]: ${text.slice(0, LOG_MESSAGE_PREVIEW_LENGTH)}`,
  );

  if (!(await admitIncoming(ctx, origin, topicId))) return;
  const sessionId = replyBinding?.sessionId ?? storedConversationSession(groupId, topicId);
  const requestId = await prepareIncomingDispatch(ctx, {
    origin,
    projectId,
    sessionId,
    topicId,
  });
  emitTelegramChat({
    requestId,
    origin,
    projectId,
    sessionId,
    text,
    topicId,
    topicName,
    messageId: ctx.message.message_id,
    replyToMessageId: origin.replyToMessageId,
  });
}

function resolveGroupMessageProject(
  replyBinding: { projectId: string; sessionId: string } | undefined,
  topicId: number | undefined,
): string | undefined {
  return replyBinding ? replyBinding.projectId : resolveProjectId(topicId);
}

async function handleGroupTextMessage(ctx: TextMessageCtx): Promise<void> {
  if (!isAuthorizedGroupTextMessage(ctx)) {
    logger.warn(`Ignoring Telegram group message from unauthorized owner/chat`);
    return;
  }
  await routeAuthorizedGroupTextMessage(ctx);
}

async function handleDirectProjectCommand(ctx: TextMessageCtx, text: string): Promise<boolean> {
  const match = /^\/project(?:@[a-z0-9_]+)?(?:\s+(.+))?$/i.exec(text.trim());
  if (!match) return false;
  const selected = match[1]?.trim();
  if (!selected) {
    await ctx.reply(`${formatProjectChoices()}\n\nUse /project <project-id> to select one.`);
    return true;
  }
  const exists = isProjectAvailable(selected);
  if (!exists) {
    await ctx.reply(`Project "${selected}" is unavailable.`);
    return true;
  }
  if (canUseStore()) saveTelegramConversation(dbRef, { chatId, projectId: selected });
  await ctx.reply(`Selected Raven project: ${selected}`);
  return true;
}

function isAuthorizedDirectTextMessage(ctx: TextMessageCtx): boolean {
  const senderId = ctx.from ? String(ctx.from.id) : undefined;
  return senderId === chatId && String(ctx.chat.id) === chatId;
}

function getOrCreateDirectConversation(): ReturnType<typeof getTelegramConversation> | undefined {
  if (!canUseStore()) return undefined;
  const existing = getTelegramConversation(dbRef, chatId);
  if (existing) return existing;
  const conversation = { chatId, projectId: PROJECT_TELEGRAM_DEFAULT };
  saveTelegramConversation(dbRef, conversation);
  return conversation;
}

function resolveDirectConversationRoute(ctx: TextMessageCtx): {
  projectId: string;
  sessionId?: string;
  conversationRevision?: number;
  replyToMessageId?: number;
} {
  const conversation = getOrCreateDirectConversation();
  const replyToMessageId = ctx.message.reply_to_message?.message_id;
  const replyBinding = resolveReplyBinding(chatId, undefined, replyToMessageId);
  return {
    projectId: replyBinding?.projectId ?? conversation?.projectId ?? PROJECT_TELEGRAM_DEFAULT,
    sessionId: replyBinding?.sessionId ?? conversation?.sessionId,
    conversationRevision: conversation?.revision,
    replyToMessageId,
  };
}

async function routeAuthorizedDirectTextMessage(ctx: TextMessageCtx): Promise<void> {
  const text = ctx.message.text;
  if (isCommandAddressedToAnotherBot(ctx, text)) return;
  logger.info(`Telegram message: ${text.slice(0, LOG_MESSAGE_PREVIEW_LENGTH)}`);

  if (await handleDirectProjectCommand(ctx, text)) return;

  const route = resolveDirectConversationRoute(ctx);
  const origin = createTelegramOrigin({
    messageId: ctx.message.message_id,
    replyToMessageId: route.replyToMessageId,
  });
  if (
    await handleModelCommand(ctx, {
      text,
      route,
      resolveCurrentRoute: () => resolveDirectConversationRoute(ctx),
    })
  )
    return;
  if (
    await handleNewConversationCommand(ctx, {
      text,
      projectId: route.projectId,
      targetChatId: chatId,
      origin,
    })
  )
    return;
  if (!(await admitIncoming(ctx, origin))) return;
  const requestId = await prepareIncomingDispatch(ctx, {
    origin,
    projectId: route.projectId,
    sessionId: route.sessionId,
  });
  emitTelegramChat({
    requestId,
    origin,
    projectId: route.projectId,
    sessionId: route.sessionId,
    text,
    messageId: ctx.message.message_id,
    replyToMessageId: route.replyToMessageId,
  });
}

async function handleDirectTextMessage(ctx: TextMessageCtx): Promise<void> {
  if (!isAuthorizedDirectTextMessage(ctx)) {
    logger.warn(`Ignoring message from unauthorized chat: ${ctx.chat.id}`);
    return;
  }
  await routeAuthorizedDirectTextMessage(ctx);
}

async function handleTextMessage(ctx: TextMessageCtx): Promise<void> {
  if (operatingMode === 'group') {
    await handleGroupTextMessage(ctx);
  } else {
    await handleDirectTextMessage(ctx);
  }
}

// ---------------------------------------------------------------------------
// message:voice / message:video_note handler
// ---------------------------------------------------------------------------

interface VoiceMessageCtx {
  chat: { id: number };
  from?: { id: number };
  message: {
    message_id: number;
    message_thread_id?: number;
    reply_to_message?: { message_id: number };
    voice?: { file_id: string; duration: number; mime_type?: string; file_size?: number };
    video_note?: { file_id: string; duration: number; file_size?: number };
  };
  getFile: () => Promise<{ file_path?: string }>;
  reply: (text: string, options?: Record<string, unknown>) => Promise<{ message_id: number }>;
}

// Shared by voice/media handlers: same-chat check in group mode, sender-id
// (falling back to chat id) check in direct mode.
function isAuthorizedMediaSender(ctx: { chat: { id: number }; from?: { id: number } }): boolean {
  if (operatingMode === 'group') {
    return String(ctx.chat.id) === groupId && String(ctx.from?.id) === chatId;
  }
  return String(ctx.from?.id) === chatId && String(ctx.chat.id) === chatId;
}

// Shared by voice/media handlers to build the message_thread_id reply option.
async function replyInThread(
  ctx: {
    reply: (text: string, options?: Record<string, unknown>) => Promise<{ message_id: number }>;
  },
  text: string,
  messageThreadId: number | undefined,
): Promise<{ message_id: number }> {
  const replyOpts: Record<string, unknown> = {};
  if (messageThreadId !== undefined && operatingMode === 'group') {
    replyOpts.message_thread_id = messageThreadId;
  }
  return ctx.reply(text, replyOpts);
}

function registerProcessingReply(
  origin: ChatTransportOrigin,
  messageId: number,
  threadId: number | undefined,
): void {
  statusMessages.set(statusKey(origin), {
    messageId,
    chatId: origin.chatId,
    threadId,
    lastEditAt: 0,
  });
}

async function acknowledgeProcessing(
  ctx: { reply: VoiceMessageCtx['reply'] },
  params: {
    text: string;
    origin: ChatTransportOrigin;
    messageThreadId: number | undefined;
  },
): Promise<number | undefined> {
  try {
    const reply = await replyInThread(ctx, params.text, params.messageThreadId);
    if (!canDispatchProvider()) return undefined;
    registerProcessingReply(params.origin, reply.message_id, params.messageThreadId);
    return reply.message_id;
  } catch (error) {
    logger.warn(`Telegram processing acknowledgement failed: ${sanitizeTelegramError(error)}`);
    return undefined;
  }
}

function assertActiveInboundWork(): void {
  if (!canDispatchProvider()) throw new Error('Telegram service stopped during inbound work');
}

async function downloadVoiceBase64(ctx: VoiceMessageCtx): Promise<string> {
  const file = await ctx.getFile();
  assertActiveInboundWork();
  if (!file.file_path) throw new Error('Voice file is unavailable');
  const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const response = await fetch(fileUrl, { signal: telegramAbortController.signal });
  assertActiveInboundWork();
  if (!response.ok) {
    throw new Error(`Telegram voice download failed: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  assertActiveInboundWork();
  return buffer.toString('base64');
}

async function downloadAndEmitVoice(
  ctx: VoiceMessageCtx,
  params: {
    duration: number;
    mimeType: string;
    messageThreadId: number | undefined;
    projectId: string;
    sessionId?: string;
    origin: ChatTransportOrigin;
  },
): Promise<void> {
  const { duration, mimeType, messageThreadId, projectId, sessionId, origin } = params;
  const topicName = resolveTopicName(messageThreadId);

  if (messageThreadId !== undefined) {
    projectTopicMap.set(projectId, messageThreadId);
  }

  logger.info(`Voice message received [${topicName ?? 'unknown'}]: ${duration}s`);
  const replyMessageId = await acknowledgeProcessing(ctx, {
    text: 'Transcribing voice message...',
    origin,
    messageThreadId,
  });
  if (!canDispatchProvider()) {
    releaseIncomingReservation(origin);
    return;
  }
  const requestId = registerIncoming(origin, projectId, sessionId);

  try {
    const base64 = await downloadVoiceBase64(ctx);
    assertActiveInboundWork();
    emitVoiceReceived({
      projectId,
      audioData: base64,
      mimeType,
      duration,
      topicId: messageThreadId,
      topicName,
      replyMessageId,
      requestId,
      sessionId,
      transportOrigin: origin,
    });
  } catch (err) {
    logger.error(`Failed to download voice file: ${err}`);
    emitChatRejected(requestId, projectId, 'Failed to process voice message');
  }
}

function emitVoiceReceived(payload: VoiceReceivedEvent['payload']): void {
  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SOURCE_TELEGRAM,
    type: 'voice:received',
    projectId: payload.projectId,
    payload,
  } as VoiceReceivedEvent);
}

function emitChatRejected(requestId: string, projectId: string, error: string): void {
  if (!canDispatchProvider()) return;
  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SOURCE_TELEGRAM,
    type: 'user:chat:rejected',
    projectId,
    payload: { requestId, projectId, error },
  } satisfies UserChatRejectedEvent);
}

async function rejectInvalidVoice(
  ctx: VoiceMessageCtx,
  params: { fields: VoiceFields; projectId?: string; messageThreadId?: number },
): Promise<boolean> {
  const { fields, projectId, messageThreadId } = params;
  if (!fields.fileId) return true;
  if (!projectId) {
    await rejectUnknownMediaTopic(ctx, messageThreadId);
    return true;
  }
  if (fields.fileSize && fields.fileSize > TELEGRAM_FILE_DOWNLOAD_LIMIT_BYTES) {
    await replyInThread(ctx, 'Voice message too large to transcribe', messageThreadId);
    return true;
  }
  return false;
}

interface VoiceFields {
  fileId: string | undefined;
  duration: number;
  mimeType: string;
  fileSize: number | undefined;
}

// voice and video_note are mutually exclusive on a Telegram message, so this
// just picks whichever is present — no cross-fallback ever actually fires.
function extractVoiceFields(ctx: VoiceMessageCtx): VoiceFields {
  const voice = ctx.message.voice;
  if (voice) {
    return {
      fileId: voice.file_id,
      duration: voice.duration,
      mimeType: voice.mime_type ?? 'audio/ogg',
      fileSize: voice.file_size,
    };
  }

  const videoNote = ctx.message.video_note;
  return {
    fileId: videoNote?.file_id,
    duration: videoNote?.duration ?? 0,
    mimeType: 'audio/ogg',
    fileSize: videoNote?.file_size,
  };
}

async function handleVoiceMessage(ctx: VoiceMessageCtx): Promise<void> {
  if (!isAuthorizedMediaSender(ctx)) {
    logger.warn(`Ignoring voice from unauthorized chat: ${ctx.chat.id}`);
    return;
  }

  const { fileId, duration, mimeType, fileSize } = extractVoiceFields(ctx);
  const messageThreadId = ctx.message.message_thread_id;
  const replyBinding = resolveReplyBinding(
    String(ctx.chat.id),
    messageThreadId,
    ctx.message.reply_to_message?.message_id,
  );
  const route = resolveMediaConversationRoute(String(ctx.chat.id), messageThreadId, replyBinding);
  const projectId = route.projectId;

  if (
    await rejectInvalidVoice(ctx, {
      fields: { fileId, duration, mimeType, fileSize },
      projectId,
      messageThreadId,
    })
  )
    return;
  if (!projectId) return;
  const origin = createTelegramOrigin({
    topicId: messageThreadId,
    messageId: ctx.message.message_id,
    replyToMessageId: ctx.message.reply_to_message?.message_id,
  });
  if (!(await admitIncoming(ctx, origin, messageThreadId))) return;
  await downloadAndEmitVoice(ctx, {
    duration,
    mimeType,
    messageThreadId,
    projectId,
    sessionId: route.sessionId,
    origin,
  });
}

// ---------------------------------------------------------------------------
// message:photo / message:document handler
// ---------------------------------------------------------------------------

interface MediaMessageCtx {
  chat: { id: number };
  from?: { id: number };
  message: {
    message_id: number;
    message_thread_id?: number;
    reply_to_message?: { message_id: number };
    photo?: Array<{
      file_id: string;
      file_unique_id: string;
      width: number;
      height: number;
      file_size?: number;
    }>;
    document?: {
      file_id: string;
      file_unique_id: string;
      file_name?: string;
      mime_type?: string;
      file_size?: number;
    };
    caption?: string;
  };
  getFile: () => Promise<{ file_path?: string }>;
  reply: (text: string, options?: Record<string, unknown>) => Promise<{ message_id: number }>;
}

interface MediaFields {
  isPhoto: boolean;
  mediaType: 'photo' | 'document';
  fileId: string | undefined;
  fileSize: number | undefined;
  originalName: string;
  mimeType: string;
}

function extractDocumentFields(ctx: MediaMessageCtx): MediaFields {
  const doc = ctx.message.document;
  if (!doc) {
    return {
      isPhoto: false,
      mediaType: 'document',
      fileId: undefined,
      fileSize: undefined,
      originalName: 'document',
      mimeType: 'application/octet-stream',
    };
  }

  return {
    isPhoto: false,
    mediaType: 'document',
    fileId: doc.file_id,
    fileSize: doc.file_size,
    originalName: doc.file_name ?? 'document',
    mimeType: doc.mime_type ?? 'application/octet-stream',
  };
}

// Resolves the fields shared by photo/document handling. For photos, picks
// the last (highest resolution) element; returns undefined for an empty
// photo array so callers can bail out instead of indexing out of bounds.
function extractMediaFields(ctx: MediaMessageCtx): MediaFields | undefined {
  const photos = ctx.message.photo;
  const isPhoto = !!photos;

  if (isPhoto) {
    if (!photos || photos.length === 0) return undefined;
    const largest = photos[photos.length - 1];
    return {
      isPhoto: true,
      mediaType: 'photo',
      fileId: largest.file_id,
      fileSize: largest.file_size,
      originalName: 'photo.jpg',
      mimeType: 'image/jpeg',
    };
  }

  return extractDocumentFields(ctx);
}

interface MediaDownloadParams {
  mediaType: 'photo' | 'document';
  originalName: string;
  mimeType: string;
  fileSize: number | undefined;
  messageThreadId: number | undefined;
  projectId: string;
  sessionId?: string;
  origin: ChatTransportOrigin;
}

interface SavedMediaFile {
  filePath: string;
  savedFileName: string;
}

function recordMediaReceipt(params: MediaDownloadParams, topicName: string | undefined): void {
  if (params.messageThreadId !== undefined) {
    projectTopicMap.set(params.projectId, params.messageThreadId);
  }
  logger.info(
    `Media ${params.mediaType} received [${topicName ?? 'unknown'}]: ${params.originalName}`,
  );
}

// Downloads the file from Telegram and saves it to data/media/. Sends the
async function fetchAndSaveMediaFile(
  ctx: MediaMessageCtx,
  originalName: string,
): Promise<SavedMediaFile> {
  const file = await ctx.getFile();
  assertActiveInboundWork();
  if (!file.file_path) {
    throw new Error('Media file is unavailable');
  }

  const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const response = await fetch(fileUrl, { signal: telegramAbortController.signal });
  assertActiveInboundWork();
  if (!response.ok) {
    throw new Error(`Telegram file download failed: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  assertActiveInboundWork();

  // Save to data/media/ directory
  const mediaDir = join(runtimeProjectRoot, 'data', 'media');
  await mkdir(mediaDir, { recursive: true });
  assertActiveInboundWork();
  const savedFileName = `${Date.now()}-${sanitizeMediaFileName(originalName)}`;
  const filePath = join(mediaDir, savedFileName);
  await writeFile(filePath, buffer, { signal: telegramAbortController.signal });
  assertActiveInboundWork();

  return { filePath, savedFileName };
}

async function downloadAndEmitMedia(
  ctx: MediaMessageCtx,
  params: MediaDownloadParams,
): Promise<void> {
  const {
    mediaType,
    originalName,
    mimeType,
    fileSize,
    messageThreadId,
    projectId,
    sessionId,
    origin,
  } = params;
  const caption = ctx.message.caption;
  const topicName = resolveTopicName(messageThreadId);
  recordMediaReceipt(params, topicName);
  const replyMessageId = await acknowledgeProcessing(ctx, {
    text: 'Processing media...',
    origin,
    messageThreadId,
  });
  if (!canDispatchProvider()) {
    releaseIncomingReservation(origin);
    return;
  }
  const requestId = registerIncoming(origin, projectId, sessionId);

  try {
    const saved = await fetchAndSaveMediaFile(ctx, originalName);
    assertActiveInboundWork();
    emitMediaReceived({
      projectId,
      mediaType,
      filePath: saved.filePath,
      mimeType,
      fileName: saved.savedFileName,
      fileSize,
      caption,
      topicId: messageThreadId,
      topicName,
      replyMessageId,
      requestId,
      sessionId,
      transportOrigin: origin,
    });
  } catch (err) {
    logger.error(`Failed to download media file: ${err}`);
    emitChatRejected(requestId, projectId, 'Failed to process media');
  }
}

function emitMediaReceived(payload: MediaReceivedEvent['payload']): void {
  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SOURCE_TELEGRAM,
    type: 'media:received',
    projectId: payload.projectId,
    payload,
  } as MediaReceivedEvent);
}

async function rejectInvalidMedia(
  ctx: MediaMessageCtx,
  params: { fields: MediaFields; projectId?: string; messageThreadId?: number },
): Promise<boolean> {
  const { fields, projectId, messageThreadId } = params;
  if (!fields.fileId) return true;
  if (!projectId) {
    await rejectUnknownMediaTopic(ctx, messageThreadId);
    return true;
  }
  if (!fields.isPhoto && !isSupportedDocumentType(fields.mimeType, fields.originalName)) {
    logger.warn(`Unsupported media type received: ${fields.mimeType} (${fields.originalName})`);
    await replyInThread(ctx, "I can't process this file type yet", messageThreadId);
    return true;
  }
  if (fields.fileSize && fields.fileSize > TELEGRAM_FILE_DOWNLOAD_LIMIT_BYTES) {
    await replyInThread(ctx, 'File too large to process', messageThreadId);
    return true;
  }
  return false;
}

async function handleMediaMessage(ctx: MediaMessageCtx): Promise<void> {
  if (!isAuthorizedMediaSender(ctx)) {
    logger.warn(`Ignoring media from unauthorized chat: ${ctx.chat.id}`);
    return;
  }

  const messageThreadId = ctx.message.message_thread_id;
  const replyBinding = resolveInboundReplyBinding(ctx, messageThreadId);
  const route = resolveMediaConversationRoute(String(ctx.chat.id), messageThreadId, replyBinding);
  const projectId = route.projectId;
  const fields = extractMediaFields(ctx);
  if (!fields || (await rejectInvalidMedia(ctx, { fields, projectId, messageThreadId }))) return;
  if (!projectId) return;
  const origin = createTelegramOrigin({
    topicId: messageThreadId,
    messageId: ctx.message.message_id,
    replyToMessageId: ctx.message.reply_to_message?.message_id,
  });
  if (!(await admitIncoming(ctx, origin, messageThreadId))) return;
  const { mediaType, fileSize, originalName, mimeType } = fields;

  await downloadAndEmitMedia(ctx, {
    mediaType,
    originalName,
    mimeType,
    fileSize,
    messageThreadId,
    projectId,
    sessionId: route.sessionId,
    origin,
  });
}

function resolveInboundReplyBinding(
  ctx: { chat: { id: number }; message: { reply_to_message?: { message_id: number } } },
  messageThreadId: number | undefined,
): { projectId: string; sessionId: string } | undefined {
  return resolveReplyBinding(
    String(ctx.chat.id),
    messageThreadId,
    ctx.message.reply_to_message?.message_id,
  );
}

async function rejectUnknownMediaTopic(
  ctx: { reply: VoiceMessageCtx['reply'] },
  topicId: number | undefined,
): Promise<void> {
  await replyInThread(
    ctx,
    `This topic is not bound to a Raven project. ${formatProjectChoices()} Run /project <project-id> here to bind it.`,
    topicId,
  );
}

// ---------------------------------------------------------------------------
// callback_query:data handler
// ---------------------------------------------------------------------------

type CallbackQueryCtx = Filter<Context, 'callback_query:data'>;

// Resolve callback deps lazily from config (injected after boot)
function resolveCallbackDeps(): CallbackDeps | null {
  if (callbackDeps) return callbackDeps;
  if (serviceConfig.pendingApprovals && serviceConfig.agentManager && serviceConfig.auditLog) {
    callbackDeps = {
      eventBus,
      logger,
      pendingApprovals: serviceConfig.pendingApprovals as CallbackDeps['pendingApprovals'],
      agentManager: serviceConfig.agentManager as CallbackDeps['agentManager'],
      auditLog: serviceConfig.auditLog as CallbackDeps['auditLog'],
    };
  }
  return callbackDeps;
}

function isAuthorizedCallbackSender(ctx: CallbackQueryCtx): boolean {
  if (operatingMode === 'group') {
    return isAuthorizedGroupCallback(ctx);
  }

  const senderId = String(ctx.callbackQuery.from.id);
  const callbackChatId = ctx.callbackQuery.message?.chat?.id;
  const authorized = senderId === chatId && String(callbackChatId) === chatId;
  if (!authorized) logger.warn(`Ignoring callback from unauthorized user: ${senderId}`);
  return authorized;
}

function isAuthorizedGroupCallback(ctx: CallbackQueryCtx): boolean {
  const callbackChatId = ctx.callbackQuery.message?.chat?.id;
  const authorized =
    callbackChatId !== undefined &&
    String(callbackChatId) === groupId &&
    String(ctx.callbackQuery.from.id) === chatId;
  if (!authorized) logger.warn(`Ignoring callback from unauthorized chat: ${callbackChatId}`);
  return authorized;
}

async function updateCallbackKeyboard(
  ctx: CallbackQueryCtx,
  updatedKeyboard: NonNullable<CallbackResult['updatedKeyboard']>,
): Promise<void> {
  if (!ctx.callbackQuery.message) return;
  try {
    const targetChat = operatingMode === 'group' ? groupId : chatId;
    await ctx.api.editMessageReplyMarkup(targetChat, ctx.callbackQuery.message.message_id, {
      reply_markup: { inline_keyboard: updatedKeyboard },
    });
  } catch (editErr) {
    logger.warn(`Failed to edit message keyboard: ${editErr}`);
  }
}

async function respondToParsedCallback(
  ctx: CallbackQueryCtx,
  parsed: CallbackAction,
  deps: CallbackDeps,
): Promise<void> {
  const result = handleCallback(parsed, deps);

  // For details action, use brief acknowledgment (full text sent as reply below)
  const answerText =
    parsed.domain === 'approval' && parsed.action === 'details'
      ? 'Loading details...'
      : result.message;
  await ctx.answerCallbackQuery({ text: answerText });

  // Edit message keyboard on success
  if (result.updatedKeyboard && ctx.callbackQuery.message) {
    await updateCallbackKeyboard(ctx, result.updatedKeyboard);
  }

  // For approval details, send as a reply message instead of editing
  if (parsed.domain === 'approval' && parsed.action === 'details' && result.success) {
    const threadId = ctx.callbackQuery.message?.message_thread_id;
    await sendMessageWithFallback(result.message, { messageThreadId: threadId });
  }
}

async function processCallbackQuery(ctx: CallbackQueryCtx, data: string): Promise<void> {
  const parsed = parseCallbackData(data);
  const deps = resolveCallbackDeps();

  if (parsed && deps) {
    await respondToParsedCallback(ctx, parsed, deps);
    return;
  }

  if (!parsed) {
    // Unrecognized format: fall back to legacy behavior (emit as user:chat:message)
    eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: SOURCE_TELEGRAM,
      type: 'user:chat:message',
      payload: {
        projectId: PROJECT_TELEGRAM_DEFAULT,
        message: data,
      },
    });
    await ctx.answerCallbackQuery({ text: 'Processing...' });
    return;
  }

  // Parsed but deps not available
  await ctx.answerCallbackQuery({ text: 'System not ready, try again' });
}

async function handleCallbackQuery(ctx: CallbackQueryCtx): Promise<void> {
  // In group mode, verify the callback came from the configured group
  if (!isAuthorizedCallbackSender(ctx)) return;

  const data = ctx.callbackQuery.data;
  logger.info(`Telegram callback: ${data}`);

  try {
    await processCallbackQuery(ctx, data);
  } catch (err) {
    logger.error(`Callback error: ${err}`);
    await ctx.answerCallbackQuery({ text: 'Error processing action' });
  }
}

// ---------------------------------------------------------------------------
// notification:deliver handler
// ---------------------------------------------------------------------------

function configuredDownloadOrigin(): string | undefined {
  if (!Object.hasOwn(serviceConfig, 'RAVEN_BASE_URL')) return process.env.RAVEN_BASE_URL;
  return typeof serviceConfig.RAVEN_BASE_URL === 'string'
    ? serviceConfig.RAVEN_BASE_URL
    : undefined;
}

async function sendNotificationAttachment(
  filePath: string,
  threadId: number | undefined,
  recorder?: SendAttemptRecorder,
): Promise<TelegramSendOutcome> {
  let size: number;
  try {
    if (!existsSync(filePath)) {
      return { outcome: 'failed', error: 'Attachment file is unavailable', attempts: 0 };
    }
    size = statSync(filePath).size;
  } catch (error) {
    return {
      outcome: 'failed',
      error: `Attachment file could not be read: ${sanitizeTelegramError(error)}`,
      attempts: 0,
    };
  }
  if (size > TELEGRAM_FILE_SEND_LIMIT_BYTES) {
    const downloadUrl = notificationFileUrl(
      filePath,
      runtimeProjectRoot,
      configuredDownloadOrigin(),
    );
    return sendMessageWithFallback(
      downloadUrl
        ? `File too large for Telegram. Download: ${downloadUrl}`
        : 'File too large for Telegram. Open its artifact in Raven; a browser download link is not configured.',
      { messageThreadId: threadId },
      recorder,
    );
  }

  return sendTelegramDocument(filePath, threadId, recorder);
}

async function sendTelegramDocument(
  filePath: string,
  threadId: number | undefined,
  recorder?: SendAttemptRecorder,
): Promise<TelegramSendOutcome> {
  if (!bot) return { outcome: 'failed', error: 'Telegram bot is not running', attempts: 0 };
  if (!canDispatchProvider()) {
    return {
      outcome: 'unknown',
      error: 'Telegram service stopped before provider dispatch',
      attempts: 0,
    };
  }
  const currentBot = bot;
  const attemptId = recorder?.begin();
  try {
    const targetChatId = documentTargetChatId();
    const options = documentSendOptions(threadId);
    const sent = await currentBot.api.sendDocument(
      targetChatId,
      new InputFile(filePath),
      options,
      telegramRequestSignal(),
    );
    const outcome = {
      outcome: 'accepted' as const,
      providerMessageId: telegramProviderMessageId(sent.message_id),
      attempts: 1,
    };
    recordAttemptResult(recorder, attemptId, outcome);
    return outcome;
  } catch (err) {
    const outcome = classifySendError(err);
    const error = sanitizeTelegramError(err);
    recordAttemptResult(recorder, attemptId, { outcome, error });
    logger.error(`Telegram attachment ${outcome}: ${error}`);
    return { outcome, error, attempts: 1 };
  }
}

function documentTargetChatId(): string {
  return operatingMode === 'group' ? groupId : chatId;
}

function documentSendOptions(threadId: number | undefined): Record<string, number> {
  if (threadId === undefined || operatingMode !== 'group') return {};
  return { message_thread_id: threadId };
}

function telegramProviderMessageId(messageId: number | undefined): string | undefined {
  return messageId === undefined ? undefined : String(messageId);
}

function createAttemptRecorder(params: {
  queueId?: string;
  claimId?: string;
  part: 'text' | 'attachment';
  threadId?: number;
}): SendAttemptRecorder | undefined {
  if (!params.queueId || !params.claimId || !canUseStore()) return undefined;
  const { queueId, claimId, part, threadId } = params;
  return {
    begin: () => {
      if (!canDispatchProvider())
        throw new Error('Telegram service stopped before delivery attempt');
      return beginDeliveryAttempt(dbRef, {
        notificationId: queueId,
        claimId,
        channel: 'telegram',
        part,
        chatId: operatingMode === 'group' ? groupId : chatId,
        topicId: threadId,
      }).id;
    },
    finish: (id, result) => {
      if (canRecordOwnedOutcome()) finishDeliveryAttempt(dbRef, id, result);
    },
  };
}

type ResolvedNotificationThread = {
  threadId?: number;
  error?: string;
};

function resolvedThread(threadId: number | undefined, error: string): ResolvedNotificationThread {
  return threadId === undefined ? { error } : { threadId };
}

function resolveGlobalNotificationThread(topic: 'general' | 'system'): ResolvedNotificationThread {
  const threadId = topic === 'system' ? topicConfig.systemTopicId : topicConfig.generalTopicId;
  return resolvedThread(threadId, `Telegram ${topic} topic is not configured`);
}

function resolveProjectNotificationThread(projectId: string): ResolvedNotificationThread {
  if (projectId === PROJECT_TELEGRAM_DEFAULT) {
    return resolveGlobalNotificationThread('general');
  }
  if (projectId === META_PROJECT_ID) return resolveGlobalNotificationThread('system');
  const threadId = canUseStore()
    ? getStoredTopic(dbRef, { projectId, groupId })
    : projectTopicMap.get(projectId);
  return resolvedThread(threadId, `No Telegram topic is bound to project ${projectId}`);
}

function resolveNotificationThreadId(
  notifEvent: NotificationDeliverEvent,
): ResolvedNotificationThread {
  const origin = notifEvent.payload.transportOrigin;
  if (origin) return resolveOriginNotificationThread(notifEvent, origin);
  if (operatingMode !== 'group') return {};
  const destination = notifEvent.payload.destination;
  if (destination?.kind === 'global') return resolveGlobalNotificationThread(destination.topic);
  if (destination?.kind === 'project')
    return resolveProjectNotificationThread(destination.projectId);
  return { error: 'Telegram delivery requires an explicit project or global destination' };
}

function resolveOriginNotificationThread(
  event: NotificationDeliverEvent,
  origin: ChatTransportOrigin,
): ResolvedNotificationThread {
  const configuredChat = operatingMode === 'group' ? groupId : chatId;
  if (origin.transport !== 'telegram' || origin.chatId !== configuredChat) {
    return { error: 'Telegram reply address does not match the configured chat' };
  }
  const destination = event.payload.destination;
  if (
    operatingMode === 'group' &&
    destination?.kind === 'project' &&
    resolveProjectId(origin.topicId) !== destination.projectId
  ) {
    return { error: 'Telegram reply topic is no longer bound to the destination project' };
  }
  return { threadId: origin.topicId };
}

function recordNotificationOutcome(
  queueId: string | undefined,
  result: { outcome: 'delivered' | 'failed' | 'unknown' | 'partial'; error?: string },
): void {
  if (!queueId || !canUseStore() || !canRecordOwnedOutcome()) return;
  markDeliveryOutcome(dbRef, { id: queueId, ...result });
}

async function deliverNotificationAttachmentPart(params: {
  filePath?: string;
  queueId?: string;
  claimId?: string;
  threadId?: number;
}): Promise<boolean> {
  if (!params.filePath) return true;
  const outcome = await sendNotificationAttachment(
    params.filePath,
    params.threadId,
    createAttemptRecorder({ ...params, part: 'attachment' }),
  );
  if (outcome.outcome === 'accepted') return true;
  recordNotificationOutcome(params.queueId, { outcome: 'partial', error: outcome.error });
  return false;
}

async function deliverTelegramNotification(params: {
  notifEvent: NotificationDeliverEvent;
  claimId?: string;
  threadId?: number;
  keyboard?: InlineKeyboard;
}): Promise<void> {
  const { notifEvent, claimId, threadId, keyboard } = params;
  const { title, body, filePath, queueId } = notifEvent.payload;
  const text = `*${escapeMarkdown(title)}*\n\n${escapeMarkdown(body)}`;
  const textOutcome = await sendMessageWithFallback(
    text,
    {
      parseMode: 'MarkdownV2',
      messageThreadId: threadId,
      replyMarkup: keyboard,
      replyToMessageId: notifEvent.payload.transportOrigin?.messageId,
    },
    createAttemptRecorder({ queueId, claimId, part: 'text', threadId }),
  );

  // Stop may close provider admission after the queue claim but before an
  // attempt is recorded. Leave that safely unattempted row for startup
  // recovery instead of converting it to an uncertain attempted delivery.
  if (textOutcome.attempts === 0) return;

  const origin = notifEvent.payload.transportOrigin;
  if (origin) await clearProcessingStatus(origin);

  if (textOutcome.outcome !== 'accepted') {
    recordNotificationOutcome(queueId, {
      outcome: textOutcome.outcome,
      error: textOutcome.error,
    });
    return;
  }
  saveNotificationReplyBinding(notifEvent, textOutcome);
  if (!(await deliverNotificationAttachmentPart({ filePath, queueId, claimId, threadId }))) return;
  recordNotificationOutcome(queueId, { outcome: 'delivered' });
}

function saveNotificationReplyBinding(
  event: NotificationDeliverEvent,
  outcome: TelegramSendOutcome,
): void {
  if (!canRecordOwnedOutcome()) return;
  const origin = event.payload.transportOrigin;
  if (!origin || !outcome.providerMessageId || !event.payload.sessionId) return;
  saveTelegramMessageBinding(dbRef, {
    chatId: origin.chatId,
    messageId: Number(outcome.providerMessageId),
    topicId: origin.topicId,
    projectId:
      event.payload.destination?.kind === 'project'
        ? event.payload.destination.projectId
        : PROJECT_TELEGRAM_DEFAULT,
    sessionId: event.payload.sessionId,
    taskId: event.payload.taskId,
    direction: 'outgoing',
  });
}

function recoverPendingTelegramDeliveries(): void {
  if (!canUseStore()) return;
  for (const item of getPendingTellNowNotifications(dbRef)) {
    handleNotificationDeliver(pendingDeliveryEvent(item));
  }
}

function pendingDeliveryEvent(
  item: ReturnType<typeof getPendingTellNowNotifications>[number],
): NotificationDeliverEvent {
  return {
    id: generateId(),
    timestamp: Date.now(),
    source: SOURCE_TELEGRAM,
    type: 'notification:deliver',
    payload: {
      channel: (item.channel ?? 'telegram') as 'telegram' | 'all',
      title: item.title,
      body: item.body,
      filePath: item.filePath ?? undefined,
      topicName: item.topicName ?? undefined,
      actions: item.actionsJson ? JSON.parse(item.actionsJson) : undefined,
      urgencyTier: item.urgencyTier,
      deliveryMode: item.deliveryMode,
      queueId: item.id,
      destination: destinationFromQueuedNotification(item),
      ...queuedReplyContext(item),
    },
  };
}

function restoreAcceptedTelegramReplyBindings(): void {
  if (!canUseStore()) return;
  for (const reply of getAcceptedTelegramRepliesMissingBinding(dbRef)) {
    saveTelegramMessageBinding(dbRef, {
      chatId: reply.chatId,
      messageId: reply.messageId,
      topicId: reply.topicId ?? undefined,
      projectId: reply.projectId,
      sessionId: reply.sessionId,
      taskId: reply.taskId ?? undefined,
      direction: 'outgoing',
    });
  }
}

function destinationFromQueuedNotification(
  item: ReturnType<typeof getPendingTellNowNotifications>[number],
): NotificationDeliverEvent['payload']['destination'] {
  if (item.destinationKind === 'project' && item.destinationProjectId) {
    return { kind: 'project', projectId: item.destinationProjectId };
  }
  if (item.destinationKind === 'global' && item.destinationTopic) {
    return { kind: 'global', topic: item.destinationTopic };
  }
  return undefined;
}

// Subscribed to notification:deliver events (delivery-scheduler intercepts raw 'notification' first)
function handleNotificationDeliver(event: unknown): void {
  const notifEvent = event as NotificationDeliverEvent;
  const { channel, actions, queueId } = notifEvent.payload;
  if (!isTelegramChannel(channel)) return;
  if (!acceptingSends) return;

  const claim = claimQueuedNotification(queueId);
  if (!claim.allowed) return;

  const address = resolveNotificationThreadId(notifEvent);
  if (address.error) {
    if (queueId && canUseStore()) {
      markDeliveryOutcome(dbRef, { id: queueId, outcome: 'failed', error: address.error });
    }
    logger.error(address.error);
    return;
  }
  const threadId = address.threadId;
  const keyboard = actions?.length ? buildInlineKeyboard(actions) : undefined;

  trackSend(() =>
    deliverTelegramNotification({ notifEvent, claimId: claim.claimId, threadId, keyboard }),
  );
}

function isTelegramChannel(channel: string): boolean {
  return channel === 'telegram' || channel === 'all';
}

function claimQueuedNotification(queueId: string | undefined): {
  allowed: boolean;
  claimId?: string;
} {
  if (!queueId || !canUseStore()) {
    logger.error('Telegram delivery requires a durable notification queue record');
    return { allowed: false };
  }
  const claimId = claimNotificationDelivery(dbRef, queueId);
  return claimId ? { allowed: true, claimId } : { allowed: false };
}

// ---------------------------------------------------------------------------
// Other event-bus handlers
// ---------------------------------------------------------------------------

// Subscribed to system:health:alert — always routes to System topic
function handleSystemHealthAlert(event: unknown): void {
  const e = event as SystemHealthAlertEvent;
  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: 'system-health',
    type: 'notification',
    payload: {
      channel: 'telegram',
      title: `System Alert [${e.payload.severity}]`,
      body: `${e.payload.message}\nSource: ${e.payload.source}`,
      destination: { kind: 'global', topic: 'system' },
      urgencyTier: 'red',
      deliveryMode: 'tell-now',
    },
  });
}

// Subscribed to agent:message for live status updates (tool_use only)
function handleAgentMessage(event: unknown): void {
  const e = event as AgentMessageEvent;
  if (e.payload.messageType !== 'tool_use') return;
  if (!bot) return;
  const origin = e.payload.transportOrigin;
  if (!origin || origin.transport !== 'telegram') return;
  const status = statusMessages.get(statusKey(origin));
  if (!status) return;
  const now = Date.now();
  if (now - status.lastEditAt < STATUS_EDIT_THROTTLE_MS) return;
  const colonIdx = e.payload.content.indexOf(':');
  const toolName = colonIdx > 0 ? e.payload.content.slice(0, colonIdx).trim() : 'Tool';
  const attribution = e.payload.agentName ? `${e.payload.agentName}: ` : '';
  status.lastEditAt = now;
  const currentBot = bot;
  trackSend(async () => {
    await currentBot.api
      .editMessageText(status.chatId, status.messageId, `${attribution}Using ${toolName}...`)
      .catch((err) => {
        logger.warn(`Failed to edit Telegram status for task ${e.payload.taskId}: ${err}`);
      });
  });
}

// Subscribed to agent:task:complete to send results back to Telegram
function resolveTelegramCompletion(e: AgentTaskCompleteEvent):
  | {
      origin: ChatTransportOrigin;
      projectId: string;
      sessionId: string;
      attribution: string;
    }
  | undefined {
  const origin = e.payload.transportOrigin;
  if (!origin || origin.transport !== 'telegram') return;
  const configuredChat = operatingMode === 'group' ? groupId : chatId;
  if (origin.chatId !== configuredChat) return;
  if (!e.projectId || !e.payload.sessionId || !canUseStore()) return;
  return {
    origin,
    projectId: e.projectId,
    sessionId: e.payload.sessionId,
    attribution: e.payload.agentName ?? 'Raven',
  };
}

function createAgentReplyQueue(
  e: AgentTaskCompleteEvent,
  context: NonNullable<ReturnType<typeof resolveTelegramCompletion>>,
): string {
  const queueId = enqueueNotification(dbRef, {
    source: 'telegram-chat-result',
    title: context.attribution,
    body: e.payload.success ? e.payload.result : 'Task failed. Check the dashboard for details.',
    channel: 'telegram',
    destination: { kind: 'project', projectId: context.projectId },
    urgencyTier: 'green',
    deliveryMode: 'tell-now',
    status: 'pending',
    scheduledFor: new Date().toISOString(),
    dedupeKey: `telegram-result:${e.payload.taskId}:${context.origin.chatId}:${context.origin.messageId}`,
    transportOrigin: context.origin,
    sessionId: context.sessionId,
    taskId: e.payload.taskId,
  });
  return queueId;
}

async function clearProcessingStatus(origin: ChatTransportOrigin): Promise<void> {
  const status = statusMessages.get(statusKey(origin));
  if (!status || !bot || !canDispatchProvider()) return;
  await bot.api
    .deleteMessage(status.chatId, status.messageId, telegramRequestSignal())
    .catch((err) => {
      logger.warn(`Failed to delete status message: ${err}`);
    });
  statusMessages.delete(statusKey(origin));
}

function saveAgentReplyBinding(
  e: AgentTaskCompleteEvent,
  context: NonNullable<ReturnType<typeof resolveTelegramCompletion>>,
  outcome: TelegramSendOutcome,
): void {
  if (!canRecordOwnedOutcome() || outcome.outcome !== 'accepted' || !outcome.providerMessageId)
    return;
  saveTelegramMessageBinding(dbRef, {
    chatId: context.origin.chatId,
    messageId: Number(outcome.providerMessageId),
    topicId: context.origin.topicId,
    projectId: context.projectId,
    sessionId: context.sessionId,
    taskId: e.payload.taskId,
    direction: 'outgoing',
  });
}

async function deliverAgentTaskComplete(e: AgentTaskCompleteEvent): Promise<void> {
  if (!canDispatchProvider()) return;
  const context = resolveTelegramCompletion(e);
  if (!context) return;
  const queueId = createAgentReplyQueue(e, context);
  const claimId = claimNotificationDelivery(dbRef, queueId);
  if (!claimId) return;
  if (operatingMode === 'group' && resolveProjectId(context.origin.topicId) !== context.projectId) {
    const error = 'Telegram reply topic is no longer bound to the originating project';
    markDeliveryOutcome(dbRef, { id: queueId, outcome: 'failed', error });
    await clearProcessingStatus(context.origin);
    logger.warn(`${error} (${context.projectId}, ${String(context.origin.topicId)})`);
    return;
  }
  await clearProcessingStatus(context.origin);
  const text = e.payload.success
    ? convertToMarkdownV2(`**${context.attribution}**\n\n${e.payload.result}`)
    : escapeMarkdown('Task failed. Check the dashboard for details.');
  const outcome = await sendMessageWithFallback(
    text,
    {
      parseMode: 'MarkdownV2',
      messageThreadId: context.origin.topicId,
      replyToMessageId: context.origin.messageId,
    },
    createAttemptRecorder({
      queueId,
      claimId,
      part: 'text',
      threadId: context.origin.topicId,
    }),
  );
  if (outcome.attempts === 0) return;
  if (canRecordOwnedOutcome()) {
    markDeliveryOutcome(dbRef, {
      id: queueId,
      outcome: outcome.outcome === 'accepted' ? 'delivered' : outcome.outcome,
      error: outcome.error,
    });
  }
  saveAgentReplyBinding(e, context, outcome);
}

function handleAgentTaskComplete(event: unknown): void {
  const e = event as AgentTaskCompleteEvent;
  trackSend(() => deliverAgentTaskComplete(e));
}

function handleUserChatAccepted(event: unknown): void {
  if (!canUseStore()) return;
  const e = event as UserChatAcceptedEvent;
  const pending = pendingOrigins.get(e.payload.requestId);
  if (!pending) return;
  saveTelegramConversationIfRevision(
    dbRef,
    {
      chatId: pending.origin.chatId,
      topicId: pending.origin.topicId,
      projectId: e.payload.projectId,
      sessionId: e.payload.sessionId,
    },
    pending.conversationRevision,
  );
  saveTelegramMessageBinding(dbRef, {
    chatId: pending.origin.chatId,
    messageId: pending.origin.messageId,
    topicId: pending.origin.topicId,
    projectId: e.payload.projectId,
    sessionId: e.payload.sessionId,
    requestId: e.payload.requestId,
    direction: 'incoming',
  });
  pendingOrigins.delete(e.payload.requestId);
}

function handleUserChatRejected(event: unknown): void {
  const e = event as UserChatRejectedEvent;
  const pending = pendingOrigins.get(e.payload.requestId);
  if (!pending) return;
  const { origin } = pending;
  pendingOrigins.delete(e.payload.requestId);
  if (canUseStore()) {
    deleteTelegramIncomingBinding(dbRef, {
      chatId: origin.chatId,
      messageId: origin.messageId,
      requestId: e.payload.requestId,
    });
  }
  const status = statusMessages.get(statusKey(origin));
  trackSend(async () => {
    if (status && bot) {
      await bot.api.deleteMessage(status.chatId, status.messageId).catch(() => undefined);
      statusMessages.delete(statusKey(origin));
    }
    await sendMessageWithFallback(escapeMarkdown(e.payload.error), {
      parseMode: 'MarkdownV2',
      messageThreadId: origin.topicId,
      replyToMessageId: origin.messageId,
    });
  });
}

// Subscribed to permission:blocked — send Telegram notification with approval buttons
function handlePermissionBlocked(event: unknown): void {
  const e = event as PermissionBlockedEvent;
  const { actionName, skillName, approvalId } = e.payload;

  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SOURCE_TELEGRAM,
    type: 'notification',
    payload: {
      channel: 'telegram' as const,
      title: 'Approval Required',
      body: `Action "${actionName}" from skill "${skillName}" requires approval.`,
      topicName: 'System',
      destination: { kind: 'global' as const, topic: 'system' as const },
      urgencyTier: 'red' as const,
      deliveryMode: 'tell-now' as const,
      actions: [
        { label: 'Approve', action: `a:y:${approvalId}` },
        { label: 'Deny', action: `a:n:${approvalId}` },
        { label: 'View Details', action: `a:v:${approvalId}` },
      ],
    },
  });
}

function handleProjectCreated(event: unknown): void {
  const e = event as { payload: { projectId: string; projectName: string } };
  trackSend(async () => {
    await ensureProjectTopic(e.payload.projectId, e.payload.projectName).catch((err: unknown) => {
      logger.warn(`Failed to create topic for project "${e.payload.projectName}": ${err}`);
    });
  });
}

function handleProjectDeleted(event: unknown): void {
  const e = event as { payload: { projectId: string } };
  trackSend(async () => {
    await closeProjectTopic(e.payload.projectId).catch((err: unknown) => {
      logger.warn(`Failed to close topic for deleted project "${e.payload.projectId}": ${err}`);
    });
  });
}

// ---------------------------------------------------------------------------
// start() setup helpers
// ---------------------------------------------------------------------------

function initializeOperatingMode(configGroupId: string | undefined): void {
  if (configGroupId) {
    operatingMode = 'group';
    groupId = configGroupId;
    topicConfig = parseTopicConfig();
    logger.info(
      `Telegram bot in group mode (group: ${groupId}, topics: ${Object.keys(topicConfig.topicMap).length})`,
    );
  } else {
    operatingMode = 'direct';
    topicConfig = { topicMap: {}, reverseMap: {}, topicToProject: {} };
    logger.info('Telegram bot in direct mode');
  }
}

async function verifyGroupMembership(): Promise<void> {
  if (operatingMode !== 'group' || !bot) return;
  try {
    await bot.api.getChat(groupId);
    logger.info('Bot verified as member of configured group');
  } catch (err) {
    logger.error(`Bot may not be a member of group ${groupId}: ${err}`);
  }
}

// Restore stable project identities before accepting group traffic.
function bootstrapGroupModeTopics(context: ServiceContext): void {
  if (operatingMode !== 'group') return;
  if (canUseStore()) {
    for (const stored of listStoredProjectTopics(dbRef, groupId)) {
      projectTopicMap.set(stored.projectId, stored.topicId);
      const project = dbRef.get<{ name: string }>(
        'SELECT name FROM projects WHERE id = ?',
        stored.projectId,
      );
      if (project) topicConfig.reverseMap[stored.topicId] = project.name;
    }
  }
  context.eventBus.on('project:created', handleProjectCreated);
  context.eventBus.on('project:deleted', handleProjectDeleted);
}

function registerTelegramHandlers(context: ServiceContext, currentBot: Bot): void {
  currentBot.on('message:text', async (ctx) => {
    await runOwnedWork(() => handleTextMessage(ctx));
  });
  currentBot.on('message:voice', async (ctx) => {
    await runOwnedWork(() => handleVoiceMessage(ctx as unknown as VoiceMessageCtx));
  });
  currentBot.on('message:video_note', async (ctx) => {
    await runOwnedWork(() => handleVoiceMessage(ctx as unknown as VoiceMessageCtx));
  });
  currentBot.on('message:photo', async (ctx) => {
    await runOwnedWork(() => handleMediaMessage(ctx as unknown as MediaMessageCtx));
  });
  currentBot.on('message:document', async (ctx) => {
    await runOwnedWork(() => handleMediaMessage(ctx as unknown as MediaMessageCtx));
  });
  currentBot.on('callback_query:data', async (ctx) => {
    await runOwnedWork(() => handleCallbackQuery(ctx));
  });
  context.eventBus.on('notification:deliver', handleNotificationDeliver);
  context.eventBus.on('system:health:alert', handleSystemHealthAlert);
  context.eventBus.on('agent:message', handleAgentMessage);
  context.eventBus.on('agent:task:complete', handleAgentTaskComplete);
  context.eventBus.on('permission:blocked', handlePermissionBlocked);
  context.eventBus.on('user:chat:accepted', handleUserChatAccepted);
  context.eventBus.on('user:chat:rejected', handleUserChatRejected);
}

const service: RavenService = {
  async start(context: ServiceContext): Promise<void> {
    eventBus = context.eventBus;
    logger = context.logger;
    dbRef = context.db;
    serviceConfig = context.config;
    runtimeProjectRoot = context.projectRoot ?? process.cwd();
    callbackDeps = null;
    runtimeGeneration++;
    telegramAbortController = new AbortController();
    acceptingSends = true;
    if (canUseStore()) reconcileInterruptedDeliveries(dbRef);

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const configChatId = process.env.TELEGRAM_CHAT_ID;
    const configGroupId = process.env.TELEGRAM_GROUP_ID;

    if (!token || !configChatId) {
      logger.warn('Telegram credentials not configured, bot disabled');
      return;
    }

    chatId = configChatId;
    initializeOperatingMode(configGroupId);

    bot = new Bot(token);

    registerTelegramHandlers(context, bot);

    // Validate group membership on startup (group mode only)
    await verifyGroupMembership();

    bootstrapGroupModeTopics(context);
    restoreAcceptedTelegramReplyBindings();
    recoverPendingTelegramDeliveries();

    bot.catch((err) => {
      logger.error(`Grammy unhandled error: ${err.error ?? err.message ?? err}`);
    });

    bot
      .start({
        onStart: () => {
          logger.info('Telegram bot started');
        },
      })
      .catch((err: unknown) => {
        logger.error(`Telegram bot polling failed: ${err}`);
      });
  },

  async stop(): Promise<void> {
    acceptingSends = false;
    telegramAbortController.abort();
    try {
      if (typeof eventBus?.off === 'function') {
        eventBus.off('notification:deliver', handleNotificationDeliver);
        eventBus.off('system:health:alert', handleSystemHealthAlert);
        eventBus.off('agent:message', handleAgentMessage);
        eventBus.off('agent:task:complete', handleAgentTaskComplete);
        eventBus.off('permission:blocked', handlePermissionBlocked);
        eventBus.off('user:chat:accepted', handleUserChatAccepted);
        eventBus.off('user:chat:rejected', handleUserChatRejected);
        eventBus.off('project:created', handleProjectCreated);
        eventBus.off('project:deleted', handleProjectDeleted);
      }
      if (bot) {
        const currentBot = bot;
        await waitBounded(
          Promise.resolve().then(() => currentBot.stop()),
          'Telegram polling stop',
        );
      }
      await waitBounded(Promise.allSettled([...pendingSends]), 'Telegram owned-work drain');
    } catch (error) {
      logger.warn(`Telegram stop cleanup failed: ${sanitizeTelegramError(error)}`);
    } finally {
      // Invalidate old async-local generations only after the bounded drain so
      // provider outcomes that arrived while stores were alive can be recorded.
      runtimeGeneration++;
      bot = null;
      projectTopicMap.clear();
      projectTopicInflight.clear();
      statusMessages.clear();
      pendingOrigins.clear();
      incomingMessageKeys.clear();
      callbackDeps = null;
      serviceConfig = {};
      logger.info('Telegram bot stopped');
    }
  },
};

// Inflight ensures concurrent calls for the same project return the same create-promise
const projectTopicInflight = new Map<string, Promise<number | undefined>>();

function invalidateTopicByThreadId(threadId: number): void {
  for (const [projectId, id] of projectTopicMap) {
    if (id === threadId) {
      projectTopicMap.delete(projectId);
      if (dbRef) deleteStoredTopic(dbRef, { projectId, groupId });
      logger.warn(`Invalidated stale Telegram topic ${threadId} for project "${projectId}"`);
    }
  }
}

async function createProjectTopic(
  currentBot: Bot,
  projectId: string,
  projectName: string,
): Promise<number | undefined> {
  // Check the persistent store (survives restarts)
  if (dbRef) {
    const storedId = getStoredTopic(dbRef, { projectId, groupId });
    if (storedId !== undefined) {
      projectTopicMap.set(projectId, storedId);
      topicConfig.topicToProject[projectName] = projectId;
      topicConfig.reverseMap[storedId] = projectName;
      return storedId;
    }
  }

  try {
    const result = await currentBot.api.createForumTopic(groupId, projectName);
    projectTopicMap.set(projectId, result.message_thread_id);
    topicConfig.topicToProject[projectName] = projectId;
    topicConfig.reverseMap[result.message_thread_id] = projectName;
    if (dbRef) {
      saveStoredTopic(dbRef, { projectId, groupId }, result.message_thread_id);
    }
    logger.info(
      `Created Telegram topic for project "${projectName}" (thread: ${result.message_thread_id})`,
    );
    return result.message_thread_id;
  } catch (err) {
    logger.warn(`Failed to create Telegram topic for project "${projectName}": ${err}`);
    return undefined;
  }
}

// Project topic thread management — create topics for newly created projects
export async function ensureProjectTopic(
  projectId: string,
  projectName: string,
): Promise<number | undefined> {
  if (operatingMode !== 'group' || !bot) return undefined;

  // Meta-project uses the System topic
  if (projectId === META_PROJECT_ID) return topicConfig.systemTopicId;
  if (projectId === PROJECT_TELEGRAM_DEFAULT) return topicConfig.generalTopicId;

  // Check if already tracked in this process
  const existing = projectTopicMap.get(projectId);
  if (existing !== undefined) return existing;

  // Deduplicate concurrent create attempts for the same project
  const inflight = projectTopicInflight.get(projectId);
  if (inflight !== undefined) return inflight;

  const currentBot = bot;
  const createPromise = createProjectTopic(currentBot, projectId, projectName);

  projectTopicInflight.set(projectId, createPromise);
  createPromise
    .finally(() => {
      projectTopicInflight.delete(projectId);
    })
    .catch(() => {
      // already handled inside createPromise
    });

  return createPromise;
}

export async function closeProjectTopic(projectId: string): Promise<void> {
  if (operatingMode !== 'group' || !bot) return;

  const threadId =
    projectTopicMap.get(projectId) ??
    (dbRef ? getStoredTopic(dbRef, { projectId, groupId }) : undefined);
  if (threadId === undefined) return;

  try {
    await bot.api.closeForumTopic(groupId, threadId);
    projectTopicMap.delete(projectId);
    const projectName = topicConfig.reverseMap[threadId];
    if (projectName !== undefined) {
      Reflect.deleteProperty(topicConfig.topicToProject, projectName);
    }
    Reflect.deleteProperty(topicConfig.reverseMap, threadId);
    if (dbRef) {
      deleteStoredTopic(dbRef, { projectId, groupId });
    }
    logger.info(`Closed Telegram topic for deleted project "${projectId}" (thread: ${threadId})`);
  } catch (err) {
    logger.warn(`Failed to close Telegram topic for project "${projectId}": ${err}`);
  }
}

export default service;
