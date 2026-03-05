import { resolve, dirname } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { createLogger, generateId, type RavenEvent, type RavenEventType } from '@raven/shared';
import { loadConfig, loadSkillsConfig, loadSchedulesConfig, projectRoot } from './config.ts';
import { initDatabase, createDbInterface, getDb } from './db/database.ts';
import { EventBus } from './event-bus/event-bus.ts';
import { SkillRegistry } from './skill-registry/skill-registry.ts';
import { McpManager } from './mcp-manager/mcp-manager.ts';
import { AgentManager } from './agent-manager/agent-manager.ts';
import { SessionManager } from './session-manager/session-manager.ts';
import { Orchestrator } from './orchestrator/orchestrator.ts';
import { Scheduler } from './scheduler/scheduler.ts';
import { createApiServer } from './api/server.ts';
import { createPermissionEngine } from './permission-engine/permission-engine.ts';
import { createAuditLog } from './permission-engine/audit-log.ts';
import { createPendingApprovals } from './permission-engine/pending-approvals.ts';
import { createExecutionLogger } from './agent-manager/execution-logger.ts';

const log = createLogger('raven');

async function main(): Promise<void> {
  log.info('Starting Raven...');

  // 1. Load config
  const config = loadConfig();
  log.info(`Config loaded (model: ${config.CLAUDE_MODEL}, port: ${config.RAVEN_PORT})`);

  if (!config.ANTHROPIC_API_KEY) {
    log.warn(
      'ANTHROPIC_API_KEY is not set. Agent tasks will fail unless claude CLI auth is available.',
    );
  }

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

  // 5. Init skill registry
  const skillRegistry = new SkillRegistry();

  // 6. Load and register skills
  const configDir = resolve(projectRoot, 'config');
  const skillsConfig = loadSkillsConfig(configDir);

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
    getSkillData: async () => null,
  };

  // Count configured (enabled) skills before loading
  const configuredSkillCount = Object.values(skillsConfig).filter((s) => s?.enabled).length;

  // Dynamic skill loading from packages/skills/
  const skillModules: Record<string, string> = {
    ticktick: resolve(projectRoot, 'packages/skills/skill-ticktick/dist/index.js'),
    gmail: resolve(projectRoot, 'packages/skills/skill-gmail/dist/index.js'),
    digest: resolve(projectRoot, 'packages/skills/skill-digest/dist/index.js'),
    telegram: resolve(projectRoot, 'packages/skills/skill-telegram/dist/index.js'),
  };

  for (const [name, modulePath] of Object.entries(skillModules)) {
    const skillConfig = skillsConfig[name];
    if (!skillConfig?.enabled) {
      log.info(`Skill '${name}' is disabled, skipping`);
      continue;
    }

    try {
      const mod = await import(modulePath);
      const createSkill = mod.default ?? mod.createSkill;
      if (typeof createSkill === 'function') {
        const skill = createSkill();
        await skillRegistry.registerSkill(skill, skillConfig.config ?? {}, baseContext);
      } else {
        log.warn(`Skill '${name}' does not export a factory function`);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn(`Failed to load skill '${name}': ${errMsg}`);
      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: 'skill-registry',
        type: 'system:health:alert',
        payload: {
          severity: 'error' as const,
          source: 'skill-registry',
          message: `Failed to load skill '${name}': ${errMsg}`,
        },
      });
    }
  }

  // 7. Init permission engine
  const permissionEngine = createPermissionEngine({ skillRegistry, eventBus });
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

  // 8. Init MCP manager
  const mcpManager = new McpManager(skillRegistry);

  // 9. Init session manager
  const sessionManager = new SessionManager();

  // 10. Init agent manager
  const agentManager = new AgentManager({
    eventBus,
    mcpManager,
    skillRegistry,
    permissionEngine,
    auditLog,
    pendingApprovals,
    executionLogger,
  });

  // 11. Init orchestrator
  const _orchestrator = new Orchestrator(eventBus, skillRegistry, mcpManager);

  // 12. Init scheduler
  const schedulesConfig = loadSchedulesConfig(configDir);
  const scheduler = new Scheduler(eventBus, config.RAVEN_TIMEZONE);
  await scheduler.initialize(schedulesConfig);

  // 13. Start API server
  const server = await createApiServer(
    {
      eventBus,
      skillRegistry,
      sessionManager,
      scheduler,
      agentManager,
      auditLog,
      pendingApprovals,
      executionLogger,
      configuredSkillCount,
    },
    config.RAVEN_PORT,
  );

  log.info(`Raven is ready! API: http://localhost:${config.RAVEN_PORT}`);

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    log.info('Shutting down...');
    permissionEngine.shutdown();
    scheduler.shutdown();
    await skillRegistry.shutdown();
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
