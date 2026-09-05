import type { McpServerConfig, SubAgentDefinition, NamedAgent, BashAccess } from '@raven/shared';
import type { NamedAgentStore } from './yaml-named-agent-store.ts';
import type { CapabilityLibrary } from '../capability-library/capability-library.ts';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface ResolvedCapabilities {
  mcpServers: Record<string, McpServerConfig>;
  agentDefinitions: Record<string, SubAgentDefinition>;
  plugins: Array<{ type: 'local'; path: string }>;
  bashAccess?: BashAccess;
}

export interface AgentResolver {
  resolveAgentCapabilities: (agent: NamedAgent) => ResolvedCapabilities;
}

function emptyCapabilities(): ResolvedCapabilities {
  return { mcpServers: {}, agentDefinitions: {}, plugins: [] };
}

export interface ResolvedDefaultAgent extends ResolvedCapabilities {
  namedAgentId?: string;
  agentName?: string;
  namedAgentInstructions?: string;
}

/** Missing optional composition dependencies mean no bindings. A broken or
 * partially configured agent must never inherit the full capability library. */
export function resolveDefaultAgentCapabilities(deps: {
  namedAgentStore?: NamedAgentStore;
  agentResolver?: AgentResolver;
}): ResolvedDefaultAgent {
  const { namedAgentStore, agentResolver } = deps;
  if (!namedAgentStore && !agentResolver) return emptyCapabilities();
  if (!namedAgentStore || !agentResolver) {
    throw new Error('Default agent requires both namedAgentStore and agentResolver');
  }
  const agent = namedAgentStore.getDefaultAgent();
  return {
    ...agentResolver.resolveAgentCapabilities(agent),
    namedAgentId: agent.id,
    agentName: agent.name,
    namedAgentInstructions: agent.instructions ?? undefined,
  };
}

function containedFile(root: string, path: string): boolean {
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch {
    return false;
  }
  const rel = relative(root, canonical);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return false;
  return statSync(canonical).isFile();
}

/** Vendor references name a skill or plugin definition inside a loaded vendor.
 * Short skill names also support the vendor's conventional skills/ directory. */
function validateVendorReference(library: CapabilityLibrary, reference: string): string {
  const [vendor, ...suffix] = reference.split('/');
  if (
    !vendor ||
    suffix.length === 0 ||
    reference.includes('\\') ||
    [vendor, ...suffix].some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Invalid vendor skill reference: ${reference}`);
  }
  const vendorPath = library.getVendorPath(vendor);
  if (!vendorPath) throw new Error(`Unknown vendor in skill reference: ${reference}`);
  let root: string;
  try {
    root = realpathSync(vendorPath);
  } catch {
    throw new Error(`Unavailable vendor in skill reference: ${reference}`);
  }
  const paths = [resolve(root, ...suffix), resolve(root, 'skills', ...suffix)];
  const found = paths.some(
    (path) =>
      containedFile(root, join(path, 'SKILL.md')) ||
      containedFile(root, join(path, '.claude-plugin', 'plugin.json')),
  );
  if (!found) throw new Error(`Missing vendor skill or plugin definition: ${reference}`);
  return vendor;
}

function resolveFromLibrary(
  library: CapabilityLibrary,
  skillNames: string[],
): ResolvedCapabilities {
  const vendors = new Set<string>();
  for (const name of skillNames) {
    const skill = library.getSkill(name);
    if (!skill) throw new Error(`Unknown agent skill: ${name}`);
    for (const mcpName of skill.config.mcps) {
      if (!library.getMcp(mcpName)) {
        throw new Error(`Skill "${name}" references unknown MCP: ${mcpName}`);
      }
    }
    for (const reference of skill.config.vendorSkills) {
      vendors.add(validateVendorReference(library, reference));
    }
  }
  const plugins = library.resolveVendorPlugins(skillNames);
  if (plugins.length !== vendors.size) {
    throw new Error(`Unresolved vendor bindings for agent skills: ${skillNames.join(', ')}`);
  }
  return {
    mcpServers: library.collectMcpServers(skillNames),
    agentDefinitions: library.collectAgentDefinitions(skillNames),
    plugins,
  };
}

export function createAgentResolver(deps: {
  capabilityLibrary?: CapabilityLibrary;
}): AgentResolver {
  const { capabilityLibrary } = deps;

  return {
    resolveAgentCapabilities(agent: NamedAgent): ResolvedCapabilities {
      // EXPLICIT PATH: agent has skills populated — resolve exactly those
      // from the CapabilityLibrary. This is now the main (and only) path;
      // skills: [] means "no capability bindings," not "give me everything."
      // Agents that want the full library must list it explicitly (see
      // projects/agents/raven/agent.yaml).
      if (agent.skills.length === 0) return emptyCapabilities();
      if (!capabilityLibrary) {
        throw new Error(`Agent "${agent.name}" has skill bindings but no capability library`);
      }
      return resolveFromLibrary(capabilityLibrary, agent.skills);
    },
  };
}
