import { Bot, InlineKeyboard } from 'grammy';
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
  type NotificationDeliverEvent,
  type SystemHealthAlertEvent,
  type AgentTaskCompleteEvent,
  type AgentMessageEvent,
  type PermissionBlockedEvent,
  type VoiceReceivedEvent,
  type MediaReceivedEvent,
} from '@raven/shared';
import type { ServiceContext, SuiteService } from '@raven/core/suite-registry/service-runner.ts';
import { markDelivered } from '@raven/core/notification-engine/notification-queue.ts';
import {
  parseCallbackData,
  handleCallback,
} from './callback-handler.ts';
import type { CallbackDeps } from './callback-handler.ts';

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
let dbRef: import('@raven/shared').DatabaseInterface | null = null;

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

export function buildInlineKeyboard(
  actions: Array<{ label: string; action: string }>,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  // Detect layout: approval actions get 3 per row, task actions get 2 per row
  const isApproval = actions.some((a) => a.action.startsWith('a:'));
  const perRow = isApproval ? 3 : 2;

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

// Unicode Private Use Area placeholders — Telegram preserves these but never displays them
const PUA_BOLD_START = '\uE000';
const PUA_BOLD_END = '\uE001';
const PUA_ITALIC_START = '\uE002';
const PUA_ITALIC_END = '\uE003';
const PUA_CODE_START = '\uE010';
const PUA_CODE_END = '\uE011';

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
  processed = processed.replace(new RegExp(`${PUA_CODE_START}(\\d+)${PUA_CODE_END}`, 'g'), (_match, idx: string) => {
    return '`' + escapeMarkdown(codeSpans[Number(idx)]) + '`';
  });

  return processed.slice(0, MAX_TELEGRAM_LENGTH);
}

