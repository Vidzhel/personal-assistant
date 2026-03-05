import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPermissionEngine } from '../permission-engine/permission-engine.ts';
import { SkillRegistry } from '../skill-registry/skill-registry.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import type { RavenSkill, SkillContext, SkillAction, ConfigReloadedEvent } from '@raven/shared';

function makeSkillWithActions(name: string, actions: SkillAction[]): RavenSkill {
  return {
    manifest: {
      name,
      displayName: name,
      version: '1.0.0',
      description: `${name} skill`,
      capabilities: ['mcp-server'],
    },
    initialize: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    getMcpServers: () => ({}),
    getAgentDefinitions: () => ({}),
    getActions: () => actions,
    handleScheduledTask: vi.fn().mockResolvedValue(undefined),
  };
}

function makeContext(): Omit<SkillContext, 'config'> {
  return {
    eventBus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
    db: { run: vi.fn(), get: vi.fn(), all: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    getSkillData: vi.fn().mockResolvedValue(null),
  };
}

function writeConfig(dir: string, config: unknown): void {
  writeFileSync(join(dir, 'permissions.json'), JSON.stringify(config));
}

describe('PermissionEngine', () => {
  let tmpDir: string;
  let skillRegistry: SkillRegistry;
  let eventBus: EventBus;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'perm-test-'));
    skillRegistry = new SkillRegistry();
    eventBus = new EventBus();

    const gmailSkill = makeSkillWithActions('gmail', [
      {
        name: 'gmail:search-emails',
        description: 'Search',
        defaultTier: 'green',
        reversible: true,
      },
      {
        name: 'gmail:archive-email',
        description: 'Archive',
        defaultTier: 'yellow',
        reversible: true,
      },
      { name: 'gmail:send-email', description: 'Send', defaultTier: 'red', reversible: false },
    ]);
    const ticktickSkill = makeSkillWithActions('ticktick', [
      {
        name: 'ticktick:get-tasks',
        description: 'Get tasks',
        defaultTier: 'green',
        reversible: true,
      },
      {
        name: 'ticktick:delete-task',
        description: 'Delete',
        defaultTier: 'red',
        reversible: false,
      },
    ]);

    await skillRegistry.registerSkill(gmailSkill, {}, makeContext());
    await skillRegistry.registerSkill(ticktickSkill, {}, makeContext());
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('config loading', () => {
    it('loads valid permissions.json', () => {
      writeConfig(tmpDir, { 'gmail:archive-email': 'green' });
      const engine = createPermissionEngine({ skillRegistry, eventBus });
      engine.initialize(tmpDir);

      expect(engine.getConfig()).toEqual({ 'gmail:archive-email': 'green' });
      engine.shutdown();
    });

    it('handles malformed JSON gracefully', () => {
      writeFileSync(join(tmpDir, 'permissions.json'), '{ invalid json }');
      const engine = createPermissionEngine({ skillRegistry, eventBus });
      engine.initialize(tmpDir);

      expect(engine.getConfig()).toEqual({});
      engine.shutdown();
    });

    it('rejects invalid tier values', () => {
      writeConfig(tmpDir, { 'gmail:archive-email': 'purple' });
      const engine = createPermissionEngine({ skillRegistry, eventBus });
      engine.initialize(tmpDir);

      expect(engine.getConfig()).toEqual({});
      engine.shutdown();
    });

    it('rejects invalid action name format', () => {
      writeConfig(tmpDir, { InvalidName: 'green' });
      const engine = createPermissionEngine({ skillRegistry, eventBus });
      engine.initialize(tmpDir);

      expect(engine.getConfig()).toEqual({});
      engine.shutdown();
    });

    it('handles missing config file', () => {
      const emptyDir = mkdtempSync(join(tmpdir(), 'perm-empty-'));
      const engine = createPermissionEngine({ skillRegistry, eventBus });
      engine.initialize(emptyDir);

      expect(engine.getConfig()).toEqual({});
      engine.shutdown();
      rmSync(emptyDir, { recursive: true, force: true });
    });

    it('creates config directory if it does not exist', () => {
      const newDir = join(tmpDir, 'subdir', 'config');
      const engine = createPermissionEngine({ skillRegistry, eventBus });
      engine.initialize(newDir);

      expect(engine.getConfig()).toEqual({});
      engine.shutdown();
    });
  });

  describe('tier resolution', () => {
    it('config override wins over skill default (AC #1)', () => {
      writeConfig(tmpDir, { 'gmail:archive-email': 'green' });
      const engine = createPermissionEngine({ skillRegistry, eventBus });
      engine.initialize(tmpDir);

      expect(engine.resolveTier('gmail:archive-email')).toBe('green');
      engine.shutdown();
    });

    it('falls back to skill default when no override (AC #2)', () => {
      writeConfig(tmpDir, {});
      const engine = createPermissionEngine({ skillRegistry, eventBus });
      engine.initialize(tmpDir);

      expect(engine.resolveTier('gmail:archive-email')).toBe('yellow');
      expect(engine.resolveTier('gmail:search-emails')).toBe('green');
      expect(engine.resolveTier('gmail:send-email')).toBe('red');
      engine.shutdown();
    });

    it('defaults to red for undeclared actions (AC #3)', () => {
      writeConfig(tmpDir, {});
      const engine = createPermissionEngine({ skillRegistry, eventBus });
      engine.initialize(tmpDir);

      expect(engine.resolveTier('unknown:action')).toBe('red');
      engine.shutdown();
    });

    it('override can promote red to green', () => {
      writeConfig(tmpDir, { 'gmail:send-email': 'green' });
      const engine = createPermissionEngine({ skillRegistry, eventBus });
      engine.initialize(tmpDir);

      expect(engine.resolveTier('gmail:send-email')).toBe('green');
      engine.shutdown();
    });

    it('override can demote green to red', () => {
      writeConfig(tmpDir, { 'gmail:search-emails': 'red' });
      const engine = createPermissionEngine({ skillRegistry, eventBus });
      engine.initialize(tmpDir);

      expect(engine.resolveTier('gmail:search-emails')).toBe('red');
      engine.shutdown();
    });
  });

  describe('file watcher', () => {
    it('reloads config on file change and emits event (AC #4)', async () => {
      writeConfig(tmpDir, {});
      const engine = createPermissionEngine({ skillRegistry, eventBus });
      engine.initialize(tmpDir);

      const eventPromise = new Promise<ConfigReloadedEvent>((resolve) => {
        eventBus.once('config:reloaded', (event) => {
          resolve(event as ConfigReloadedEvent);
        });
      });

      // Modify config
      writeConfig(tmpDir, { 'gmail:archive-email': 'green' });

      const event = await eventPromise;
      expect(event.type).toBe('config:reloaded');
      expect(event.payload.configType).toBe('permissions');
      expect(engine.getConfig()).toEqual({ 'gmail:archive-email': 'green' });
      engine.shutdown();
    });

    it('retains previous config on invalid reload (AC #5)', async () => {
      writeConfig(tmpDir, { 'gmail:archive-email': 'green' });
      const engine = createPermissionEngine({ skillRegistry, eventBus });
      engine.initialize(tmpDir);

      expect(engine.getConfig()).toEqual({ 'gmail:archive-email': 'green' });

      const eventSpy = vi.fn();
      eventBus.on('config:reloaded', eventSpy);

      // Write invalid config
      writeFileSync(join(tmpDir, 'permissions.json'), '{ bad json }');

      // Wait for debounce + processing
      await new Promise((r) => setTimeout(r, 300));

      // Previous config should be retained
      expect(engine.getConfig()).toEqual({ 'gmail:archive-email': 'green' });
      // Event should NOT have been emitted for the invalid reload
      // (the first valid load didn't go through the watcher, so spy should have 0 calls)
      expect(eventSpy).not.toHaveBeenCalled();
      engine.shutdown();
    });

    it('shutdown stops file watcher', () => {
      writeConfig(tmpDir, {});
      const engine = createPermissionEngine({ skillRegistry, eventBus });
      engine.initialize(tmpDir);
      engine.shutdown();
      // Should not throw — double shutdown is safe
      engine.shutdown();
    });
  });

  describe('integration: PermissionEngine + SkillRegistry + EventBus', () => {
    it('full flow: load config, resolve tiers, reload, verify event', async () => {
      writeConfig(tmpDir, { 'ticktick:delete-task': 'yellow' });
      const engine = createPermissionEngine({ skillRegistry, eventBus });
      engine.initialize(tmpDir);

      // Override works
      expect(engine.resolveTier('ticktick:delete-task')).toBe('yellow');
      // Skill default works
      expect(engine.resolveTier('ticktick:get-tasks')).toBe('green');
      // Unknown defaults to red
      expect(engine.resolveTier('unknown:action')).toBe('red');

      // Reload with new config
      const reloadPromise = new Promise<void>((resolve) => {
        eventBus.once('config:reloaded', () => resolve());
      });

      writeConfig(tmpDir, { 'gmail:send-email': 'yellow' });
      await reloadPromise;

      // Old override gone, new override active
      expect(engine.resolveTier('ticktick:delete-task')).toBe('red');
      expect(engine.resolveTier('gmail:send-email')).toBe('yellow');

      engine.shutdown();
    });
  });
});
