import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync } from 'node:fs';
import { createLogger } from '@raven/shared';
import { loadConfig, loadSkillsConfig, loadSchedulesConfig } from './config.js';
import { initDatabase, createDbInterface } from './db/database.js';
import { EventBus } from './event-bus/event-bus.js';
import { SkillRegistry } from './skill-registry/skill-registry.js';
import { McpManager } from './mcp-manager/mcp-manager.js';
import { AgentManager } from './agent-manager/agent-manager.js';
import { SessionManager } from './session-manager/session-manager.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { Scheduler } from './scheduler/scheduler.js';
import { createApiServer } from './api/server.js';

const log = createLogger('raven');

async function main() {
  log.info('Starting Raven...');

  // 1. Load config
  const config = loadConfig();
  log.info(`Config loaded (model: ${config.CLAUDE_MODEL}, port: ${config.RAVEN_PORT})`);

  if (!config.ANTHROPIC_API_KEY) {
    log.warn('ANTHROPIC_API_KEY is not set. Agent tasks will fail unless claude CLI auth is available.');
  }

  // 2. Ensure data directories
  const dbDir = dirname(resolve(config.DATABASE_PATH));
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
  if (!existsSync(config.SESSION_PATH)) mkdirSync(config.SESSION_PATH, { recursive: true });

  // 3. Init database
  initDatabase(resolve(config.DATABASE_PATH));
  const dbInterface = createDbInterface();

  // 4. Init event bus
  const eventBus = new EventBus();

  // 5. Init skill registry
  const skillRegistry = new SkillRegistry();

  // 6. Load and register skills
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const projectRoot = resolve(__dirname, '../../..');
  const configDir = resolve(projectRoot, 'config');
  const skillsConfig = loadSkillsConfig(configDir);

  const baseContext = {
    eventBus: {
      emit: (event: unknown) => eventBus.emit(event as import('@raven/shared').RavenEvent),
      on: (type: string, handler: (event: unknown) => void) => eventBus.on(type as import('@raven/shared').RavenEventType, handler),
      off: (type: string, handler: (event: unknown) => void) => eventBus.off(type as import('@raven/shared').RavenEventType, handler),
    },
    db: dbInterface,
    logger: log,
    getSkillData: async () => null,
  };

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
      log.warn(`Failed to load skill '${name}': ${err instanceof Error ? err.message : err}`);
    }
  }

  // 7. Init MCP manager
  const mcpManager = new McpManager(skillRegistry);

  // 8. Init session manager
  const sessionManager = new SessionManager();

  // 9. Init agent manager
  const agentManager = new AgentManager(eventBus, mcpManager, skillRegistry);

  // 10. Init orchestrator
  const orchestrator = new Orchestrator(eventBus, skillRegistry, mcpManager);

  // 11. Init scheduler
  const schedulesConfig = loadSchedulesConfig(configDir);
  const scheduler = new Scheduler(eventBus, config.RAVEN_TIMEZONE);
  await scheduler.initialize(schedulesConfig);

  // 12. Start API server
  const server = await createApiServer(
    { eventBus, skillRegistry, sessionManager, scheduler, agentManager },
    config.RAVEN_PORT,
  );

  log.info(`Raven is ready! API: http://localhost:${config.RAVEN_PORT}`);

  // Graceful shutdown
  const shutdown = async () => {
    log.info('Shutting down...');
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
  console.error('Fatal error:', err);
  process.exit(1);
});
