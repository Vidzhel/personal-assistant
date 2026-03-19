import {
  createLogger,
  generateId,
  SUITE_EMAIL,
  SOURCE_ORCHESTRATOR,
  SKILL_ORCHESTRATOR,
  type NewEmailEvent,
  type ScheduleTriggeredEvent,
  type UserChatMessageEvent,
} from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { SuiteRegistry } from '../suite-registry/suite-registry.ts';
import type { SessionManager } from '../session-manager/session-manager.ts';
import type { MessageStore } from '../session-manager/message-store.ts';
import type { ContextInjector } from '../knowledge-engine/context-injector.ts';
import type { Retrospective } from '../knowledge-engine/retrospective.ts';
import { createKnowledgeAgentDefinition } from '../knowledge-engine/knowledge-agent.ts';
import { getDb } from '../db/database.ts';

const log = createLogger('orchestrator');

const LOG_MESSAGE_PREVIEW_LENGTH = 100;

export interface OrchestratorDeps {
  eventBus: EventBus;
  suiteRegistry: SuiteRegistry;
  sessionManager: SessionManager;
  messageStore: MessageStore;
  contextInjector?: ContextInjector;
  retrospective?: Retrospective;
  port: number;
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
  private contextInjector?: ContextInjector;
  private retrospective?: Retrospective;
  private port: number;

  constructor(deps: OrchestratorDeps) {
    this.eventBus = deps.eventBus;
    this.suiteRegistry = deps.suiteRegistry;
    this.sessionManager = deps.sessionManager;
    this.messageStore = deps.messageStore;
    this.contextInjector = deps.contextInjector;
    this.retrospective = deps.retrospective;
    this.port = deps.port;
    this.eventBus.on<NewEmailEvent>('email:new', (e) => {
      this.handleNewEmail(e).catch((err: unknown) => log.error(`handleNewEmail failed: ${err}`));
    });
    this.eventBus.on<ScheduleTriggeredEvent>('schedule:triggered', (e) => {
      this.handleSchedule(e).catch((err: unknown) => log.error(`handleSchedule failed: ${err}`));
    });
    this.eventBus.on<UserChatMessageEvent>('user:chat:message', (e) => {
      this.handleUserChat(e).catch((err: unknown) => log.error(`handleUserChat failed: ${err}`));
    });

    log.info('Orchestrator initialized');
  }

