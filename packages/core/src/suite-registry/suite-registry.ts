import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createLogger,
  type McpServerConfig,
  type SubAgentDefinition,
  type SkillAction,
} from '@raven/shared';
import { loadSuite, type LoadedSuite, type SuiteSchedule } from './suite-loader.ts';

const log = createLogger('suite-registry');

export interface SuiteConfig {
  enabled: boolean;
  config?: Record<string, unknown>;
}

export class SuiteRegistry {
  private suites = new Map<string, LoadedSuite>();

  async loadSuites(suitesDir: string, config: Record<string, SuiteConfig>): Promise<void> {
    const entries = await readdir(suitesDir);

    for (const entry of entries) {
      const fullPath = join(suitesDir, entry);
      const s = await stat(fullPath);
      if (!s.isDirectory()) continue;

      // _orchestrator is always loaded
      const isOrchestrator = entry === '_orchestrator';
      const suiteConfig = config[entry];

      if (!isOrchestrator && !suiteConfig?.enabled) {
        log.info(`Suite '${entry}' is disabled, skipping`);
        continue;
      }

      try {
        const suite = await loadSuite(fullPath);
        this.suites.set(suite.manifest.name, suite);
        log.info(
          `Suite registered: ${suite.manifest.name} ` +
            `(${suite.agents.length} agents, ${Object.keys(suite.mcpServers).length} MCPs, ` +
            `${suite.actions.length} actions)`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Failed to load suite '${entry}': ${msg}`);
      }
    }
  }

  getSuite(name: string): LoadedSuite | undefined {
    return this.suites.get(name);
  }

  getAllSuites(): LoadedSuite[] {
    return Array.from(this.suites.values());
  }

  getEnabledSuiteNames(): string[] {
    return Array.from(this.suites.keys());
  }

  /**
   * Collects MCP server configs from all (or specified) suites.
   * Returns namespaced keys: `suiteName_mcpKey`.
   */
  collectMcpServers(suiteNames?: string[]): Record<string, McpServerConfig> {
    const servers: Record<string, McpServerConfig> = {};
    const names = suiteNames ?? this.getEnabledSuiteNames();

    for (const name of names) {
      const suite = this.suites.get(name);
      if (!suite) continue;
      Object.assign(servers, suite.mcpServers);
    }

    return servers;
  }

  /**
   * Collects agent definitions from all (or specified) suites.
   * Returns a flat namespace of all agents across all suites.
   */
  collectAgentDefinitions(suiteNames?: string[]): Record<string, SubAgentDefinition> {
    const defs: Record<string, SubAgentDefinition> = {};
    const names = suiteNames ?? this.getEnabledSuiteNames();

    for (const name of names) {
      const suite = this.suites.get(name);
      if (!suite) continue;

      // Compute MCP keys for this suite
      const mcpKeys = Object.keys(suite.mcpServers);

      for (const agent of suite.agents) {
        defs[agent.name] = {
          description: agent.description,
          prompt: agent.prompt,
          tools: agent.tools,
          model: agent.model,
          mcpServers: mcpKeys.length > 0 ? mcpKeys : undefined,
        };
      }
    }

    return defs;
  }

  /**
   * Collects actions from all (or specified) suites.
   * Deduplicates by action name.
   */
  collectActions(suiteNames?: string[]): SkillAction[] {
    const actions: SkillAction[] = [];
    const seen = new Set<string>();
    const names = suiteNames ?? this.getEnabledSuiteNames();

    for (const name of names) {
      const suite = this.suites.get(name);
      if (!suite) continue;

      for (const action of suite.actions) {
        if (seen.has(action.name)) {
          log.warn(`Duplicate action name "${action.name}" in suite "${name}" — skipping`);
          continue;
        }
        seen.add(action.name);
        actions.push(action);
      }
    }

    return actions;
  }

  /**
   * Collects all schedules from all suites.
   */
  collectSchedules(): Array<SuiteSchedule & { suiteName: string }> {
    const schedules: Array<SuiteSchedule & { suiteName: string }> = [];

    for (const [name, suite] of this.suites) {
      for (const schedule of suite.schedules) {
        schedules.push({ ...schedule, suiteName: name });
      }
    }

    return schedules;
  }

  /**
   * Finds which suite owns a given scheduled task type.
   */
  findSuiteForTaskType(taskType: string): LoadedSuite | undefined {
    for (const suite of this.suites.values()) {
      if (suite.schedules.some((s) => s.taskType === taskType)) {
        return suite;
      }
    }
    return undefined;
  }

  /**
   * Validates that agent tool patterns reference existing MCP servers.
   */
  validateAgentTools(): void {
    const allMcpServers = this.collectMcpServers();
    const serverNames = new Set(Object.keys(allMcpServers));

    for (const [suiteName, suite] of this.suites) {
      for (const agent of suite.agents) {
        for (const tool of agent.tools) {
          const match = tool.match(/^mcp__(.+)__\*$/);
          if (!match) continue;
          if (!serverNames.has(match[1])) {
            throw new Error(
              `Suite "${suiteName}" agent "${agent.name}" declares tool pattern "${tool}" ` +
                `but no MCP server named "${match[1]}" exists. ` +
                `Available: ${[...serverNames].join(', ')}`,
            );
          }
        }
      }
    }
  }
}
