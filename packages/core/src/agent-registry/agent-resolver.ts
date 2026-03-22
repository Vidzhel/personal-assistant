import {
  createLogger,
  type McpServerConfig,
  type SubAgentDefinition,
  type NamedAgent,
} from '@raven/shared';
import type { SuiteRegistry } from '../suite-registry/suite-registry.ts';

const log = createLogger('agent-resolver');

export interface ResolvedCapabilities {
  mcpServers: Record<string, McpServerConfig>;
  agentDefinitions: Record<string, SubAgentDefinition>;
}

export interface AgentResolver {
  resolveAgentCapabilities: (agent: NamedAgent) => ResolvedCapabilities;
}

export function createAgentResolver(deps: { suiteRegistry: SuiteRegistry }): AgentResolver {
  const { suiteRegistry } = deps;

  return {
    resolveAgentCapabilities(agent: NamedAgent): ResolvedCapabilities {
      // Empty suite_ids or default agent → all suites (backward-compatible)
      if (agent.suiteIds.length === 0 || agent.isDefault) {
        return {
          mcpServers: suiteRegistry.collectMcpServers(),
          agentDefinitions: suiteRegistry.collectAgentDefinitions(),
        };
      }

      // Validate that all suite_ids reference enabled suites
      const enabledNames = new Set(suiteRegistry.getEnabledSuiteNames());
      for (const suiteId of agent.suiteIds) {
        if (!enabledNames.has(suiteId)) {
          log.warn(`Agent "${agent.name}" references missing/disabled suite: ${suiteId}`);
        }
      }

      const validSuites = agent.suiteIds.filter((s) => enabledNames.has(s));

      return {
        mcpServers: suiteRegistry.collectMcpServers(validSuites),
        agentDefinitions: suiteRegistry.collectAgentDefinitions(validSuites),
      };
    },
  };
}
