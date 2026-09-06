import {
  createLogger,
  generateId,
  HTTP_STATUS,
  SOURCE_ORCHESTRATOR,
  SKILL_ORCHESTRATOR,
  type NewEmailEvent,
  type UserChatMessageEvent,
  type Project,
  type SystemAccessLevel,
} from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { SessionManager } from '../session-manager/session-manager.ts';
import type { MessageStore } from '../session-manager/message-store.ts';
import type { SessionRetrospective } from '../session-manager/session-retrospective.ts';
import type { NamedAgentStore } from '../agent-registry/yaml-named-agent-store.ts';
import {
  resolveDefaultAgentCapabilities,
  resolveAgentExecutionSettings,
  type AgentResolver,
  type ResolvedDefaultAgent,
} from '../agent-registry/agent-resolver.ts';
import type { CapabilityLibrary } from '../capability-library/capability-library.ts';
import type { ProjectRegistry } from '../project-registry/project-registry.ts';
import type { ScaffoldingApi } from '../scaffolding/scaffolding-api.ts';
import { getDb } from '../db/database.ts';
import { getConfig } from '../config.ts';
import { resolveSystemAccessInstructions } from '../project-manager/system-access-gate.ts';
import { createAuditLog } from '../permission-engine/audit-log.ts';
import { validateChatTarget } from '../session-manager/chat-validation.ts';
import { assertActiveProject } from '../project-manager/project-active.ts';
import { createManagedProject } from '../project-manager/project-lifecycle.ts';
import { ProjectMutationError } from '../project-manager/project-mutation.ts';

const log = createLogger('orchestrator');

const LOG_MESSAGE_PREVIEW_LENGTH = 100;
// Library skill name for Gmail (library/skills/communication/email/gmail/config.json) —
// distinct from the retired suite name 'email'.
const GMAIL_SKILL = 'gmail';

export interface OrchestratorDeps {
  eventBus: EventBus;
  sessionManager: SessionManager;
  messageStore: MessageStore;
  sessionRetrospective?: SessionRetrospective;
  namedAgentStore?: NamedAgentStore;
  agentResolver?: AgentResolver;
  capabilityLibrary?: CapabilityLibrary;
  projectRegistry?: ProjectRegistry;
  scaffoldingApi?: ScaffoldingApi;
  projectsDir?: string;
  port: number;
}

/**
 * Routes events to agents with explicit capability bindings. Raven MCP tools
 * are separately scoped to each task by agent-session.
 */
export class Orchestrator {
  private eventBus: EventBus;
  private sessionManager: SessionManager;
  private messageStore: MessageStore;
  private sessionRetrospective?: SessionRetrospective;
  private namedAgentStore?: NamedAgentStore;
  private agentResolver?: AgentResolver;
  private capabilityLibrary?: CapabilityLibrary;
  private projectRegistry?: ProjectRegistry;
  private scaffoldingApi?: ScaffoldingApi;
  private projectsDir?: string;
  private port: number;
  private lifetime = new AbortController();
  private pending = new Set<Promise<void>>();
  private readonly emailHandler = (event: NewEmailEvent): void => {
    if (!this.lifetime.signal.aborted) this.track(() => this.handleNewEmail(event));
  };
  private readonly chatHandler = (event: UserChatMessageEvent): void => {
    if (!this.lifetime.signal.aborted) this.track(() => this.handleUserChat(event));
  };

  constructor(deps: OrchestratorDeps) {
    this.eventBus = deps.eventBus;
    this.sessionManager = deps.sessionManager;
    this.messageStore = deps.messageStore;
    this.sessionRetrospective = deps.sessionRetrospective;
    this.namedAgentStore = deps.namedAgentStore;
    this.agentResolver = deps.agentResolver;
    this.capabilityLibrary = deps.capabilityLibrary;
    this.projectRegistry = deps.projectRegistry;
    this.scaffoldingApi = deps.scaffoldingApi;
    this.projectsDir = deps.projectsDir;
    this.port = deps.port;
    this.eventBus.on('email:new', this.emailHandler);
    this.eventBus.on('user:chat:message', this.chatHandler);

    log.info('Orchestrator initialized');
  }

  private track(work: () => Promise<void>): void {
    // Register before work begins: a synchronous event listener may call stop().
    const observed = Promise.resolve()
      .then(work)
      .catch((err: unknown) => {
        if (!this.lifetime.signal.aborted) log.error(`Orchestrator event failed: ${err}`);
      });
    this.pending.add(observed);
    void observed.finally(() => this.pending.delete(observed));
  }

  /** Detach intake immediately, then let admitted filesystem work settle while stores are open. */
  async stop(): Promise<void> {
    this.lifetime.abort(new Error('Raven is stopping'));
    this.eventBus.off('email:new', this.emailHandler);
    this.eventBus.off('user:chat:message', this.chatHandler);
    await Promise.allSettled([...this.pending]);
  }

