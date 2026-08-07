import { Bot, InlineKeyboard, InputFile, type Context, type Filter } from 'grammy';
import { existsSync, statSync, readdirSync, type Dirent } from 'node:fs';
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
} from '@raven/shared';
import type { ServiceContext, RavenService } from '../types.ts';
import { markDelivered } from '../../notification-engine/notification-queue.ts';
import { getStoredTopic, saveStoredTopic, deleteStoredTopic } from './topic-store.ts';
import { parseCallbackData, handleCallback } from './callback-handler.ts';
import type { CallbackDeps, CallbackAction, CallbackResult } from './callback-handler.ts';

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
let dbRef: DatabaseInterface | null = null;

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
const STATUS_EDIT_THROTTLE_MS = 2000;

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
  return topicConfig.topicMap[topicName] ?? agentTopicMap.get(topicName);
}

interface SendMessageOptions {
  parseMode?: 'MarkdownV2' | 'HTML';
  messageThreadId?: number;
  replyMarkup?: InlineKeyboard;
}

async function sendMessage(text: string, options: SendMessageOptions = {}): Promise<void> {
  if (!bot) return;
  const { parseMode, messageThreadId, replyMarkup } = options;

  const targetChatId = operatingMode === 'group' ? groupId : chatId;
  const apiOptions: Record<string, unknown> = {};
  if (parseMode) apiOptions.parse_mode = parseMode;
  if (messageThreadId !== undefined && operatingMode === 'group') {
    apiOptions.message_thread_id = messageThreadId;
  }
  if (replyMarkup) apiOptions.reply_markup = replyMarkup;

  await bot.api.sendMessage(targetChatId, text, apiOptions);
}

async function sendMessageWithFallback(
  text: string,
  options: SendMessageOptions = {},
): Promise<void> {
  const { parseMode, messageThreadId, replyMarkup } = options;
  try {
    await sendMessage(text, { parseMode, messageThreadId, replyMarkup });
  } catch (err) {
    if (messageThreadId !== undefined) {
      if (THREAD_NOT_FOUND_RE.test(String(err))) {
        invalidateTopicByThreadId(messageThreadId);
      }
      logger.warn(`Topic send failed (thread ${messageThreadId}), falling back to non-topic send`);
      try {
        await sendMessage(text, { parseMode, replyMarkup });
      } catch (fallbackErr) {
        logger.error(`Telegram fallback send failed: ${fallbackErr}`);
      }
    } else {
      logger.error(`Telegram send failed: ${err}`);
    }
  }
}

function resolveTopicName(messageThreadId: number | undefined): string | undefined {
  if (messageThreadId === undefined) return undefined;
  return topicConfig.reverseMap[messageThreadId];
}

function resolveProjectId(topicName: string | undefined): string {
  // System topic and "Raven System" map to meta-project
  if (topicName === 'System' || topicName === 'Raven System') {
    return META_PROJECT_ID;
  }
  if (topicName && topicConfig.topicToProject[topicName]) {
    return topicConfig.topicToProject[topicName];
  }
  // Messages without a topic association route to meta-project
  if (!topicName) {
    return META_PROJECT_ID;
  }
  return PROJECT_TELEGRAM_DEFAULT;
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

async function handleGroupTextMessage(ctx: TextMessageCtx): Promise<void> {
  if (String(ctx.chat.id) !== groupId) {
    logger.warn(`Ignoring message from unauthorized chat: ${ctx.chat.id}`);
    return;
  }

  const text = ctx.message.text;
  const messageThreadId = ctx.message.message_thread_id;
  const topicName = resolveTopicName(messageThreadId);
  const topicId = messageThreadId;
  const projectId = resolveProjectId(topicName);

  // Track topicId per projectId for response routing
  if (topicId !== undefined) {
    projectTopicMap.set(projectId, topicId);
  }

  logger.info(
    `Telegram group message [${topicName ?? 'unknown'}]: ${text.slice(0, LOG_MESSAGE_PREVIEW_LENGTH)}`,
  );

  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SOURCE_TELEGRAM,
    type: 'user:chat:message',
    payload: {
      projectId,
      message: text,
      topicId,
      topicName,
    },
  });

  const replyThreadId = topicId;
  const replyOpts: Record<string, unknown> = { disable_notification: true };
  if (replyThreadId) replyOpts.message_thread_id = replyThreadId;
  const statusMsg = await ctx.reply('Processing...', replyOpts);
  statusMessages.set(projectId, {
    messageId: statusMsg.message_id,
    chatId: groupId,
    threadId: topicId,
    lastEditAt: 0,
  });
}

