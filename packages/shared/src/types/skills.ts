import type { McpServerConfig, SubAgentDefinition, AgentTaskRequestEvent } from './events.ts';

export interface SkillManifest {
  name: string;
  displayName: string;
  version: string;
  description: string;
  capabilities: SkillCapability[];
  configSchema?: Record<string, unknown>;
  defaultSchedules?: SkillScheduleDefinition[];
}

export type SkillCapability =
  | 'mcp-server'
  | 'event-source'
  | 'agent-definition'
  | 'data-provider'
  | 'notification-sink';

export interface SkillScheduleDefinition {
  id: string;
  name: string;
  cron: string;
  taskType: string;
  enabled: boolean;
}

export interface SkillContext {
  eventBus: EventBusInterface;
  db: DatabaseInterface;
  config: Record<string, unknown>;
  logger: LoggerInterface;
  getSkillData: (skillName: string, dataType: string) => Promise<unknown>;
}

export interface EventBusInterface {
  emit(event: unknown): void;
  on(type: string, handler: (event: unknown) => void): void;
  off(type: string, handler: (event: unknown) => void): void;
}

export interface DatabaseInterface {
  run(sql: string, ...params: unknown[]): void;
  get<T>(sql: string, ...params: unknown[]): T | undefined;
  all<T>(sql: string, ...params: unknown[]): T[];
}

export interface LoggerInterface {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

export interface DigestSection {
  skillName: string;
  title: string;
  priority: number;
  markdownContent: string;
  items?: DigestItem[];
}

export interface DigestItem {
  type: 'task' | 'email' | 'event' | 'reminder' | 'custom';
  title: string;
  detail?: string;
  dueDate?: string;
  priority?: 'low' | 'medium' | 'high';
  actionable?: boolean;
}

export type AgentTaskPayload = AgentTaskRequestEvent['payload'];

export interface RavenSkill {
  manifest: SkillManifest;
  initialize(context: SkillContext): Promise<void>;
  shutdown(): Promise<void>;
  getMcpServers(): Record<string, McpServerConfig>;
  getAgentDefinitions(): Record<string, SubAgentDefinition>;
  handleScheduledTask(
    taskType: string,
    context: SkillContext,
  ): Promise<AgentTaskPayload | undefined>;
  getDataForDigest?(): Promise<DigestSection>;
}
