import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, closeDatabase, getDb } from '../db/database.ts';
import { createIntentStore, type IntentStore } from '../intents/intent-store.ts';

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

describe('intent-store', () => {
  let tmpDir: string;
  let store: IntentStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-intent-store-'));
    initDatabase(join(tmpDir, 'test.db'));
    store = createIntentStore(getDb());
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('defaults kind="event" to fireBudget=3, cooldown=24h, expiry=+90d', () => {
      const now = Date.now();
      const intent = store.create(
        { kind: 'event', keywords: ['invoice'], eventTypes: ['email:new'], message: 'reminder' },
        now,
      );
      expect(intent.fireBudget).toBe(3);
      expect(intent.cooldownHours).toBe(24);
      expect(intent.expiresAt).toBe(now + 90 * MS_PER_DAY);
      expect(intent.status).toBe('active');
      expect(intent.firesUsed).toBe(0);
    });

    it('defaults kind="time" to fireBudget=1 (one-shot)', () => {
      const now = Date.now();
      const intent = store.create(
        { kind: 'time', nextFireAt: now + MS_PER_HOUR, message: 'call the bank' },
        now,
      );
      expect(intent.fireBudget).toBe(1);
      expect(intent.nextFireAt).toBe(now + MS_PER_HOUR);
    });

    it('honors explicit overrides', () => {
      const now = Date.now();
      const intent = store.create(
        {
          kind: 'event',
          keywords: ['x'],
          eventTypes: ['email:new'],
          message: 'm',
          fireBudget: 10,
          cooldownHours: 1,
          expiresAt: now + MS_PER_HOUR,
        },
        now,
      );
      expect(intent.fireBudget).toBe(10);
      expect(intent.cooldownHours).toBe(1);
      expect(intent.expiresAt).toBe(now + MS_PER_HOUR);
    });
  });

  describe('tryFire — the atomic guard', () => {
    it('fires once and flips to exhausted exactly when the last budget slot is used', () => {
      const now = Date.now();
      const intent = store.create(
        { kind: 'event', keywords: ['x'], eventTypes: ['email:new'], message: 'm', fireBudget: 1 },
        now,
      );

      expect(store.tryFire(intent.id, now)).toBe(true);

      const after = store.get(intent.id);
      expect(after?.firesUsed).toBe(1);
      expect(after?.status).toBe('exhausted');
      expect(after?.lastFiredAt).toBe(now);
    });

    it('blocks a second fire once budget is exhausted', () => {
      const now = Date.now();
      const intent = store.create(
        { kind: 'event', keywords: ['x'], eventTypes: ['email:new'], message: 'm', fireBudget: 1 },
        now,
      );

      expect(store.tryFire(intent.id, now)).toBe(true);
      expect(store.tryFire(intent.id, now + MS_PER_DAY * 10)).toBe(false);
      expect(store.get(intent.id)?.firesUsed).toBe(1);
    });

    it('blocks a fire within the cooldown window', () => {
      const now = Date.now();
      const intent = store.create(
        {
          kind: 'event',
          keywords: ['x'],
          eventTypes: ['email:new'],
          message: 'm',
          fireBudget: 5,
          cooldownHours: 24,
        },
        now,
      );

      expect(store.tryFire(intent.id, now)).toBe(true);
      // 1 hour later — well inside the 24h cooldown
      expect(store.tryFire(intent.id, now + MS_PER_HOUR)).toBe(false);
      expect(store.get(intent.id)?.firesUsed).toBe(1);
    });

    it('allows a fire once the cooldown window has passed', () => {
      const now = Date.now();
      const intent = store.create(
        {
          kind: 'event',
          keywords: ['x'],
          eventTypes: ['email:new'],
          message: 'm',
          fireBudget: 5,
          cooldownHours: 1,
        },
        now,
      );

      expect(store.tryFire(intent.id, now)).toBe(true);
      expect(store.tryFire(intent.id, now + 2 * MS_PER_HOUR)).toBe(true);
      expect(store.get(intent.id)?.firesUsed).toBe(2);
    });

    it('blocks a fire past expiry even if budget/cooldown would otherwise allow it', () => {
      const now = Date.now();
      const intent = store.create(
        {
          kind: 'event',
          keywords: ['x'],
          eventTypes: ['email:new'],
          message: 'm',
          fireBudget: 5,
          cooldownHours: 0,
          expiresAt: now + MS_PER_HOUR,
        },
        now,
      );

      expect(store.tryFire(intent.id, now + 2 * MS_PER_HOUR)).toBe(false);
      expect(store.get(intent.id)?.firesUsed).toBe(0);
    });

    it('never fires a cancelled intent', () => {
      const now = Date.now();
      const intent = store.create(
        { kind: 'event', keywords: ['x'], eventTypes: ['email:new'], message: 'm' },
        now,
      );
      expect(store.cancel(intent.id)).toBe(true);
      expect(store.tryFire(intent.id, now)).toBe(false);
    });

    it('is safe under concurrent-looking calls: only one of two same-tick tryFire calls on a budget=1 intent wins', () => {
      const now = Date.now();
      const intent = store.create(
        { kind: 'event', keywords: ['x'], eventTypes: ['email:new'], message: 'm', fireBudget: 1 },
        now,
      );

      const first = store.tryFire(intent.id, now);
      const second = store.tryFire(intent.id, now);
      expect([first, second].filter(Boolean)).toHaveLength(1);
    });
  });

  describe('expireStale', () => {
    it('flips active rows past expiry to expired, and leaves others alone', () => {
      const now = Date.now();
      const expired = store.create(
        {
          kind: 'event',
          keywords: ['x'],
          eventTypes: ['email:new'],
          message: 'm',
          expiresAt: now - 1,
        },
        now - MS_PER_DAY,
      );
      const fresh = store.create(
        {
          kind: 'event',
          keywords: ['x'],
          eventTypes: ['email:new'],
          message: 'm',
          expiresAt: now + MS_PER_DAY,
        },
        now,
      );

      const flipped = store.expireStale(now);
      expect(flipped).toBe(1);
      expect(store.get(expired.id)?.status).toBe('expired');
      expect(store.get(fresh.id)?.status).toBe('active');
    });
  });

  describe('cancel', () => {
    it('cancels an active intent and is idempotent (second call is a no-op)', () => {
      const intent = store.create({
        kind: 'time',
        nextFireAt: Date.now() + MS_PER_HOUR,
        message: 'm',
      });
      expect(store.cancel(intent.id)).toBe(true);
      expect(store.get(intent.id)?.status).toBe('cancelled');
      expect(store.cancel(intent.id)).toBe(false);
    });

    it('returns false for an unknown id', () => {
      expect(store.cancel('does-not-exist')).toBe(false);
    });
  });

  describe('listDueTimeIntents', () => {
    it('returns only active kind=time intents whose nextFireAt has arrived', () => {
      const now = Date.now();
      const due = store.create({ kind: 'time', nextFireAt: now - 1000, message: 'due' }, now);
      store.create({ kind: 'time', nextFireAt: now + MS_PER_HOUR, message: 'not due' }, now);
      store.create(
        { kind: 'event', keywords: ['x'], eventTypes: ['email:new'], message: 'not time-kind' },
        now,
      );

      const result = store.listDueTimeIntents(now);
      expect(result.map((i) => i.id)).toEqual([due.id]);
    });
  });
});
