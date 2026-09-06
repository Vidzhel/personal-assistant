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
    expect(config.CLAUDE_MODEL).toBe('claude-sonnet-5');
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

  it('attributes an invalid extra browser origin to its own setting', async () => {
    process.env.RAVEN_BASE_URL = 'https://raven.example.test';
    process.env.RAVEN_BROWSER_ORIGINS = 'https://raven.example.test/path';
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exited = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('invalid config');
    });
    try {
      const { loadConfig } = await import('../config.ts');
      expect(() => loadConfig()).toThrow('invalid config');
      expect(JSON.stringify(logged.mock.calls)).toContain('RAVEN_BROWSER_ORIGINS');
      expect(JSON.stringify(logged.mock.calls)).not.toContain('RAVEN_BASE_URL');
    } finally {
      logged.mockRestore();
      exited.mockRestore();
    }
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

  it.each([
    ['CLAUDE_MODEL', ''],
    ['CLAUDE_MODEL', '   '],
    ['RAVEN_AGENT_MAX_TURNS', '0'],
    ['RAVEN_AGENT_MAX_TURNS', '1.5'],
    ['RAVEN_AGENT_MAX_TURNS', '101'],
    ['RAVEN_AGENT_MAX_TURNS', 'NaN'],
    ['RAVEN_MAX_BUDGET_USD_PER_DAY', '-1'],
    ['RAVEN_MAX_BUDGET_USD_PER_DAY', 'Infinity'],
    ['RAVEN_MAX_BUDGET_USD_PER_DAY', 'NaN'],
    ['RAVEN_MAX_CONCURRENT_AGENTS', '0'],
    ['RAVEN_MAX_CONCURRENT_AGENTS', '1.5'],
    ['RAVEN_TIMEZONE', 'Not/AZone'],
  ])('rejects invalid budget configuration %s=%s', async (key, value) => {
    process.env[key] = value;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    try {
      const { loadConfig } = await import('../config.ts');
      expect(() => loadConfig()).toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('accepts a zero daily budget to stop model admission', async () => {
    process.env.RAVEN_MAX_BUDGET_USD_PER_DAY = '0';
    const { loadConfig } = await import('../config.ts');
    expect(loadConfig().RAVEN_MAX_BUDGET_USD_PER_DAY).toBe(0);
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

  it('accepts only the dedicated TickTick MCP credential field', async () => {
    process.env.TICKTICK_MCP_TOKEN = 'fake-mcp-token';
    process.env.TICKTICK_CLIENT_ID = 'retired-client';
    process.env.TICKTICK_CLIENT_SECRET = 'retired-secret';
    process.env.TICKTICK_ACCESS_TOKEN = 'retired-access';
    const { loadConfig } = await import('../config.ts');
    const config = loadConfig();
    expect(config.TICKTICK_MCP_TOKEN).toBe('fake-mcp-token');
    expect(config).not.toHaveProperty('TICKTICK_CLIENT_ID');
    expect(config).not.toHaveProperty('TICKTICK_CLIENT_SECRET');
    expect(config).not.toHaveProperty('TICKTICK_ACCESS_TOKEN');
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

  describe('RAVEN_HEARTBEAT_ACTIVE_HOURS (F6)', () => {
    it('accepts a valid "HH-HH" value unchanged', async () => {
      process.env.RAVEN_HEARTBEAT_ACTIVE_HOURS = '22-06';
      const { loadConfig } = await import('../config.ts');
      const config = loadConfig();
      expect(config.RAVEN_HEARTBEAT_ACTIVE_HOURS).toBe('22-06');
    });

    it('defaults to "08-22" when unset', async () => {
      delete process.env.RAVEN_HEARTBEAT_ACTIVE_HOURS;
      const { loadConfig } = await import('../config.ts');
      const config = loadConfig();
      expect(config.RAVEN_HEARTBEAT_ACTIVE_HOURS).toBe('08-22');
    });

    // The old /^\d{1,2}-\d{1,2}$/ pattern let hours >23 through (e.g.
    // "25-30"), which isWithinActiveHours could then never match against a
    // 0-23 local hour — a fail-CLOSED outcome (heartbeat silently never
    // fires) contradicting that function's documented fail-open intent. The
    // tightened regex rejects it outright, and `.catch()` means rejection
    // falls back to the default instead of crashing config load entirely.
    it('falls back to the default on an out-of-range hour value rather than crashing config load', async () => {
      process.env.RAVEN_HEARTBEAT_ACTIVE_HOURS = '25-30';
      const { loadConfig } = await import('../config.ts');
      const config = loadConfig();
      expect(config.RAVEN_HEARTBEAT_ACTIVE_HOURS).toBe('08-22');
    });

    it('falls back to the default on a malformed value', async () => {
      process.env.RAVEN_HEARTBEAT_ACTIVE_HOURS = 'garbage';
      const { loadConfig } = await import('../config.ts');
      const config = loadConfig();
      expect(config.RAVEN_HEARTBEAT_ACTIVE_HOURS).toBe('08-22');
    });
  });
});
