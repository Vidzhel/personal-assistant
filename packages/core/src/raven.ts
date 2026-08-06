import { resolve, dirname } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import {
  createLogger,
  generateId,
  initFileLogging,
  type DatabaseInterface,
  type RavenEvent,
  type RavenEventType,
} from '@raven/shared';
import { loadSuitesConfig, projectRoot, type AppConfig } from './config.ts';
import { loadIntegrationsConfig } from './config/integrations-config.ts';
import { initDatabase, createDbInterface, getDb } from './db/database.ts';
import { EventBus } from './event-bus/event-bus.ts';
import { SuiteRegistry } from './suite-registry/suite-registry.ts';
import { ServiceRunner } from './suite-registry/service-runner.ts';
import { McpManager } from './mcp-manager/mcp-manager.ts';
import { AgentManager } from './agent-manager/agent-manager.ts';
import { SessionManager } from './session-manager/session-manager.ts';
import { Orchestrator } from './orchestrator/orchestrator.ts';
import { createMessageStore } from './session-manager/message-store.ts';
import { createApiServer } from './api/server.ts';
import { createPermissionEngine } from './permission-engine/permission-engine.ts';
import { createAuditLog } from './permission-engine/audit-log.ts';
import { createPendingApprovals } from './permission-engine/pending-approvals.ts';
import { createExecutionLogger } from './agent-manager/execution-logger.ts';
import { initializeBackend, setActiveBackend } from './agent-manager/agent-session.ts';
import type { AgentBackend } from './agent-manager/agent-backend.ts';
import { createTaskStore } from './task-manager/task-store.ts';
import { createTaskLifecycle } from './task-manager/task-lifecycle.ts';
import { createYamlNamedAgentStore } from './agent-registry/yaml-named-agent-store.ts';
import { createAgentResolver } from './agent-registry/agent-resolver.ts';
import { CapabilityLibrary } from './capability-library/capability-library.ts';
import { ProjectRegistry } from './project-registry/project-registry.ts';
import { createAgentYamlStore } from './project-registry/agent-yaml-store.ts';
import { createConfigCommitter } from './agent-registry/config-committer.ts';
import { createSuiteScaffolder } from './suite-registry/suite-scaffolder.ts';
import { createScaffoldingApi } from './scaffolding/scaffolding-api.ts';
import { createKnowledgeStore } from './knowledge-engine/knowledge-store.ts';
import { createIngestionProcessor } from './knowledge-engine/ingestion.ts';
import { createEmbeddingEngine } from './knowledge-engine/embeddings.ts';
import { createClusteringEngine } from './knowledge-engine/clustering.ts';
import { createChunkingEngine } from './knowledge-engine/chunking.ts';
import { createRetrievalEngine } from './knowledge-engine/retrieval.ts';
import { createContextInjector } from './knowledge-engine/context-injector.ts';
import { createKnowledgeLifecycle } from './knowledge-engine/knowledge-lifecycle.ts';
import { createRetrospective } from './knowledge-engine/retrospective.ts';
import { loadKnowledgeDomainConfig } from './knowledge-engine/domain-config.ts';
import { createNeo4jClient } from './knowledge-engine/neo4j-client.ts';
import { syncProjectNodes } from './knowledge-engine/project-knowledge.ts';
import { getMetaProject } from './project-manager/meta-project.ts';
import { createIdleDetector } from './session-manager/idle-detector.ts';
import { createSessionRetrospective } from './session-manager/session-retrospective.ts';
import { createSessionCompaction } from './session-manager/session-compaction.ts';
import { createKnowledgeConsolidation } from './knowledge-engine/knowledge-consolidation.ts';
import { TaskExecutionEngine } from './task-execution/task-execution-engine.ts';
import { createValidationDeps } from './task-execution/create-validation-deps.ts';
import { createExecutionBridge } from './task-execution/execution-bridge.ts';
import { TemplateRegistry } from './template-engine/template-registry.ts';
import { createTemplateScheduler } from './template-engine/template-scheduler.ts';
import type { SessionIdleEvent } from '@raven/shared';
import type { RavenMcpDeps } from './mcp-server/index.ts';
import { createMemoryStore } from './agent-memory/memory-store.ts';
import { createJobRegistry } from './scheduler/job-registry.ts';
import { registerCoreJobs } from './scheduler/core-jobs.ts';
import { createScheduleEngine } from './scheduler/schedule-engine.ts';
import { createSchedulePrefs } from './scheduler/schedule-prefs.ts';

