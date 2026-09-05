import {
  createLogger,
  generateId,
  SOURCE_ORCHESTRATOR,
  SKILL_ORCHESTRATOR,
  type NewEmailEvent,
  type UserChatMessageEvent,
  type Project,
  type SystemAccessLevel,
  type BashAccess,
} from '@raven/shared';
import type Database from 'better-sqlite3';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { SessionManager } from '../session-manager/session-manager.ts';
import type { MessageStore } from '../session-manager/message-store.ts';
import type { SessionRetrospective } from '../session-manager/session-retrospective.ts';
import type { NamedAgentStore } from '../agent-registry/yaml-named-agent-store.ts';
import {
  resolveDefaultAgentCapabilities,
  type AgentResolver,
  type ResolvedDefaultAgent,
} from '../agent-registry/agent-resolver.ts';
import type { CapabilityLibrary } from '../capability-library/capability-library.ts';
import type { ProjectRegistry } from '../project-registry/project-registry.ts';
import type { ScaffoldingApi } from '../scaffolding/scaffolding-api.ts';
import { getDb } from '../db/database.ts';
import { resolveSystemAccessInstructions } from '../project-manager/system-access-gate.ts';
import { createAuditLog } from '../permission-engine/audit-log.ts';
import { createManagedProject } from '../project-manager/project-lifecycle.ts';
import { validateChatTarget } from '../session-manager/chat-validation.ts';

const log = createLogger('orchestrator');

const LOG_MESSAGE_PREVIEW_LENGTH = 100;
// Library skill name for Gmail (library/skills/communication/email/gmail/config.json) —
// distinct from the retired suite name 'email'.
const GMAIL_SKILL = 'gmail';

/** ensureProject fallback for callers with no registry/scaffolding wired
 * (minimal test harnesses) — keeps chat working via a DB-only row rather
 * than hard-failing, same as the pre-Task-1 behavior. */
