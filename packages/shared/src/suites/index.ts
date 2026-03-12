export {
  defineAgent,
  defineSuite,
  buildPrompt,
  parseActions,
  parseMcpConfig,
  resolveEnvVars,
  type AgentDefinition,
  type ResolvedAgentDefinition,
  type SuiteManifest,
  type ResolvedSuiteManifest,
  type PromptParts,
  type ActionDefinition,
  type McpConfig,
} from './define.ts';

export {
  MCP_NAMESPACE_SEP,
  MCP_TOOL_PATTERN_RE,
  MCP_TOOL_WILDCARD_RE,
  namespaceMcpKey,
  buildMcpToolPattern,
  buildLocalToNamespacedMap,
  rewriteAgentMcpRefs,
  validateAgentMcpRefs,
} from './mcp-naming.ts';
