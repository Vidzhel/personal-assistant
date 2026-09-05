import {
  createLogger,
  generateId,
  SOURCE_ORCHESTRATOR,
  SKILL_ORCHESTRATOR,
  type McpServerConfig,
  type SubAgentDefinition,
  type NewEmailEvent,
  type UserChatMessageEvent,
  type Project,
  type ProjectNode,
  type SystemAccessLevel,
  type BashAccess,
} from '@raven/shared';
import type Database from 'better-sqlite3';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { SessionManager } from '../session-manager/session-manager.ts';
import type { MessageStore } from '../session-manager/message-store.ts';
import type { SessionRetrospective } from '../session-manager/session-retrospective.ts';
import type { NamedAgentStore } from '../agent-registry/yaml-named-agent-store.ts';
import type { AgentResolver } from '../agent-registry/agent-resolver.ts';
import type { CapabilityLibrary } from '../capability-library/capability-library.ts';
import type { ProjectRegistry } from '../project-registry/project-registry.ts';
import type { ScaffoldingApi } from '../scaffolding/scaffolding-api.ts';
import { createKnowledgeAgentDefinition } from '../knowledge-engine/knowledge-agent.ts';
import { getDb } from '../db/database.ts';
import { resolveSystemAccessInstructions } from '../project-manager/system-access-gate.ts';
import { createAuditLog } from '../permission-engine/audit-log.ts';
import { kebabCase, uniqueFsPath, upsertCacheRow } from '../project-manager/project-sync.ts';
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

interface ResolveProjectNodeInput {
  projectRegistry: ProjectRegistry;
  scaffoldingApi: ScaffoldingApi;
  projectsDir: string;
  fsPath: string;
  displayName: string;
  topicName: string | undefined;
}

/** Looks up the registry node for `fsPath`, scaffolding a real directory
 * (and reloading the registry) when none exists yet. Returns undefined only
 * when the scaffold attempt itself fails — the caller still upserts a
 * cache row in that case, just without an fs_path link.
 *
 * Scaffolding uses uniqueFsPath rather than the raw kebab-cased `fsPath` —
 * two unrelated auto-created projects can legitimately kebab to the same
 * slug (two Telegram topics both named "Inbox", or two direct-mode chats
 * that both fall back to the 'Inbox' default) — so a brand-new node never
 * collides with one this same slug already produced. */
async function resolveOrScaffoldProjectNode(
  input: ResolveProjectNodeInput,
): Promise<ProjectNode | undefined> {
  const { projectRegistry, scaffoldingApi, projectsDir, fsPath, displayName, topicName } = input;
  const existing = projectRegistry.getProject(fsPath);
  if (existing) return existing;

  const scaffoldPath = uniqueFsPath(projectRegistry, fsPath);
  try {
    await scaffoldingApi.createProject({
      path: scaffoldPath,
      displayName,
      description: topicName
        ? `Auto-created from Telegram topic "${topicName}"`
        : 'Auto-created catch-all for unnamed sources',
    });
    await projectRegistry.load(projectsDir);
    return projectRegistry.getProject(scaffoldPath);
  } catch (err) {
    log.error(`Failed to scaffold project directory "${scaffoldPath}": ${err}`);
    return undefined;
  }
}

/** A node found/scaffolded for this fsPath might already be claimed by a
 * DIFFERENT project row (e.g. a prior ensureProject call for another
 * projectId already linked fs_path="inbox" — same kebab-derived slug,
 * different id — and resolveOrScaffoldProjectNode's `existing` branch
 * returns that same node without ever attempting to scaffold a fresh one).
 * Writing this node's id as fs_path for a second row would violate the
 * partial UNIQUE index (idx_projects_fs_path) and, left uncaught, would
 * abort handleUserChat before the user's message is ever persisted (see
 * project-sync.ts's fs_path invariant). Falling back to fsPath: null keeps
 * ensureProject itself impossible to throw on this path — the row is left
 * unreconciled for project-sync's boot-time reconciler to scaffold its own
 * directory for, same as any other referenced-but-unlinked row. */
