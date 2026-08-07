import {
  createLogger,
  type McpServerConfig,
  type SubAgentDefinition,
  type NamedAgent,
  type BashAccess,
} from '@raven/shared';
import type { SuiteRegistry } from '../suite-registry/suite-registry.ts';
import type { CapabilityLibrary } from '../capability-library/capability-library.ts';

const log = createLogger('agent-resolver');

export interface ResolvedCapabilities {
  mcpServers: Record<string, McpServerConfig>;
  agentDefinitions: Record<string, SubAgentDefinition>;
  plugins: Array<{ type: 'local'; path: string }>;
  bashAccess?: BashAccess;
}

export interface AgentResolver {
  resolveAgentCapabilities: (agent: NamedAgent) => ResolvedCapabilities;
}

const EMPTY_CAPABILITIES: ResolvedCapabilities = {
  mcpServers: {},
  agentDefinitions: {},
  plugins: [],
};

function resolveFromLibrary(
  library: CapabilityLibrary,
  skillNames?: string[],
): ResolvedCapabilities {
  return {
    mcpServers: library.collectMcpServers(skillNames),
    agentDefinitions: library.collectAgentDefinitions(skillNames),
    plugins: library.resolveVendorPlugins(skillNames),
  };
}

function resolveFromSuiteRegistry(
  registry: SuiteRegistry,
  agent: NamedAgent,
): ResolvedCapabilities {
  if (agent.suiteIds.length === 0 || agent.isDefault) {
    return {
      mcpServers: registry.collectMcpServers(),
      agentDefinitions: registry.collectAgentDefinitions(),
      plugins: registry.collectVendorPlugins(),
    };
  }

  const enabledNames = new Set(registry.getEnabledSuiteNames());
  for (const suiteId of agent.suiteIds) {
    if (!enabledNames.has(suiteId)) {
      log.warn(`Agent "${agent.name}" references missing/disabled suite: ${suiteId}`);
    }
  }

  const validSuites = agent.suiteIds.filter((s) => enabledNames.has(s));

  return {
    mcpServers: registry.collectMcpServers(validSuites),
    agentDefinitions: registry.collectAgentDefinitions(validSuites),
    plugins: registry.collectVendorPlugins(validSuites),
  };
}

export function createAgentResolver(deps: {
  capabilityLibrary?: CapabilityLibrary;
  suiteRegistry?: SuiteRegistry;
}): AgentResolver {
  const { capabilityLibrary, suiteRegistry } = deps;

  return {
    resolveAgentCapabilities(agent: NamedAgent): ResolvedCapabilities {
      // EXPLICIT PATH: agent has skills populated — resolve exactly those
      // from the CapabilityLibrary. This is now the main path; skills: []
      // no longer means "give me everything."
      if (capabilityLibrary && agent.skills.length > 0) {
        return resolveFromLibrary(capabilityLibrary, agent.skills);
      }

      // NOTHING: empty skills + empty suiteIds means the agent has no
      // capability bindings at all — not "resolve everything." Agents that
      // want the full library must list it explicitly (see
      // projects/agents/raven/agent.yaml).
      const hasNoBindings = agent.skills.length === 0 && agent.suiteIds.length === 0;
      if (hasNoBindings) {
        return EMPTY_CAPABILITIES;
      }

      // LEGACY PATH: fall back to suiteIds via SuiteRegistry (pre-library
      // agents bound to suites instead of skills). Phase 2 deletes this.
      if (suiteRegistry) {
        return resolveFromSuiteRegistry(suiteRegistry, agent);
      }

      return EMPTY_CAPABILITIES;
    },
  };
}
