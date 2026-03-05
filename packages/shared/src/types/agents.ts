import type { McpServerConfig, SubAgentDefinition, Priority } from './events.ts';

export interface AgentSession {
  id: string;
  sdkSessionId?: string;
  projectId: string;
  status: 'idle' | 'running' | 'completed' | 'error';
  createdAt: number;
  lastActiveAt: number;
  turnCount: number;
  currentTaskId?: string;
}

export interface AgentTask {
  id: string;
  sessionId?: string;
  projectId?: string;
  skillName: string;
  actionName?: string;
  prompt: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  priority: Priority;
  mcpServers: Record<string, McpServerConfig>;
  agentDefinitions: Record<string, SubAgentDefinition>;
  result?: string;
  durationMs?: number;
  errors?: string[];
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}
