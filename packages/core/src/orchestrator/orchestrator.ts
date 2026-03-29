import {
  createLogger,
  generateId,
  SUITE_EMAIL,
  SOURCE_ORCHESTRATOR,
  SKILL_ORCHESTRATOR,
  type McpServerConfig,
  type SubAgentDefinition,
  type NewEmailEvent,
  type ScheduleTriggeredEvent,
  type UserChatMessageEvent,
  type Project,
  type SystemAccessLevel,
} from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { SuiteRegistry } from '../suite-registry/suite-registry.ts';
import type { SessionManager } from '../session-manager/session-manager.ts';
import type { MessageStore } from '../session-manager/message-store.ts';
import type { ContextInjector } from '../knowledge-engine/context-injector.ts';
import type { Retrospective } from '../knowledge-engine/retrospective.ts';
import type { KnowledgeConsolidation } from '../knowledge-engine/knowledge-consolidation.ts';
import type { SessionCompaction } from '../session-manager/session-compaction.ts';
import type { SessionRetrospective } from '../session-manager/session-retrospective.ts';
import type { AgentTaskCompleteEvent } from '@raven/shared';
import type { NamedAgentStore } from '../agent-registry/named-agent-store.ts';
import type { AgentResolver } from '../agent-registry/agent-resolver.ts';
import type { CapabilityLibrary } from '../capability-library/capability-library.ts';
import type { ProjectRegistry } from '../project-registry/project-registry.ts';
import { createKnowledgeAgentDefinition } from '../knowledge-engine/knowledge-agent.ts';
import { getDb } from '../db/database.ts';
import { isMetaProject } from '../project-manager/meta-project.ts';
import {
  resolveSystemAccessInstructions,
  resolveToolUseInstructions,
} from '../project-manager/system-access-gate.ts';
import { createAuditLog } from '../permission-engine/audit-log.ts';
import { buildSessionReferencesContext } from '../session-manager/session-references.ts';
import { buildProjectDataSourcesContext } from '../project-manager/project-data-sources.ts';

const log = createLogger('orchestrator');

const LOG_MESSAGE_PREVIEW_LENGTH = 100;

export interface OrchestratorDeps {
  eventBus: EventBus;
  suiteRegistry: SuiteRegistry;
  sessionManager: SessionManager;
  messageStore: MessageStore;
  contextInjector?: ContextInjector;
  retrospective?: Retrospective;
  knowledgeConsolidation?: KnowledgeConsolidation;
  sessionCompaction?: SessionCompaction;
  sessionRetrospective?: SessionRetrospective;
  namedAgentStore?: NamedAgentStore;
  agentResolver?: AgentResolver;
  capabilityLibrary?: CapabilityLibrary;
  projectRegistry?: ProjectRegistry;
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
  private knowledgeConsolidation?: KnowledgeConsolidation;
  private sessionCompaction?: SessionCompaction;
  private sessionRetrospective?: SessionRetrospective;
  private namedAgentStore?: NamedAgentStore;
  private agentResolver?: AgentResolver;
  private capabilityLibrary?: CapabilityLibrary;
  private projectRegistry?: ProjectRegistry;
  private port: number;

