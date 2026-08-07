import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EventBusInterface, NewEmailEvent } from '@raven/shared';
import { initDatabase, closeDatabase, getDb } from '../db/database.ts';
import { createIntentStore, type IntentStore } from '../intents/intent-store.ts';
import {
  matchesAllKeywords,
  extractMatchText,
  checkEventIntents,
  runTimeSweep,
} from '../intents/intent-matcher.ts';

const MS_PER_HOUR = 3_600_000;

function fakeEventBus(): EventBusInterface & {
  emitted: Array<{ type: string; payload: unknown }>;
} {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  return {
    emitted,
    emit: (event: unknown) => {
      const e = event as { type: string; payload: unknown };
      emitted.push({ type: e.type, payload: e.payload });
    },
    on: () => undefined,
    off: () => undefined,
  };
}

function makeEmail(overrides: Partial<NewEmailEvent['payload']> = {}): NewEmailEvent {
  return {
    id: 'e1',
    timestamp: Date.now(),
    source: 'test',
    type: 'email:new',
    payload: {
      from: 'billing@acme.test',
      subject: 'Your invoice is ready',
      snippet: 'Please find attached the invoice for this month.',
      messageId: 'm1',
      receivedAt: Date.now(),
      ...overrides,
    },
  };
}

describe('matchesAllKeywords', () => {
  it('is case-insensitive and requires ALL keywords', () => {
    expect(matchesAllKeywords('Your Invoice is ready', ['invoice', 'ready'])).toBe(true);
    expect(matchesAllKeywords('Your Invoice is ready', ['invoice', 'overdue'])).toBe(false);
  });

  it('never matches with zero keywords', () => {
    expect(matchesAllKeywords('anything at all', [])).toBe(false);
  });
});

describe('extractMatchText', () => {
  it('extracts subject + snippet for email:new', () => {
    const text = extractMatchText(makeEmail());
    expect(text).toBe('Your invoice is ready Please find attached the invoice for this month.');
  });

  it('returns undefined for an event type it does not curate', () => {
    const text = extractMatchText({
      id: 'x',
      timestamp: Date.now(),
      source: 'test',
      type: 'config:reloaded',
      payload: { configType: 'x', timestamp: '2020-01-01' },
    } as never);
    expect(text).toBeUndefined();
  });
});

describe('checkEventIntents + runTimeSweep (integration over a real DB)', () => {
  let tmpDir: string;
  let store: IntentStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-intent-matcher-'));
    initDatabase(join(tmpDir, 'test.db'));
    store = createIntentStore(getDb());
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fires a notification exactly once on a matching event', () => {
    store.create({
      kind: 'event',
      keywords: ['invoice'],
      eventTypes: ['email:new'],
      message: 'Pay the invoice',
    });
    const bus = fakeEventBus();

    checkEventIntents({ intentStore: store, eventBus: bus }, makeEmail());

    expect(bus.emitted).toHaveLength(1);
    expect(bus.emitted[0].type).toBe('notification');
    expect((bus.emitted[0].payload as { title: string }).title).toBe('Reminder');
    expect((bus.emitted[0].payload as { body: string }).body).toContain('Pay the invoice');
  });

  it('does not fire when keywords do not all match', () => {
    store.create({
      kind: 'event',
      keywords: ['invoice', 'overdue'],
      eventTypes: ['email:new'],
      message: 'Pay the invoice',
    });
    const bus = fakeEventBus();

    checkEventIntents({ intentStore: store, eventBus: bus }, makeEmail());

    expect(bus.emitted).toHaveLength(0);
  });

  it('does not fire for an event type the intent did not declare', () => {
    store.create({
      kind: 'event',
      keywords: ['invoice'],
      eventTypes: ['financial:transaction:recorded'],
      message: 'Pay the invoice',
    });
    const bus = fakeEventBus();

    checkEventIntents({ intentStore: store, eventBus: bus }, makeEmail());

    expect(bus.emitted).toHaveLength(0);
  });

  it('respects fire budget across repeated matching events', () => {
    store.create({
      kind: 'event',
      keywords: ['invoice'],
      eventTypes: ['email:new'],
      message: 'Pay the invoice',
      fireBudget: 1,
      cooldownHours: 0,
    });
    const bus = fakeEventBus();
    const deps = { intentStore: store, eventBus: bus };

    checkEventIntents(deps, makeEmail());
    checkEventIntents(deps, makeEmail());

    expect(bus.emitted).toHaveLength(1);
  });

  it('respects cooldown between matching events', () => {
    const now = Date.now();
    store.create(
      {
        kind: 'event',
        keywords: ['invoice'],
        eventTypes: ['email:new'],
        message: 'Pay the invoice',
        fireBudget: 5,
        cooldownHours: 24,
      },
      now,
    );
    const bus = fakeEventBus();
    const deps = { intentStore: store, eventBus: bus };

    checkEventIntents(deps, makeEmail(), now);
    checkEventIntents(deps, makeEmail(), now + MS_PER_HOUR);

    expect(bus.emitted).toHaveLength(1);
  });

  it('runTimeSweep fires due kind=time intents and skips not-yet-due ones', () => {
    const now = Date.now();
    store.create({ kind: 'time', nextFireAt: now - 1000, message: 'call the bank' }, now);
    store.create({ kind: 'time', nextFireAt: now + MS_PER_HOUR, message: 'not yet' }, now);
    const bus = fakeEventBus();

    runTimeSweep({ intentStore: store, eventBus: bus }, now);

    expect(bus.emitted).toHaveLength(1);
    expect((bus.emitted[0].payload as { body: string }).body).toContain('call the bank');
  });

  it('runTimeSweep also expires stale active intents', () => {
    const now = Date.now();
    const stale = store.create(
      {
        kind: 'event',
        keywords: ['x'],
        eventTypes: ['email:new'],
        message: 'm',
        expiresAt: now - 1,
      },
      now - MS_PER_HOUR,
    );
    const bus = fakeEventBus();

    runTimeSweep({ intentStore: store, eventBus: bus }, now);

    expect(store.get(stale.id)?.status).toBe('expired');
  });
});

describe('intent-matcher service', () => {
  it('subscribes to every MATCHED_EVENT_TYPES entry and unsubscribes on stop', async () => {
    const on = vi.fn();
    const off = vi.fn();
    const bus: EventBusInterface = { emit: vi.fn(), on, off };
    const store = { listActive: () => [], listDueTimeIntents: () => [], expireStale: () => 0 };

    const { default: intentMatcher } = await import('../intents/intent-matcher.ts');
    await intentMatcher.start({
      eventBus: bus,
      db: {} as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      config: { intentStore: store },
      projectRoot: '/tmp',
      integrationsConfig: {} as never,
      jobRegistry: {} as never,
    });

    expect(on.mock.calls.length).toBeGreaterThanOrEqual(6);
    await intentMatcher.stop();
    expect(off.mock.calls.length).toBe(on.mock.calls.length);
  });

  it('disables itself gracefully (no throw) when intentStore is missing from config', async () => {
    const bus: EventBusInterface = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
    const { default: intentMatcher } = await import('../intents/intent-matcher.ts');
    await expect(
      intentMatcher.start({
        eventBus: bus,
        db: {} as never,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        config: {},
        projectRoot: '/tmp',
        integrationsConfig: {} as never,
        jobRegistry: {} as never,
      }),
    ).resolves.toBeUndefined();
    await intentMatcher.stop();
  });
});
