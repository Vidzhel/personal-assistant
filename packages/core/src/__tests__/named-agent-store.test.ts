import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, getDb } from '../db/database.ts';
import { createNamedAgentStore } from '../agent-registry/named-agent-store.ts';
import type { NamedAgentStore } from '../agent-registry/named-agent-store.ts';

function makeMockEventBus() {
  const events: Array<{ type: string; payload: any }> = [];
  return {
    emit: vi.fn((event: any) => events.push(event)),
    on: vi.fn(),
    off: vi.fn(),
    events,
  };
}

describe('NamedAgentStore', () => {
  let tmpDir: string;
  let store: NamedAgentStore;
  let eventBus: ReturnType<typeof makeMockEventBus>;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-nastore-'));
    initDatabase(join(tmpDir, 'test.db'));
    eventBus = makeMockEventBus();
    store = createNamedAgentStore({
      db: {
        run: (sql: string, ...params: unknown[]) =>
          getDb()
            .prepare(sql)
            .run(...params),
        get: <T>(sql: string, ...params: unknown[]) =>
          getDb()
            .prepare(sql)
            .get(...params) as T | undefined,
        all: <T>(sql: string, ...params: unknown[]) =>
          getDb()
            .prepare(sql)
            .all(...params) as T[],
      },
      eventBus,
      configDir: tmpDir,
    });
  });

  afterAll(() => {
    try {
      getDb().close();
    } catch {
      /* */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getDefaultAgent', () => {
    it('returns the seeded default agent', () => {
      const agent = store.getDefaultAgent();
      expect(agent.name).toBe('raven');
      expect(agent.isDefault).toBe(true);
      expect(agent.suiteIds).toEqual([]);
    });
  });

  describe('listAgents', () => {
    it('returns agents with default first', () => {
      const agents = store.listAgents();
      expect(agents.length).toBeGreaterThanOrEqual(1);
      expect(agents[0].isDefault).toBe(true);
    });
  });

  describe('createAgent', () => {
    it('creates a new named agent', () => {
      const agent = store.createAgent({
        name: 'test-agent',
        description: 'A test agent',
        instructions: 'Be helpful',
        suiteIds: ['email', 'task-management'],
        skills: [],
      });

      expect(agent.id).toBeDefined();
      expect(agent.name).toBe('test-agent');
      expect(agent.description).toBe('A test agent');
      expect(agent.instructions).toBe('Be helpful');
      expect(agent.suiteIds).toEqual(['email', 'task-management']);
      expect(agent.isDefault).toBe(false);
      expect(agent.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('emits agent:config:created event', () => {
      const before = eventBus.events.length;
      store.createAgent({ name: 'event-test', suiteIds: [], skills: [] });
      const event = eventBus.events
        .slice(before)
        .find((e: any) => e.type === 'agent:config:created');
      expect(event).toBeDefined();
      expect(event!.payload.name).toBe('event-test');
    });

    it('syncs to config file on create', () => {
      store.createAgent({ name: 'sync-test', suiteIds: [], skills: [] });
      const configPath = join(tmpDir, 'agents.json');
      expect(existsSync(configPath)).toBe(true);
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      const found = config.find((a: any) => a.name === 'sync-test');
      expect(found).toBeDefined();
    });

    it('rejects duplicate names', () => {
      expect(() => store.createAgent({ name: 'test-agent', suiteIds: [], skills: [] })).toThrow();
    });
  });

  describe('getAgent / getAgentByName', () => {
    it('retrieves by id', () => {
      const created = store.createAgent({ name: 'get-by-id', suiteIds: [], skills: [] });
      const found = store.getAgent(created.id);
      expect(found).toBeDefined();
      expect(found!.name).toBe('get-by-id');
    });

    it('retrieves by name', () => {
      store.createAgent({ name: 'get-by-name', suiteIds: [], skills: [] });
      const found = store.getAgentByName('get-by-name');
      expect(found).toBeDefined();
      expect(found!.name).toBe('get-by-name');
    });

    it('returns undefined for nonexistent id', () => {
      expect(store.getAgent('nonexistent')).toBeUndefined();
    });

    it('returns undefined for nonexistent name', () => {
      expect(store.getAgentByName('nonexistent')).toBeUndefined();
    });
  });

  describe('updateAgent', () => {
    it('updates specified fields', () => {
      const created = store.createAgent({ name: 'update-me', suiteIds: ['old-suite'], skills: [] });
      const updated = store.updateAgent(created.id, {
        description: 'Updated desc',
        suiteIds: ['new-suite'],
      });
      expect(updated.description).toBe('Updated desc');
      expect(updated.suiteIds).toEqual(['new-suite']);
    });

    it('emits agent:config:updated event with changes', () => {
      const created = store.createAgent({ name: 'update-event', suiteIds: [], skills: [] });
      const before = eventBus.events.length;
      store.updateAgent(created.id, { description: 'Changed' });
      const event = eventBus.events
        .slice(before)
        .find((e: any) => e.type === 'agent:config:updated');
      expect(event).toBeDefined();
      expect(event!.payload.changes).toContain('description');
    });

    it('throws for nonexistent agent', () => {
      expect(() => store.updateAgent('nonexistent', { description: 'x' })).toThrow(
        'Named agent not found',
      );
    });

    it('returns existing if no changes provided', () => {
      const created = store.createAgent({ name: 'no-change', suiteIds: [], skills: [] });
      const same = store.updateAgent(created.id, {});
      expect(same.id).toBe(created.id);
    });
  });

  describe('deleteAgent', () => {
    it('deletes a non-default agent', () => {
      const created = store.createAgent({ name: 'delete-me', suiteIds: [], skills: [] });
      store.deleteAgent(created.id);
      expect(store.getAgent(created.id)).toBeUndefined();
    });

    it('emits agent:config:deleted event', () => {
      const created = store.createAgent({ name: 'delete-event', suiteIds: [], skills: [] });
      const before = eventBus.events.length;
      store.deleteAgent(created.id);
      const event = eventBus.events
        .slice(before)
        .find((e: any) => e.type === 'agent:config:deleted');
      expect(event).toBeDefined();
    });

    it('prevents deleting the default agent', () => {
      const defaultAgent = store.getDefaultAgent();
      expect(() => store.deleteAgent(defaultAgent.id)).toThrow('Cannot delete the default agent');
    });

    it('throws for nonexistent agent', () => {
      expect(() => store.deleteAgent('nonexistent')).toThrow('Named agent not found');
    });
  });

  describe('loadFromConfigFile', () => {
    it('seeds from config file when DB is empty', () => {
      const tmpDir2 = mkdtempSync(join(tmpdir(), 'raven-nacfg-'));
      const dbPath = join(tmpDir2, 'test2.db');

      // Write a config file
      writeFileSync(
        join(tmpDir2, 'agents.json'),
        JSON.stringify([
          {
            name: 'from-config',
            description: 'Loaded from config',
            suite_ids: ['email'],
            is_default: true,
          },
        ]),
      );

      // Open a second DB and run migration
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic import for isolated DB
      const BetterSqlite3 = require('better-sqlite3');
      const db2 = new BetterSqlite3(dbPath);
      db2.exec(readFileSync(join(process.cwd(), 'migrations/016-named-agents.sql'), 'utf-8'));
      db2.exec(readFileSync(join(process.cwd(), 'migrations/021-agent-skills.sql'), 'utf-8'));
      db2.prepare('DELETE FROM named_agents').run();

      const store2 = createNamedAgentStore({
        db: {
          run: (sql: string, ...params: unknown[]) => db2.prepare(sql).run(...params),
          get: <T>(sql: string, ...params: unknown[]) =>
            db2.prepare(sql).get(...params) as T | undefined,
          all: <T>(sql: string, ...params: unknown[]) => db2.prepare(sql).all(...params) as T[],
        },
        eventBus: makeMockEventBus(),
        configDir: tmpDir2,
      });

      store2.loadFromConfigFile();
      const agents = store2.listAgents();
      expect(agents.length).toBe(1);
      expect(agents[0].name).toBe('from-config');

      db2.close();
      rmSync(tmpDir2, { recursive: true, force: true });
    });
  });
});
