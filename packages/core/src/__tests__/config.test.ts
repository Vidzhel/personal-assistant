import { describe, it, expect, vi, afterEach } from 'vitest';

// Mock dotenv so it doesn't load the real .env file during tests
vi.mock('dotenv', () => ({ default: { config: () => {} } }));

describe('config', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it('parses valid env with defaults', async () => {
    // Clear all config-related env vars to test Zod defaults
    delete process.env.RAVEN_PORT;
    delete process.env.RAVEN_TIMEZONE;
    delete process.env.RAVEN_AGENT_MAX_TURNS;
    delete process.env.CLAUDE_MODEL;
    delete process.env.LOG_LEVEL;
    delete process.env.DATABASE_PATH;
    delete process.env.RAVEN_MAX_CONCURRENT_AGENTS;
    delete process.env.RAVEN_DIGEST_TIME;
    delete process.env.RAVEN_MAX_BUDGET_USD_PER_DAY;
    delete process.env.SESSION_PATH;
    delete process.env.ANTHROPIC_API_KEY;

    const { loadConfig } = await import('../config.ts');
    const config = loadConfig();

    expect(config.RAVEN_PORT).toBe(4001);
    expect(config.RAVEN_TIMEZONE).toBe('UTC');
    expect(config.RAVEN_AGENT_MAX_TURNS).toBe(25);
    expect(config.CLAUDE_MODEL).toBe('claude-sonnet-4-6');
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.RAVEN_MAX_CONCURRENT_AGENTS).toBe(3);
  });

  it('respects custom env values', async () => {
    process.env.RAVEN_PORT = '4000';
    process.env.RAVEN_TIMEZONE = 'America/New_York';
    process.env.RAVEN_AGENT_MAX_TURNS = '10';
    process.env.LOG_LEVEL = 'debug';
    process.env.RAVEN_MAX_CONCURRENT_AGENTS = '5';

    const { loadConfig } = await import('../config.ts');
    const config = loadConfig();

    expect(config.RAVEN_PORT).toBe(4000);
    expect(config.RAVEN_TIMEZONE).toBe('America/New_York');
    expect(config.RAVEN_AGENT_MAX_TURNS).toBe(10);
    expect(config.LOG_LEVEL).toBe('debug');
    expect(config.RAVEN_MAX_CONCURRENT_AGENTS).toBe(5);
  });

  it('invalid LOG_LEVEL causes exit', async () => {
    process.env.LOG_LEVEL = 'invalid_level';

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    const { loadConfig } = await import('../config.ts');
    expect(() => loadConfig()).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });

  it('getConfig throws if loadConfig not called', async () => {
    const { getConfig } = await import('../config.ts');
    expect(() => getConfig()).toThrow('Config not loaded');
  });

  it('ANTHROPIC_API_KEY defaults to empty string', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { loadConfig } = await import('../config.ts');
    const config = loadConfig();
    expect(config.ANTHROPIC_API_KEY).toBe('');
  });

  it('Telegram group/topic env vars are optional and parsed correctly', async () => {
    process.env.TELEGRAM_GROUP_ID = '-1001234567890';
    process.env.TELEGRAM_TOPIC_GENERAL = '1';
    process.env.TELEGRAM_TOPIC_SYSTEM = '42';
    process.env.TELEGRAM_TOPIC_MAP = '{"Work":5,"Personal":7}';

    const { loadConfig } = await import('../config.ts');
    const config = loadConfig();

    expect(config.TELEGRAM_GROUP_ID).toBe('-1001234567890');
    expect(config.TELEGRAM_TOPIC_GENERAL).toBe('1');
    expect(config.TELEGRAM_TOPIC_SYSTEM).toBe('42');
    expect(config.TELEGRAM_TOPIC_MAP).toBe('{"Work":5,"Personal":7}');
  });

  it('Telegram group/topic env vars default to undefined when not set', async () => {
    delete process.env.TELEGRAM_GROUP_ID;
    delete process.env.TELEGRAM_TOPIC_GENERAL;
    delete process.env.TELEGRAM_TOPIC_SYSTEM;
    delete process.env.TELEGRAM_TOPIC_MAP;

    const { loadConfig } = await import('../config.ts');
    const config = loadConfig();

    expect(config.TELEGRAM_GROUP_ID).toBeUndefined();
    expect(config.TELEGRAM_TOPIC_GENERAL).toBeUndefined();
    expect(config.TELEGRAM_TOPIC_SYSTEM).toBeUndefined();
    expect(config.TELEGRAM_TOPIC_MAP).toBeUndefined();
  });
});
