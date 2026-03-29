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
      // NEW PATH: if agent has skills populated, use CapabilityLibrary
      if (capabilityLibrary && agent.skills.length > 0) {
        return resolveFromLibrary(capabilityLibrary, agent.skills);
      }

      // DEFAULT/ALL: if agent is default or has empty skills+suiteIds, use all capabilities
      const hasNoBindings = agent.skills.length === 0 && agent.suiteIds.length === 0;
      if (capabilityLibrary && (agent.isDefault || hasNoBindings)) {
        return resolveFromLibrary(capabilityLibrary);
      }

      // LEGACY PATH: fall back to suiteIds via SuiteRegistry
      if (suiteRegistry) {
        return resolveFromSuiteRegistry(suiteRegistry, agent);
      }

      return EMPTY_CAPABILITIES;
    },
  };
}
