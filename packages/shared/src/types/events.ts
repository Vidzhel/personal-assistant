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

export type RavenEvent =
  | NewEmailEvent
  | ScheduleTriggeredEvent
  | AgentTaskRequestEvent
  | AgentTaskCompleteEvent
  | AgentMessageEvent
  | UserChatMessageEvent
  | NotificationEvent
  | SkillDataEvent
  | ConfigReloadedEvent;

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
