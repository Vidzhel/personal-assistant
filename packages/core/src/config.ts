import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import 'dotenv/config';

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().default(''),  // Empty = use `claude` CLI auth (MAX plan)
  CLAUDE_MODEL: z.string().default('claude-sonnet-4-5-20250514'),
  RAVEN_PORT: z.coerce.number().default(3001),
  RAVEN_TIMEZONE: z.string().default('UTC'),
  RAVEN_DIGEST_TIME: z.string().default('08:00'),
  RAVEN_MAX_CONCURRENT_AGENTS: z.coerce.number().default(3),
  RAVEN_MAX_BUDGET_USD_PER_DAY: z.coerce.number().default(5.0),
  DATABASE_PATH: z.string().default('./data/raven.db'),
  SESSION_PATH: z.string().default('./data/sessions'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

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
});

export type AppConfig = z.infer<typeof envSchema>;

let config: AppConfig;

export function loadConfig(): AppConfig {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid configuration:', result.error.format());
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