function resolveSafeFsPath(db: Database.Database, node: ProjectNode | undefined): string | null {
  if (!node) return null;
  const owner = db.prepare('SELECT 1 FROM projects WHERE fs_path = ?').get(node.id);
  if (owner) {
    log.warn(
      `fs_path "${node.id}" is already owned by another project row — linking this one unreconciled instead of colliding`,
    );
    return null;
  }
  return node.id;
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
 * The Orchestrator subscribes to events and routes them to appropriate suite agents.
 *
 * CRITICAL: The orchestrator itself has NO MCP servers.
 * It delegates to suite-specific sub-agents that carry their own MCPs.
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

  /** Fallback when no named agent could be resolved: the full capability library. */
  private resolveFullLibraryCapabilities(): {
    agentDefinitions: Record<string, SubAgentDefinition>;
    mcpServers: Record<string, McpServerConfig>;
    plugins: Array<{ type: 'local'; path: string }>;
  } {
    if (!this.capabilityLibrary) {
      return { agentDefinitions: {}, mcpServers: {}, plugins: [] };
    }
    return {
      agentDefinitions: this.capabilityLibrary.collectAgentDefinitions(),
      mcpServers: this.capabilityLibrary.collectMcpServers(),
      plugins: this.capabilityLibrary.resolveVendorPlugins(),
    };
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

    const displayName = topicName ?? 'Inbox';
    const fsPath = kebabCase(displayName);
    const node = await resolveOrScaffoldProjectNode({
      projectRegistry,
      scaffoldingApi,
      projectsDir,
      fsPath,
      displayName,
      topicName,
    });

    const safeFsPath = resolveSafeFsPath(db, node);
    upsertCacheRow(db, { id: projectId, name: displayName, fsPath: safeFsPath });
    log.info(`Auto-created project "${projectId}" (fs_path: ${safeFsPath ?? 'none'})`);
  }

  // eslint-disable-next-line max-lines-per-function, complexity -- async handler with context injection, named agent resolution, and knowledge agent merging
  private async handleUserChat(event: UserChatMessageEvent): Promise<void> {
    const { projectId, sessionId, message, topicId, topicName } = event.payload;
    log.info(`User chat in project ${projectId}: ${message.slice(0, LOG_MESSAGE_PREVIEW_LENGTH)}`);

    // Ensure the project exists (Telegram messages may reference
    // auto-generated project IDs). This has to stay ahead of session
    // creation, not just message persistence: sessions.project_id is a hard
    // FK to projects(id) (foreign_keys=ON), so getOrCreateSession's INSERT
    // for a brand-new project would itself throw before appendMessage ever
    // ran if the project row didn't exist yet — appendMessage can't be
    // moved ahead of ensureProject without first solving that. What *can*
    // move is making ensureProject itself unable to throw, which is the
    // actual fix here (see resolveSafeFsPath) — a collision on the derived
    // fs_path no longer escapes to the caller and aborts the handler before
    // the user's message is stored.
    // Only new conversations may auto-create a project (e.g. a Telegram topic).
    // Explicit session IDs must never create or select a replacement conversation.
    if (sessionId === undefined) await this.ensureProject(projectId, topicName);

    const target = validateChatTarget(this.sessionManager, projectId, sessionId);
    if (!target.ok) {
      this.eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: SOURCE_ORCHESTRATOR,
        type: 'user:chat:rejected',
        projectId,
        payload: { requestId: event.id, projectId, sessionId, error: target.error },
      });
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

    // Resolve capabilities from named agent (if configured) or fall back to all suites
    let agentDefinitions: Record<string, SubAgentDefinition>;
    let mcpServers: Record<string, McpServerConfig>;
    let plugins: Array<{ type: 'local'; path: string }>;
    let namedAgentInstructions: string | undefined;
    let namedAgentId: string | undefined;
    let agentName: string | undefined;

    if (this.namedAgentStore && this.agentResolver) {
      try {
        const namedAgent = this.namedAgentStore.getDefaultAgent();
        const capabilities = this.agentResolver.resolveAgentCapabilities(namedAgent);
        agentDefinitions = capabilities.agentDefinitions;
        mcpServers = capabilities.mcpServers;
        plugins = capabilities.plugins;
        namedAgentId = namedAgent.id;
        agentName = namedAgent.name;
        if (namedAgent.instructions) {
          namedAgentInstructions = namedAgent.instructions;
        }
      } catch (err) {
        log.warn(`Named agent resolution failed, falling back to the full library: ${err}`);
        ({ agentDefinitions, mcpServers, plugins } = this.resolveFullLibraryCapabilities());
      }
    } else {
      ({ agentDefinitions, mcpServers, plugins } = this.resolveFullLibraryCapabilities());
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

    // Merge knowledge agent into agent definitions
    agentDefinitions['knowledge-agent'] = createKnowledgeAgentDefinition();

    // Look up project for system access level
    const db = getDb();
    const projectRow = db
      .prepare('SELECT name, system_access, fs_path FROM projects WHERE id = ?')
      .get(projectId) as
      { name: string; system_access: string; fs_path: string | null } | undefined;
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
          const chain = resolved.contextChain.filter(Boolean).join('\n\n---\n\n');
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
        mcpServers, // Resolved from named agent or all suites
        agentDefinitions, // Sub-agents carry the MCPs + knowledge agent
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
