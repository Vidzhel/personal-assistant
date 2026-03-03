import {
  createLogger,
  generateId,
  type NewEmailEvent,
  type ScheduleTriggeredEvent,
  type UserChatMessageEvent,
  type McpServerConfig,
  type SubAgentDefinition,
} from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.js';
import type { SkillRegistry } from '../skill-registry/skill-registry.js';
import type { McpManager } from '../mcp-manager/mcp-manager.js';
import { getDb } from '../db/database.js';

const log = createLogger('orchestrator');

/**
 * The Orchestrator subscribes to events and routes them to appropriate skill sub-agents.
 *
 * CRITICAL: The orchestrator itself has NO MCP servers.
 * It delegates to skill-specific sub-agents that carry their own MCPs.
 */
export class Orchestrator {
  constructor(
    private eventBus: EventBus,
    private skillRegistry: SkillRegistry,
    private mcpManager: McpManager,
  ) {
    this.eventBus.on<NewEmailEvent>('email:new', (e) => this.handleNewEmail(e));
    this.eventBus.on<ScheduleTriggeredEvent>('schedule:triggered', (e) => this.handleSchedule(e));
    this.eventBus.on<UserChatMessageEvent>('user:chat:message', (e) => this.handleUserChat(e));

    log.info('Orchestrator initialized');
  }

  private handleNewEmail(event: NewEmailEvent): void {
    const { from, subject, snippet } = event.payload;
    log.info(`New email from ${from}: ${subject}`);

    // Spawn a gmail sub-agent to analyze the email
    const gmailSkill = this.skillRegistry.getSkill('gmail');
    if (!gmailSkill) {
      log.warn('Gmail skill not available, ignoring email event');
      return;
    }

    const mcpServers = gmailSkill.getMcpServers();
    const taskId = generateId();

    this.eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'orchestrator',
      type: 'agent:task:request',
      payload: {
        taskId,
        prompt: [
          `A new email has arrived. Analyze it and determine if any action is needed.`,
          ``,
          `From: ${from}`,
          `Subject: ${subject}`,
          `Preview: ${snippet}`,
          ``,
          `Use the Gmail tools to read the full email if needed.`,
          `Provide a brief summary and indicate if this requires user action.`,
        ].join('\n'),
        skillName: 'gmail',
        mcpServers,
        priority: 'normal',
        projectId: event.projectId,
      },
    });
  }

  private async handleSchedule(event: ScheduleTriggeredEvent): Promise<void> {
    const { taskType, scheduleName } = event.payload;
    log.info(`Schedule triggered: ${scheduleName} (${taskType})`);

    const skill = this.skillRegistry.findSkillForTaskType(taskType);
    if (!skill) {
      log.warn(`No skill found for task type: ${taskType}`);
      return;
    }

    // Let the skill handle the scheduled task - it returns an agent task payload
    // or void if it handled it internally
    const payload = await skill.handleScheduledTask(taskType, {
      eventBus: {
        emit: (event: unknown) => this.eventBus.emit(event as import('@raven/shared').RavenEvent),
        on: (type: string, handler: (event: unknown) => void) => this.eventBus.on(type as import('@raven/shared').RavenEventType, handler),
        off: (type: string, handler: (event: unknown) => void) => this.eventBus.off(type as import('@raven/shared').RavenEventType, handler),
      },
      db: (() => {
        const db = getDb();
        return {
          run: (sql: string, ...p: unknown[]) => db.prepare(sql).run(...p),
          get: <T>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as T | undefined,
          all: <T>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[],
        };
      })(),
      config: {},
      logger: log,
      getSkillData: async () => null,
    });

    if (payload) {
      this.eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: 'orchestrator',
        type: 'agent:task:request',
        payload,
      });
    }
  }

  private handleUserChat(event: UserChatMessageEvent): void {
    const { projectId, message, sessionId } = event.payload;
    log.info(`User chat in project ${projectId}: ${message.slice(0, 100)}`);

    // Look up the project to know which skills are enabled
    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
      | { skills: string } | undefined;

    const enabledSkills = project
      ? (JSON.parse(project.skills) as string[])
      : this.skillRegistry.getEnabledSkillNames();

    // Collect sub-agent definitions from all enabled skills.
    // The orchestrator agent itself has NO MCPs - it delegates via Task tool to sub-agents.
    const agentDefinitions = this.skillRegistry.collectAgentDefinitions(enabledSkills);

    const taskId = generateId();

    this.eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'orchestrator',
      projectId,
      type: 'agent:task:request',
      payload: {
        taskId,
        prompt: message,
        skillName: 'orchestrator',
        mcpServers: {},  // NO MCPs on the orchestrator agent
        agentDefinitions, // Sub-agents carry the MCPs
        priority: 'high',
        sessionId,
        projectId,
      },
    });
  }
}
