import {
  initializeKnowledge,
  type KnowledgeRuntime,
} from './knowledge-engine/initialize-knowledge.ts';
import { resolve, dirname } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import {
  createLogger,
  generateId,
  initFileLogging,
  closeFileLogging,
  UNSNOOZABLE_CATEGORIES,
  META_PROJECT_ID,
  type DatabaseInterface,
  type RavenEvent,
  type RavenEventType,
} from '@raven/shared';
import { projectRoot, setConfig, type AppConfig } from './config.ts';
import { loadIntegrationsConfig } from './config/integrations-config.ts';
import { initDatabase, createDbInterface, getDb, closeDatabase } from './db/database.ts';
import { EventBus } from './event-bus/event-bus.ts';
import { createServiceRunner } from './services/runner.ts';
import { SERVICE_DEFINITIONS } from './services/registry.ts';
import { AgentManager } from './agent-manager/agent-manager.ts';
import { SessionManager } from './session-manager/session-manager.ts';
import { Orchestrator } from './orchestrator/orchestrator.ts';
import { createMessageStore } from './session-manager/message-store.ts';
import { createApiServer, type ApiDeps } from './api/server.ts';
import { createPermissionEngine } from './permission-engine/permission-engine.ts';
import { createAuditLog } from './permission-engine/audit-log.ts';
import { createPendingApprovals } from './permission-engine/pending-approvals.ts';
import { createExecutionLogger } from './agent-manager/execution-logger.ts';
import { initializeBackend, setActiveBackend } from './agent-manager/agent-session.ts';
import type { AgentBackend } from './agent-manager/agent-backend.ts';
import { createModelBudget } from './agent-manager/model-budget.ts';
import { createTaskStore } from './task-manager/task-store.ts';
import { createYamlNamedAgentStore } from './agent-registry/yaml-named-agent-store.ts';
import { createAgentResolver } from './agent-registry/agent-resolver.ts';
import { CapabilityLibrary } from './capability-library/capability-library.ts';
import { ProjectRegistry } from './project-registry/project-registry.ts';
import { createAgentYamlStore } from './project-registry/agent-yaml-store.ts';
import { createConfigCommitter } from './agent-registry/config-committer.ts';
import { createScaffoldingApi } from './scaffolding/scaffolding-api.ts';
import {
  createScaffoldAndActivate,
  createReloadRegistries,
} from './scaffolding/scaffold-and-activate.ts';
import { getMetaProject } from './project-manager/meta-project.ts';
import { runProjectSync, syncProjectCache } from './project-manager/project-sync.ts';
import { createIdleDetector } from './session-manager/idle-detector.ts';
import { createSessionRetrospective } from './session-manager/session-retrospective.ts';
import { TaskExecutionEngine } from './task-execution/task-execution-engine.ts';
import { createValidationDeps } from './task-execution/create-validation-deps.ts';
import { createExecutionBridge } from './task-execution/execution-bridge.ts';
import { TemplateRegistry } from './template-engine/template-registry.ts';
import { createTemplateScheduler } from './template-engine/template-scheduler.ts';
import type { SessionIdleEvent } from '@raven/shared';
import type { RavenMcpDeps } from './mcp-server/index.ts';
import { createMemoryStore } from './agent-memory/memory-store.ts';
import { createMemoryConsolidation } from './agent-memory/memory-consolidation.ts';
import { createJobRegistry } from './scheduler/job-registry.ts';
import { registerCoreJobs } from './scheduler/core-jobs.ts';
import { createScheduleEngine } from './scheduler/schedule-engine.ts';
import type { SelfTestJobDeps } from './services/system/self-test.ts';
import { createSchedulePrefs } from './scheduler/schedule-prefs.ts';
import { createScheduleFireLog } from './scheduler/schedule-fire-log.ts';
import { createIntentStore } from './intents/intent-store.ts';
import { createHeartbeat } from './services/system/heartbeat.ts';
import { createGeminiUploadCleanup } from './services/gemini-transcription/upload-cleanup.ts';

const log = createLogger('raven');

