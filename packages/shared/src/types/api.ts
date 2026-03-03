import type { AgentMessageEvent, RavenEvent, AgentSession } from './index.ts';

export type WsMessageToClient =
  | { type: 'agent:message'; data: AgentMessageEvent['payload'] }
  | { type: 'agent:status'; data: { taskId: string; status: string } }
  | { type: 'event'; data: RavenEvent }
  | { type: 'notification'; data: { title: string; body: string } }
  | { type: 'session:update'; data: AgentSession };

export type WsMessageFromClient =
  | { type: 'subscribe'; channels: string[] }
  | { type: 'unsubscribe'; channels: string[] }
  | {
      type: 'chat:send';
      projectId: string;
      message: string;
      sessionId?: string;
    };

export interface ScheduleRecord {
  id: string;
  name: string;
  cron: string;
  timezone: string;
  taskType: string;
  skillName: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}
