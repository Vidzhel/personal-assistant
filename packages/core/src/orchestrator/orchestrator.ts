import {
  createLogger,
  generateId,
  type NewEmailEvent,
  type ScheduleTriggeredEvent,
  type UserChatMessageEvent,
} from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { SuiteRegistry } from '../suite-registry/suite-registry.ts';
import type { SessionManager } from '../session-manager/session-manager.ts';
import type { MessageStore } from '../session-manager/message-store.ts';

const log = createLogger('orchestrator');

export interface OrchestratorDeps {
  eventBus: EventBus;
  suiteRegistry: SuiteRegistry;
  sessionManager: SessionManager;
  messageStore: MessageStore;
}

/**
 * The Orchestrator subscribes to events and routes them to appropriate suite agents.
 *
 * CRITICAL: The orchestrator itself has NO MCP servers.
 * It delegates to suite-specific sub-agents that carry their own MCPs.
 */
export class Orchestrator {
  private eventBus: EventBus;
  private suiteRegistry: SuiteRegistry;
  private sessionManager: SessionManager;
  private messageStore: MessageStore;

  constructor(deps: OrchestratorDeps) {
    this.eventBus = deps.eventBus;
    this.suiteRegistry = deps.suiteRegistry;
    this.sessionManager = deps.sessionManager;
    this.messageStore = deps.messageStore;
    this.eventBus.on<NewEmailEvent>('email:new', (e) => this.handleNewEmail(e));
    this.eventBus.on<ScheduleTriggeredEvent>('schedule:triggered', (e) => this.handleSchedule(e));
    this.eventBus.on<UserChatMessageEvent>('user:chat:message', (e) => this.handleUserChat(e));

    log.info('Orchestrator initialized');
  }

  private handleNewEmail(event: NewEmailEvent): void {
    const { from, subject, snippet } = event.payload;
    log.info(`New email from ${from}: ${subject}`);

    const emailSuite = this.suiteRegistry.getSuite('email');
    if (!emailSuite) {
      log.warn('Email suite not available, ignoring email event');
      return;
    }

    const mcpServers = emailSuite.mcpServers;
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
        skillName: 'email',
        mcpServers,
        priority: 'normal',
        projectId: event.projectId,
      },
    });
  }

  private handleSchedule(event: ScheduleTriggeredEvent): void {
    const { taskType, scheduleName } = event.payload;
    log.info(`Schedule triggered: ${scheduleName} (${taskType})`);

    const suite = this.suiteRegistry.findSuiteForTaskType(taskType);
    if (!suite) {
      log.warn(`No suite found for task type: ${taskType}`);
      return;
    }

    // Collect agent definitions and MCPs from all enabled suites
    // so the scheduled agent can delegate to other suites' agents
    const agentDefinitions = this.suiteRegistry.collectAgentDefinitions();
    const mcpServers = this.suiteRegistry.collectMcpServers();

    const taskId = generateId();

    this.eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'orchestrator',
      type: 'agent:task:request',
      payload: {
        taskId,
        prompt: `Execute the scheduled task: ${scheduleName} (type: ${taskType}).`,
        skillName: suite.manifest.name,
        mcpServers,
        agentDefinitions,
        priority: 'normal',
      },
    });
  }

  private handleUserChat(event: UserChatMessageEvent): void {
    const { projectId, message } = event.payload;
    log.info(`User chat in project ${projectId}: ${message.slice(0, 100)}`);

    // Get or create a session for this project
    const session = this.sessionManager.getOrCreateSession(projectId);
    this.sessionManager.updateStatus(session.id, 'running');

    // Store the user message
    this.messageStore.appendMessage(session.id, {
      role: 'user',
      content: message,
    });

    // Collect sub-agent definitions from all enabled suites.
    // The orchestrator agent itself has NO MCPs - it delegates via Agent tool to sub-agents.
    const agentDefinitions = this.suiteRegistry.collectAgentDefinitions();

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
        mcpServers: this.suiteRegistry.collectMcpServers(), // Declared for SDK to spawn; only sub-agents use them
        agentDefinitions, // Sub-agents carry the MCPs
        priority: 'high',
        sessionId: session.id,
        projectId,
      },
    });
  }
}
