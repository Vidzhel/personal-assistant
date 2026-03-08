import type {
  RavenSkill,
  SkillManifest,
  SkillContext,
  McpServerConfig,
  SubAgentDefinition,
  DigestSection,
  AgentTaskPayload,
  SkillAction,
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

  getActions(): SkillAction[] {
    return [
      {
        name: 'ticktick:get-tasks',
        description: 'Retrieve tasks and lists',
        defaultTier: 'green',
        reversible: true,
      },
      {
        name: 'ticktick:get-task-details',
        description: 'Get details of a specific task',
        defaultTier: 'green',
        reversible: true,
      },
      {
        name: 'ticktick:create-task',
        description: 'Create a new task',
        defaultTier: 'yellow',
        reversible: true,
      },
      {
        name: 'ticktick:update-task',
        description: 'Update an existing task',
        defaultTier: 'yellow',
        reversible: true,
      },
      {
        name: 'ticktick:complete-task',
        description: 'Mark a task as complete',
        defaultTier: 'yellow',
        reversible: true,
      },
      {
        name: 'ticktick:delete-task',
        description: 'Permanently delete a task',
        defaultTier: 'red',
        reversible: false,
      },
    ];
  }

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
        command: 'node',
        args: ['--experimental-strip-types', 'packages/mcp-ticktick/src/index.ts'],
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
          'You are a TickTick task management agent within Raven. Use the TickTick MCP tools to manage tasks.\n\n' +
          'Available tools: get_projects, get_project, get_project_tasks, create_project, update_project, delete_project, ' +
          'get_task, create_task, update_task, delete_task, complete_task, batch_create_tasks, get_all_tasks, get_today_tasks.\n\n' +
          'For listing all tasks use get_all_tasks. For today/overdue tasks use get_today_tasks. Be concise and return structured data.',
        tools: ['mcp__ticktick__*', 'Read', 'Grep'],
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
