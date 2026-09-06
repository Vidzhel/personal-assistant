import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createLogger, buildMcpToolPattern, MCP_TOOL_PATTERN_RE } from '@raven/shared';
import type {
  McpDefinition,
  LoadedSkill,
  LoadedLibrary,
  McpServerConfig,
  SubAgentDefinition,
} from '@raven/shared';
import type { ActionDefinition } from '@raven/shared';

import { loadLibrary } from './library-loader.ts';
import type { DefinitionDiagnostic } from '../diagnostics/definition-diagnostics.ts';
import {
  createMcpServerConfig,
  getMcpConfigurationStatus,
  type McpConfigurationStatus,
} from './mcp-config.ts';

const log = createLogger('capability-library');

export class CapabilityLibrary {
  private library: (LoadedLibrary & { diagnostics?: DefinitionDiagnostic[] }) | null = null;
  private diagnostics: DefinitionDiagnostic[] = [];
  private libraryRoot?: string;

  async load(libraryDir: string): Promise<void> {
    try {
      this.library = await loadLibrary(libraryDir);
      this.libraryRoot = resolve(libraryDir);
      this.diagnostics = [...(this.library.diagnostics ?? [])];
    } catch (error) {
      this.diagnostics = [
        {
          source: 'skill',
          path: '.',
          code: 'library-root-unavailable',
          message: error instanceof Error ? error.message : String(error),
          severity: 'error',
        },
      ];
      throw error;
    }
    log.info(
      `CapabilityLibrary loaded: ${String(this.library.skills.size)} skills, ${String(this.library.mcps.size)} mcps`,
    );
  }

  getDefinitionDiagnostics(): readonly DefinitionDiagnostic[] {
    return [...this.diagnostics];
  }

  /** Only bound definitions affect task context; adding an unrelated skill is safe. */
  getRevision(skillNames?: string[]): string {
    const lib = this.ensureLoaded();
    if (this.diagnostics.some((entry) => entry.code === 'library-root-unavailable')) {
      throw new Error('Capability library is unavailable');
    }
    const skills = [...new Set(skillNames ?? [...lib.skills.keys()])].sort().map((name) => {
      const skill = lib.skills.get(name);
      if (!skill) throw new Error(`Skill is unavailable: ${name}`);
      return skill;
    });
    const mcps = [...new Set(skills.flatMap((skill) => skill.config.mcps))].sort().map((name) => {
      const definition = lib.mcps.get(name);
      const config = definition ? this.createServerConfig(definition) : undefined;
      const configured =
        config?.type === 'http' ? getMcpConfigurationStatus(config).configured : true;
      return [name, definition, configured];
    });
    const vendors = [...new Set(skills.flatMap((skill) => skill.config.vendorSkills))]
      .sort()
      .map((reference) => [reference, lib.vendorPaths.get(reference.split('/')[0])]);
    return createHash('sha256').update(JSON.stringify({ skills, mcps, vendors })).digest('hex');
  }

  private ensureLoaded(): LoadedLibrary {
    if (!this.library) {
      throw new Error('CapabilityLibrary not loaded — call load() first');
    }
    return this.library;
  }

  private resolveSkills(skillNames?: string[]): LoadedSkill[] {
    const lib = this.ensureLoaded();
    if (!skillNames) {
      return Array.from(lib.skills.values());
    }
    const result: LoadedSkill[] = [];
    for (const name of skillNames) {
      const skill = lib.skills.get(name);
      if (skill) {
        result.push(skill);
      }
    }
    return result;
  }

  getSkillNames(): string[] {
    const lib = this.ensureLoaded();
    return Array.from(lib.skills.keys());
  }

  getSkill(name: string): LoadedSkill | undefined {
    const lib = this.ensureLoaded();
    return lib.skills.get(name);
  }

  getMcp(name: string): McpDefinition | undefined {
    const lib = this.ensureLoaded();
    return lib.mcps.get(name);
  }

  /** Return the anchored, unresolved form safe to persist in task events. */
  getMcpServerConfig(name: string): McpServerConfig | undefined {
    const definition = this.getMcp(name);
    return definition ? this.createServerConfig(definition) : undefined;
  }

