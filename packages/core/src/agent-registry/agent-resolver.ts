import {
  NAMED_AGENT_MODEL_TIERS,
  type McpServerConfig,
  type SubAgentDefinition,
  type NamedAgent,
  type BashAccess,
  type NamedAgentModelTier,
} from '@raven/shared';
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
  namedAgentModel?: string | null;
  namedAgentMaxTurns?: number | null;
}

const MAX_AGENT_TURNS = 100;

const NAMED_AGENT_MODEL_IDS: Record<NamedAgentModelTier, string> = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-5',
};

export interface AgentExecutionDefaults {
  model: string;
  maxTurns: number;
}

export function validateResolvedAgentExecutionSettings(input: {
  model?: string;
  maxTurns?: number;
}): void {
  if (
    input.model !== undefined &&
    (typeof input.model !== 'string' || input.model.trim().length === 0)
  ) {
    throw new Error('Invalid agent model: model must be non-empty');
  }
  if (
    input.maxTurns !== undefined &&
    (!Number.isInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > MAX_AGENT_TURNS)
  ) {
    throw new Error(`Invalid agent maxTurns: ${String(input.maxTurns)}`);
  }
}

/** Validate and resolve named-agent settings at the dispatch boundary. The
 * tier is deliberately converted before the budget wrapper sees it, so the
 * ledger and SDK receive the same effective model identifier. */
export function resolveAgentExecutionSettings(input: {
  model?: string | null;
  maxTurns?: number | null;
  defaults: AgentExecutionDefaults;
}): { model: string; maxTurns: number } {
  const { model, maxTurns, defaults } = input;
  const effectiveModel =
    model === null || model === undefined
      ? defaults.model
      : NAMED_AGENT_MODEL_IDS[model as NamedAgentModelTier];
  if (!effectiveModel) {
    throw new Error(`Unsupported named-agent model: ${String(model)}`);
  }
  const effectiveMaxTurns = maxTurns ?? defaults.maxTurns;
  validateResolvedAgentExecutionSettings({ model: effectiveModel, maxTurns: effectiveMaxTurns });
  return { model: effectiveModel, maxTurns: effectiveMaxTurns };
}

/** Reject malformed configured values even for dispatchers that intentionally
 * use their own model/turn override (for example heartbeat). */
export function validateNamedAgentSettings(agent: NamedAgent): void {
  if (
    agent.model !== null &&
    !NAMED_AGENT_MODEL_TIERS.includes(agent.model as NamedAgentModelTier)
  ) {
    throw new Error(`Unsupported named-agent model: ${String(agent.model)}`);
  }
  if (
    agent.maxTurns !== null &&
    (!Number.isInteger(agent.maxTurns) || agent.maxTurns < 1 || agent.maxTurns > MAX_AGENT_TURNS)
  ) {
    throw new Error(`Invalid agent maxTurns: ${String(agent.maxTurns)}`);
  }
}

/** Missing optional composition dependencies mean no bindings. A broken or
 * partially configured agent must never inherit the full capability library. */
export function resolveDefaultAgentCapabilities(deps: {
  namedAgentStore?: NamedAgentStore;
  agentResolver?: AgentResolver;
  projectId?: string;
}): ResolvedDefaultAgent {
  const { namedAgentStore, agentResolver } = deps;
  if (!namedAgentStore && !agentResolver) return emptyCapabilities();
  if (!namedAgentStore || !agentResolver) {
    throw new Error('Default agent requires both namedAgentStore and agentResolver');
  }
  const agent = namedAgentStore.getDefaultAgent(deps.projectId);
  validateNamedAgentSettings(agent);
  return {
    ...agentResolver.resolveAgentCapabilities(agent),
    bashAccess: agent.bash,
    namedAgentId: agent.id,
    agentName: agent.name,
    namedAgentInstructions: agent.instructions ?? undefined,
    namedAgentModel: agent.model,
    namedAgentMaxTurns: agent.maxTurns,
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

export function resolveSkillCapabilities(
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
      return resolveSkillCapabilities(capabilityLibrary, agent.skills);
    },
  };
}