/**
 * True boundaries only — kept intentionally minimal. Each field lets tests
 * substitute one seam without reaching into module-level state:
 * - `agentBackend`: skip the SDK entirely, run a fake backend.
 * - `dbPath`: point at a temp SQLite file instead of `data/raven.db`.
 * - `dataDir`: redirect all `data/*` runtime directories (logs, sessions,
 *   knowledge, media) and the background service project root away from
 *   the real project tree.
 * - `skipSuites`: skip starting real background services (Telegram bot,
 *   IMAP watcher, etc.) at boot.
 */
export interface RavenOverrides {
  agentBackend?: AgentBackend;
  dbPath?: string;
  dataDir?: string;
  /** Redirects the `projects/` tree (filesystem project store) away from
   * the real repo. Tests that create projects through the API/orchestrator
   * MUST set this — otherwise scaffolding writes real directories into the
   * checked-out repo. Distinct from `dataDir`, which only redirects
   * `data/*` runtime state; `projects/` holds source-of-truth definitions
   * resolved against `projectRoot` by default. */
  projectsDir?: string;
  /** Writable capability definitions, including scaffolded skills. */
  libraryDir?: string;
  /** Configuration storage shared by composition loaders and background services. */
  configDir?: string;
  /** Restrict HTTP binding for embedded callers and isolated smoke processes. */
  apiHost?: string;
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

  // Sync the getConfig() singleton — agent-manager, agent-session, and
  // permission-engine read config that way rather than via a threaded
  // parameter. index.ts's loadConfig() used to do this implicitly as a
  // side effect; createRaven takes config as an argument instead, so it
  // must set this explicitly.
  setConfig(config);

  const dataRoot = overrides.dataDir ?? projectRoot;
  const dataDir = resolve(dataRoot, 'data');

  // 1b. Initialize file logging (must be before any substantive logging)
  const logDir = resolve(dataRoot, 'data/logs');
  initFileLogging({ logDir, maxDays: 7, pretty: process.env.NODE_ENV !== 'production' });

  log.info(`Config loaded (model: ${config.CLAUDE_MODEL}, port: ${config.RAVEN_PORT})`);

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
  const geminiUploadCleanup = createGeminiUploadCleanup({ db: dbInterface });
  geminiUploadCleanup.recoverInterrupted();
  const modelBudget = createModelBudget({
    db: getDb(),
    dailyLimitUsd: config.RAVEN_MAX_BUDGET_USD_PER_DAY,
    maxConcurrent: config.RAVEN_MAX_CONCURRENT_AGENTS,
    timeZone: config.RAVEN_TIMEZONE,
  });
  modelBudget.recoverInterrupted();
  // All Manager and direct model calls share this one budgeted backend.
  if (overrides.agentBackend) setActiveBackend(overrides.agentBackend, modelBudget);
  else initializeBackend(modelBudget);

