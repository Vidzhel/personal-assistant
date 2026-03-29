import { resolve, dirname } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import {
  createLogger,
  generateId,
  initFileLogging,
  type RavenEvent,
  type RavenEventType,
} from '@raven/shared';
import { loadConfig, loadSuitesConfig, loadSchedulesConfig, projectRoot } from './config.ts';
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
import { Scheduler } from './scheduler/scheduler.ts';
import { createApiServer } from './api/server.ts';
import { createPermissionEngine } from './permission-engine/permission-engine.ts';
import { createAuditLog } from './permission-engine/audit-log.ts';
import { createPendingApprovals } from './permission-engine/pending-approvals.ts';
import { createExecutionLogger } from './agent-manager/execution-logger.ts';
import { initializeBackend } from './agent-manager/agent-session.ts';
import { createTaskStore } from './task-manager/task-store.ts';
import { createTemplateLoader } from './task-manager/template-loader.ts';
import { createTaskLifecycle } from './task-manager/task-lifecycle.ts';
import { createPipelineEngine } from './pipeline-engine/pipeline-engine.ts';
import { createPipelineStore } from './pipeline-engine/pipeline-store.ts';
import { createPipelineScheduler } from './pipeline-engine/pipeline-scheduler.ts';
import { createPipelineEventTrigger } from './pipeline-engine/pipeline-event-trigger.ts';
import { createNamedAgentStore } from './agent-registry/named-agent-store.ts';
import { createAgentResolver } from './agent-registry/agent-resolver.ts';
import { CapabilityLibrary } from './capability-library/capability-library.ts';
import { ProjectRegistry } from './project-registry/project-registry.ts';
import { createAgentYamlStore } from './project-registry/agent-yaml-store.ts';
import { createConfigCommitter } from './agent-registry/config-committer.ts';
import { createSuiteScaffolder } from './suite-registry/suite-scaffolder.ts';
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
import type { SessionIdleEvent } from '@raven/shared';

const log = createLogger('raven');

