import type { McpServerConfig, SubAgentDefinition, NamedAgent, BashAccess } from '@raven/shared';
import type { CapabilityLibrary } from '../capability-library/capability-library.ts';

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
      if (capabilityLibrary && agent.skills.length > 0) {
        return resolveFromLibrary(capabilityLibrary, agent.skills);
      }

      return EMPTY_CAPABILITIES;
    },
  };
}