function insertDegradedProjectRow(
  db: Database.Database,
  projectId: string,
  topicName: string | undefined,
): void {
  const now = Date.now();
  db.prepare(
    'INSERT INTO projects (id, name, description, skills, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(projectId, topicName ?? projectId, 'Auto-created (registry unavailable)', '[]', now, now);
  log.warn(`Project "${projectId}" cache-only — project registry/scaffolding not wired`);
}

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
    this.eventBus.on<NewEmailEvent>('email:new', (e) => {
      this.handleNewEmail(e).catch((err: unknown) => log.error(`handleNewEmail failed: ${err}`));
    });
    this.eventBus.on<UserChatMessageEvent>('user:chat:message', (e) => {
      this.handleUserChat(e).catch((err: unknown) => log.error(`handleUserChat failed: ${err}`));
    });

    log.info('Orchestrator initialized');
  }

  private async handleNewEmail(event: NewEmailEvent): Promise<void> {
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
   * Ensure a project row exists for auto-created project ids (Telegram
   * topics, direct-mode chat). Filesystem is the source of truth: when no
   * registry node backs `projectId` yet, scaffold one — kebab-cased topic
   * name when available, else the "inbox" catch-all for unnameable sources
   * (e.g. legacy direct-mode messages, which carry no topic at all) —
   * before upserting the DB cache row.
   */
  private async ensureProject(projectId: string, topicName: string | undefined): Promise<void> {
    const db = getDb();
    if (db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) return;

    const { projectRegistry, scaffoldingApi, projectsDir } = this;
    if (!projectRegistry || !scaffoldingApi || !projectsDir) {
      insertDegradedProjectRow(db, projectId, topicName);
      return;
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
      payload: { requestId: event.id, projectId, sessionId, error },
    });
  }

  // eslint-disable-next-line max-lines-per-function, complexity -- async handler with project context, capability resolution, and session dispatch
  private async handleUserChat(event: UserChatMessageEvent): Promise<void> {
    const { projectId, sessionId, message, topicId, topicName } = event.payload;
    log.info(`User chat in project ${projectId}: ${message.slice(0, LOG_MESSAGE_PREVIEW_LENGTH)}`);

    let capabilities: ResolvedDefaultAgent;
    try {
      capabilities = resolveDefaultAgentCapabilities({
        namedAgentStore: this.namedAgentStore,
        agentResolver: this.agentResolver,
      });
    } catch (error) {
      this.rejectChat(event, `Agent capability resolution failed: ${String(error)}`);
      return;
    }
    const {
      agentDefinitions,
      mcpServers,
      plugins,
      namedAgentInstructions,
      namedAgentId,
      agentName,
    } = capabilities;

    // Only new conversations may create a project, before the session FK is written.
    // Explicit session IDs must never select a replacement conversation.
    try {
      if (sessionId === undefined) await this.ensureProject(projectId, topicName);
    } catch (error) {
      this.rejectChat(event, `Project creation failed: ${String(error)}`);
      return;
    }

    const target = validateChatTarget(this.sessionManager, projectId, sessionId);
    if (!target.ok) {
      this.rejectChat(event, target.error);
      return;
    }
    const session = target.session ?? this.sessionManager.getOrCreateSession(projectId);
    this.sessionManager.updateStatus(session.id, 'running');

    // Store the user message
    this.messageStore.appendMessage(session.id, {
      role: 'user',
      content: message,
    });

    // Check for manual retrospective intent
    const lowerMsg = message.toLowerCase();
    if (
      this.sessionRetrospective &&
      (lowerMsg === 'retrospective' ||
        lowerMsg.includes('summarize this session') ||
        lowerMsg.includes('run retrospective'))
    ) {
      try {
        const result = await this.sessionRetrospective.runRetrospective(session.id, projectId);
        this.messageStore.appendMessage(session.id, {
          role: 'assistant',
          content: `**Session Retrospective**\n\n${result.summary}\n\n**Decisions:** ${result.decisions.length ? result.decisions.join(', ') : 'None'}\n**Findings:** ${result.findings.length ? result.findings.join(', ') : 'None'}\n**Action Items:** ${result.actionItems.length ? result.actionItems.join(', ') : 'None'}`,
        });
        this.sessionManager.updateStatus(session.id, 'idle');
        return;
      } catch (err) {
        log.error(`Manual retrospective failed: ${err}`);
      }
    }

    // Auto-generate session name on first turn
    if (session.turnCount === 0) {
      this.sessionManager.autoGenerateName(session.id, message);
    }

    // Resolve bash access config from project registry agent YAML
    let bashAccess: BashAccess | undefined;
    if (this.projectRegistry && agentName) {
      try {
        const globalNode = this.projectRegistry.getGlobal();
        const yamlAgent = globalNode.agents.find((a) => a.name === agentName);
        if (yamlAgent?.bash) {
          bashAccess = yamlAgent.bash;
        }
      } catch (err) {
        log.debug(`Bash access resolution skipped: ${err}`);
      }
    }

    // Look up project for system access level
    const db = getDb();
    const projectRow = db
      .prepare('SELECT name, system_access, system_prompt, fs_path FROM projects WHERE id = ?')
      .get(projectId) as
      | {
          name: string;
          system_access: string;
          system_prompt: string | null;
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

    // Project context chain from filesystem-based project hierarchy
    let projectContextChain: string | undefined;
    if (this.projectRegistry && projectRow) {
      try {
        // fs_path is the authoritative link (see project-manager/project-sync.ts);
        // name-based lookup is a fallback for rows not yet reconciled.
        const fsProject = projectRow.fs_path
          ? this.projectRegistry.getProject(projectRow.fs_path)
          : this.projectRegistry.findByName(projectRow.name);
        if (fsProject) {
          const resolved = this.projectRegistry.resolveProjectContext(fsProject.id);
          const contexts = [...resolved.contextChain];
          if (projectRow.system_prompt && fsProject.metadata?.systemPrompt === undefined) {
            contexts.push(projectRow.system_prompt);
          }
          const chain = contexts.filter(Boolean).join('\n\n---\n\n');
          if (chain) {
            projectContextChain = chain;
          }
        }
      } catch (err) {
        log.warn(`Project context chain resolution failed: ${err}`);
      }
    }

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
        projectContextChain,
        namedAgentInstructions,
        systemAccessInstructions,
        priority: 'high',
        sessionId: session.id,
        projectId,
        namedAgentId,
        bashAccess,
      },
    });
  }
}