  // 3b. Verify meta-project exists (seeded by the fresh schema). Throws rather
  // than process.exit(1) — this function must stay testable; the fatal exit
  // now happens once, at the top-level main() in index.ts.
  try {
    const meta = getMetaProject();
    log.info(`Meta-project verified: "${meta.name}" (id: ${meta.id})`);
  } catch (err) {
    log.error(`Meta-project missing after schema initialization: ${err}`);
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

  // 5. Init config dir + integrations config
  const configDir = overrides.configDir ?? resolve(projectRoot, 'config');
  const integrationsConfig = loadIntegrationsConfig(configDir);

  // Load capability library — the sole capability system (skills, MCPs,
  // agent definitions, actions all come from library/).
  const capabilityLibrary = new CapabilityLibrary();
  const libraryDir = overrides.libraryDir ?? resolve(projectRoot, 'library');
  try {
    await capabilityLibrary.load(libraryDir);
    log.info(
      `Capability library loaded (${String(capabilityLibrary.getSkillNames().length)} skills)`,
    );
  } catch (err) {
    log.warn(`Capability library failed to load: ${err}`);
  }

  // Load project registry (filesystem-based project hierarchy). projectsDir
  // is overridable so tests never scaffold real directories into the repo
  // (see RavenOverrides.projectsDir).
  const projectRegistry = new ProjectRegistry();
  const projectsDir = overrides.projectsDir ?? resolve(projectRoot, 'projects');
  if (!existsSync(projectsDir)) mkdirSync(projectsDir, { recursive: true });
  try {
    await projectRegistry.load(projectsDir);
    log.info('Project registry loaded');
  } catch (err) {
    log.error(`Project registry failed to load: ${err}`);
    eventBus.removeAllListeners();
    closeDatabase();
    await closeFileLogging();
    throw err;
  }

  // Create agent YAML store (filesystem-backed agent definitions)
  const agentYamlStore = createAgentYamlStore();

  // Create scaffolding API (project domain creation)
  const scaffoldingApi = createScaffoldingApi({
    projectsDir,
    projectRegistry,
    syncProjects: () => {
      syncProjectCache({ db: getDb(), projectRegistry });
    },
    agentYamlStore,
    capabilityLibrary,
    libraryDir,
  });

  // Refresh the operational project projection from current definitions.
  try {
    await runProjectSync({ db: getDb(), projectRegistry, scaffoldingApi, projectsDir });
  } catch (err) {
    log.error(`Project definitions could not refresh the operational cache: ${err}`);
    eventBus.removeAllListeners();
    closeDatabase();
    await closeFileLogging();
    throw err;
  }

  // Validate authoritative task files before any integration or worker starts.
  const projectRecords = {
    projectsDir,
    projects: () => {
      projectRegistry.assertHealthy();
      return projectRegistry.listProjects().map((node) => ({
        id: node.isMeta ? META_PROJECT_ID : (node.metadata?.id ?? node.id),
        fsPath: node.id,
      }));
    },
  };
  let taskStore: ReturnType<typeof createTaskStore>;
  let executionEngine: TaskExecutionEngine;
  let executionLogger: ReturnType<typeof createExecutionLogger>;
  try {
    taskStore = createTaskStore({ ...projectRecords, eventBus });
    taskStore.getTaskCountsByStatus();
    executionLogger = createExecutionLogger(projectRecords);
    executionEngine = new TaskExecutionEngine({
      ...projectRecords,
      eventBus,
      validationDeps: createValidationDeps(eventBus, {
        cancelAgentTask: (id) => agentManager.cancelTask(id),
      }),
    });
    executionEngine.queryTrees();
  } catch (error) {
    eventBus.removeAllListeners();
    closeDatabase();
    await closeFileLogging();
    throw error;
  }
  (globalThis as unknown as Record<string, unknown>).__raven_task_store__ = taskStore;

  // L16: count only services whose requiresEnv is fully satisfied — NOT
  // every declared ServiceDefinition. Most deployments only configure a few
  // integrations (Gmail, TickTick, Telegram, ...) out of everything Raven
  // CAN run, so counting all SERVICE_DEFINITIONS made /api/health's
  // `services.configured` perpetually far above `services.loaded` even when
  // every service that could possibly start already had. This count is what
  // "loaded" (serviceRunner.getRunningCount()) is meaningfully compared
  // against in health.ts — a startup failure is still the only way
  // loaded < configured now.
  const configuredServiceCount = SERVICE_DEFINITIONS.filter((def) =>
    def.requiresEnv.every((v) => process.env[v]),
  ).length;

  // Intents (deterministic prospective memory): one shared store instance
  // threaded into the intent-matcher service (via baseContext.config, same
  // pattern as agentManager/pendingApprovals below), the Raven MCP tools
  // (create_intent/list_intents/cancel_intent), and the REST API — so a
  // cancel from the web UI and a fire from the matcher are never racing two
  // separate views of the same table.
  const intentStore = createIntentStore(getDb());

  // 6. Start background services (IMAP watcher, Telegram bot, etc.) — now
  // compiled ServiceDefinitions rather than suite-declared dynamic imports.
  const serviceRunner = createServiceRunner();
  const jobRegistry = createJobRegistry();
  let boundPort = config.RAVEN_PORT;
  let knowledge: KnowledgeRuntime | undefined = undefined;
  const baseContext = {
    eventBus: {
      emit: (event: unknown) => eventBus.emit(event as RavenEvent),
      on: (type: string, handler: (event: unknown) => void) =>
        eventBus.on(type as RavenEventType, handler),
      off: (type: string, handler: (event: unknown) => void) =>
        eventBus.off(type as RavenEventType, handler),
    },
    db: dbInterface,
    executionLogger,
    geminiUploadCleanup,
    logger: log,
    config: {
      intentStore,
      RAVEN_PORT: config.RAVEN_PORT,
      neo4j: {
        enabled: config.NEO4J_ENABLED,
        uri: config.NEO4J_URI,
        user: config.NEO4J_USER,
        password: config.NEO4J_PASSWORD,
      },
    } as Record<string, unknown>,
    projectRoot: dataRoot,
    configDir,
    projectsDir,
    libraryDir,
    getApiPort: () => boundPort,
    maintainKnowledge: async () => {
      if (!knowledge) return undefined;
      const refresh = await knowledge.reindex();
      return { refresh, reconciliation: await knowledge.knowledgeStore.reconcile() };
    },
    integrationsConfig,
    jobRegistry,
  };

  if (!overrides.skipSuites) {
    await serviceRunner.startServices(SERVICE_DEFINITIONS, baseContext);
  }

  // 7. Init permission engine
  const permissionEngine = createPermissionEngine({ capabilityLibrary, eventBus });
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

  // 7f. Init named agent registry (filesystem YAML is the source of truth)
  const namedAgentStore = createYamlNamedAgentStore({
    projectRegistry,
    agentYamlStore,
    projectsDir,
    eventBus: baseContext.eventBus,
  });
  const agentResolver = createAgentResolver({ capabilityLibrary });
  const configCommitter = createConfigCommitter({ eventBus });
  configCommitter.start();
  log.info(`Named agent registry initialized (${namedAgentStore.listAgents().length} agents)`);

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
    capabilityLibrary,
    db: dbInterface,
    pendingApprovals,
    intentStore,
  };
  const agentManager = new AgentManager({
    eventBus,
    permissionEngine,
    auditLog,
    pendingApprovals,
    capabilityLibrary,
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

  const mediaDir = resolve(dataRoot, 'data/media');
  if (!existsSync(mediaDir)) mkdirSync(mediaDir, { recursive: true });

  knowledge = await initializeKnowledge({
    config,
    eventBus,
    executionLogger,
    knowledgeDir,
    mediaDir,
    configDir,
  });
  const {
    neo4jClient,
    knowledgeStore,
    ingestionProcessor,
    embeddingEngine,
    clusteringEngine,
    chunkingEngine,
    retrievalEngine,
    knowledgeLifecycle,
    retrospective,
    knowledgeConsolidation,
  } = knowledge ?? {};
  if (knowledge) Object.assign(ravenMcpDeps, { knowledgeStore, retrievalEngine });

  // 11a. Init session retrospective — always constructed now (Phase 3): the
  // memory-candidate write path has no Neo4j dependency, so degraded mode
  // (Neo4j unreachable) still runs retrospectives and still writes memory
  // candidates. Only the additive knowledge-bubble half of the pipeline is
  // conditional on knowledgeStore+neo4jClient (see SessionRetrospectiveDeps).
  const sessionRetrospective = createSessionRetrospective({
    messageStore,
    sessionManager,
    eventBus,
    config,
    projectsDir,
    namedAgentStore,
    ...(knowledgeStore && neo4jClient ? { knowledgeStore, neo4j: neo4jClient } : {}),
  });

  // 11a-2. Memory consolidation (Phase 3): promotes pending memory
  // candidates written by retrospectives into an agent's actual memory
  // files, then regenerates MEMORY.md and git-commits. No Neo4j dependency.
  const memoryConsolidation = createMemoryConsolidation({
    projectsDir,
    memoryStore,
    namedAgentStore,
    eventBus,
    config,
  });

  // 11a-3. Weekly system retrospective deps (Phase 3): deterministic
  // aggregation of recorded agent failures + stuck task trees over 7d into one
  // memory candidate for the default agent. No model call, no Neo4j dep.
  const systemRetrospectiveDeps = {
    projectsDir,
    executionLogger,
    namedAgentStore,
    executionEngine,
  };

  // 11a-4. Self-test deps (Phase 3): deterministic invariants over the same
  // subsystems raven.ts already wired — no model call, no Neo4j dep.
  // scheduleEngine is added below via Object.assign once it exists — the
  // schedule health needs current activation/in-flight state and the canary
  // check needs effective enabled definitions — and selfTestDeps must be constructed here
  // (before registerCoreJobs) while scheduleEngine isn't built until after.
  const selfTestDeps: SelfTestJobDeps = {
    db: getDb(),
    executionEngine,
    executionLogger,
    pendingApprovals,
    serviceRunner,
    dataDir,
    eventBus,
  };

  // Durable per-fire log the self-test job reads to check "every schedule's
  // last fire reached a healthy terminal status" (see schedule-fire-log.ts).
  const scheduleFireLog = createScheduleFireLog(getDb());

  // Existing schedule engine dispatches registered jobs, templates and heartbeat.
  registerCoreJobs(jobRegistry, {
    taskStore,
    retrospective,
    knowledgeConsolidation,
    memoryConsolidation,
    systemRetrospectiveDeps,
    selfTestDeps,
  });
  const schedulePrefs = createSchedulePrefs(getDb());

  // Heartbeat (Phase 4 Task 3): ambient check-in, off by default (see
  // projects/schedules/heartbeat.yaml). Reuses the same capability/session
  // deps a real chat turn gets — see heartbeat.ts for why it dispatches via
  // runAgentTask directly rather than through agent-manager's event queue.
  const heartbeat = createHeartbeat({
    db: getDb(),
    executionLogger,
    eventBus,
    sessionManager,
    config,
    namedAgentStore,
    agentResolver,
    capabilityLibrary,
    ravenMcpDeps,
    memoryStore,
    permissionDeps: { permissionEngine, auditLog, pendingApprovals, capabilityLibrary },
  });

  const scheduleEngine = createScheduleEngine({
    schedules: projectRegistry.getGlobal().schedules,
    jobRegistry,
    taskStore,
    timezone: config.RAVEN_TIMEZONE,
    fireTemplate: (ref, options) => templateScheduler.triggerTemplate(ref, options),
    fireHeartbeat: heartbeat.fireHeartbeat,
    schedulePrefs,
    scheduleFireLog,
  });
  scheduleEngine.start();
  // Lazy-extend selfTestDeps now that scheduleEngine exists (same pattern
  // as ravenMcpDeps above) — checkCanary uses it to distinguish an enabled
  // canary schedule that's gone quiet from one that's simply turned off.
  Object.assign(selfTestDeps, { scheduleEngine });

  // Scaffold-and-activate: the single write->reload->commit path per
  // artifact kind (project/agent/template/schedule/skill) that makes
  // chat-driven "Raven, learn to do X" produce a live, git-committed
  // artifact with no restart. Built only now that scheduleEngine exists
  // (schedule-kind activation resyncs it) — added to ravenMcpDeps via
  // Object.assign, same lazy-extension pattern as knowledgeStore below,
  // since AgentManager (which holds ravenMcpDeps) was already constructed
  // above per the INVARIANT comment on ravenMcpDeps's first assignment.
  const scaffoldAndActivateDeps = {
    syncProjects: () => {
      syncProjectCache({ db: getDb(), projectRegistry });
    },
    scaffoldingApi,
    projectRegistry,
    templateRegistry,
    scheduleEngine,
    capabilityLibrary,
    projectsDir,
    libraryDir,
  };
  const scaffoldAndActivate = createScaffoldAndActivate(scaffoldAndActivateDeps);
  const reloadRegistries = createReloadRegistries(scaffoldAndActivateDeps);
  Object.assign(ravenMcpDeps, { scaffoldAndActivate, reloadRegistries });

  // 11b. Init idle detector + register session:idle handler — sessionRetrospective
  // is unconditionally constructed now (Phase 3), so this always wires up.
  const idleDetector = createIdleDetector({ eventBus, config });
  eventBus.on<SessionIdleEvent>('session:idle', (e) => {
    sessionRetrospective
      .runRetrospective(e.payload.sessionId, e.payload.projectId)
      .catch((err: unknown) => log.error(`Session retrospective failed: ${err}`));
  });
  idleDetector.start();
  log.info('Session idle detector started');

  // 11c. Init orchestrator after capability dependencies are available
  const _orchestrator = new Orchestrator({
    eventBus,
    sessionManager,
    messageStore,
    sessionRetrospective,
    namedAgentStore,
    agentResolver,
    capabilityLibrary,
    projectRegistry,
    scaffoldingApi,
    projectsDir,
    port: config.RAVEN_PORT,
  });

  // 12n. Backfill chunk embeddings for any un-chunked bubbles (non-blocking).
  // Undefined when the knowledge engine failed to initialize.
  chunkingEngine?.backfillChunks().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Chunk backfill failed: ${msg}`);
  });

  // 13. API server — bind deferred to start() so the instance can be handed
  // back to callers (tests) before the port is actually listening.
  let server: Awaited<ReturnType<typeof createApiServer>> | undefined;

  const apiDeps: ApiDeps = {
    eventBus,
    capabilityLibrary,
    sessionManager,
    scheduleEngine,
    agentManager,
    auditLog,
    pendingApprovals,
    permissionEngine,
    executionLogger,
    modelBudget,
    geminiUploadCleanup,
    messageStore,
    knowledgeStore,
    reindexKnowledge: knowledge?.reindex,
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
    memoryStore,
    serviceRunner,
    configuredServiceCount,
    unsnoozableCategories: [...UNSNOOZABLE_CATEGORIES],
    sessionRetrospective,
    dataDir,
    projectRegistry,
    agentYamlStore,
    projectsDir,
    executionEngine,
    templateRegistry,
    templateScheduler,
    scaffoldingApi,
    scaffoldAndActivate,
    intentStore,
  };

  async function start(): Promise<void> {
    server = await createApiServer(apiDeps, config.RAVEN_PORT, overrides.apiHost);

    const address = server.addresses()[0];
    boundPort = address?.port ?? config.RAVEN_PORT;
    void geminiUploadCleanup.retryPending().catch((error: unknown) => {
      log.warn(`Provider upload cleanup remains pending: ${String(error)}`);
    });
    log.info(`Raven is ready! API: http://localhost:${boundPort}`);
  }

  // Graceful shutdown — mirrors the former main()'s shutdown body, minus
  // process.exit (the caller decides what to do after stop() resolves).
  let stopping: Promise<void> | undefined;
  function stop(): Promise<void> {
    stopping ??= shutdown();
    return stopping;
  }

  async function shutdown(): Promise<void> {
    log.info('Shutting down...');
    const errors: unknown[] = [];
    async function cleanup(operation: () => unknown): Promise<void> {
      try {
        await operation();
      } catch (err) {
        errors.push(err);
        log.error(`Shutdown cleanup failed: ${err}`);
      }
    }
    // Stop HTTP acceptance immediately; let accepted requests drain before graph disposal.
    const serverClosed = cleanup(() => server?.close());
    // Stop admission now; keep completion consumers/stores alive until local tasks settle.
    executionEngine.stopAdmission();
    templateScheduler.stop();
    // Cancel all job owners before schedule drain. Shared graph/SQLite stores
    // remain available until these local tasks and the HTTP requests settle.
    await Promise.all(
      [
        () => _orchestrator.stop(),
        () => sessionRetrospective.stop(),
        () => agentManager.stop(),
        () => heartbeat.stop(),
        () => memoryConsolidation.stop(),
        () => geminiUploadCleanup.stop(),
        () => knowledgeConsolidation?.stop(),
        () => retrospective?.stop(),
        () => serviceRunner.stopAll(),
        () => scheduleEngine.stop(),
      ].map(cleanup),
    );
    await cleanup(() => idleDetector.stop());
    await cleanup(() => executionBridge.stop());
    await cleanup(() => executionEngine.stop());
    await cleanup(() => configCommitter.stop());
    await cleanup(() => permissionEngine.shutdown());
    await serverClosed;
    delete ravenMcpDeps.knowledgeStore;
    delete ravenMcpDeps.retrievalEngine;
    await cleanup(() => knowledge?.stop());
    await cleanup(() => eventBus.removeAllListeners());
    await cleanup(closeDatabase);
    log.info('Goodbye!');
    // Flush the logging worker before callers remove temporary runtime directories.
    await cleanup(closeFileLogging);
    if (errors.length > 0)
      throw new AggregateError(errors, 'Raven shutdown encountered cleanup failures');
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
