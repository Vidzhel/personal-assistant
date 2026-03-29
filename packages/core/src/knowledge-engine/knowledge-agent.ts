import type { SubAgentDefinition } from '@raven/shared';

export function createKnowledgeAgentDefinition(): SubAgentDefinition {
  return {
    description:
      'Knowledge management agent — search, browse, organize, and manage your knowledge base. ' +
      'Delegate here when the user wants to find information in their knowledge.',
    prompt:
      "You manage Raven's knowledge base. Use these MCP tools:\n" +
      '- search_knowledge: find existing knowledge by query, tags, or domain\n' +
      '- save_knowledge: store new knowledge items\n' +
      '- get_knowledge_context: retrieve relevant context for a topic\n\n' +
      'Do not use WebFetch to call localhost APIs.',
    tools: [], // No WebFetch needed — MCP tools handle everything
  };
}