async function handleDirectTextMessage(ctx: TextMessageCtx): Promise<void> {
  const senderId = String(ctx.from?.id);
  if (senderId !== chatId && String(ctx.chat.id) !== chatId) {
    logger.warn(`Ignoring message from unauthorized chat: ${ctx.chat.id}`);
    return;
  }

  const text = ctx.message.text;
  logger.info(`Telegram message: ${text.slice(0, LOG_MESSAGE_PREVIEW_LENGTH)}`);

  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SOURCE_TELEGRAM,
    type: 'user:chat:message',
    payload: {
      projectId: PROJECT_TELEGRAM_DEFAULT,
      message: text,
    },
  });

  const statusMsg = await ctx.reply('Processing\\.\\.\\.', { disable_notification: true });
  statusMessages.set(PROJECT_TELEGRAM_DEFAULT, {
    messageId: statusMsg.message_id,
    chatId,
    threadId: undefined,
    lastEditAt: 0,
  });
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
    message_thread_id?: number;
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
    return String(ctx.chat.id) === groupId;
  }
  const senderId = String(ctx.from ? ctx.from.id : ctx.chat.id);
  return senderId === chatId || String(ctx.chat.id) === chatId;
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

async function downloadAndEmitVoice(
  ctx: VoiceMessageCtx,
  params: { duration: number; mimeType: string; messageThreadId: number | undefined },
): Promise<void> {
  const { duration, mimeType, messageThreadId } = params;
  const topicName = resolveTopicName(messageThreadId);
  const projectId = resolveProjectId(topicName);

  if (messageThreadId !== undefined) {
    projectTopicMap.set(projectId, messageThreadId);
  }

  logger.info(`Voice message received [${topicName ?? 'unknown'}]: ${duration}s`);
  const replyMsg = await replyInThread(ctx, 'Transcribing voice message...', messageThreadId);

  try {
    const file = await ctx.getFile();
    if (!file.file_path) {
      logger.error('Voice file has no file_path');
      return;
    }

    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(fileUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    const base64 = buffer.toString('base64');

    // Emit voice:received event
    eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: SOURCE_TELEGRAM,
      type: 'voice:received',
      projectId,
      payload: {
        projectId,
        audioData: base64,
        mimeType,
        duration,
        topicId: messageThreadId,
        topicName,
        replyMessageId: replyMsg.message_id,
      },
    } as VoiceReceivedEvent);
  } catch (err) {
    logger.error(`Failed to download voice file: ${err}`);
    await sendMessageWithFallback('Failed to process voice message', { messageThreadId });
  }
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

  if (!fileId) return;

  // Telegram Bot API limits file downloads to 20MB
  if (fileSize && fileSize > TELEGRAM_FILE_DOWNLOAD_LIMIT_BYTES) {
    await replyInThread(ctx, 'Voice message too large to transcribe', messageThreadId);
    return;
  }

  await downloadAndEmitVoice(ctx, { duration, mimeType, messageThreadId });
}

// ---------------------------------------------------------------------------
// message:photo / message:document handler
// ---------------------------------------------------------------------------

