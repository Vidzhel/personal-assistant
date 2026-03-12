import { Bot } from 'grammy';
import { generateId, type EventBusInterface, type LoggerInterface } from '@raven/shared';
import type { ServiceContext, SuiteService } from '@raven/core/suite-registry/service-runner.ts';

let bot: Bot | null = null;
let chatId: string;
let eventBus: EventBusInterface;
let logger: LoggerInterface;

function escapeMarkdown(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

async function sendMessage(text: string, parseMode?: 'MarkdownV2' | 'HTML'): Promise<void> {
  if (!bot) return;
  await bot.api.sendMessage(chatId, text, { parse_mode: parseMode });
}

const service: SuiteService = {
  async start(context: ServiceContext): Promise<void> {
    eventBus = context.eventBus;
    logger = context.logger;

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const configChatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !configChatId) {
      logger.warn('Telegram credentials not configured, bot disabled');
      return;
    }

    chatId = configChatId;
    bot = new Bot(token);

    // Handle incoming messages
    bot.on('message:text', async (ctx) => {
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
        source: 'telegram',
        type: 'user:chat:message',
        payload: {
          projectId: 'telegram-default',
          message: text,
        },
      } as unknown);

      await ctx.reply('Got it, processing...');
    });

    // Handle callback queries
    bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      logger.info(`Telegram callback: ${data}`);

      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: 'telegram',
        type: 'user:chat:message',
        payload: {
          projectId: 'telegram-default',
          message: data,
        },
      } as unknown);

      await ctx.answerCallbackQuery({ text: 'Processing...' });
    });

    // Subscribe to notification events
    context.eventBus.on('notification', (event: unknown) => {
      const notifEvent = event as { payload: { channel: string; title: string; body: string } };
      const { channel, title, body } = notifEvent.payload;
      if (channel === 'telegram' || channel === 'all') {
        const text = `*${escapeMarkdown(title)}*\n\n${escapeMarkdown(body)}`;
        sendMessage(text, 'MarkdownV2').catch((err) =>
          logger.error(`Telegram send failed: ${err}`),
        );
      }
    });

    // Subscribe to agent:task:complete to send results back to Telegram
    context.eventBus.on('agent:task:complete', (event: unknown) => {
      const e = event as { payload: { result: string; success: boolean }; source: string };
      if (e.source === 'telegram' || e.source === 'orchestrator') {
        const text = e.payload.success
          ? e.payload.result.slice(0, 4000)
          : 'Task failed. Check the dashboard for details.';
        sendMessage(text).catch((err) => logger.error(`Telegram send failed: ${err}`));
      }
    });

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
    logger.info('Telegram bot stopped');
  },
};

export default service;
