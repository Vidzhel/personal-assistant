import type { McpServerConfig } from '@raven/shared';
import type { SuiteRegistry } from '../suite-registry/suite-registry.ts';

/**
 * MCP Manager resolves MCP server configs from suites on demand.
 * MCP servers are NOT started eagerly — they are passed as config to
 * Claude Agent SDK query() calls, which starts them as sub-processes.
 * This ensures MCPs are only active during sub-agent execution.
 */
export class McpManager {
  private suiteRegistry: SuiteRegistry;

  constructor(suiteRegistry: SuiteRegistry) {
    this.suiteRegistry = suiteRegistry;
  }

  /**
   * Resolve MCP server configs for a specific suite.
   * Returns configs that will be passed to a sub-agent's query() options.
   */
  resolveForSuite(suiteName: string): Record<string, McpServerConfig> {
    return this.suiteRegistry.collectMcpServers([suiteName]);
  }

  /**
   * Resolve MCP server configs for multiple suites.
   */
  resolveForSuites(suiteNames: string[]): Record<string, McpServerConfig> {
    return this.suiteRegistry.collectMcpServers(suiteNames);
  }

  /**
   * List all available MCP servers across all suites (for dashboard display).
   */
  listAvailable(): Record<string, McpServerConfig> {
    return this.suiteRegistry.collectMcpServers();
  }
}