export function parseTopicConfig(): TopicConfig {
  const generalStr = process.env.TELEGRAM_TOPIC_GENERAL;
  const systemStr = process.env.TELEGRAM_TOPIC_SYSTEM;
  const mapStr = process.env.TELEGRAM_TOPIC_MAP;

  const generalTopicId = generalStr ? Number(generalStr) : undefined;
  const systemTopicId = systemStr ? Number(systemStr) : undefined;

  const topicMapSchema = z.record(z.string(), z.number());
  let topicMap: Record<string, number> = {};
  if (mapStr) {
    try {
      const parsed: unknown = JSON.parse(mapStr);
      const result = topicMapSchema.safeParse(parsed);
      if (result.success) {
        topicMap = result.data;
      } else {
        logger?.warn('TELEGRAM_TOPIC_MAP has invalid structure (expected Record<string, number>), ignoring');
      }
    } catch {
      logger?.warn('TELEGRAM_TOPIC_MAP is not valid JSON, ignoring');
    }
  }

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

async function sendMessage(
  text: string,
  parseMode?: 'MarkdownV2' | 'HTML',
  messageThreadId?: number,
  replyMarkup?: InlineKeyboard,
): Promise<void> {
  if (!bot) return;

  const targetChatId = operatingMode === 'group' ? groupId : chatId;
  const options: Record<string, unknown> = {};
  if (parseMode) options.parse_mode = parseMode;
  if (messageThreadId !== undefined && operatingMode === 'group') {
    options.message_thread_id = messageThreadId;
  }
  if (replyMarkup) options.reply_markup = replyMarkup;

  await bot.api.sendMessage(targetChatId, text, options);
}

async function sendMessageWithFallback(
  text: string,
  parseMode?: 'MarkdownV2' | 'HTML',
  messageThreadId?: number,
  replyMarkup?: InlineKeyboard,
): Promise<void> {
  try {
    await sendMessage(text, parseMode, messageThreadId, replyMarkup);
  } catch (err) {
    if (messageThreadId !== undefined) {
      logger.warn(`Topic send failed (thread ${messageThreadId}), falling back to non-topic send`);
      try {
        await sendMessage(text, parseMode, undefined, replyMarkup);
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

const service: SuiteService = {
  async start(context: ServiceContext): Promise<void> {
    eventBus = context.eventBus;
    logger = context.logger;
    dbRef = context.db;

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const configChatId = process.env.TELEGRAM_CHAT_ID;
    const configGroupId = process.env.TELEGRAM_GROUP_ID;

    if (!token || !configChatId) {
      logger.warn('Telegram credentials not configured, bot disabled');
      return;
    }

    chatId = configChatId;

    // Determine operating mode
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

    bot = new Bot(token);

    // Handle incoming messages
    bot.on('message:text', async (ctx) => {
      if (operatingMode === 'group') {
        // Group mode: accept messages from the configured group
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

        logger.info(`Telegram group message [${topicName ?? 'unknown'}]: ${text.slice(0, 100)}`);

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
      } else {
        // Direct mode: legacy behavior
        const senderId = String(ctx.from?.id);
        if (senderId !== chatId && String(ctx.chat.id) !== chatId) {
          logger.warn(`Ignoring message from unauthorized chat: ${ctx.chat.id}`);
          return;
        }

        const text = ctx.message.text;
        logger.info(`Telegram message: ${text.slice(0, 100)}`);

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
    });

    // Handle voice messages (and video notes) for transcription
    const handleVoiceMessage = async (
      ctx: { chat: { id: number }; message: { message_thread_id?: number; voice?: { file_id: string; duration: number; mime_type?: string; file_size?: number }; video_note?: { file_id: string; duration: number; file_size?: number } }; getFile: () => Promise<{ file_path?: string }>; reply: (text: string, options?: Record<string, unknown>) => Promise<{ message_id: number }> },
    ): Promise<void> => {
      // Authorization check (same as text messages)
      if (operatingMode === 'group') {
        if (String(ctx.chat.id) !== groupId) {
          logger.warn(`Ignoring voice from unauthorized chat: ${ctx.chat.id}`);
          return;
        }
      } else {
        const senderId = String((ctx as Record<string, unknown>).from ? ((ctx as Record<string, unknown>).from as { id: number }).id : ctx.chat.id);
        if (senderId !== chatId && String(ctx.chat.id) !== chatId) {
          logger.warn(`Ignoring voice from unauthorized chat: ${ctx.chat.id}`);
          return;
        }
      }

      const voice = ctx.message.voice;
      const videoNote = ctx.message.video_note;
      const fileId = voice?.file_id ?? videoNote?.file_id;
      const duration = voice?.duration ?? videoNote?.duration ?? 0;
      const mimeType = voice?.mime_type ?? 'audio/ogg';
      const fileSize = voice?.file_size ?? videoNote?.file_size;

      if (!fileId) return;

      // Telegram Bot API limits file downloads to 20MB
      const maxFileSize = 20 * 1024 * 1024;
      if (fileSize && fileSize > maxFileSize) {
        const replyOpts: Record<string, unknown> = {};
        const messageThreadId = ctx.message.message_thread_id;
        if (messageThreadId !== undefined && operatingMode === 'group') {
          replyOpts.message_thread_id = messageThreadId;
        }
        await ctx.reply('Voice message too large to transcribe', replyOpts);
        return;
      }

      const messageThreadId = ctx.message.message_thread_id;
      const topicName = resolveTopicName(messageThreadId);
      const projectId = resolveProjectId(topicName);

      if (messageThreadId !== undefined) {
        projectTopicMap.set(projectId, messageThreadId);
      }

      logger.info(`Voice message received [${topicName ?? 'unknown'}]: ${duration}s`);

      // Send "Transcribing..." reply
      const replyOpts: Record<string, unknown> = {};
      if (messageThreadId !== undefined && operatingMode === 'group') {
        replyOpts.message_thread_id = messageThreadId;
      }
      const replyMsg = await ctx.reply('Transcribing voice message...', replyOpts);

      // Download the voice file
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
        await sendMessageWithFallback(
          'Failed to process voice message',
          undefined,
          messageThreadId,
        );
      }
    };

    bot.on('message:voice', async (ctx) => {
      await handleVoiceMessage(ctx as unknown as Parameters<typeof handleVoiceMessage>[0]);
    });

    bot.on('message:video_note', async (ctx) => {
      await handleVoiceMessage(ctx as unknown as Parameters<typeof handleVoiceMessage>[0]);
    });

    // Handle photo and document messages for media routing
    const handleMediaMessage = async (
      ctx: {
        chat: { id: number };
        message: {
          message_thread_id?: number;
          photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }>;
          document?: { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string; file_size?: number };
          caption?: string;
        };
        getFile: () => Promise<{ file_path?: string }>;
        reply: (text: string, options?: Record<string, unknown>) => Promise<{ message_id: number }>;
      },
    ): Promise<void> => {
      // Authorization check (same as voice/text messages)
      if (operatingMode === 'group') {
        if (String(ctx.chat.id) !== groupId) {
          logger.warn(`Ignoring media from unauthorized chat: ${ctx.chat.id}`);
          return;
        }
      } else {
        const senderId = String((ctx as Record<string, unknown>).from ? ((ctx as Record<string, unknown>).from as { id: number }).id : ctx.chat.id);
        if (senderId !== chatId && String(ctx.chat.id) !== chatId) {
          logger.warn(`Ignoring media from unauthorized chat: ${ctx.chat.id}`);
          return;
        }
      }

      const isPhoto = !!ctx.message.photo;
      const mediaType: 'photo' | 'document' = isPhoto ? 'photo' : 'document';

      // For photos: pick the last element (highest resolution)
      const fileId = isPhoto
        ? ctx.message.photo![ctx.message.photo!.length - 1].file_id
        : ctx.message.document?.file_id;
      const fileSize = isPhoto
        ? ctx.message.photo![ctx.message.photo!.length - 1].file_size
        : ctx.message.document?.file_size;
      const originalName = isPhoto ? 'photo.jpg' : (ctx.message.document?.file_name ?? 'document');
      const mimeType = isPhoto ? 'image/jpeg' : (ctx.message.document?.mime_type ?? 'application/octet-stream');
      const caption = ctx.message.caption;

      if (!fileId) return;

      if (!isPhoto && !isSupportedDocumentType(mimeType, originalName)) {
        const replyOpts: Record<string, unknown> = {};
        const messageThreadId = ctx.message.message_thread_id;
        if (messageThreadId !== undefined && operatingMode === 'group') {
          replyOpts.message_thread_id = messageThreadId;
        }
        logger.warn(`Unsupported media type received: ${mimeType} (${originalName})`);
        await ctx.reply("I can't process this file type yet", replyOpts);
        return;
      }

      // Enforce 20MB file size limit
      const maxFileSize = 20 * 1024 * 1024;
      if (fileSize && fileSize > maxFileSize) {
        const replyOpts: Record<string, unknown> = {};
        const messageThreadId = ctx.message.message_thread_id;
        if (messageThreadId !== undefined && operatingMode === 'group') {
          replyOpts.message_thread_id = messageThreadId;
        }
        await ctx.reply('File too large to process', replyOpts);
        return;
      }

      const messageThreadId = ctx.message.message_thread_id;
      const topicName = resolveTopicName(messageThreadId);
      const projectId = resolveProjectId(topicName);

      if (messageThreadId !== undefined) {
        projectTopicMap.set(projectId, messageThreadId);
      }

      logger.info(`Media ${mediaType} received [${topicName ?? 'unknown'}]: ${originalName}`);

      // Send "Processing media..." reply
      const replyOpts: Record<string, unknown> = {};
      if (messageThreadId !== undefined && operatingMode === 'group') {
        replyOpts.message_thread_id = messageThreadId;
      }
      const replyMsg = await ctx.reply('Processing media...', replyOpts);

      // Download the file and save to disk
      try {
        const file = await ctx.getFile();
        if (!file.file_path) {
          logger.error('Media file has no file_path');
          await sendMessageWithFallback('Failed to process media', undefined, messageThreadId);
          return;
        }

        const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        const response = await fetch(fileUrl);
        if (!response.ok) {
          logger.error(`Telegram file download failed: ${response.status} ${response.statusText}`);
          await sendMessageWithFallback('Failed to process media', undefined, messageThreadId);
          return;
        }
        const buffer = Buffer.from(await response.arrayBuffer());

        // Save to data/media/ directory
        const mediaDir = join(process.cwd(), 'data', 'media');
        await mkdir(mediaDir, { recursive: true });
        const savedFileName = `${Date.now()}-${sanitizeMediaFileName(originalName)}`;
        const filePath = join(mediaDir, savedFileName);
        await writeFile(filePath, buffer);

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
            filePath,
            mimeType,
            fileName: savedFileName,
            fileSize,
            caption,
            topicId: messageThreadId,
            topicName,
            replyMessageId: replyMsg.message_id,
          },
        } as MediaReceivedEvent);
      } catch (err) {
        logger.error(`Failed to download media file: ${err}`);
        await sendMessageWithFallback(
          'Failed to process media',
          undefined,
          messageThreadId,
        );
      }
    };

    bot.on('message:photo', async (ctx) => {
      await handleMediaMessage(ctx as unknown as Parameters<typeof handleMediaMessage>[0]);
    });

    bot.on('message:document', async (ctx) => {
      await handleMediaMessage(ctx as unknown as Parameters<typeof handleMediaMessage>[0]);
    });

    // Resolve callback deps lazily from config (injected after boot)
    const resolveCallbackDeps = (): CallbackDeps | null => {
      if (callbackDeps) return callbackDeps;
      const cfg = context.config as Record<string, unknown>;
      if (cfg.pendingApprovals && cfg.agentManager && cfg.auditLog) {
        callbackDeps = {
          eventBus: context.eventBus,
          logger: context.logger,
          pendingApprovals: cfg.pendingApprovals as CallbackDeps['pendingApprovals'],
          agentManager: cfg.agentManager as CallbackDeps['agentManager'],
          auditLog: cfg.auditLog as CallbackDeps['auditLog'],
        };
      }
      return callbackDeps;
    };

    // Handle callback queries
    bot.on('callback_query:data', async (ctx) => {
      // In group mode, verify the callback came from the configured group
      if (operatingMode === 'group') {
        const callbackChatId = ctx.callbackQuery.message?.chat?.id;
        if (callbackChatId !== undefined && String(callbackChatId) !== groupId) {
          logger.warn(`Ignoring callback from unauthorized chat: ${callbackChatId}`);
          return;
        }
      } else {
        const senderId = String(ctx.callbackQuery.from.id);
        if (senderId !== chatId) {
          logger.warn(`Ignoring callback from unauthorized user: ${senderId}`);
          return;
        }
      }

      const data = ctx.callbackQuery.data;
      logger.info(`Telegram callback: ${data}`);

      try {
        const parsed = parseCallbackData(data);
        const deps = resolveCallbackDeps();

        if (parsed && deps) {
          const result = handleCallback(parsed, deps);

          // For details action, use brief acknowledgment (full text sent as reply below)
          const answerText =
            parsed.domain === 'approval' && parsed.action === 'details'
              ? 'Loading details...'
              : result.message;
          await ctx.answerCallbackQuery({ text: answerText });

          // Edit message keyboard on success
          if (result.updatedKeyboard && ctx.callbackQuery.message) {
            try {
              const targetChat = operatingMode === 'group' ? groupId : chatId;
              await ctx.api.editMessageReplyMarkup(
                targetChat,
                ctx.callbackQuery.message.message_id,
                { reply_markup: { inline_keyboard: result.updatedKeyboard } },
              );
            } catch (editErr) {
              logger.warn(`Failed to edit message keyboard: ${editErr}`);
            }
          }

          // For approval details, send as a reply message instead of editing
          if (parsed.domain === 'approval' && parsed.action === 'details' && result.success) {
            const threadId = ctx.callbackQuery.message?.message_thread_id;
            await sendMessageWithFallback(result.message, undefined, threadId);
          }
        } else if (!parsed) {
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
        } else {
          // Parsed but deps not available
          await ctx.answerCallbackQuery({ text: 'System not ready, try again' });
        }
      } catch (err) {
        logger.error(`Callback error: ${err}`);
        await ctx.answerCallbackQuery({ text: 'Error processing action' });
      }
    });

    // Subscribe to notification:deliver events (delivery-scheduler intercepts raw 'notification' first)
    context.eventBus.on('notification:deliver', (event: unknown) => {
      const notifEvent = event as NotificationDeliverEvent;
      const { channel, title, body, topicName, actions } = notifEvent.payload;
      if (channel === 'telegram' || channel === 'all') {
        const text = `*${escapeMarkdown(title)}*\n\n${escapeMarkdown(body)}`;
        let threadId: number | undefined;

        if (operatingMode === 'group') {
          if (topicName) {
            threadId = getTopicThreadId(topicName);
          } else {
            // Default notifications to General topic
            threadId = topicConfig.generalTopicId;
          }
        }

        // Build inline keyboard from actions array
        let keyboard: InlineKeyboard | undefined;
        if (actions && actions.length > 0) {
          keyboard = buildInlineKeyboard(actions);
        }

        sendMessageWithFallback(text, 'MarkdownV2', threadId, keyboard)
          .then(() => {
            // Mark queued notification as delivered if it came from the queue
            const queueId = (notifEvent.payload as Record<string, unknown>).queueId as string | undefined;
            if (queueId && dbRef) {
              markDelivered(dbRef, queueId);
            }
          })
          .catch(() => {
            // already logged in sendMessageWithFallback
          });
      }
    });

    // Subscribe to system:health:alert — always route to System topic
    context.eventBus.on('system:health:alert', (event: unknown) => {
      const e = event as SystemHealthAlertEvent;
      const text = `*System Alert \\[${escapeMarkdown(e.payload.severity)}\\]*\n\n${escapeMarkdown(e.payload.message)}\n_Source: ${escapeMarkdown(e.payload.source)}_`;
      const threadId = operatingMode === 'group' ? topicConfig.systemTopicId : undefined;

      sendMessageWithFallback(text, 'MarkdownV2', threadId).catch(() => {
        // already logged
      });
    });

    // Subscribe to agent:message for live status updates (tool_use only)
    context.eventBus.on('agent:message', (event: unknown) => {
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
    });

    // Subscribe to agent:task:complete to send results back to Telegram
    context.eventBus.on('agent:task:complete', (event: unknown) => {
      const e = event as AgentTaskCompleteEvent;
      if (e.source === 'telegram' || e.source === 'orchestrator' || e.source === 'agent-manager') {
        // Delete status message if one exists
        const projectId = e.projectId;
        const status = projectId ? statusMessages.get(projectId) : undefined;
        if (status && bot) {
          bot.api.deleteMessage(status.chatId, status.messageId).catch((err) => {
            logger.warn(`Failed to delete status message: ${err}`);
          });
          statusMessages.delete(projectId!);
        }

        const text = e.payload.success
          ? convertToMarkdownV2(e.payload.result)
          : escapeMarkdown('Task failed. Check the dashboard for details.');

        // Route response back to source topic
        let threadId: number | undefined;
        if (operatingMode === 'group' && projectId) {
          threadId = projectTopicMap.get(projectId);
        }

        sendMessageWithFallback(text, 'MarkdownV2', threadId).catch(() => {
          // already logged
        });
      }
    });

    // Subscribe to permission:blocked — send Telegram notification with approval buttons
    context.eventBus.on('permission:blocked', (event: unknown) => {
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
    });

    // Validate group membership on startup (group mode only)
    if (operatingMode === 'group') {
      try {
        await bot.api.getChat(groupId);
        logger.info('Bot verified as member of configured group');
      } catch (err) {
        logger.error(`Bot may not be a member of group ${groupId}: ${err}`);
      }
    }

    // Bootstrap agent topics from DB and listen for new agent creation
    if (operatingMode === 'group' && dbRef) {
      try {
        const rows = dbRef.all<{ name: string }>('SELECT name FROM named_agents');
        const agentNames = rows.map((r) => r.name);
        if (agentNames.length > 0) {
          ensureAllAgentTopics(agentNames).catch((err: unknown) => {
            logger.warn(`Failed to bootstrap agent topics: ${err}`);
          });
        }
      } catch (err) {
        logger.warn(`Failed to query named agents for topic bootstrap: ${err}`);
      }

      context.eventBus.on('agent:config:created', (event: unknown) => {
        const e = event as { payload: { name: string } };
        ensureAgentTopic(e.payload.name).catch((err: unknown) => {
          logger.warn(`Failed to create topic for new agent "${e.payload.name}": ${err}`);
        });
      });

      // Listen for project creation events and create Telegram topics for new projects
      context.eventBus.on('project:created', (event: unknown) => {
        const e = event as { payload: { projectId: string; projectName: string } };
        ensureProjectTopic(e.payload.projectId, e.payload.projectName).catch((err: unknown) => {
          logger.warn(`Failed to create topic for project "${e.payload.projectName}": ${err}`);
        });
      });

      // Listen for project deletion events and close the Telegram topic
      context.eventBus.on('project:deleted', (event: unknown) => {
        const e = event as { payload: { projectId: string } };
        closeProjectTopic(e.payload.projectId).catch((err: unknown) => {
          logger.warn(`Failed to close topic for deleted project "${e.payload.projectId}": ${err}`);
        });
      });
    }

    bot.catch((err) => {
      logger.error(`Grammy unhandled error: ${err.error ?? err.message ?? err}`);
    });

    bot.start({
      onStart: () => {
        logger.info('Telegram bot started');
      },
    }).catch((err: unknown) => {
      logger.error(`Telegram bot polling failed: ${err}`);
    });
  },

  async stop(): Promise<void> {
    if (bot) {
      await bot.stop();
      bot = null;
    }
    projectTopicMap.clear();
    agentTopicMap.clear();
    logger.info('Telegram bot stopped');
  },
};

// Agent topic thread management — dynamically create and track topics per named agent
const agentTopicMap = new Map<string, number>(); // agentName → threadId

export async function ensureAgentTopic(agentName: string): Promise<number | undefined> {
  if (operatingMode !== 'group' || !bot) return undefined;

  // Check if already mapped
  const existing = agentTopicMap.get(agentName);
  if (existing !== undefined) return existing;

  // Check if a topic already exists in the static config
  const staticId = topicConfig.topicMap[agentName];
  if (staticId !== undefined) {
    agentTopicMap.set(agentName, staticId);
    return staticId;
  }

  // Create a new forum topic for this agent
  try {
    const displayName = agentName.charAt(0).toUpperCase() + agentName.slice(1);
    const result = await bot.api.createForumTopic(groupId, `Agent: ${displayName}`);
    agentTopicMap.set(agentName, result.message_thread_id);
    logger.info(`Created Telegram topic for agent "${agentName}" (thread: ${result.message_thread_id})`);
    return result.message_thread_id;
  } catch (err) {
    logger.warn(`Failed to create Telegram topic for agent "${agentName}": ${err}`);
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

  // Check if already tracked
  const existing = projectTopicMap.get(projectId);
  if (existing !== undefined) return existing;

  try {
    const result = await bot.api.createForumTopic(groupId, projectName);
    projectTopicMap.set(projectId, result.message_thread_id);
    // Also update topicToProject mapping for incoming message routing
    topicConfig.topicToProject[projectName] = projectId;
    topicConfig.reverseMap[result.message_thread_id] = projectName;
    logger.info(
      `Created Telegram topic for project "${projectName}" (thread: ${result.message_thread_id})`,
    );
    return result.message_thread_id;
  } catch (err) {
    logger.warn(`Failed to create Telegram topic for project "${projectName}": ${err}`);
    return undefined;
  }
}

export async function closeProjectTopic(projectId: string): Promise<void> {
  if (operatingMode !== 'group' || !bot) return;

  const threadId = projectTopicMap.get(projectId);
  if (threadId === undefined) return;

  try {
    await bot.api.closeForumTopic(groupId, threadId);
    projectTopicMap.delete(projectId);
    logger.info(`Closed Telegram topic for deleted project "${projectId}" (thread: ${threadId})`);
  } catch (err) {
    logger.warn(`Failed to close Telegram topic for project "${projectId}": ${err}`);
  }
}

export function getAgentTopicThreadId(agentName: string): number | undefined {
  return agentTopicMap.get(agentName) ?? topicConfig.topicMap[agentName];
}

export async function ensureAllAgentTopics(agentNames: string[]): Promise<void> {
  for (const name of agentNames) {
    await ensureAgentTopic(name);
  }
}

export default service;