  private async handleNewEmail(event: NewEmailEvent): Promise<void> {
    const { from, subject, snippet } = event.payload;
    log.info(`New email from ${from}: ${subject}`);

    const emailSuite = this.suiteRegistry.getSuite(SUITE_EMAIL);
    if (!emailSuite) {
      log.warn('Email suite not available, ignoring email event');
      return;
    }

    // Pervasive context injection: query from email subject + sender + snippet
    let knowledgeContext: string | undefined;
    if (this.contextInjector) {
      try {
        const query = `${subject} ${from} ${snippet}`;
        const ctx = await this.contextInjector.retrieveContext(query);
        if (ctx) {
          knowledgeContext = this.contextInjector.formatContext(ctx);
        }
      } catch (err) {
        log.warn(`Knowledge context retrieval failed for email: ${err}`);
      }
    }

    const mcpServers = emailSuite.mcpServers;
    const taskId = generateId();

    this.eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: SOURCE_ORCHESTRATOR,
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
        skillName: SUITE_EMAIL,
        mcpServers,
        knowledgeContext,
        priority: 'normal',
        projectId: event.projectId,
      },
    });
  }

  private async handleSchedule(event: ScheduleTriggeredEvent): Promise<void> {
    const { taskType, scheduleName } = event.payload;
    log.info(`Schedule triggered: ${scheduleName} (${taskType})`);

    // Handle knowledge:retrospective inline — no agent needed, just run summary + stale detection
    if (taskType === 'knowledge:retrospective') {
      if (!this.retrospective) {
        log.warn('Retrospective not available, ignoring schedule trigger');
        return;
      }
      await this.retrospective.runFullRetrospective();
      return;
    }

    const suite = this.suiteRegistry.findSuiteForTaskType(taskType);
    if (!suite) {
      log.warn(`No suite found for task type: ${taskType}`);
      return;
    }

    // Pervasive context injection: query from schedule name + task type
    let knowledgeContext: string | undefined;
    if (this.contextInjector) {
      try {
        const query = `${scheduleName} ${taskType}`;
        const ctx = await this.contextInjector.retrieveContext(query);
        if (ctx) {
          knowledgeContext = this.contextInjector.formatContext(ctx);
        }
      } catch (err) {
        log.warn(`Knowledge context retrieval failed for schedule: ${err}`);
      }
    }

    // Collect agent definitions and MCPs from all enabled suites
    // so the scheduled agent can delegate to other suites' agents
    const agentDefinitions = this.suiteRegistry.collectAgentDefinitions();
    const mcpServers = this.suiteRegistry.collectMcpServers();

    const taskId = generateId();

    this.eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: SOURCE_ORCHESTRATOR,
      type: 'agent:task:request',
      payload: {
        taskId,
        prompt: `Execute the scheduled task: ${scheduleName} (type: ${taskType}).`,
        skillName: suite.manifest.name,
        mcpServers,
        agentDefinitions,
        knowledgeContext,
        priority: 'normal',
      },
    });
  }

  /** Ensure a project row exists for auto-created project IDs (e.g. Telegram topics). */
  private ensureProject(projectId: string): void {
    const db = getDb();
    const exists = db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId);
    if (!exists) {
      const now = Date.now();
      db.prepare(
        'INSERT INTO projects (id, name, description, skills, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(projectId, projectId, 'Auto-created from Telegram', '[]', now, now);
      log.info(`Auto-created project "${projectId}"`);
    }
  }

  // eslint-disable-next-line max-lines-per-function -- async handler with context injection and knowledge agent merging
  private async handleUserChat(event: UserChatMessageEvent): Promise<void> {
    const { projectId, sessionId, message, topicId, topicName } = event.payload;
    log.info(`User chat in project ${projectId}: ${message.slice(0, LOG_MESSAGE_PREVIEW_LENGTH)}`);

    // Ensure the project exists (Telegram messages may reference auto-generated project IDs)
    this.ensureProject(projectId);

    // Use the specific session if provided, otherwise fall back to getOrCreateSession
    const session =
      (sessionId && this.sessionManager.getSession(sessionId)) ||
      this.sessionManager.getOrCreateSession(projectId);
    this.sessionManager.updateStatus(session.id, 'running');

    // Store the user message
    this.messageStore.appendMessage(session.id, {
      role: 'user',
      content: message,
    });

    // Pervasive context injection: query from user message text
    let knowledgeContext: string | undefined;
    if (this.contextInjector) {
      try {
        const ctx = await this.contextInjector.retrieveContext(message);
        if (ctx) {
          knowledgeContext = this.contextInjector.formatContext(ctx);
        }
      } catch (err) {
        log.warn(`Knowledge context retrieval failed, proceeding without: ${err}`);
      }
    }

    // Collect sub-agent definitions from all enabled suites.
    // The orchestrator agent itself has NO MCPs - it delegates via Agent tool to sub-agents.
    const agentDefinitions = this.suiteRegistry.collectAgentDefinitions();

    // Merge knowledge agent into agent definitions
    agentDefinitions['knowledge-agent'] = createKnowledgeAgentDefinition(this.port);

    // Build prompt with topic context and media context if available
    let prompt = message;
    if (topicName) {
      prompt = `[Context: This message is from the '${topicName}' topic thread (topicId: ${topicId})]\n\n${message}`;
    }
    const mediaAttachment = event.payload.mediaAttachment;
    if (mediaAttachment) {
      prompt += `\n\n[Media file available on disk: ${mediaAttachment.filePath} (${mediaAttachment.fileName}, ${mediaAttachment.mimeType}, ${mediaAttachment.type})]`;
    }

    const taskId = generateId();

    this.eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: SOURCE_ORCHESTRATOR,
      projectId,
      type: 'agent:task:request',
      payload: {
        taskId,
        prompt,
        skillName: SKILL_ORCHESTRATOR,
        mcpServers: this.suiteRegistry.collectMcpServers(), // Declared for SDK to spawn; only sub-agents use them
        agentDefinitions, // Sub-agents carry the MCPs + knowledge agent
        knowledgeContext,
        priority: 'high',
        sessionId: session.id,
        projectId,
      },
    });
  }
}