interface MediaMessageCtx {
  chat: { id: number };
  from?: { id: number };
  message: {
    message_thread_id?: number;
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
}

interface SavedMediaFile {
  filePath: string;
  savedFileName: string;
}

// Downloads the file from Telegram and saves it to data/media/. Sends the
// user-facing failure reply itself on the two "no data" failure paths, so
// callers only need to bail out without emitting anything.
async function fetchAndSaveMediaFile(
  ctx: MediaMessageCtx,
  originalName: string,
  messageThreadId: number | undefined,
): Promise<SavedMediaFile | undefined> {
  const file = await ctx.getFile();
  if (!file.file_path) {
    logger.error('Media file has no file_path');
    await sendMessageWithFallback('Failed to process media', { messageThreadId });
    return undefined;
  }

  const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const response = await fetch(fileUrl);
  if (!response.ok) {
    logger.error(`Telegram file download failed: ${response.status} ${response.statusText}`);
    await sendMessageWithFallback('Failed to process media', { messageThreadId });
    return undefined;
  }
  const buffer = Buffer.from(await response.arrayBuffer());

  // Save to data/media/ directory
  const mediaDir = join(process.cwd(), 'data', 'media');
  await mkdir(mediaDir, { recursive: true });
  const savedFileName = `${Date.now()}-${sanitizeMediaFileName(originalName)}`;
  const filePath = join(mediaDir, savedFileName);
  await writeFile(filePath, buffer);

  return { filePath, savedFileName };
}

async function downloadAndEmitMedia(
  ctx: MediaMessageCtx,
  params: MediaDownloadParams,
): Promise<void> {
  const { mediaType, originalName, mimeType, fileSize, messageThreadId } = params;
  const caption = ctx.message.caption;
  const topicName = resolveTopicName(messageThreadId);
  const projectId = resolveProjectId(topicName);

  if (messageThreadId !== undefined) {
    projectTopicMap.set(projectId, messageThreadId);
  }

  logger.info(`Media ${mediaType} received [${topicName ?? 'unknown'}]: ${originalName}`);
  const replyMsg = await replyInThread(ctx, 'Processing media...', messageThreadId);

  try {
    const saved = await fetchAndSaveMediaFile(ctx, originalName, messageThreadId);
    if (!saved) return;

    // Emit media:received event
    eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: SOURCE_TELEGRAM,
      type: 'media:received',
      projectId,
      payload: {
        projectId,
        mediaType,
        filePath: saved.filePath,
        mimeType,
        fileName: saved.savedFileName,
        fileSize,
        caption,
        topicId: messageThreadId,
        topicName,
        replyMessageId: replyMsg.message_id,
      },
    } as MediaReceivedEvent);
  } catch (err) {
    logger.error(`Failed to download media file: ${err}`);
    await sendMessageWithFallback('Failed to process media', { messageThreadId });
  }
}

async function handleMediaMessage(ctx: MediaMessageCtx): Promise<void> {
  if (!isAuthorizedMediaSender(ctx)) {
    logger.warn(`Ignoring media from unauthorized chat: ${ctx.chat.id}`);
    return;
  }

  const messageThreadId = ctx.message.message_thread_id;
  const fields = extractMediaFields(ctx);
  if (!fields || !fields.fileId) return;

  const { isPhoto, mediaType, fileSize, originalName, mimeType } = fields;

  if (!isPhoto && !isSupportedDocumentType(mimeType, originalName)) {
    logger.warn(`Unsupported media type received: ${mimeType} (${originalName})`);
    await replyInThread(ctx, "I can't process this file type yet", messageThreadId);
    return;
  }

  // Enforce 20MB file size limit
  if (fileSize && fileSize > TELEGRAM_FILE_DOWNLOAD_LIMIT_BYTES) {
    await replyInThread(ctx, 'File too large to process', messageThreadId);
    return;
  }

  await downloadAndEmitMedia(ctx, { mediaType, originalName, mimeType, fileSize, messageThreadId });
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
    const callbackChatId = ctx.callbackQuery.message?.chat?.id;
    if (callbackChatId !== undefined && String(callbackChatId) !== groupId) {
      logger.warn(`Ignoring callback from unauthorized chat: ${callbackChatId}`);
      return false;
    }
    return true;
  }

  const senderId = String(ctx.callbackQuery.from.id);
  if (senderId !== chatId) {
    logger.warn(`Ignoring callback from unauthorized user: ${senderId}`);
    return false;
  }
  return true;
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

function buildNotificationThreadId(topicName: string | undefined): number | undefined {
  if (operatingMode !== 'group') return undefined;
  if (topicName) return getTopicThreadId(topicName);
  // Default notifications to General topic
  return topicConfig.generalTopicId;
}

