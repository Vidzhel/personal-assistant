import { Bot } from 'grammy';
import { z } from 'zod';
import {
  generateId,
  SOURCE_TELEGRAM,
  PROJECT_TELEGRAM_DEFAULT,
  type EventBusInterface,
  type LoggerInterface,
  type NotificationEvent,
  type SystemHealthAlertEvent,
  type AgentTaskCompleteEvent,
} from '@raven/shared';
import type { ServiceContext, SuiteService } from '@raven/core/suite-registry/service-runner.ts';

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

// Track topicId per projectId so responses can route back to source topic
const projectTopicMap = new Map<string, number>();

export function escapeMarkdown(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
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
  return topicConfig.topicMap[topicName];
}

async function sendMessage(
  text: string,
  parseMode?: 'MarkdownV2' | 'HTML',
  messageThreadId?: number,
): Promise<void> {
  if (!bot) return;

  const targetChatId = operatingMode === 'group' ? groupId : chatId;
  const options: Record<string, unknown> = {};
  if (parseMode) options.parse_mode = parseMode;
  if (messageThreadId !== undefined && operatingMode === 'group') {
    options.message_thread_id = messageThreadId;
  }

  await bot.api.sendMessage(targetChatId, text, options);
}

async function sendMessageWithFallback(
  text: string,
  parseMode?: 'MarkdownV2' | 'HTML',
  messageThreadId?: number,
): Promise<void> {
  try {
    await sendMessage(text, parseMode, messageThreadId);
  } catch (err) {
    if (messageThreadId !== undefined) {
      logger.warn(`Topic send failed (thread ${messageThreadId}), falling back to non-topic send`);
      try {
        await sendMessage(text, parseMode);
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
  if (topicName && topicConfig.topicToProject[topicName]) {
    return topicConfig.topicToProject[topicName];
  }
  return PROJECT_TELEGRAM_DEFAULT;
}

const service: SuiteService = {
  async start(context: ServiceContext): Promise<void> {
    eventBus = context.eventBus;
    logger = context.logger;

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
        await ctx.reply('Got it, processing...', replyThreadId ? { message_thread_id: replyThreadId } : {});
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

        await ctx.reply('Got it, processing...');
      }
    });

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
    });

    // Subscribe to notification events
    context.eventBus.on('notification', (event: unknown) => {
      const notifEvent = event as NotificationEvent;
      const { channel, title, body, topicName } = notifEvent.payload;
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

        sendMessageWithFallback(text, 'MarkdownV2', threadId).catch(() => {
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

    // Subscribe to agent:task:complete to send results back to Telegram
    context.eventBus.on('agent:task:complete', (event: unknown) => {
      const e = event as AgentTaskCompleteEvent;
      if (e.source === 'telegram' || e.source === 'orchestrator' || e.source === 'agent-manager') {
        const text = e.payload.success
          ? e.payload.result.slice(0, 4000)
          : 'Task failed. Check the dashboard for details.';

        // Route response back to source topic
        let threadId: number | undefined;
        if (operatingMode === 'group' && e.projectId) {
          threadId = projectTopicMap.get(e.projectId);
        }

        sendMessageWithFallback(text, undefined, threadId).catch(() => {
          // already logged
        });
      }
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

    bot.start({
      onStart: () => {
        logger.info('Telegram bot started');
      },
    });
  },

  async stop(): Promise<void> {
    if (bot) {
      await bot.stop();
      bot = null;
    }
    projectTopicMap.clear();
    logger.info('Telegram bot stopped');
  },
};

export default service;
