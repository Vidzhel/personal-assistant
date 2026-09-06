import {
  ModelIdSchema,
  ModelConfigSchema,
  type McpServerConfig,
  type SubAgentDefinition,
  type NamedAgent,
  type BashAccess,
  type ModelConfig,
} from '@raven/shared';
import type { NamedAgentStore } from './yaml-named-agent-store.ts';
import type { CapabilityLibrary } from '../capability-library/capability-library.ts';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { normalizeModelId } from './model-settings.ts';

export interface ResolvedCapabilities {
  mcpServers: Record<string, McpServerConfig>;
  agentDefinitions: Record<string, SubAgentDefinition>;
  plugins: Array<{ type: 'local'; path: string }>;
  /** Selected MCP definitions omitted because their optional runtime configuration is absent. */
  unavailableMcpServers?: string[];
  /** Selected skills whose declared MCP integration is not fully available. */
  unavailableSkills?: string[];
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
  namedAgentRevision?: string;
  agentName?: string;
  namedAgentInstructions?: string;
  namedAgentModel?: string | null;
  namedAgentMaxTurns?: number | null;
}

const MAX_AGENT_TURNS = 100;

export interface AgentExecutionDefaults {
  model: string;
  maxTurns: number;
}

export function validateResolvedAgentExecutionSettings(input: {
  model?: string;
  maxTurns?: number;
  modelConfig?: ModelConfig;
}): void {
  if (input.model !== undefined && !ModelIdSchema.safeParse(input.model).success) {
    throw new Error('Invalid agent model: model must be a non-empty model identifier');
  }
  if (input.modelConfig !== undefined) {
    const config = ModelConfigSchema.parse(input.modelConfig);
    if (!config.model || config.model !== input.model) {
      throw new Error('Captured model settings must match the admitted model');
    }
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
      ? normalizeModelId(defaults.model)
      : normalizeModelId(ModelIdSchema.parse(model));
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
  if (agent.model !== null && !ModelIdSchema.safeParse(agent.model).success) {
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
    namedAgentRevision: agent.definitionRevision,
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
  const mcpServers = library.collectMcpServers(skillNames);
  const activeMcpNames = new Set(Object.keys(mcpServers));
  const unavailableMcpServers = [
    ...new Set(
      skillNames.flatMap(
        (name) =>
          library.getSkill(name)?.config.mcps.filter((mcpName) => !activeMcpNames.has(mcpName)) ??
          [],
      ),
    ),
  ].sort();
  const unavailableMcpNames = new Set(unavailableMcpServers);
  const unavailableSkills = [...new Set(skillNames)]
    .filter((name) =>
      library.getSkill(name)?.config.mcps.some((mcpName) => unavailableMcpNames.has(mcpName)),
    )
    .sort();
  return {
    mcpServers,
    agentDefinitions: library.collectAgentDefinitions(skillNames, activeMcpNames),
    plugins,
    ...(unavailableMcpServers.length > 0 && { unavailableMcpServers }),
    ...(unavailableSkills.length > 0 && { unavailableSkills }),
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
