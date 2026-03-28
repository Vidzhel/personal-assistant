import { createLogger, buildMcpToolPattern } from '@raven/shared';
import type {
  McpDefinition,
  LoadedSkill,
  LoadedLibrary,
  McpServerConfig,
  SubAgentDefinition,
} from '@raven/shared';
import type { ActionDefinition } from '@raven/shared';

import { loadLibrary } from './library-loader.ts';

const log = createLogger('capability-library');

/**
 * Resolves `${VAR_NAME}` placeholders in MCP env values from process.env.
 * Returns empty string for missing env vars (lenient — no throw).
 */
function resolveEnvVars(env?: Record<string, string>): Record<string, string> | undefined {
  if (!env) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, val] of Object.entries(env)) {
    if (val.startsWith('${') && val.endsWith('}')) {
      resolved[key] = process.env[val.slice(2, -1)] ?? '';
    } else {
      resolved[key] = val;
    }
  }
  return resolved;
}

export class CapabilityLibrary {
  private library: LoadedLibrary | null = null;

  async load(libraryDir: string): Promise<void> {
    this.library = await loadLibrary(libraryDir);
    log.info(
      `CapabilityLibrary loaded: ${String(this.library.skills.size)} skills, ${String(this.library.mcps.size)} mcps`,
    );
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

      const env = resolveEnvVars(Object.keys(mcp.env).length > 0 ? mcp.env : undefined);

      result[mcpName] = {
        command: mcp.command,
        args: mcp.args,
        ...(env ? { env } : {}),
      };
    }

    return result;
  }

  collectAgentDefinitions(skillNames?: string[]): Record<string, SubAgentDefinition> {
    const skills = this.resolveSkills(skillNames);
    const result: Record<string, SubAgentDefinition> = {};

    for (const skill of skills) {
      const tools: string[] = [...skill.config.tools];
      for (const mcpName of skill.config.mcps) {
        tools.push(buildMcpToolPattern(mcpName));
      }

      const def: SubAgentDefinition = {
        description: skill.config.description,
        prompt: skill.skillMd,
        tools: tools.length > 0 ? tools : undefined,
        model: skill.config.model,
        mcpServers: skill.config.mcps.length > 0 ? skill.config.mcps : undefined,
      };

      result[skill.config.name] = def;
    }

    return result;
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
