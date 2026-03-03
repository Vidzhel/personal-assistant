import {
  createLogger,
  type RavenSkill,
  type SkillContext,
  type McpServerConfig,
  type SubAgentDefinition,
} from '@raven/shared';

const log = createLogger('skill-registry');

export class SkillRegistry {
  private skills = new Map<string, RavenSkill>();

  async registerSkill(
    skill: RavenSkill,
    config: Record<string, unknown>,
    baseContext: Omit<SkillContext, 'config'>,
  ): Promise<void> {
    const name = skill.manifest.name;
    log.info(`Registering skill: ${name}`);

    const context: SkillContext = { ...baseContext, config };
    await skill.initialize(context);
    this.skills.set(name, skill);

    log.info(`Skill registered: ${name} (${skill.manifest.capabilities.join(', ')})`);
  }

  getSkill(name: string): RavenSkill | undefined {
    return this.skills.get(name);
  }

  getAllSkills(): RavenSkill[] {
    return Array.from(this.skills.values());
  }

  getEnabledSkillNames(): string[] {
    return Array.from(this.skills.keys());
  }

  collectMcpServers(skillNames?: string[]): Record<string, McpServerConfig> {
    const servers: Record<string, McpServerConfig> = {};
    const names = skillNames ?? this.getEnabledSkillNames();
    for (const name of names) {
      const skill = this.skills.get(name);
      if (!skill) continue;
      const mcps = skill.getMcpServers();
      for (const [key, config] of Object.entries(mcps)) {
        servers[`${name}_${key}`] = config;
      }
    }
    return servers;
  }

  collectAgentDefinitions(skillNames?: string[]): Record<string, SubAgentDefinition> {
    const defs: Record<string, SubAgentDefinition> = {};
    const names = skillNames ?? this.getEnabledSkillNames();
    for (const name of names) {
      const skill = this.skills.get(name);
      if (!skill) continue;
      const agents = skill.getAgentDefinitions();
      for (const [key, def] of Object.entries(agents)) {
        defs[key] = def;
      }
    }
    return defs;
  }

  findSkillForTaskType(taskType: string): RavenSkill | undefined {
    for (const skill of this.skills.values()) {
      const schedules = skill.manifest.defaultSchedules ?? [];
      if (schedules.some((s) => s.taskType === taskType)) {
        return skill;
      }
    }
    return undefined;
  }

  async shutdown(): Promise<void> {
    const skills = Array.from(this.skills.values()).reverse();
    for (const skill of skills) {
      log.info(`Shutting down skill: ${skill.manifest.name}`);
      await skill.shutdown();
    }
    this.skills.clear();
  }
}
