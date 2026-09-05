import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { AppConfig } from '../../config.ts';
import type { RavenOverrides } from '../../raven.ts';
import { assertIsolatedRoot } from '../setup/isolated-composition.ts';

interface FixtureOptions {
  agents?: string[];
  template?: 'morning-digest';
  schedule?: 'memory-consolidation' | 'self-test';
  gmailActions?: boolean;
  emailRules?: boolean;
}

function write(path: string, content: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
}

/** Minimal definitions only: never clone the owner's projects, memories or library. */
export function createRavenTestFixture(
  root: string,
  options: FixtureOptions = {},
): RavenOverrides & {
  dataDir: string;
  projectsDir: string;
  libraryDir: string;
  configDir: string;
  dbPath: string;
} {
  assertIsolatedRoot(root);
  const agents = options.agents ?? ['raven'];
  if (agents.some((name) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))) {
    throw new Error('Fixture agent names must be kebab-case');
  }
  const projectsDir = join(root, 'projects');
  const libraryDir = join(root, 'library');
  const configDir = join(root, 'config');
  for (const dir of [projectsDir, libraryDir, configDir]) mkdirSync(dir, { recursive: true });
  for (const name of agents) {
    write(join(projectsDir, 'agents', name, 'agent.yaml'), {
      name,
      displayName: name,
      description: 'Isolated test agent',
      isDefault: name === 'raven',
      skills: [],
    });
  }
  // Specific shipped definitions exercise their real contracts; no directory copy.
  const shippedProjects = resolve(import.meta.dirname, '../../../../../projects');
  if (options.template) {
    const path = join('templates', `${options.template}.yaml`);
    mkdirSync(join(projectsDir, 'templates'), { recursive: true });
    copyFileSync(join(shippedProjects, path), join(projectsDir, path));
  }
  if (options.schedule) {
    // Manual trigger tests must never race an ambient cron fire.
    write(join(projectsDir, 'schedules', `${options.schedule}.yaml`), {
      name: options.schedule,
      cron: '0 0 1 1 *',
      timezone: 'UTC',
      enabled: false,
      run: { kind: 'job', ref: options.schedule },
    });
  }
  if (options.gmailActions) {
    write(join(libraryDir, 'skills', 'email', 'gmail', 'config.json'), {
      name: 'gmail',
      displayName: 'Gmail fixture',
      description: 'Test email permission actions; no external MCP',
      mcps: [],
      actions: ['archive-email', 'mark-read', 'send-email', 'delete-email'].map((name) => ({
        name: `gmail:${name}`,
        description: name,
        defaultTier: name === 'send-email' || name === 'delete-email' ? 'red' : 'yellow',
        reversible: name === 'archive-email' || name === 'mark-read',
      })),
    });
    write(join(libraryDir, 'skills', 'email', 'gmail', 'skill.md'), 'Test email actions only.');
  }
  if (options.emailRules) {
    write(join(configDir, 'email-rules.json'), {
      enabled: true,
      matchMode: 'all',
      rules: [
        {
          name: 'automated-noreply',
          match: { from: ['noreply@'], has: ['automated'] },
          actions: { archive: true, markRead: true },
          enabled: true,
          priority: 5,
        },
      ],
    });
  }
  return { dataDir: root, projectsDir, libraryDir, configDir, dbPath: join(root, 'test.db') };
}

export function buildTestConfig(): AppConfig {
  return {
    ANTHROPIC_API_KEY: '',
    CLAUDE_MODEL: 'claude-sonnet-4-6',
    RAVEN_PORT: 0,
    RAVEN_TIMEZONE: 'UTC',
    RAVEN_DIGEST_TIME: '08:00',
    RAVEN_MAX_CONCURRENT_AGENTS: 3,
    RAVEN_AGENT_MAX_TURNS: 25,
    RAVEN_MAX_BUDGET_USD_PER_DAY: 5,
    DATABASE_PATH: './data/raven.db',
    SESSION_PATH: './data/sessions',
    LOG_LEVEL: 'info',
    NEO4J_URI: 'bolt://graph.invalid:7687',
    NEO4J_USER: 'test-user',
    NEO4J_PASSWORD: 'test-password',
    RAVEN_SESSION_IDLE_TIMEOUT_MS: 1_800_000,
    RAVEN_CONSOLIDATION_CRON: '0 3 * * 0',
    RAVEN_AUTO_RETROSPECTIVE_ENABLED: true,
    RAVEN_HEARTBEAT_ACTIVE_HOURS: '08-22',
  };
}
