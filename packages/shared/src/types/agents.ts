import { z } from 'zod';
import type { McpServerConfig, SubAgentDefinition, Priority } from './events.ts';

export interface NamedAgent {
  id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  suiteIds: string[];
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export const NamedAgentCreateInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Must be kebab-case'),
  description: z.string().optional(),
  instructions: z.string().optional(),
  suiteIds: z.array(z.string()).default([]),
});

export type NamedAgentCreateInput = z.infer<typeof NamedAgentCreateInputSchema>;

export const NamedAgentUpdateInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Must be kebab-case')
    .optional(),
  description: z.string().nullable().optional(),
  instructions: z.string().nullable().optional(),
  suiteIds: z.array(z.string()).optional(),
});

export type NamedAgentUpdateInput = z.infer<typeof NamedAgentUpdateInputSchema>;

export interface AgentSession {
  id: string;
  sdkSessionId?: string;
  projectId: string;
  status: 'idle' | 'running' | 'completed' | 'error';
  createdAt: number;
  lastActiveAt: number;
  turnCount: number;
  currentTaskId?: string;
  name?: string;
  description?: string;
  pinned?: boolean;
  summary?: string;
}

export interface SessionReference {
  id: string;
  sourceSessionId: string;
  targetSessionId: string;
  context?: string;
  createdAt: string;
}

export interface AgentTask {
  id: string;
  sessionId?: string;
  projectId?: string;
  skillName: string;
  actionName?: string;
  prompt: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled';
  priority: Priority;
  mcpServers: Record<string, McpServerConfig>;
  agentDefinitions: Record<string, SubAgentDefinition>;
  knowledgeContext?: string;
  sessionReferencesContext?: string;
  namedAgentId?: string;
  result?: string;
  durationMs?: number;
  errors?: string[];
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}