  getMcpConfigurationStatus(
    name: string,
    env: NodeJS.ProcessEnv = process.env,
  ): McpConfigurationStatus | undefined {
    const config = this.getMcpServerConfig(name);
    return config ? getMcpConfigurationStatus(config, env) : undefined;
  }

  getVendorPath(name: string): string | undefined {
    return this.ensureLoaded().vendorPaths.get(name);
  }

  collectMcpServers(skillNames?: string[]): Record<string, McpServerConfig> {
    const lib = this.ensureLoaded();
    const skills = this.resolveSkills(skillNames);
    const result: Record<string, McpServerConfig> = {};

    const mcpNames = new Set<string>();
    for (const skill of skills) {
      for (const mcpName of skill.config.mcps) {
        mcpNames.add(mcpName);
      }
    }

    for (const mcpName of mcpNames) {
      const mcp = lib.mcps.get(mcpName);
      if (!mcp) {
        log.warn(`MCP "${mcpName}" referenced by skill but not found in library`);
        continue;
      }

      const config = this.createServerConfig(mcp);
      if (config.type === 'http' && !getMcpConfigurationStatus(config).configured) continue;
      result[mcpName] = config;
    }

    return result;
  }

  collectAgentDefinitions(
    skillNames?: string[],
    availableMcpNames?: ReadonlySet<string>,
  ): Record<string, SubAgentDefinition> {
    const skills = this.resolveSkills(skillNames);
    const result: Record<string, SubAgentDefinition> = {};
    const available = availableMcpNames ?? new Set(Object.keys(this.collectMcpServers(skillNames)));

    for (const skill of skills) {
      const tools = skill.config.tools.filter((tool) => {
        const match = tool.match(MCP_TOOL_PATTERN_RE);
        return !match || available.has(match[1]);
      });
      const activeMcps = skill.config.mcps.filter((mcpName) => available.has(mcpName));
      for (const mcpName of activeMcps) {
        tools.push(buildMcpToolPattern(mcpName));
      }

      const def: SubAgentDefinition = {
        description: skill.config.description,
        prompt: skill.skillMd,
        // An explicit empty list prevents the SDK from inheriting the parent
        // agent's unrelated tools when every declared MCP is unavailable.
        tools,
        model: skill.config.model,
        effort: skill.config.effort,
        mcpServers: activeMcps.length > 0 ? activeMcps : undefined,
      };

      result[skill.config.name] = def;
    }

    return result;
  }

  private createServerConfig(definition: McpDefinition): McpServerConfig {
    if (!this.libraryRoot) throw new Error('CapabilityLibrary not loaded — call load() first');
    return createMcpServerConfig(definition, this.libraryRoot);
  }

  collectActions(skillNames?: string[]): ActionDefinition[] {
    const skills = this.resolveSkills(skillNames);
    const seen = new Set<string>();
    const actions: ActionDefinition[] = [];

    for (const skill of skills) {
      for (const action of skill.config.actions) {
        if (seen.has(action.name)) continue;
        seen.add(action.name);
        actions.push({
          name: action.name,
          description: action.description,
          defaultTier: action.defaultTier,
          reversible: action.reversible,
        });
      }
    }

    return actions;
  }

  resolveVendorPlugins(skillNames?: string[]): Array<{ type: 'local'; path: string }> {
    const lib = this.ensureLoaded();
    const skills = this.resolveSkills(skillNames);
    const seen = new Set<string>();
    const plugins: Array<{ type: 'local'; path: string }> = [];

    for (const skill of skills) {
      for (const vendorRef of skill.config.vendorSkills) {
        const vendorName = vendorRef.split('/')[0];
        if (!vendorName || seen.has(vendorName)) continue;
        seen.add(vendorName);

        const vendorPath = lib.vendorPaths.get(vendorName);
        if (!vendorPath) {
          log.warn(
            `Vendor "${vendorName}" referenced by skill "${skill.config.name}" but not found in library`,
          );
          continue;
        }

        plugins.push({ type: 'local', path: vendorPath });
      }
    }

    return plugins;
  }

  getSkillCatalog(skillNames?: string[]): string {
    const skills = this.resolveSkills(skillNames);
    if (skills.length === 0) {
      return '## Available Skills\n\nNo skills loaded.';
    }

    const lines = skills.map((s) => `- **${s.config.name}** — ${s.config.description}`);
    return `## Available Skills\n\n${lines.join('\n')}\n`;
  }
}
