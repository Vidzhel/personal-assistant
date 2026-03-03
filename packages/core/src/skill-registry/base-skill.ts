import type {
  RavenSkill,
  SkillManifest,
  SkillContext,
  McpServerConfig,
  SubAgentDefinition,
  DigestSection,
  AgentTaskPayload,
} from '@raven/shared';

export abstract class BaseSkill implements RavenSkill {
  abstract manifest: SkillManifest;

  protected context!: SkillContext;

  async initialize(context: SkillContext): Promise<void> {
    this.context = context;
  }

  async shutdown(): Promise<void> {}

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

  async getDataForDigest(): Promise<DigestSection> {
    return {
      skillName: this.manifest.name,
      title: this.manifest.displayName,
      priority: 99,
      markdownContent: '',
    };
  }
}
