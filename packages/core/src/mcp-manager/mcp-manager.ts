import type { McpServerConfig } from '@raven/shared';
import type { SkillRegistry } from '../skill-registry/skill-registry.ts';

/**
 * MCP Manager resolves MCP server configs from skills on demand.
 * MCP servers are NOT started eagerly — they are passed as config to
 * Claude Agent SDK query() calls, which starts them as sub-processes.
 * This ensures MCPs are only active during sub-agent execution.
 */
export class McpManager {
  private skillRegistry: SkillRegistry;

  constructor(skillRegistry: SkillRegistry) {
    this.skillRegistry = skillRegistry;
  }

  /**
   * Resolve MCP server configs for a specific skill.
   * Returns configs that will be passed to a sub-agent's query() options.
   */
  resolveForSkill(skillName: string): Record<string, McpServerConfig> {
    return this.skillRegistry.collectMcpServers([skillName]);
  }

  /**
   * Resolve MCP server configs for multiple skills.
   */
  resolveForSkills(skillNames: string[]): Record<string, McpServerConfig> {
    return this.skillRegistry.collectMcpServers(skillNames);
  }

  /**
   * List all available MCP servers across all skills (for dashboard display).
   */
  listAvailable(): Record<string, McpServerConfig> {
    return this.skillRegistry.collectMcpServers();
  }
}
