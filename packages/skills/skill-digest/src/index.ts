import {
  generateId,
  type RavenSkill,
  type SkillManifest,
  type SkillContext,
  type McpServerConfig,
  type SubAgentDefinition,
  type AgentTaskPayload,
} from '@raven/shared';

class DigestSkill implements RavenSkill {
  manifest: SkillManifest = {
    name: 'digest',
    displayName: 'Morning Digest',
    version: '0.1.0',
    description: 'Daily morning briefing with tasks, emails, and suggestions',
    capabilities: ['agent-definition'],
    defaultSchedules: [
      {
        id: 'morning-digest',
        name: 'Morning Digest',
        cron: '0 8 * * *',
        taskType: 'morning-digest',
        enabled: true,
      },
    ],
  };

  private context!: SkillContext;

  async initialize(context: SkillContext): Promise<void> {
    this.context = context;
    this.context.logger.info('Digest skill initialized');
  }

  async shutdown(): Promise<void> {}

  getMcpServers(): Record<string, McpServerConfig> {
    return {}; // Digest skill has no MCPs - it delegates to other skill agents
  }

  getAgentDefinitions(): Record<string, SubAgentDefinition> {
    return {};
  }

  async handleScheduledTask(
    taskType: string,
    _context: SkillContext,
  ): Promise<AgentTaskPayload | undefined> {
    if (taskType !== 'morning-digest') return;

    // The digest creates an orchestrator-level agent task that uses
    // sub-agents from other skills to gather data
    return {
      taskId: generateId(),
      prompt: [
        'Generate a morning digest briefing for the user.',
        '',
        'You have access to sub-agents for different data sources:',
        "- Use the ticktick-agent to get today's tasks and overdue items",
        '- Use the gmail-agent to summarize unread/important emails',
        '',
        'Compile the data into a well-formatted morning briefing with:',
        "1. Task overview (today's tasks, overdue items)",
        '2. Email highlights (important unread emails)',
        '3. Day structure suggestions',
        '',
        'Format the output as clean markdown.',
      ].join('\n'),
      skillName: 'digest',
      mcpServers: {}, // No MCPs on the digest agent - it delegates to sub-agents
      priority: 'normal',
    };
  }
}

export default function createSkill(): RavenSkill {
  return new DigestSkill();
}
