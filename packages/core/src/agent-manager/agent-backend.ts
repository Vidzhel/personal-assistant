import type { SubAgentDefinition } from '@raven/shared';

export type AgentBackend = (opts: BackendOptions) => Promise<BackendResult>;

export interface ToolUseMeta {
  parentToolUseId?: string | null; // null = main agent, string = sub-agent
  toolUseId?: string; // ID of this tool_use block
}

export interface BackendOptions {
  prompt: string;
  systemPrompt: string;
  allowedTools: string[];
  model: string;
  maxTurns: number;
  mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
  agents: Record<string, SubAgentDefinition>;
  onAssistantMessage: (text: string, meta?: ToolUseMeta) => void;
  onToolUse?: (toolName: string, toolInput: string, meta?: ToolUseMeta) => void;
  onStderr: (data: string) => void;
}

export interface BackendResult {
  sessionId?: string;
  result: string;
  success: boolean;
  errors: string[];
}