const log = createLogger('raven');

/**
 * True boundaries only — kept intentionally minimal. Each field lets tests
 * substitute one seam without reaching into module-level state:
 * - `agentBackend`: skip the SDK entirely, run a fake backend.
 * - `dbPath`: point at a temp SQLite file instead of `data/raven.db`.
 * - `dataDir`: redirect all `data/*` runtime directories (logs, sessions,
 *   knowledge, media) away from the real project tree.
 * - `skipSuites`: skip starting real suite services (Telegram bot, IMAP
 *   watcher, etc.) — suite *loading* still happens, only service startup
 *   is skipped.
 */
export interface RavenOverrides {
  agentBackend?: AgentBackend;
  dbPath?: string;
  dataDir?: string;
  skipSuites?: boolean;
}

export interface RavenInstance {
  start(): Promise<void>;
  stop(): Promise<void>;
  eventBus: EventBus;
  db: DatabaseInterface;
  readonly port: number;
}

/**
 * Composition root. Wires every subsystem exactly as the old `main()` did;
 * only the API server bind (and the "ready" log) is deferred to the
 * returned `start()` so tests can inspect the instance (e.g. read `db`)
 * before the HTTP port is bound, and so `stop()` has something to close.
 */
// eslint-disable-next-line max-lines-per-function, complexity -- boot sequence that initializes all subsystems (moved verbatim from former main())
export async function createRaven(
  config: AppConfig,
  overrides: RavenOverrides = {},
): Promise<RavenInstance> {
  log.info('Starting Raven...');

  const dataRoot = overrides.dataDir ?? projectRoot;

  // 1b. Initialize file logging (must be before any substantive logging)
  const logDir = resolve(dataRoot, 'data/logs');
  initFileLogging({ logDir, maxDays: 7, pretty: process.env.NODE_ENV !== 'production' });

  log.info(`Config loaded (model: ${config.CLAUDE_MODEL}, port: ${config.RAVEN_PORT})`);

  // Initialize agent backend: injected override (tests) or SDK/CLI mode from config
  if (overrides.agentBackend) {
    setActiveBackend(overrides.agentBackend);
  } else {
    initializeBackend(config.ANTHROPIC_API_KEY);
  }

  // 2. Ensure data directories (resolve relative paths against dataRoot, not CWD)
  const dbPath = overrides.dbPath ?? resolve(dataRoot, config.DATABASE_PATH);
  const sessionPath = resolve(dataRoot, config.SESSION_PATH);
  const dbDir = dirname(dbPath);
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
  if (!existsSync(sessionPath)) mkdirSync(sessionPath, { recursive: true });
  const knowledgeDir = resolve(dataRoot, 'data/knowledge');
  if (!existsSync(knowledgeDir)) mkdirSync(knowledgeDir, { recursive: true });

  // 3. Init database
  initDatabase(dbPath);
  const dbInterface = createDbInterface();

  // 3b. Verify meta-project exists (seeded by migration 017). Throws rather
  // than process.exit(1) — this function must stay testable; the fatal exit
  // now happens once, at the top-level main() in index.ts.
  try {
    const meta = getMetaProject();
    log.info(`Meta-project verified: "${meta.name}" (id: ${meta.id})`);
  } catch (err) {
    log.error(`Meta-project missing — migration 017 may not have run: ${err}`);
    throw err;
  }

  // 4. Init event bus
  const eventBus = new EventBus();

  // 4b. Persist all events to the database
  const insertEvent = getDb().prepare(
    'INSERT OR IGNORE INTO events (id, type, source, project_id, payload, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
  );
  eventBus.on('*', (event: RavenEvent) => {
    insertEvent.run(
      event.id,
      event.type,
      event.source,
      event.projectId ?? null,
      JSON.stringify('payload' in event ? event.payload : {}),
      event.timestamp,
    );
  });

  // 5. Init suite registry and load suites
  const suiteRegistry = new SuiteRegistry();
  const configDir = resolve(projectRoot, 'config');
  const suitesConfig = loadSuitesConfig(configDir);
  const suitesDir = resolve(projectRoot, 'suites');

  const integrationsConfig = loadIntegrationsConfig(configDir);

  await suiteRegistry.loadSuites(suitesDir, suitesConfig);
  suiteRegistry.validateAgentTools();

  // Load capability library (v2 — runs alongside suite registry during migration)
  const capabilityLibrary = new CapabilityLibrary();
  const libraryDir = resolve(projectRoot, 'library');
  try {
    await capabilityLibrary.load(libraryDir);
    log.info(
      `Capability library loaded (${String(capabilityLibrary.getSkillNames().length)} skills)`,
    );
  } catch (err) {
    log.warn(`Capability library not found or failed to load, using suite registry only: ${err}`);
  }

  // Load project registry (filesystem-based project hierarchy)
  const projectRegistry = new ProjectRegistry();
  const projectsDir = resolve(projectRoot, 'projects');
  try {
    await projectRegistry.load(projectsDir);
    log.info('Project registry loaded');
  } catch (err) {
    log.warn(`Project registry failed to load, continuing without: ${err}`);
  }

  // Create agent YAML store (filesystem-backed agent definitions)
  const agentYamlStore = createAgentYamlStore();

  // Create scaffolding API (project domain creation)
  const scaffoldingApi = createScaffoldingApi({ projectsDir, projectRegistry, agentYamlStore });

  // Count configured (enabled) suites
  const configuredSuiteCount = Object.values(suitesConfig).filter((s) => s?.enabled).length;

  // 6. Start suite services (IMAP watcher, Telegram bot, etc.)
  const serviceRunner = new ServiceRunner();
  const jobRegistry = createJobRegistry();
  const baseContext = {
    eventBus: {
      emit: (event: unknown) => eventBus.emit(event as RavenEvent),
      on: (type: string, handler: (event: unknown) => void) =>
        eventBus.on(type as RavenEventType, handler),
      off: (type: string, handler: (event: unknown) => void) =>
        eventBus.off(type as RavenEventType, handler),
    },
    db: dbInterface,
    logger: log,
    config: {},
    projectRoot,
    integrationsConfig,
    jobRegistry,
  };

  if (!overrides.skipSuites) {
    await serviceRunner.startServices(suiteRegistry.getAllSuites(), baseContext);
  }

  // 7. Init permission engine
  const permissionEngine = createPermissionEngine({ suiteRegistry, eventBus });
  permissionEngine.initialize(configDir);
  log.info('Permission engine initialized');

  // 7b. Init audit log
  const auditLog = createAuditLog(getDb());
  auditLog.initialize();
  log.info('Audit log initialized');

  // 7c. Init pending approvals
  const pendingApprovals = createPendingApprovals(getDb());
  pendingApprovals.initialize();
  log.info('Pending approvals initialized');

  // 7d. Init execution logger
  const executionLogger = createExecutionLogger({ db: getDb() });
  log.info('Execution logger initialized');

  // 7e. Init task store
  const taskStore = createTaskStore({ db: dbInterface, eventBus: baseContext.eventBus });
  log.info('Task manager initialized');

  // Expose task store globally for suite services
  (globalThis as unknown as Record<string, unknown>).__raven_task_store__ = taskStore;

  // 7f. Init named agent registry (filesystem YAML is the source of truth)
  const namedAgentStore = createYamlNamedAgentStore({
    projectRegistry,
    agentYamlStore,
    projectsDir,
    eventBus: baseContext.eventBus,
  });
  const agentResolver = createAgentResolver({ capabilityLibrary, suiteRegistry });
  const configCommitter = createConfigCommitter({ eventBus });
  configCommitter.start();
  const suiteScaffolder = createSuiteScaffolder({ suitesDir, configDir });
  log.info(`Named agent registry initialized (${namedAgentStore.listAgents().length} agents)`);

  // 7g. Task lifecycle bridge — connects agent events to RavenTask lifecycle
  const taskLifecycle = createTaskLifecycle({ eventBus: baseContext.eventBus, taskStore });
  taskLifecycle.start();

  // 7h. Init task execution engine
  const executionEngine = new TaskExecutionEngine({
    db: dbInterface,
    eventBus: baseContext.eventBus,
    validationDeps: createValidationDeps(baseContext.eventBus),
  });
  log.info('task execution engine initialized');

  // 7i. Init template engine (registry + scheduler). Construction only here —
  // templateScheduler.start() is deferred until after AgentManager exists
  // (see below): starting it here would let a due-on-boot schedule fire a
  // template, which drives the execution engine to emit
  // execution:task:run-agent — and if the execution bridge is listening but
  // AgentManager isn't constructed yet, the resulting agent:task:request has
  // no subscriber and the task silently stalls forever.
  const templateRegistry = new TemplateRegistry();
  await templateRegistry.load(projectsDir);
  log.info(
    `Template registry loaded (${String(templateRegistry.getAllTemplates().length)} templates)`,
  );

  const templateScheduler = createTemplateScheduler({
    templateRegistry,
    executionEngine,
    eventBus: baseContext.eventBus,
  });

  // 7i. Task notification handler — post to Telegram agent topic or "Tasks" fallback
  for (const eventType of ['task:created', 'task:completed'] as const) {
    eventBus.on(eventType, (event: RavenEvent) => {
      if (event.type !== 'task:created' && event.type !== 'task:completed') return;
      const payload = event.payload as {
        taskId: string;
        title: string;
        assignedAgentId?: string;
        projectId?: string;
      };
      const action = event.type === 'task:created' ? 'Created' : 'Completed';
      const parts = [`Task ${action}: ${payload.title}`];
      if (payload.assignedAgentId) parts.push(`Agent: ${payload.assignedAgentId}`);
      if (payload.projectId) parts.push(`Project: ${payload.projectId}`);

      // Route to agent-specific topic if assigned, otherwise fall back to "Tasks"
      let topicName = 'Tasks';
      if (payload.assignedAgentId) {
        const agent = namedAgentStore.getAgent(payload.assignedAgentId);
        if (agent) topicName = agent.name;
      }

      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: 'task-manager',
        type: 'notification',
        payload: {
          channel: 'telegram' as const,
          title: `Task ${action}`,
          body: parts.join('\n'),
          topicName,
        },
      });
    });
  }

  // 7h. Inject permission deps into service context for callback handler (lazy resolution)
  Object.assign(baseContext.config, { pendingApprovals, auditLog });

  // 8. Init MCP manager
  const mcpManager = new McpManager(suiteRegistry);

  // 9. Init session manager + message store
  const sessionManager = new SessionManager();
  const messageStore = createMessageStore({ basePath: sessionPath });
  const memoryStore = createMemoryStore({ projectsDir });

  // 10. Init agent manager. INVARIANT: AgentManager subscribes before any
  // agent:task:request emitter starts — it is the sole subscriber for that
  // event, so it must exist before executionBridge.start(),
  // templateScheduler.start(), scheduleEngine.start(), idleDetector.start(),
  // or any of the knowledge/Neo4j engines below (which can take a while to
  // initialize and previously left a boot window where those events were
  // silently dropped). ravenMcpDeps is a mutable object: knowledgeStore and
  // retrievalEngine are added via Object.assign once the knowledge engine
  // initializes further down — agent-session resolves ravenMcpDeps lazily
  // per task at run time, and every knowledge-dependent MCP tool already
  // guards for "not available", so the fields can be optional here.
  const ravenMcpDeps: RavenMcpDeps = {
    eventBus,
    executionEngine,
    messageStore,
    sessionManager,
    namedAgentStore,
    projectRegistry,
    db: dbInterface,
    pendingApprovals,
  };
  const agentManager = new AgentManager({
    eventBus,
    mcpManager,
    suiteRegistry,
    permissionEngine,
    auditLog,
    pendingApprovals,
    executionLogger,
    messageStore,
    sessionManager,
    memoryStore,
    ravenMcpDeps,
  });

  // 10b. Inject agentManager into service context for callback handler
  Object.assign(baseContext.config, { agentManager });

  // Expose agent manager globally for suite services (ticktick-sync)
  (globalThis as unknown as Record<string, unknown>).__raven_agent_manager__ = agentManager;

  // Execution bridge: runtime observes agent:task:complete and drives
  // onTaskCompleted/onTaskBlocked/onTaskFailed on the engine, honoring the
  // template's `agent` field with resolved capabilities. Started only now
  // that agentManager exists to receive the agent:task:request events it
  // emits, and wired to agentManager.cancelTask so a cancelled tree can
  // abort in-flight agent runs.
  const executionBridge = createExecutionBridge({
    eventBus,
    executionEngine,
    namedAgentStore,
    agentResolver,
    cancelAgentTask: agentManager.cancelTask.bind(agentManager),
  });
  executionBridge.start();

  templateScheduler.start();
  log.info('Template scheduler started');

  // 11. Orchestrator — initialized after knowledge engine (step 12j) for context injection

  // 12d. Init Neo4j client for knowledge engine
  const neo4jClient = createNeo4jClient({
    uri: config.NEO4J_URI,
    user: config.NEO4J_USER,
    password: config.NEO4J_PASSWORD,
  });
  await neo4jClient.ensureSchema();
  await syncProjectNodes(neo4jClient);
  log.info(`Neo4j connected (${config.NEO4J_URI})`);

  // 12e. Init knowledge store and reindex
  const knowledgeStore = createKnowledgeStore({ neo4j: neo4jClient, knowledgeDir });
  const reindexResult = await knowledgeStore.reindexAll();
  log.info(`Knowledge store: ${reindexResult.indexed} bubbles indexed`);

  // 12f. Init knowledge ingestion processor
  const mediaDir = resolve(dataRoot, 'data/media');
  if (!existsSync(mediaDir)) mkdirSync(mediaDir, { recursive: true });
  const ingestionProcessor = createIngestionProcessor({
    knowledgeStore,
    eventBus,
    executionLogger,
    mediaDir,
  });
  ingestionProcessor.start();

  // 12g. Init embedding engine (lazy model init — loads on first use)
  const embeddingEngine = createEmbeddingEngine({ neo4j: neo4jClient, eventBus, knowledgeStore });
  embeddingEngine.start();

  // 12h. Init clustering engine
  const domainConfig = loadKnowledgeDomainConfig(configDir);
  const clusteringEngine = createClusteringEngine({
    neo4j: neo4jClient,
    eventBus,
    embeddingEngine,
    knowledgeStore,
    domainConfig,
  });
  await clusteringEngine.start();
  log.info('Knowledge intelligence engine initialized (embeddings + clustering)');

  // 12i. Init chunking engine (chunk-level embeddings for retrieval)
  const chunkingEngine = createChunkingEngine({
    neo4j: neo4jClient,
    eventBus,
    knowledgeStore,
    knowledgeDir,
  });
  chunkingEngine.start();

  // 12j. Init retrieval engine (multi-tier search pipeline)
  const retrievalEngine = createRetrievalEngine({
    neo4j: neo4jClient,
    knowledgeStore,
    knowledgeDir,
  });
  log.info('Knowledge retrieval engine initialized (chunking + multi-tier search)');

  // Knowledge engine is up — extend the already-constructed ravenMcpDeps
  // (AgentManager was built earlier, before this potentially slow Neo4j/
  // reindex boot window) so subsequent agent-session invocations get
  // knowledge tools too.
  Object.assign(ravenMcpDeps, { knowledgeStore, retrievalEngine });

  // 12k. Init context injector for pervasive knowledge injection
  // Context injector kept for retrieval engine; agents now access knowledge via MCP tools
  const _contextInjector = createContextInjector({ retrievalEngine });

  // 12l. Init knowledge lifecycle engine (stale detection, snooze, merge, remove)
  const knowledgeLifecycle = createKnowledgeLifecycle({
    neo4j: neo4jClient,
    knowledgeStore,
    eventBus,
    embeddingEngine,
    chunkingEngine,
    knowledgeDir,
  });

  // 12m. Init retrospective engine (weekly summary generation)
  const retrospective = createRetrospective({
    neo4j: neo4jClient,
    eventBus,
    lifecycle: knowledgeLifecycle,
  });
  log.info('Knowledge lifecycle & retrospective engines initialized');

  // 11a. Init session retrospective, compaction, and consolidation
  const sessionRetrospective = createSessionRetrospective({
    messageStore,
    sessionManager,
    eventBus,
    config,
    knowledgeStore,
    neo4j: neo4jClient,
  });

  const sessionCompaction = createSessionCompaction({
    messageStore,
    eventBus,
    config,
  });

  const knowledgeConsolidation = createKnowledgeConsolidation({
    neo4j: neo4jClient,
    eventBus,
    config,
  });

  // Unified schedule engine (job-kind schedules; template/agent kinds land in Plan 1b)
  registerCoreJobs(jobRegistry, { taskStore, retrospective, knowledgeConsolidation });
  const schedulePrefs = createSchedulePrefs(getDb());
  const scheduleEngine = createScheduleEngine({
    schedules: projectRegistry.getGlobal().schedules,
    jobRegistry,
    taskStore,
    timezone: config.RAVEN_TIMEZONE,
    fireTemplate: (ref, options) => templateScheduler.triggerTemplate(ref, options),
    schedulePrefs,
  });
  scheduleEngine.start();

  // 11b. Init idle detector + register session:idle handler
  const idleDetector = createIdleDetector({ eventBus, config });
  eventBus.on<SessionIdleEvent>('session:idle', (e) => {
    sessionRetrospective
      .runRetrospective(e.payload.sessionId, e.payload.projectId)
      .catch((err: unknown) => log.error(`Session retrospective failed: ${err}`));
  });
  idleDetector.start();
  log.info('Session idle detector started');

  // 11c. Init orchestrator (after knowledge engine for context injection)
  const _orchestrator = new Orchestrator({
    eventBus,
    suiteRegistry,
    sessionManager,
    messageStore,
    sessionCompaction,
    sessionRetrospective,
    namedAgentStore,
    agentResolver,
    capabilityLibrary,
    projectRegistry,
    port: config.RAVEN_PORT,
  });

  // 12n. Backfill chunk embeddings for any un-chunked bubbles (non-blocking)
  chunkingEngine.backfillChunks().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Chunk backfill failed: ${msg}`);
  });

  // 13. API server — bind deferred to start() so the instance can be handed
  // back to callers (tests) before the port is actually listening.
  let server: Awaited<ReturnType<typeof createApiServer>> | undefined;
  let boundPort = config.RAVEN_PORT;

  async function start(): Promise<void> {
    server = await createApiServer(
      {
        eventBus,
        suiteRegistry,
        sessionManager,
        scheduleEngine,
        agentManager,
        auditLog,
        pendingApprovals,
        executionLogger,
        messageStore,
        knowledgeStore,
        ingestionProcessor,
        embeddingEngine,
        clusteringEngine,
        chunkingEngine,
        retrievalEngine,
        neo4jClient,
        knowledgeLifecycle,
        retrospective,
        db: dbInterface,
        taskStore,
        namedAgentStore,
        suiteScaffolder,
        configuredSuiteCount,
        unsnoozableCategories: (suitesConfig['notifications']?.config?.unsnoozableCategories ??
          []) as string[],
        sessionRetrospective,
        dataDir: resolve(dataRoot, 'data'),
        projectRegistry,
        agentYamlStore,
        projectsDir,
        executionEngine,
        templateRegistry,
        templateScheduler,
        scaffoldingApi,
      },
      config.RAVEN_PORT,
    );

    const address = server.addresses()[0];
    boundPort = address?.port ?? config.RAVEN_PORT;
    log.info(`Raven is ready! API: http://localhost:${boundPort}`);
  }

  // Graceful shutdown — mirrors the former main()'s shutdown body, minus
  // process.exit (the caller decides what to do after stop() resolves).
  async function stop(): Promise<void> {
    log.info('Shutting down...');
    idleDetector.stop();
    executionBridge.stop();
    templateScheduler.stop();
    permissionEngine.shutdown();
    scheduleEngine.stop();
    await serviceRunner.stopAll();
    await neo4jClient.close();
    if (server) await server.close();
    log.info('Goodbye!');
  }

  return {
    start,
    stop,
    eventBus,
    db: dbInterface,
    get port(): number {
      return boundPort;
    },
  };
}
