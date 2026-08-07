import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRaven, type RavenInstance } from '../raven.ts';
import type { AppConfig } from '../config.ts';
import type { NotificationEvent, RavenEventType } from '@raven/shared';
import { getDb } from '../db/database.ts';
import { createIntentStore, type IntentStore } from '../intents/intent-store.ts';
import intentMatcher from '../intents/intent-matcher.ts';
import type { AgentBackend } from '../agent-manager/agent-backend.ts';

/**
 * E2E over the real composition root: createRaven -> start -> create an
 * intent directly against the store backing this Raven instance (mirrors
 * what the create_intent MCP tool does — there is no REST create route by
 * design, chat is the only creation surface, see the Phase 4 plan's
 * self-review) -> the REAL intent-matcher service (started here directly
 * rather than via skipSuites:false, to avoid booting every other zero-env
 * background service just to exercise this one) subscribes to the live
 * eventBus -> emitting a matching `email:new` fires exactly one
 * notification, respects cooldown on a repeat, and exhausts budget.
 */

const MS_PER_HOUR = 3_600_000;

function buildTestConfig(): AppConfig {
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
    NEO4J_URI: 'bolt://localhost:7687',
    NEO4J_USER: 'neo4j',
    NEO4J_PASSWORD: 'ravenpassword',
    RAVEN_SESSION_IDLE_TIMEOUT_MS: 1_800_000,
    RAVEN_CONSOLIDATION_CRON: '0 3 * * 0',
    RAVEN_AUTO_RETROSPECTIVE_ENABLED: true,
    RAVEN_HEARTBEAT_ACTIVE_HOURS: '08-22',
  };
}

function wrapEventBus(raven: RavenInstance): {
  emit: (event: unknown) => void;
  on: (type: string, handler: (event: unknown) => void) => void;
  off: (type: string, handler: (event: unknown) => void) => void;
} {
  return {
    emit: (event: unknown) => raven.eventBus.emit(event as never),
    on: (type: string, handler: (event: unknown) => void) =>
      raven.eventBus.on(type as RavenEventType, handler),
    off: (type: string, handler: (event: unknown) => void) =>
      raven.eventBus.off(type as RavenEventType, handler),
  };
}

describe('e2e: intents — create -> matching event -> notification, with budget + cooldown', () => {
  let tmpDir: string | undefined;
  let raven: RavenInstance | undefined;
  let intentStore: IntentStore | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await intentMatcher.stop();
    if (raven) await raven.stop();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    raven = undefined;
    tmpDir = undefined;
    intentStore = undefined;
  });

  it('fires once on match, stays silent within cooldown, exhausts after budget', async () => {
    // The real Orchestrator also subscribes to email:new (unconditionally,
    // to dispatch a gmail-skill triage turn) — every emitted email below
    // triggers that path too, alongside the intent matcher. A fake backend
    // keeps that unrelated dispatch from ever touching the real Claude SDK.
    const fakeBackend: AgentBackend = async () => ({ result: 'ok', success: true, errors: [] });

    tmpDir = mkdtempSync(join(tmpdir(), 'raven-e2e-intents-'));
    const dbPath = join(tmpDir, 'test.db');
    const projectsDir = join(tmpDir, 'projects');

    raven = await createRaven(buildTestConfig(), {
      dbPath,
      dataDir: tmpDir,
      projectsDir,
      agentBackend: fakeBackend,
      skipSuites: true,
    });
    await raven.start();

    intentStore = createIntentStore(getDb());
    const intent = intentStore.create({
      kind: 'event',
      keywords: ['invoice'],
      eventTypes: ['email:new'],
      message: 'Pay the invoice',
      fireBudget: 2,
      cooldownHours: 24,
    });

    await intentMatcher.start({
      eventBus: wrapEventBus(raven),
      db: raven.db,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
      config: { intentStore },
      projectRoot: tmpDir,
      integrationsConfig: {} as never,
      jobRegistry: {} as never,
    });

    const notifications: NotificationEvent[] = [];
    raven.eventBus.on<NotificationEvent>('notification', (e) => {
      if (e.source === 'intent-matcher') notifications.push(e);
    });

    const emitEmail = (): void => {
      raven?.eventBus.emit({
        id: `email-${String(Date.now())}-${String(Math.random())}`,
        timestamp: Date.now(),
        source: 'test',
        type: 'email:new',
        payload: {
          from: 'billing@acme.test',
          subject: 'Your invoice is ready',
          snippet: 'See attached invoice.',
          messageId: `m-${String(Date.now())}`,
          receivedAt: Date.now(),
        },
      });
    };

    // 1) First matching email -> exactly one notification.
    emitEmail();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].payload.channel).toBe('telegram');
    expect(notifications[0].payload.title).toBe('Reminder');
    expect(notifications[0].payload.body).toContain('Pay the invoice');
    expect(intentStore.get(intent.id)?.firesUsed).toBe(1);
    expect(intentStore.get(intent.id)?.status).toBe('active');

    // 2) A second matching email arrives immediately — inside the 24h
    // cooldown — nothing fires.
    emitEmail();
    expect(notifications).toHaveLength(1);
    expect(intentStore.get(intent.id)?.firesUsed).toBe(1);

    // 3) Advance the clock past the cooldown (still through the real
    // event-driven path — checkEventIntents defaults to Date.now()) and
    // fire again: budget was 2, so this second fire exhausts it.
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 25 * MS_PER_HOUR);
    emitEmail();
    expect(notifications).toHaveLength(2);
    expect(intentStore.get(intent.id)?.status).toBe('exhausted');
    expect(intentStore.get(intent.id)?.firesUsed).toBe(2);

    // 4) Budget exhausted — a third matching email, even well past
    // cooldown, fires nothing.
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 100 * MS_PER_HOUR);
    emitEmail();
    expect(notifications).toHaveLength(2);
  }, 10000);
});
