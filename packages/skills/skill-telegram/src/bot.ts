import { Bot } from 'grammy';
import type { LoggerInterface, EventBusInterface } from '@raven/shared';
import { generateId } from '@raven/shared';

export class TelegramBot {
  private bot: Bot;
  private chatId: string;

  constructor(
    token: string,
    chatId: string,
    private eventBus: EventBusInterface,
    private logger: LoggerInterface,
  ) {
    this.chatId = chatId;
    this.bot = new Bot(token);

    // Handle incoming messages
    this.bot.on('message:text', async (ctx) => {
      const senderId = String(ctx.from?.id);
      // Only process messages from the configured chat
      if (senderId !== this.chatId && String(ctx.chat.id) !== this.chatId) {
        this.logger.warn(`Ignoring message from unauthorized chat: ${ctx.chat.id}`);
        return;
      }

      const text = ctx.message.text;
      this.logger.info(`Telegram message: ${text.slice(0, 100)}`);

      // Emit as a user chat message to the default project
      this.eventBus.emit({
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

    // Handle callback queries (from inline buttons)
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      this.logger.info(`Telegram callback: ${data}`);

      this.eventBus.emit({
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
  }

  async start(): Promise<void> {
    this.bot.start({
      onStart: () => {
        this.logger.info('Telegram bot started');
      },
    });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
    this.logger.info('Telegram bot stopped');
  }

  async sendMessage(text: string, parseMode?: 'MarkdownV2' | 'HTML'): Promise<void> {
    await this.bot.api.sendMessage(this.chatId, text, {
      parse_mode: parseMode,
    });
  }

  async sendMessageWithButtons(
    text: string,
    buttons: Array<{ text: string; callbackData: string }>,
  ): Promise<void> {
    await this.bot.api.sendMessage(this.chatId, text, {
      reply_markup: {
        inline_keyboard: [buttons.map((b) => ({ text: b.text, callback_data: b.callbackData }))],
      },
    });
  }
}
