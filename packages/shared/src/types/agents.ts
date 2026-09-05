import { z } from 'zod';
import type { McpServerConfig, SubAgentDefinition, Priority } from './events.ts';
import type { BashAccess } from './project-fs.ts';
import { BashAccessSchema } from '../project/schemas.ts';

const MAX_AGENT_TURNS = 100;

/** The model tiers accepted in an agent definition.  Runtime dispatch maps
 * these stable tiers to SDK model identifiers before reserving budget. */
export const NAMED_AGENT_MODEL_TIERS = ['haiku', 'sonnet', 'opus'] as const;
export type NamedAgentModelTier = (typeof NAMED_AGENT_MODEL_TIERS)[number];

export interface NamedAgent {
  id: string;
  name: string;
  /** Stable project identity for local agents; global agents omit this. */
  projectId?: string;
  /** Hash of the current definition bytes and its canonical identity path. */
  definitionRevision?: string;
  description: string | null;
  instructions: string | null;
  skills: string[]; // references library skill names
  model: string | null;
  maxTurns: number | null;
  bash?: BashAccess;
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
  skills: z.array(z.string()).default([]),
  model: z.enum(NAMED_AGENT_MODEL_TIERS).optional(),
  maxTurns: z.number().int().min(1).max(MAX_AGENT_TURNS).optional(),
  bash: BashAccessSchema.optional(),
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
  skills: z.array(z.string()).optional(),
  model: z.enum(NAMED_AGENT_MODEL_TIERS).nullable().optional(),
  maxTurns: z.number().int().min(1).max(MAX_AGENT_TURNS).nullable().optional(),
  bash: BashAccessSchema.optional(),
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

export interface CandidateBubble {
  title: string;
  content: string;
  tags: string[];
  confidence: 'high' | 'low';
  sourceDescription: string;
}

export interface SessionRetrospectiveResult {
  sessionId: string;
  projectId: string;
  summary: string;
  decisions: string[];
  findings: string[];
  actionItems: string[];
  candidateBubbles: CandidateBubble[];
  bubblesCreated: number;
  bubblesDrafted: number;
  memoryCandidatesWritten: number;
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
  projectContextChain?: string;
  taskBoardContext?: string;
  /** Named agent's persona instructions, rendered into the system prompt by
   * prompt-builder.ts (stable per named agent, not per message) — see
   * orchestrator.ts handleUserChat. Moved out of the per-turn user prompt so
   * SDK session resume doesn't re-teach it every turn. */
  namedAgentInstructions?: string;
  /** Rendered text from system-access-gate.ts's resolveSystemAccessInstructions
   * for this project's system access level; rendered into the system prompt
   * by prompt-builder.ts for the same reason as namedAgentInstructions. */
  systemAccessInstructions?: string;
  namedAgentId?: string;
  /** Effective SDK model identifier selected from the named-agent tier. */
  model?: string;
  /** Validated per-dispatch turn cap from the named-agent definition. */
  maxTurns?: number;
  treeId?: string;
  executionTaskId?: string;
  plugins?: Array<{ type: 'local'; path: string }>;
  bashAccess?: BashAccess;
  /** Set only by runtime-internal dispatchers (create-validation-deps.ts) —
   * see AgentTaskRequestEvent.payload.internal in events.ts. */
  internal?: 'validator';
  /** Set only by AgentManager.executeAction on the synthetic
   * re-dispatch task created after a human approves a red-tier action (see
   * agent-manager.ts). Equals `actionName` on that one task. Both
   * agent-session.ts's pre-execution gate and the canUseTool tool-policy
   * (permission-engine/tool-policy.ts) treat a matching actionName as
   * pre-approved rather than re-resolving its tier — otherwise the re-run
   * would hit the same red tier and get queued for approval again, forever. */
  approvedActionName?: string;
  result?: string;
  durationMs?: number;
  errors?: string[];
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}
