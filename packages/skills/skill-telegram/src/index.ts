import type {
  RavenSkill,
  SkillManifest,
  SkillContext,
  McpServerConfig,
  SubAgentDefinition,
  AgentTaskPayload,
  NotificationEvent,
} from '@raven/shared';
import { TelegramBot } from './bot.ts';

class TelegramSkill implements RavenSkill {
  manifest: SkillManifest = {
    name: 'telegram',
    displayName: 'Telegram',
    version: '0.1.0',
    description: 'Push notifications and quick commands via Telegram',
    capabilities: ['notification-sink', 'event-source'],
  };

  private context!: SkillContext;
  private bot: TelegramBot | null = null;

  async initialize(context: SkillContext): Promise<void> {
    this.context = context;

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (token && chatId) {
      this.bot = new TelegramBot(token, chatId, context.eventBus, context.logger);

      // Subscribe to notification events
      context.eventBus.on('notification', (event: unknown) => {
        const notifEvent = event as NotificationEvent;
        const { channel, title, body } = notifEvent.payload;
        if (channel === 'telegram' || channel === 'all') {
          const text = `*${escapeMarkdown(title)}*\n\n${escapeMarkdown(body)}`;
          this.bot
            ?.sendMessage(text, 'MarkdownV2')
            .catch((err) => context.logger.error(`Telegram send failed: ${err}`));
        }
      });

      // Subscribe to agent:task:complete to send results back to Telegram
      context.eventBus.on('agent:task:complete', (event: unknown) => {
        const e = event as { payload: { result: string; success: boolean }; source: string };
        // Only send back if the task originated from Telegram
        if (e.source === 'telegram' || e.source === 'orchestrator') {
          const text = e.payload.success
            ? e.payload.result.slice(0, 4000)
            : 'Task failed. Check the dashboard for details.';
          this.bot
            ?.sendMessage(text)
            .catch((err) => context.logger.error(`Telegram send failed: ${err}`));
        }
      });

      this.bot.start().catch((err) => {
        context.logger.error(`Telegram bot failed to start: ${err}`);
      });

      context.logger.info('Telegram bot started');
    } else {
      context.logger.warn('Telegram credentials not configured, bot disabled');
    }

    context.logger.info('Telegram skill initialized');
  }

  async shutdown(): Promise<void> {
    if (this.bot) {
      await this.bot.stop();
    }
  }

  getMcpServers(): Record<string, McpServerConfig> {
    return {};
  }

  getAgentDefinitions(): Record<string, SubAgentDefinition> {
    return {};
  }

  async handleScheduledTask(
    _taskType: string,
    _context: SkillContext,
  ): Promise<AgentTaskPayload | undefined> {
    return undefined;
  }
}

function escapeMarkdown(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

export default function createSkill(): RavenSkill {
  return new TelegramSkill();
}