  constructor(deps: OrchestratorDeps) {
    this.eventBus = deps.eventBus;
    this.suiteRegistry = deps.suiteRegistry;
    this.sessionManager = deps.sessionManager;
    this.messageStore = deps.messageStore;
    this.contextInjector = deps.contextInjector;
    this.retrospective = deps.retrospective;
    this.knowledgeConsolidation = deps.knowledgeConsolidation;
    this.sessionCompaction = deps.sessionCompaction;
    this.sessionRetrospective = deps.sessionRetrospective;
    this.namedAgentStore = deps.namedAgentStore;
    this.agentResolver = deps.agentResolver;
    this.capabilityLibrary = deps.capabilityLibrary;
    this.projectRegistry = deps.projectRegistry;
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
    this.eventBus.on<AgentTaskCompleteEvent>('agent:task:complete', (e) => {
      this.handleTaskCompleteCompaction(e).catch((err: unknown) =>
        log.error(`handleTaskCompleteCompaction failed: ${err}`),
      );
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
    const plugins = emailSuite.vendorPlugins;
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
        plugins,
        knowledgeContext,
        priority: 'normal',
        projectId: event.projectId,
      },
    });
  }

  // eslint-disable-next-line max-lines-per-function -- handles multiple schedule types with context injection
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

    // Handle knowledge-consolidation inline
    if (taskType === 'knowledge-consolidation') {
      if (!this.knowledgeConsolidation) {
        log.warn('Knowledge consolidation not available, ignoring schedule trigger');
        return;
      }
      await this.knowledgeConsolidation.runConsolidation();
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

    // Collect agent definitions, MCPs, and vendor plugins from all enabled suites
    // so the scheduled agent can delegate to other suites' agents
    const agentDefinitions = this.suiteRegistry.collectAgentDefinitions();
    const mcpServers = this.suiteRegistry.collectMcpServers();
    const plugins = this.suiteRegistry.collectVendorPlugins();

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
        plugins,
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

  // eslint-disable-next-line max-lines-per-function, complexity -- async handler with context injection, named agent resolution, and knowledge agent merging
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

    // Session cross-references context for agent prompt
    let sessionReferencesContext: string | undefined;
    try {
      sessionReferencesContext = buildSessionReferencesContext(session.id);
    } catch (err) {
      log.warn(`Session references context retrieval failed: ${err}`);
    }

    // Project data sources context for agent prompt
    let projectDataSourcesContext: string | undefined;
    try {
      projectDataSourcesContext = buildProjectDataSourcesContext(projectId);
    } catch (err) {
      log.warn(`Project data sources context retrieval failed: ${err}`);
    }

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

    // Resolve capabilities from named agent (if configured) or fall back to all suites
    let agentDefinitions: Record<string, SubAgentDefinition>;
    let mcpServers: Record<string, McpServerConfig>;
    let plugins: Array<{ type: 'local'; path: string }>;
    let namedAgentInstructions: string | undefined;
    let namedAgentId: string | undefined;

    if (this.namedAgentStore && this.agentResolver) {
      try {
        const namedAgent = this.namedAgentStore.getDefaultAgent();
        const capabilities = this.agentResolver.resolveAgentCapabilities(namedAgent);
        agentDefinitions = capabilities.agentDefinitions;
        mcpServers = capabilities.mcpServers;
        plugins = capabilities.plugins;
        namedAgentId = namedAgent.id;
        if (namedAgent.instructions) {
          namedAgentInstructions = namedAgent.instructions;
        }
      } catch (err) {
        log.warn(`Named agent resolution failed, falling back to all suites: ${err}`);
        agentDefinitions = this.suiteRegistry.collectAgentDefinitions();
        mcpServers = this.suiteRegistry.collectMcpServers();
        plugins = this.suiteRegistry.collectVendorPlugins();
      }
    } else {
      agentDefinitions = this.suiteRegistry.collectAgentDefinitions();
      mcpServers = this.suiteRegistry.collectMcpServers();
      plugins = this.suiteRegistry.collectVendorPlugins();
    }

    // Inject skill catalog from capability library (v2) into agent context
    let skillCatalogContext: string | undefined;
    if (this.capabilityLibrary) {
      try {
        const skillNames = Object.keys(agentDefinitions);
        const catalog = this.capabilityLibrary.getSkillCatalog(skillNames);
        if (catalog) {
          skillCatalogContext = catalog;
        }
      } catch (err) {
        log.warn(`Skill catalog generation failed: ${err}`);
      }
    }

    // Merge knowledge agent into agent definitions
    agentDefinitions['knowledge-agent'] = createKnowledgeAgentDefinition(this.port);

    // Look up project for system access level
    const db = getDb();
    const projectRow = db
      .prepare('SELECT name, system_access FROM projects WHERE id = ?')
      .get(projectId) as { name: string; system_access: string } | undefined;
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
        const fsProject = this.projectRegistry.findByName(projectRow.name);
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

    // Build prompt with topic context and media context if available
    let prompt = message;
    if (topicName) {
      prompt = `[Context: This message is from the '${topicName}' topic thread (topicId: ${topicId})]\n\n${message}`;
    }
    const mediaAttachment = event.payload.mediaAttachment;
    if (mediaAttachment) {
      prompt += `\n\n[Media file available on disk: ${mediaAttachment.filePath} (${mediaAttachment.fileName}, ${mediaAttachment.mimeType}, ${mediaAttachment.type})]`;
    }

    // Prepend named agent instructions and config management capability
    if (namedAgentInstructions) {
      prompt = `[Agent Instructions: ${namedAgentInstructions}]\n\n${prompt}`;
    }
    if (this.namedAgentStore) {
      prompt = `[System: You can manage named agents via the REST API at http://localhost:${this.port}/api/agents (GET, POST, PATCH, DELETE). Use this to create, update, or adjust agent configurations when asked.]\n\n${prompt}`;
    }

    // Prepend meta-project management instructions (only for meta-project)
    if (isMetaProject(projectId)) {
      const metaInstructions = [
        '[System: You are operating as the Raven System meta-project agent. You can manage the system through these REST APIs:',
        `- GET/POST http://localhost:${this.port}/api/projects — List and create projects`,
        `- PUT/DELETE http://localhost:${this.port}/api/projects/:id — Update and delete projects`,
        `- GET/POST/PATCH/DELETE http://localhost:${this.port}/api/agents — Named agent management`,
        `- GET http://localhost:${this.port}/api/pipelines — List pipelines`,
        `- POST http://localhost:${this.port}/api/pipelines/:name/trigger — Trigger a pipeline`,
        `- GET/POST http://localhost:${this.port}/api/schedules — Schedule management`,
        `- GET http://localhost:${this.port}/api/suites — List available suites`,
        `- GET http://localhost:${this.port}/api/skills — List registered skills`,
        `- GET http://localhost:${this.port}/api/audit-logs — View audit trail`,
        'Use these APIs to fulfill system management requests.]',
      ].join('\n');
      prompt = `${metaInstructions}\n\n${prompt}`;
    }

    // Prepend tool use instructions
    prompt = `[System: ${resolveToolUseInstructions()}]\n\n${prompt}`;

    // Prepend system access instructions (topmost layer)
    prompt = `[System Access Control: ${resolveSystemAccessInstructions(projectForAccess)}]\n\n${prompt}`;

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
        knowledgeContext,
        sessionReferencesContext,
        projectDataSourcesContext,
        skillCatalogContext,
        projectContextChain,
        priority: 'high',
        sessionId: session.id,
        projectId,
        namedAgentId,
      },
    });
  }

  private async handleTaskCompleteCompaction(event: AgentTaskCompleteEvent): Promise<void> {
    if (!this.sessionCompaction || !event.payload.sessionId) return;

    try {
      await this.sessionCompaction.checkAndCompact(event.payload.sessionId);
    } catch (err) {
      log.warn(`Session compaction check failed for ${event.payload.sessionId}: ${err}`);
    }
  }
}