// eslint-disable-next-line max-lines-per-function, complexity -- boot sequence that initializes all subsystems
async function main(): Promise<void> {
  log.info('Starting Raven...');

  // 1. Load config
  const config = loadConfig();

  // 1b. Initialize file logging (must be before any substantive logging)
  const logDir = resolve(projectRoot, 'data/logs');
  initFileLogging({ logDir, maxDays: 7, pretty: process.env.NODE_ENV !== 'production' });

  log.info(`Config loaded (model: ${config.CLAUDE_MODEL}, port: ${config.RAVEN_PORT})`);

  // Initialize agent backend: SDK mode (API key) or CLI mode (claude binary)
  initializeBackend(config.ANTHROPIC_API_KEY);

  // 2. Ensure data directories (resolve relative paths against project root, not CWD)
  const dbPath = resolve(projectRoot, config.DATABASE_PATH);
  const sessionPath = resolve(projectRoot, config.SESSION_PATH);
  const dbDir = dirname(dbPath);
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
  if (!existsSync(sessionPath)) mkdirSync(sessionPath, { recursive: true });
  const knowledgeDir = resolve(projectRoot, 'data/knowledge');
  if (!existsSync(knowledgeDir)) mkdirSync(knowledgeDir, { recursive: true });

  // 3. Init database
  initDatabase(dbPath);
  const dbInterface = createDbInterface();

  // 3b. Verify meta-project exists (seeded by migration 017)
  try {
    const meta = getMetaProject();
    log.info(`Meta-project verified: "${meta.name}" (id: ${meta.id})`);
  } catch (err) {
    log.error(`Meta-project missing — migration 017 may not have run: ${err}`);
    process.exit(1);
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

  // Count configured (enabled) suites
  const configuredSuiteCount = Object.values(suitesConfig).filter((s) => s?.enabled).length;

  // 6. Start suite services (IMAP watcher, Telegram bot, etc.)
  const serviceRunner = new ServiceRunner();
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
  };

  await serviceRunner.startServices(suiteRegistry.getAllSuites(), baseContext);

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

  // 7e. Init task store and template loader
  const taskStore = createTaskStore({ db: dbInterface, eventBus: baseContext.eventBus });
  const templatesDir = resolve(projectRoot, 'config/task-templates');
  const templateLoader = createTemplateLoader({ templatesDir, taskStore });
  log.info('Task manager initialized');

  // Expose task store globally for suite services
  (globalThis as unknown as Record<string, unknown>).__raven_task_store__ = taskStore;

  // 7f. Init named agent registry
  const namedAgentStore = createNamedAgentStore({
    db: dbInterface,
    eventBus: baseContext.eventBus,
    configDir: configDir,
  });
  namedAgentStore.loadFromConfigFile();
  const agentResolver = createAgentResolver({ capabilityLibrary, suiteRegistry });
  const configCommitter = createConfigCommitter({
    eventBus,
    configFilePath: resolve(configDir, 'agents.json'),
  });
  configCommitter.start();
  const suiteScaffolder = createSuiteScaffolder({ suitesDir, configDir });
  log.info(`Named agent registry initialized (${namedAgentStore.listAgents().length} agents)`);

  // 7g. Archival schedule handler
  eventBus.on('schedule:triggered', (event: RavenEvent) => {
    if (event.type === 'schedule:triggered' && 'payload' in event) {
      const payload = event.payload as { scheduleName?: string };
      if (payload.scheduleName === 'Task Archival') {
        const count = taskStore.archiveCompletedTasks();
        if (count > 0) log.info(`Archived ${count} completed tasks`);
      }
    }
  });

  // 7g. Task lifecycle bridge — connects agent events to RavenTask lifecycle
  const taskLifecycle = createTaskLifecycle({ eventBus: baseContext.eventBus, taskStore });
  taskLifecycle.start();

  // 7h. Task notification handler — post to Telegram agent topic or "Tasks" fallback
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

  // 10. Init agent manager
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
  });

  // 10b. Inject agentManager into service context for callback handler
  Object.assign(baseContext.config, { agentManager });

  // Expose agent manager globally for suite services (ticktick-sync)
  (globalThis as unknown as Record<string, unknown>).__raven_agent_manager__ = agentManager;

  // 11. Orchestrator — initialized after knowledge engine (step 12j) for context injection

  // 12. Init scheduler (merge config schedules + suite-level schedules)
  const schedulesConfig = loadSchedulesConfig(configDir);
  const suiteSchedules = suiteRegistry.collectSchedules().map((s) => ({
    id: s.id,
    name: s.name,
    cron: s.cron,
    taskType: s.taskType,
    skillName: s.suiteName,
    enabled: s.enabled,
  }));
  const scheduler = new Scheduler(eventBus, config.RAVEN_TIMEZONE);
  await scheduler.initialize([...schedulesConfig, ...suiteSchedules]);

  // 12b. Init pipeline engine
  const pipelineStore = createPipelineStore({ db: dbInterface });
  const pipelineEngine = createPipelineEngine({
    eventBus,
    suiteRegistry,
    mcpManager,
    pipelineStore,
  });
  const pipelinesDir = resolve(projectRoot, 'config/pipelines');
  pipelineEngine.initialize(pipelinesDir);
  log.info('Pipeline engine initialized');

  // 12c. Init pipeline scheduler (cron triggers) and event triggers
  const pipelineScheduler = createPipelineScheduler({
    pipelineEngine,
    eventBus,
    timezone: config.RAVEN_TIMEZONE,
  });
  const pipelineEventTrigger = createPipelineEventTrigger({
    pipelineEngine,
    eventBus,
  });
  pipelineScheduler.registerPipelines();
  pipelineEventTrigger.registerPipelines();

  const cronCount = pipelineEngine
    .getAllPipelines()
    .filter((p) => p.config.enabled && p.config.trigger.type === 'cron').length;
  const eventCount = pipelineEngine
    .getAllPipelines()
    .filter((p) => p.config.enabled && p.config.trigger.type === 'event').length;
  log.info(`Pipeline scheduler: ${cronCount} cron jobs, ${eventCount} event triggers`);

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
  const mediaDir = resolve(projectRoot, 'data/media');
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

  // 12k. Init context injector for pervasive knowledge injection
  const contextInjector = createContextInjector({ retrievalEngine });

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
    contextInjector,
    retrospective,
    knowledgeConsolidation,
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

  // 13. Start API server
  const server = await createApiServer(
    {
      eventBus,
      suiteRegistry,
      sessionManager,
      scheduler,
      agentManager,
      auditLog,
      pendingApprovals,
      executionLogger,
      messageStore,
      pipelineEngine,
      pipelineStore,
      pipelineScheduler,
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
      templateLoader,
      namedAgentStore,
      suiteScaffolder,
      configuredSuiteCount,
      unsnoozableCategories: (suitesConfig['notifications']?.config?.unsnoozableCategories ??
        []) as string[],
      sessionRetrospective,
      dataDir: resolve(projectRoot, 'data'),
      projectRegistry,
      agentYamlStore,
      projectsDir,
    },
    config.RAVEN_PORT,
  );

  log.info(`Raven is ready! API: http://localhost:${config.RAVEN_PORT}`);

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    log.info('Shutting down...');
    idleDetector.stop();
    pipelineScheduler.shutdown();
    pipelineEventTrigger.shutdown();
    pipelineEngine.shutdown();
    permissionEngine.shutdown();
    scheduler.shutdown();
    await serviceRunner.stopAll();
    await neo4jClient.close();
    await server.close();
    log.info('Goodbye!');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console -- fatal handler, logger may not be initialized
  console.error('Fatal error:', err);
  process.exit(1);
});
