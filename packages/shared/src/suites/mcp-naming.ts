export const MCP_NAMESPACE_SEP = '_';
export const MCP_TOOL_PATTERN_RE = /^mcp__([^_]+)__(.+)$/;
export const MCP_TOOL_WILDCARD_RE = /^mcp__(.+)__\*$/;

export function namespaceMcpKey(suiteName: string, localKey: string): string {
  return `${suiteName}${MCP_NAMESPACE_SEP}${localKey}`;
}

export function buildMcpToolPattern(serverKey: string): string {
  return `mcp__${serverKey}__*`;
}

export function buildLocalToNamespacedMap(
  namespacedKeys: string[],
  suiteName: string,
): Map<string, string> {
  const map = new Map<string, string>();
  const prefix = `${suiteName}${MCP_NAMESPACE_SEP}`;
  for (const key of namespacedKeys) {
    if (key.startsWith(prefix)) {
      map.set(key.slice(prefix.length), key);
    }
  }
  return map;
}

export function rewriteAgentMcpRefs(
  agent: { tools: string[]; mcpServers?: string[] },
  localToNamespaced: Map<string, string>,
): { tools: string[]; mcpServers: string[] | undefined } {
  const tools = agent.tools.map((tool) => {
    const match = tool.match(MCP_TOOL_PATTERN_RE);
    if (match) {
      const namespacedKey = localToNamespaced.get(match[1]);
      if (namespacedKey) return `mcp__${namespacedKey}__${match[2]}`;
    }
    return tool;
  });

  const mcpServers = agent.mcpServers?.map((key) => localToNamespaced.get(key) ?? key);

  return { tools, mcpServers };
}

/**
 * Validates agent MCP references against a set of known local MCP keys.
 * Throws if an agent references an MCP server not in the suite's mcp.json.
 */
export function validateAgentMcpRefs(
  agent: { name: string; tools: string[]; mcpServers?: string[] },
  localMcpKeys: Set<string>,
  suiteName: string,
): void {
  for (const key of agent.mcpServers ?? []) {
    if (!localMcpKeys.has(key)) {
      throw new Error(
        `Suite "${suiteName}" agent "${agent.name}" references MCP server "${key}" ` +
          `but suite only defines: ${[...localMcpKeys].join(', ') || '(none)'}`,
      );
    }
  }

  for (const tool of agent.tools) {
    const match = tool.match(MCP_TOOL_PATTERN_RE);
    if (!match) continue;
    const localKey = match[1];
    if (!localMcpKeys.has(localKey)) {
      throw new Error(
        `Suite "${suiteName}" agent "${agent.name}" has tool pattern "${tool}" ` +
          `referencing MCP server "${localKey}" but suite only defines: ` +
          `${[...localMcpKeys].join(', ') || '(none)'}`,
      );
    }
  }
}
