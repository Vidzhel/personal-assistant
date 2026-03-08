import { z } from 'zod';
import type { PermissionTier } from './permissions.ts';
import { PermissionTierSchema } from './permissions.ts';

export interface BaseEvent {
  id: string;
  timestamp: number;
  source: string;
  projectId?: string;
}

export interface NewEmailEvent extends BaseEvent {
  type: 'email:new';
  payload: {
    from: string;
    subject: string;
    snippet: string;
    messageId: string;
    receivedAt: number;
  };
}

export interface ScheduleTriggeredEvent extends BaseEvent {
  type: 'schedule:triggered';
  payload: {
    scheduleId: string;
    scheduleName: string;
    taskType: string;
  };
}

export interface AgentTaskRequestEvent extends BaseEvent {
  type: 'agent:task:request';
  payload: {
    taskId: string;
    prompt: string;
    skillName: string;
    actionName?: string;
    mcpServers: Record<string, McpServerConfig>;
    agentDefinitions?: Record<string, SubAgentDefinition>;
    priority: Priority;
    sessionId?: string;
    projectId?: string;
  };
}

export interface AgentTaskCompleteEvent extends BaseEvent {
  type: 'agent:task:complete';
  payload: {
    taskId: string;
    sessionId?: string;
    result: string;
    durationMs: number;
    success: boolean;
    errors?: string[];
  };
}

export interface AgentMessageEvent extends BaseEvent {
  type: 'agent:message';
  payload: {
    taskId: string;
    sessionId?: string;
    messageType: 'assistant' | 'tool_use' | 'thinking' | 'result';
    content: string;
    messageId?: string;
  };
}

export interface UserChatMessageEvent extends BaseEvent {
  type: 'user:chat:message';
  payload: {
    projectId: string;
    sessionId?: string;
    message: string;
  };
}

export interface NotificationEvent extends BaseEvent {
  type: 'notification';
  payload: {
    channel: 'telegram' | 'web' | 'all';
    title: string;
    body: string;
    actions?: Array<{ label: string; action: string; data?: unknown }>;
  };
}

export interface SkillDataEvent extends BaseEvent {
  type: 'skill:data';
  payload: {
    skillName: string;
    dataType: string;
    data: unknown;
  };
}

export interface ConfigReloadedEvent extends BaseEvent {
  type: 'config:reloaded';
  payload: {
    configType: string;
    timestamp: string;
  };
}

export interface PermissionApprovedEvent extends BaseEvent {
  type: 'permission:approved';
  payload: {
    actionName: string;
    skillName: string;
    tier: PermissionTier;
    sessionId?: string;
  };
}

export interface PermissionBlockedEvent extends BaseEvent {
  type: 'permission:blocked';
  payload: {
    actionName: string;
    skillName: string;
    tier: PermissionTier;
    approvalId: string;
    sessionId?: string;
  };
}

export const PermissionApprovedPayloadSchema = z.object({
  actionName: z.string(),
  skillName: z.string(),
  tier: PermissionTierSchema,
  sessionId: z.string().optional(),
});

export const PermissionBlockedPayloadSchema = z.object({
  actionName: z.string(),
  skillName: z.string(),
  tier: PermissionTierSchema,
  approvalId: z.string(),
  sessionId: z.string().optional(),
});

export interface PermissionDeniedEvent extends BaseEvent {
  type: 'permission:denied';
  payload: {
    actionName: string;
    skillName: string;
    tier: PermissionTier;
    approvalId: string;
    sessionId?: string;
  };
}

export const PermissionDeniedPayloadSchema = z.object({
  actionName: z.string(),
  skillName: z.string(),
  tier: PermissionTierSchema,
  approvalId: z.string(),
  sessionId: z.string().optional(),
});

export interface SystemHealthAlertEvent extends BaseEvent {
  type: 'system:health:alert';
  payload: {
    severity: 'warning' | 'error' | 'critical';
    source: string;
    message: string;
    taskId?: string;
  };
}

export const SystemHealthAlertPayloadSchema = z.object({
  severity: z.enum(['warning', 'error', 'critical']),
  source: z.string(),
  message: z.string(),
  taskId: z.string().optional(),
});

export type RavenEvent =
  | NewEmailEvent
  | ScheduleTriggeredEvent
  | AgentTaskRequestEvent
  | AgentTaskCompleteEvent
  | AgentMessageEvent
  | UserChatMessageEvent
  | NotificationEvent
  | SkillDataEvent
  | ConfigReloadedEvent
  | PermissionApprovedEvent
  | PermissionBlockedEvent
  | PermissionDeniedEvent
  | SystemHealthAlertEvent;

export type RavenEventType = RavenEvent['type'];

export type Priority = 'low' | 'normal' | 'high' | 'urgent';

export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface SubAgentDefinition {
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
}
