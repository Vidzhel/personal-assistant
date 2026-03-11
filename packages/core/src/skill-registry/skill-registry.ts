import {
  createLogger,
  ACTION_NAME_REGEX,
  type RavenSkill,
  type SkillContext,
  type McpServerConfig,
  type SubAgentDefinition,
  type SkillAction,
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
      const mcpKeys = Object.keys(skill.getMcpServers()).map((k) => `${name}_${k}`);
      for (const [key, def] of Object.entries(agents)) {
        defs[key] = { ...def, mcpServers: mcpKeys.length > 0 ? mcpKeys : undefined };
      }
    }
    return defs;
  }

  collectActions(skillNames?: string[]): SkillAction[] {
    const actions: SkillAction[] = [];
    const seen = new Set<string>();
    const names = skillNames ?? this.getEnabledSkillNames();
    for (const name of names) {
      const skill = this.skills.get(name);
      if (!skill) continue;
      const skillActions = skill.getActions();
      for (const action of skillActions) {
        if (!isValidActionName(action.name)) {
          log.warn(`Invalid action name "${action.name}" from skill "${name}" — skipping`);
          continue;
        }
        if (seen.has(action.name)) {
          log.warn(`Duplicate action name "${action.name}" from skill "${name}" — skipping`);
          continue;
        }
        seen.add(action.name);
        actions.push(action);
      }
    }
    return actions;
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

  validateAgentTools(): void {
    const mcpServers = this.collectMcpServers();
    const serverNames = new Set(Object.keys(mcpServers));

    for (const [skillName, skill] of this.skills) {
      const agents = skill.getAgentDefinitions();
      for (const [agentKey, def] of Object.entries(agents)) {
        for (const tool of def.tools ?? []) {
          const match = tool.match(/^mcp__(.+)__\*$/);
          if (!match) continue;
          if (!serverNames.has(match[1])) {
            throw new Error(
              `Skill "${skillName}" agent "${agentKey}" declares tool pattern "${tool}" ` +
                `but no MCP server named "${match[1]}" exists. ` +
                `Available: ${[...serverNames].join(', ')}`,
            );
          }
        }
      }
    }
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

export function isValidActionName(name: string): boolean {
  return ACTION_NAME_REGEX.test(name);
}
