import type {
  RavenSkill,
  SkillManifest,
  SkillContext,
  McpServerConfig,
  SubAgentDefinition,
  DigestSection,
  AgentTaskPayload,
} from '@raven/shared';
import { ImapWatcher } from './imap-watcher.ts';

class GmailSkill implements RavenSkill {
  manifest: SkillManifest = {
    name: 'gmail',
    displayName: 'Gmail',
    version: '0.1.0',
    description: 'Email monitoring and management via Gmail',
    capabilities: ['mcp-server', 'agent-definition', 'event-source', 'data-provider'],
  };

  private context!: SkillContext;
  private watcher: ImapWatcher | null = null;

  async initialize(context: SkillContext): Promise<void> {
    this.context = context;

    // Start IMAP IDLE watcher if credentials are available
    const user = process.env.GMAIL_IMAP_USER;
    const password = process.env.GMAIL_IMAP_PASSWORD;
    const watchFolders = (context.config as { watchFolders?: string[] }).watchFolders ?? ['INBOX'];

    if (user && password) {
      this.watcher = new ImapWatcher(
        { host: 'imap.gmail.com', port: 993, user, password, watchFolders },
        context.eventBus,
        context.logger,
      );
      this.watcher.start().catch((err) => {
        context.logger.error(`IMAP watcher failed to start: ${err}`);
      });
      context.logger.info(`Gmail IMAP watcher started for ${user}`);
    } else {
      context.logger.warn('Gmail IMAP credentials not configured, watcher disabled');
    }

    context.logger.info('Gmail skill initialized');
  }

  async shutdown(): Promise<void> {
    if (this.watcher) {
      await this.watcher.stop();
    }
  }

  getMcpServers(): Record<string, McpServerConfig> {
    const env: Record<string, string> = {};

    if (process.env.GMAIL_CLIENT_ID) {
      env.GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID;
      env.GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET ?? '';
      env.GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN ?? '';
    }

    return {
      gmail: {
        command: 'npx',
        args: ['-y', '@shinzolabs/gmail-mcp'],
        env,
      },
    };
  }

  getAgentDefinitions(): Record<string, SubAgentDefinition> {
    return {
      'gmail-agent': {
        description:
          'Reads and manages Gmail emails. Use this agent for email summaries, searching emails, and drafting replies.',
        prompt:
          'You are a Gmail agent within Raven. Use the Gmail MCP tools to read, search, and manage emails. Be concise and return structured data.',
        tools: ['mcp__gmail_gmail__*', 'Read', 'Grep'],
      },
    };
  }

  async handleScheduledTask(
    _taskType: string,
    _context: SkillContext,
  ): Promise<AgentTaskPayload | undefined> {
    return undefined;
  }

  async getDataForDigest(): Promise<DigestSection> {
    return {
      skillName: 'gmail',
      title: 'Email',
      priority: 2,
      markdownContent: 'Use the Gmail agent to summarize unread emails.',
    };
  }
}

export default function createSkill(): RavenSkill {
  return new GmailSkill();
}