async function sendNotificationAttachment(
  filePath: string,
  threadId: number | undefined,
): Promise<void> {
  if (!existsSync(filePath)) return;

  const stat = statSync(filePath);
  if (stat.size > TELEGRAM_FILE_SEND_LIMIT_BYTES) {
    const relativePath = filePath.replace(/^data\/files\//, '');
    const downloadUrl = `${process.env.RAVEN_BASE_URL ?? 'http://localhost:3001'}/api/files/${relativePath}`;
    await sendMessage(`File too large for Telegram. Download: ${downloadUrl}`, {
      messageThreadId: threadId,
    });
    return;
  }

  if (!bot) return;
  const currentBot = bot;
  try {
    const targetChatId = operatingMode === 'group' ? groupId : chatId;
    await currentBot.api.sendDocument(targetChatId, new InputFile(filePath), {
      ...(threadId !== undefined && operatingMode === 'group'
        ? { message_thread_id: threadId }
        : {}),
    });
  } catch (err) {
    logger.error(`Failed to send document via Telegram: ${err}`);
  }
}

async function deliverTelegramNotification(
  notifEvent: NotificationDeliverEvent,
  threadId: number | undefined,
  keyboard: InlineKeyboard | undefined,
): Promise<void> {
  const { title, body, filePath } = notifEvent.payload;
  const text = `*${escapeMarkdown(title)}*\n\n${escapeMarkdown(body)}`;
  await sendMessageWithFallback(text, {
    parseMode: 'MarkdownV2',
    messageThreadId: threadId,
    replyMarkup: keyboard,
  });

  if (filePath) {
    await sendNotificationAttachment(filePath, threadId);
  }

  // Mark queued notification as delivered if it came from the queue
  const queueId = (notifEvent.payload as Record<string, unknown>).queueId as string | undefined;
  if (queueId && dbRef) {
    markDelivered(dbRef, queueId);
  }
}

// Subscribed to notification:deliver events (delivery-scheduler intercepts raw 'notification' first)
function handleNotificationDeliver(event: unknown): void {
  const notifEvent = event as NotificationDeliverEvent;
  const { channel, topicName, actions } = notifEvent.payload;
  if (channel !== 'telegram' && channel !== 'all') return;

  const threadId = buildNotificationThreadId(topicName);
  const keyboard = actions && actions.length > 0 ? buildInlineKeyboard(actions) : undefined;

  void deliverTelegramNotification(notifEvent, threadId, keyboard).catch(() => {
    // errors already logged above
  });
}

// ---------------------------------------------------------------------------
// Other event-bus handlers
// ---------------------------------------------------------------------------

// Subscribed to system:health:alert — always routes to System topic
function handleSystemHealthAlert(event: unknown): void {
  const e = event as SystemHealthAlertEvent;
  const text = `*System Alert \\[${escapeMarkdown(e.payload.severity)}\\]*\n\n${escapeMarkdown(e.payload.message)}\n_Source: ${escapeMarkdown(e.payload.source)}_`;
  const threadId = operatingMode === 'group' ? topicConfig.systemTopicId : undefined;

  sendMessageWithFallback(text, { parseMode: 'MarkdownV2', messageThreadId: threadId }).catch(
    () => {
      // already logged
    },
  );
}

// Subscribed to agent:message for live status updates (tool_use only)
function handleAgentMessage(event: unknown): void {
  const e = event as AgentMessageEvent;
  if (e.payload.messageType !== 'tool_use') return;
  if (!bot) return;

  // Find which project this task belongs to by checking all status messages
  for (const [projectId, status] of statusMessages) {
    const now = Date.now();
    if (now - status.lastEditAt < STATUS_EDIT_THROTTLE_MS) continue;

    // Extract tool name from content (first colon-delimited segment)
    const colonIdx = e.payload.content.indexOf(':');
    const toolName = colonIdx > 0 ? e.payload.content.slice(0, colonIdx).trim() : 'Tool';
    const statusText = `Using ${toolName}...`;

    status.lastEditAt = now;
    bot.api.editMessageText(status.chatId, status.messageId, statusText).catch((err) => {
      logger.warn(`Failed to edit status message for ${projectId}: ${err}`);
    });
    break;
  }
}

// Subscribed to agent:task:complete to send results back to Telegram
function handleAgentTaskComplete(event: unknown): void {
  const e = event as AgentTaskCompleteEvent;
  if (e.source !== 'telegram' && e.source !== 'orchestrator' && e.source !== 'agent-manager')
    return;

  // Delete status message if one exists
  const projectId = e.projectId;
  if (projectId) {
    const status = statusMessages.get(projectId);
    if (status && bot) {
      bot.api.deleteMessage(status.chatId, status.messageId).catch((err) => {
        logger.warn(`Failed to delete status message: ${err}`);
      });
      statusMessages.delete(projectId);
    }
  }

  const text = e.payload.success
    ? convertToMarkdownV2(e.payload.result)
    : escapeMarkdown('Task failed. Check the dashboard for details.');

  // Route response back to source topic
  const threadId =
    operatingMode === 'group' && projectId ? projectTopicMap.get(projectId) : undefined;

  sendMessageWithFallback(text, { parseMode: 'MarkdownV2', messageThreadId: threadId }).catch(
    () => {
      // already logged
    },
  );
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

function handleAgentConfigCreated(event: unknown): void {
  const e = event as { payload: { name: string } };
  ensureAgentTopic(e.payload.name).catch((err: unknown) => {
    logger.warn(`Failed to create topic for new agent "${e.payload.name}": ${err}`);
  });
}

function handleProjectCreated(event: unknown): void {
  const e = event as { payload: { projectId: string; projectName: string } };
  ensureProjectTopic(e.payload.projectId, e.payload.projectName).catch((err: unknown) => {
    logger.warn(`Failed to create topic for project "${e.payload.projectName}": ${err}`);
  });
}

function handleProjectDeleted(event: unknown): void {
  const e = event as { payload: { projectId: string } };
  closeProjectTopic(e.payload.projectId).catch((err: unknown) => {
    logger.warn(`Failed to close topic for deleted project "${e.payload.projectId}": ${err}`);
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
    logger.info('Telegram bot in direct mode (legacy)');
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

// Bootstrap agent topics from the filesystem and listen for new agent/project creation
function bootstrapGroupModeTopics(context: ServiceContext): void {
  if (operatingMode !== 'group') return;

  const agentNames = listAgentNamesFromFs(context.projectRoot);
  if (agentNames.length > 0) {
    ensureAllAgentTopics(agentNames).catch((err: unknown) => {
      logger.warn(`Failed to bootstrap agent topics: ${err}`);
    });
  }

  context.eventBus.on('agent:config:created', handleAgentConfigCreated);
  context.eventBus.on('project:created', handleProjectCreated);
  context.eventBus.on('project:deleted', handleProjectDeleted);
}

const service: RavenService = {
  async start(context: ServiceContext): Promise<void> {
    eventBus = context.eventBus;
    logger = context.logger;
    dbRef = context.db;
    serviceConfig = context.config;

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

    // Handle incoming messages
    bot.on('message:text', handleTextMessage);

    // Handle voice messages (and video notes) for transcription
    bot.on('message:voice', async (ctx) => {
      await handleVoiceMessage(ctx as unknown as VoiceMessageCtx);
    });
    bot.on('message:video_note', async (ctx) => {
      await handleVoiceMessage(ctx as unknown as VoiceMessageCtx);
    });

    // Handle photo and document messages for media routing
    bot.on('message:photo', async (ctx) => {
      await handleMediaMessage(ctx as unknown as MediaMessageCtx);
    });
    bot.on('message:document', async (ctx) => {
      await handleMediaMessage(ctx as unknown as MediaMessageCtx);
    });

    // Handle callback queries
    bot.on('callback_query:data', handleCallbackQuery);

    context.eventBus.on('notification:deliver', handleNotificationDeliver);
    context.eventBus.on('system:health:alert', handleSystemHealthAlert);
    context.eventBus.on('agent:message', handleAgentMessage);
    context.eventBus.on('agent:task:complete', handleAgentTaskComplete);
    context.eventBus.on('permission:blocked', handlePermissionBlocked);

    // Validate group membership on startup (group mode only)
    await verifyGroupMembership();

    bootstrapGroupModeTopics(context);

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
    if (bot) {
      await bot.stop();
      bot = null;
    }
    projectTopicMap.clear();
    projectTopicInflight.clear();
    agentTopicMap.clear();
    agentTopicInflight.clear();
    logger.info('Telegram bot stopped');
  },
};

// Agent topic thread management — dynamically create and track topics per named agent
const agentTopicMap = new Map<string, number>(); // agentName → threadId

// Inflight ensures concurrent calls for the same agent return the same create-promise
const agentTopicInflight = new Map<string, Promise<number | undefined>>();

// Inflight ensures concurrent calls for the same project return the same create-promise
const projectTopicInflight = new Map<string, Promise<number | undefined>>();

function invalidateTopicByThreadId(threadId: number): void {
  for (const [agentName, id] of agentTopicMap) {
    if (id === threadId) {
      agentTopicMap.delete(agentName);
      if (dbRef) deleteStoredTopic(dbRef, { scope: 'agent', key: agentName, groupId });
      logger.warn(`Invalidated stale Telegram topic ${threadId} for agent "${agentName}"`);
    }
  }
  for (const [projectId, id] of projectTopicMap) {
    if (id === threadId) {
      projectTopicMap.delete(projectId);
      if (dbRef) deleteStoredTopic(dbRef, { scope: 'project', key: projectId, groupId });
      logger.warn(`Invalidated stale Telegram topic ${threadId} for project "${projectId}"`);
    }
  }
}

export async function ensureAgentTopic(agentName: string): Promise<number | undefined> {
  if (operatingMode !== 'group' || !bot) return undefined;

  // Check if already mapped in this process
  const existing = agentTopicMap.get(agentName);
  if (existing !== undefined) return existing;

  // Check if a topic already exists in the static config
  const staticId = topicConfig.topicMap[agentName];
  if (staticId !== undefined) {
    agentTopicMap.set(agentName, staticId);
    return staticId;
  }

  // Deduplicate concurrent create attempts for the same agent
  const inflight = agentTopicInflight.get(agentName);
  if (inflight !== undefined) return inflight;

  const currentBot = bot;
  const createPromise = (async (): Promise<number | undefined> => {
    // Check the persistent store (survives restarts)
    if (dbRef) {
      const storedId = getStoredTopic(dbRef, { scope: 'agent', key: agentName, groupId });
      if (storedId !== undefined) {
        agentTopicMap.set(agentName, storedId);
        return storedId;
      }
    }

    // Create a new forum topic for this agent
    try {
      const displayName = agentName.charAt(0).toUpperCase() + agentName.slice(1);
      const result = await currentBot.api.createForumTopic(groupId, `Agent: ${displayName}`);
      agentTopicMap.set(agentName, result.message_thread_id);
      if (dbRef) {
        saveStoredTopic(
          dbRef,
          { scope: 'agent', key: agentName, groupId },
          result.message_thread_id,
        );
      }
      logger.info(
        `Created Telegram topic for agent "${agentName}" (thread: ${result.message_thread_id})`,
      );
      return result.message_thread_id;
    } catch (err) {
      logger.warn(`Failed to create Telegram topic for agent "${agentName}": ${err}`);
      return undefined;
    }
  })();

  agentTopicInflight.set(agentName, createPromise);
  createPromise
    .finally(() => {
      agentTopicInflight.delete(agentName);
    })
    .catch(() => {
      // already handled inside createPromise
    });

  return createPromise;
}

async function createProjectTopic(
  currentBot: Bot,
  projectId: string,
  projectName: string,
): Promise<number | undefined> {
  // Check the persistent store (survives restarts)
  if (dbRef) {
    const storedId = getStoredTopic(dbRef, { scope: 'project', key: projectId, groupId });
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
      saveStoredTopic(
        dbRef,
        { scope: 'project', key: projectId, groupId },
        result.message_thread_id,
      );
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
    (dbRef ? getStoredTopic(dbRef, { scope: 'project', key: projectId, groupId }) : undefined);
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
      deleteStoredTopic(dbRef, { scope: 'project', key: projectId, groupId });
    }
    logger.info(`Closed Telegram topic for deleted project "${projectId}" (thread: ${threadId})`);
  } catch (err) {
    logger.warn(`Failed to close Telegram topic for project "${projectId}": ${err}`);
  }
}

export function getAgentTopicThreadId(agentName: string): number | undefined {
  return agentTopicMap.get(agentName) ?? topicConfig.topicMap[agentName];
}

// Agent names come from the filesystem (projects/agents/) — the single source
// of truth for agent definitions. Supports both flat <name>.yaml files and
// directory-per-agent <name>/agent.yaml layouts. System agents (_-prefixed)
// never get Telegram topics.
export function listAgentNamesFromFs(projectRoot: string | undefined): string[] {
  if (!projectRoot) return [];
  const agentsDir = join(projectRoot, 'projects', 'agents');
  let entries: Dirent[];
  try {
    entries = readdirSync(agentsDir, { withFileTypes: true }) as Dirent[];
  } catch {
    return [];
  }

  const names: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && /\.ya?ml$/.test(entry.name)) {
      names.push(entry.name.replace(/\.ya?ml$/, ''));
    } else if (entry.isDirectory()) {
      try {
        const inner = readdirSync(join(agentsDir, entry.name)) as string[];
        if (inner.includes('agent.yaml')) names.push(entry.name);
      } catch {
        // unreadable dir — skip
      }
    }
  }
  return names.filter((n) => !n.startsWith('_'));
}

export async function ensureAllAgentTopics(agentNames: string[]): Promise<void> {
  for (const name of agentNames) {
    await ensureAgentTopic(name);
  }
}

export default service;