  private async handleNewEmail(event: NewEmailEvent): Promise<void> {
    if (this.lifetime.signal.aborted) return;
    const { from, subject, snippet } = event.payload;
    log.info(`New email from ${from}: ${subject}`);

    if (!this.capabilityLibrary) {
      log.warn('Capability library not available, ignoring email event');
      return;
    }

    // Library skill name for Gmail — see library/skills/communication/email/gmail
    const mcpServers = this.capabilityLibrary.collectMcpServers([GMAIL_SKILL]);
    const plugins = this.capabilityLibrary.resolveVendorPlugins([GMAIL_SKILL]);
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
        skillName: GMAIL_SKILL,
        mcpServers,
        plugins,
        priority: 'normal',
        projectId: event.projectId,
      },
    });
  }

  /**
   * Existing project IDs must already be linked to a definition. A missing
   * ID may create a managed definition through the normal lifecycle when
   * project definition storage is available; no cache-only project is ever
   * inserted when that storage is unavailable.
   */
  private async ensureProject(projectId: string, topicName: string | undefined): Promise<void> {
    const db = getDb();
    const existing = db.prepare('SELECT fs_path FROM projects WHERE id = ?').get(projectId) as
      { fs_path: string | null } | undefined;
    if (existing) {
      assertActiveProject(db, projectId);
      return;
    }
    const { projectRegistry, scaffoldingApi, projectsDir } = this;
    if (!projectRegistry || !scaffoldingApi || !projectsDir) {
      throw new ProjectMutationError(
        'Project definition storage is unavailable',
        HTTP_STATUS.SERVICE_UNAVAILABLE,
      );
    }

    await createManagedProject(
      { db, projectRegistry, scaffoldingApi, projectsDir },
      { name: topicName ?? 'Inbox', systemAccess: 'none' },
      projectId,
    );
  }

  private rejectChat(event: UserChatMessageEvent, error: string): void {
    const { projectId, sessionId } = event.payload;
    this.eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: SOURCE_ORCHESTRATOR,
      type: 'user:chat:rejected',
      projectId,
      payload: { requestId: event.payload.requestId ?? event.id, projectId, sessionId, error },
    });
  }

  // eslint-disable-next-line max-lines-per-function, complexity -- async handler with project context, capability resolution, and session dispatch
  private async handleUserChat(event: UserChatMessageEvent): Promise<void> {
    if (this.lifetime.signal.aborted) {
      this.rejectChat(event, 'Raven is stopping. Your message was not accepted.');
      return;
    }
    const { projectId, sessionId, message, topicId, topicName } = event.payload;
    log.info(`User chat in project ${projectId}: ${message.slice(0, LOG_MESSAGE_PREVIEW_LENGTH)}`);

    let capabilities: ResolvedDefaultAgent;
    let executionSettings: { model: string; maxTurns: number };
    try {
      capabilities = resolveDefaultAgentCapabilities({
        namedAgentStore: this.namedAgentStore,
        agentResolver: this.agentResolver,
        projectId: getDb().prepare('SELECT id FROM projects WHERE id = ?').get(projectId)
          ? projectId
          : undefined,
      });
      executionSettings = resolveAgentExecutionSettings({
        model: capabilities.namedAgentModel,
        maxTurns: capabilities.namedAgentMaxTurns,
        defaults: {
          model: getConfig().CLAUDE_MODEL,
          maxTurns: getConfig().RAVEN_AGENT_MAX_TURNS,
        },
      });
    } catch (error) {
      this.rejectChat(event, `Agent capability resolution failed: ${String(error)}`);
      return;
    }
    const { agentDefinitions, mcpServers, plugins, namedAgentInstructions, namedAgentId } =
      capabilities;

    // Only new conversations may create a project, before the session FK is written.
    // Explicit session IDs must never select a replacement conversation.
    try {
      if (sessionId === undefined) await this.ensureProject(projectId, topicName);
    } catch (error) {
      this.rejectChat(event, `Project creation failed: ${String(error)}`);
      return;
    }
    if (this.lifetime.signal.aborted) {
      this.rejectChat(event, 'Raven is stopping. Your message was not accepted.');
      return;
    }

    const target = validateChatTarget(this.sessionManager, projectId, {
      sessionId,
      projectRegistry: this.projectRegistry,
    });
    if (!target.ok) {
      this.rejectChat(event, target.error);
      return;
    }
    const session = target.session ?? this.sessionManager.getOrCreateSession(projectId);

    // Store the user message
    const stored = this.messageStore.appendMessage(session.id, {
      role: 'user',
      content: message,
    });
    if (!stored) {
      this.rejectChat(event, 'Could not save your message. Please try again.');
      return;
    }
    this.sessionManager.updateStatus(session.id, 'running');
    if (event.payload.requestId) {
      this.eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: SOURCE_ORCHESTRATOR,
        type: 'user:chat:accepted',
        projectId,
        payload: {
          requestId: event.payload.requestId,
          projectId,
          sessionId: session.id,
          messageId: stored,
        },
      });
    }

    if (this.lifetime.signal.aborted) {
      this.sessionManager.updateStatus(session.id, 'idle');
      return;
    }

    // Check for manual retrospective intent
    const lowerMsg = message.toLowerCase();
    if (
      this.sessionRetrospective &&
      (lowerMsg === 'retrospective' ||
        lowerMsg.includes('summarize this session') ||
        lowerMsg.includes('run retrospective'))
    ) {
      try {
        const result = await this.sessionRetrospective.runRetrospective(
          session.id,
          projectId,
          this.lifetime.signal,
        );
        if (this.lifetime.signal.aborted) {
          this.sessionManager.updateStatus(session.id, 'idle');
          return;
        }
        const retrospectiveReply = `**Session Retrospective**\n\n${result.summary}\n\n**Decisions:** ${result.decisions.length ? result.decisions.join(', ') : 'None'}\n**Findings:** ${result.findings.length ? result.findings.join(', ') : 'None'}\n**Action Items:** ${result.actionItems.length ? result.actionItems.join(', ') : 'None'}`;
        this.messageStore.appendMessage(session.id, {
          role: 'assistant',
          content: retrospectiveReply,
        });
        if (event.payload.transportOrigin) {
          this.eventBus.emit({
            id: generateId(),
            timestamp: Date.now(),
            source: SOURCE_ORCHESTRATOR,
            type: 'notification',
            projectId,
            payload: {
              channel: 'telegram',
              title: 'Raven',
              body: retrospectiveReply,
              destination: { kind: 'project', projectId },
              transportOrigin: event.payload.transportOrigin,
              sessionId: session.id,
              taskId: `retrospective:${event.payload.requestId ?? stored}`,
              urgencyTier: 'green',
              deliveryMode: 'tell-now',
            },
          });
        }
        this.sessionManager.updateStatus(session.id, 'idle');
        return;
      } catch (err) {
        if (this.lifetime.signal.aborted) {
          this.sessionManager.updateStatus(session.id, 'idle');
          return;
        }
        log.error(`Manual retrospective failed: ${err}`);
      }
    }

    // Auto-generate session name on first turn
    if (session.turnCount === 0) {
      this.sessionManager.autoGenerateName(session.id, message);
    }

    const bashAccess = capabilities.bashAccess;

    // Look up project for system access level
    const db = getDb();
    const projectRow = db
      .prepare('SELECT name, system_access, fs_path FROM projects WHERE id = ?')
      .get(projectId) as
      | {
          name: string;
          system_access: string;
          fs_path: string | null;
        }
      | undefined;
    const systemAccess = (projectRow?.system_access ?? 'none') as SystemAccessLevel;
    const projectForAccess: Project = {
      id: projectId,
      name: projectRow?.name ?? projectId,
      skills: [],
      systemAccess,
      createdAt: 0,
      updatedAt: 0,
    };

    // Audit log: record system access configuration (only for non-default access levels)
    if (systemAccess !== 'none') {
      try {
        const auditLog = createAuditLog(db);
        auditLog.insert({
          skillName: SKILL_ORCHESTRATOR,
          actionName: 'system:access:configured',
          permissionTier: 'green',
          outcome: 'executed',
          details: JSON.stringify({
            projectId,
            systemAccess,
            projectName: projectRow?.name ?? projectId,
          }),
        });
      } catch {
        log.warn('Failed to write system access audit entry');
      }
    }

    // Build prompt with only per-turn context (topic thread, media
    // attachment) — the message itself. Stable instructions (agent persona,
    // MCP tool usage, tool-use guidance, system access control) no longer
    // get prepended here; they're rendered into the system prompt by
    // prompt-builder.ts from the fields below instead. With SDK session
    // resume, re-prepending them to the user message every turn would
    // duplicate them into history on top of the fresh copy the system
    // prompt already carries.
    let prompt = message;
    if (topicName) {
      prompt = `[Context: This message is from the '${topicName}' topic thread (topicId: ${topicId})]\n\n${message}`;
    }
    const mediaAttachment = event.payload.mediaAttachment;
    if (mediaAttachment) {
      prompt += `\n\n[Media file available on disk: ${mediaAttachment.filePath} (${mediaAttachment.fileName}, ${mediaAttachment.mimeType}, ${mediaAttachment.type})]`;
    }

    const systemAccessInstructions = resolveSystemAccessInstructions(projectForAccess);

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
        mcpServers,
        agentDefinitions,
        plugins,
        namedAgentInstructions,
        systemAccessInstructions,
        priority: 'high',
        sessionId: session.id,
        projectId,
        namedAgentId,
        namedAgentRevision: capabilities.namedAgentRevision,
        model: executionSettings.model,
        maxTurns: executionSettings.maxTurns,
        bashAccess,
        transportOrigin: event.payload.transportOrigin,
      },
    });
  }
}
