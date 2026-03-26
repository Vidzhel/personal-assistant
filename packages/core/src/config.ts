import { z } from 'zod';
import dotenv from 'dotenv';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve project root from file location (works from both src/ and dist/)
const __dirname = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(__dirname, '..', '..', '..');

// Load .env from project root — not CWD (which differs in workspace scripts)
dotenv.config({ path: resolve(projectRoot, '.env') });

const DEFAULT_PORT = 4001;
const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_MAX_TURNS = 25;
const DEFAULT_BUDGET_USD = 5.0;
const DEFAULT_IDLE_TIMEOUT_MS = 1800000; // 30 minutes
const DEFAULT_COMPACTION_THRESHOLD = 40; // message count
const DEFAULT_CONSOLIDATION_CRON = '0 3 * * 0'; // Sunday 3am

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().default(''), // Empty = use `claude` CLI auth (MAX plan)
  CLAUDE_MODEL: z.string().default('claude-sonnet-4-6'),
  RAVEN_PORT: z.coerce.number().default(DEFAULT_PORT),
  RAVEN_TIMEZONE: z.string().default('UTC'),
  RAVEN_DIGEST_TIME: z.string().default('08:00'),
  RAVEN_MAX_CONCURRENT_AGENTS: z.coerce.number().default(DEFAULT_MAX_CONCURRENT),
  RAVEN_AGENT_MAX_TURNS: z.coerce.number().default(DEFAULT_MAX_TURNS),
  RAVEN_MAX_BUDGET_USD_PER_DAY: z.coerce.number().default(DEFAULT_BUDGET_USD),
  DATABASE_PATH: z.string().default('./data/raven.db'),
  SESSION_PATH: z.string().default('./data/sessions'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Neo4j (knowledge engine graph store)
  NEO4J_URI: z.string().default('bolt://localhost:7687'),
  NEO4J_USER: z.string().default('neo4j'),
  NEO4J_PASSWORD: z.string().default('ravenpassword'),

  // Optional skill-specific (loaded from .env, injected into skill configs)
  TICKTICK_CLIENT_ID: z.string().optional(),
  TICKTICK_CLIENT_SECRET: z.string().optional(),
  TICKTICK_ACCESS_TOKEN: z.string().optional(),
  GMAIL_IMAP_USER: z.string().optional(),
  GMAIL_IMAP_PASSWORD: z.string().optional(),
  GMAIL_CLIENT_ID: z.string().optional(),
  GMAIL_CLIENT_SECRET: z.string().optional(),
  GMAIL_REFRESH_TOKEN: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  TELEGRAM_GROUP_ID: z.string().optional(),
  TELEGRAM_TOPIC_GENERAL: z.string().optional(),
  TELEGRAM_TOPIC_SYSTEM: z.string().optional(),
  TELEGRAM_TOPIC_MAP: z.string().optional(),

  // Session auto-compaction & retrospective
  RAVEN_SESSION_IDLE_TIMEOUT_MS: z.coerce.number().default(DEFAULT_IDLE_TIMEOUT_MS),
  RAVEN_SESSION_COMPACTION_THRESHOLD: z.coerce.number().default(DEFAULT_COMPACTION_THRESHOLD),
  RAVEN_CONSOLIDATION_CRON: z.string().default(DEFAULT_CONSOLIDATION_CRON),
  RAVEN_AUTO_RETROSPECTIVE_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export type AppConfig = z.infer<typeof envSchema>;

let config: AppConfig;

export function loadConfig(): AppConfig {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    // eslint-disable-next-line no-console -- runs before logger init
    console.error('Invalid configuration:', z.treeifyError(result.error));
    process.exit(1);
  }
  config = result.data;
  return config;
}

export function getConfig(): AppConfig {
  if (!config) throw new Error('Config not loaded. Call loadConfig() first.');
  return config;
}

export interface SkillsConfig {
  [skillName: string]: {
    enabled: boolean;
    config: Record<string, unknown>;
  };
}

export function loadSkillsConfig(configDir: string): SkillsConfig {
  const path = resolve(configDir, 'skills.json');
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as SkillsConfig;
}

export interface SuitesConfig {
  [suiteName: string]: {
    enabled: boolean;
    config?: Record<string, unknown>;
  };
}

export function loadSuitesConfig(configDir: string): SuitesConfig {
  const path = resolve(configDir, 'suites.json');
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as SuitesConfig;
}

export interface ScheduleConfig {
  id: string;
  name: string;
  cron: string;
  taskType: string;
  skillName: string;
  enabled: boolean;
}

export function loadSchedulesConfig(configDir: string): ScheduleConfig[] {
  const path = resolve(configDir, 'schedules.json');
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as ScheduleConfig[];
}
