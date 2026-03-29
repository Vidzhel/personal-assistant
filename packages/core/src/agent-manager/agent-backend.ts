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
  mcpServers: Record<string, unknown>;
  agents: Record<string, SubAgentDefinition>;
  plugins?: Array<{ type: 'local'; path: string }>;
  onAssistantMessage: (text: string, meta?: ToolUseMeta) => void;
  onToolUse?: (toolName: string, toolInput: string, meta?: ToolUseMeta) => void;
  onToolResult?: (result: {
    toolUseId: string;
    output: string;
    isError: boolean;
    meta?: ToolUseMeta;
  }) => void;
  onRawMessage?: (rawJson: string) => void;
  signal?: AbortSignal;
  onStderr: (data: string) => void;
  cwd?: string;
}

export interface BackendResult {
  sessionId?: string;
  result: string;
  success: boolean;
  errors: string[];
}
