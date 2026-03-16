import { resolve, dirname } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { createLogger, type RavenEvent, type RavenEventType } from '@raven/shared';
import { loadConfig, loadSuitesConfig, loadSchedulesConfig, projectRoot } from './config.ts';
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
import { createPipelineEngine } from './pipeline-engine/pipeline-engine.ts';
import { createPipelineStore } from './pipeline-engine/pipeline-store.ts';
import { createPipelineScheduler } from './pipeline-engine/pipeline-scheduler.ts';
import { createPipelineEventTrigger } from './pipeline-engine/pipeline-event-trigger.ts';

const log = createLogger('raven');

// eslint-disable-next-line max-lines-per-function -- boot sequence that initializes all subsystems
async function main(): Promise<void> {
  log.info('Starting Raven...');

  // 1. Load config
  const config = loadConfig();
  log.info(`Config loaded (model: ${config.CLAUDE_MODEL}, port: ${config.RAVEN_PORT})`);

  // Initialize agent backend: SDK mode (API key) or CLI mode (claude binary)
  initializeBackend(config.ANTHROPIC_API_KEY);

  // 2. Ensure data directories (resolve relative paths against project root, not CWD)
  const dbPath = resolve(projectRoot, config.DATABASE_PATH);
  const sessionPath = resolve(projectRoot, config.SESSION_PATH);
  const dbDir = dirname(dbPath);
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
  if (!existsSync(sessionPath)) mkdirSync(sessionPath, { recursive: true });

  // 3. Init database
  initDatabase(dbPath);
  const dbInterface = createDbInterface();

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

  await suiteRegistry.loadSuites(suitesDir, suitesConfig);
  suiteRegistry.validateAgentTools();

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

  // 7e. Inject permission deps into service context for callback handler (lazy resolution)
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

  // 11. Init orchestrator
  const _orchestrator = new Orchestrator({
    eventBus,
    suiteRegistry,
    sessionManager,
    messageStore,
  });

  // 12. Init scheduler
  const schedulesConfig = loadSchedulesConfig(configDir);
  const scheduler = new Scheduler(eventBus, config.RAVEN_TIMEZONE);
  await scheduler.initialize(schedulesConfig);

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
      configuredSuiteCount,
    },
    config.RAVEN_PORT,
  );

  log.info(`Raven is ready! API: http://localhost:${config.RAVEN_PORT}`);

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    log.info('Shutting down...');
    pipelineScheduler.shutdown();
    pipelineEventTrigger.shutdown();
    pipelineEngine.shutdown();
    permissionEngine.shutdown();
    scheduler.shutdown();
    await serviceRunner.stopAll();
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
