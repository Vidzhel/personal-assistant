import type {
  RavenSkill,
  SkillManifest,
  SkillContext,
  McpServerConfig,
  SubAgentDefinition,
  DigestSection,
  AgentTaskPayload,
} from '@raven/shared';

class TickTickSkill implements RavenSkill {
  manifest: SkillManifest = {
    name: 'ticktick',
    displayName: 'TickTick Tasks',
    version: '0.1.0',
    description: 'Task management via TickTick',
    capabilities: ['mcp-server', 'agent-definition', 'data-provider'],
  };

  private context!: SkillContext;

  async initialize(context: SkillContext): Promise<void> {
    this.context = context;
    this.context.logger.info('TickTick skill initialized');
  }

  async shutdown(): Promise<void> {}

  getMcpServers(): Record<string, McpServerConfig> {
    const env: Record<string, string> = {};
    const config = this.context.config as Record<string, string>;

    if (config.clientId || process.env.TICKTICK_CLIENT_ID) {
      env.TICKTICK_CLIENT_ID = config.clientId ?? process.env.TICKTICK_CLIENT_ID ?? '';
      env.TICKTICK_CLIENT_SECRET = config.clientSecret ?? process.env.TICKTICK_CLIENT_SECRET ?? '';
      env.TICKTICK_ACCESS_TOKEN = config.accessToken ?? process.env.TICKTICK_ACCESS_TOKEN ?? '';
    }

    return {
      ticktick: {
        command: 'npx',
        args: ['-y', '@alexarevalo.ai/mcp-server-ticktick'],
        env,
      },
    };
  }

  getAgentDefinitions(): Record<string, SubAgentDefinition> {
    return {
      'ticktick-agent': {
        description:
          'Manages tasks in TickTick. Use this agent for creating, listing, updating, or organizing tasks.',
        prompt:
          'You are a TickTick task management agent within Raven. Use the TickTick MCP tools to manage tasks. Be concise and return structured data.',
        tools: ['mcp__ticktick_ticktick__*', 'Read', 'Grep'],
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
      skillName: 'ticktick',
      title: 'Tasks',
      priority: 1,
      markdownContent: "Use the TickTick agent to fetch today's tasks and overdue items.",
    };
  }
}

export default function createSkill(): RavenSkill {
  return new TickTickSkill();
}
