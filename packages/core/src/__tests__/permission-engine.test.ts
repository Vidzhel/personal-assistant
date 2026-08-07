import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createPermissionEngine } from '../permission-engine/permission-engine.ts';
import { SuiteRegistry } from '../suite-registry/suite-registry.ts';
import { CapabilityLibrary } from '../capability-library/capability-library.ts';
import { EventBus } from '../event-bus/event-bus.ts';
import type { SkillAction, ConfigReloadedEvent } from '@raven/shared';

// Path to the real library/ directory — mirrors library-integration.test.ts.
// Using the real library (rather than a fixture) lets the conflict tests
// below exercise the actual byte-identical dupes between suites/*/
// actions.json and library/skills/*/config.json that motivated Task 1.
const LIBRARY_DIR = resolve(import.meta.dirname, '..', '..', '..', '..', 'library');

async function loadRealLibrary(): Promise<CapabilityLibrary> {
  const lib = new CapabilityLibrary();
  await lib.load(LIBRARY_DIR);
  return lib;
}

function makeSuiteRegistryWithActions(suiteActions: Record<string, SkillAction[]>): SuiteRegistry {
  const registry = new SuiteRegistry();
  for (const [name, actions] of Object.entries(suiteActions)) {
    (registry as any).suites.set(name, {
      manifest: {
        name,
        displayName: name,
        version: '1.0.0',
        description: `${name} suite`,
        capabilities: [],
        requiresEnv: [],
        services: [],
      },
      agents: [],
      mcpServers: {},
      actions,
      schedules: [],
      vendorPlugins: [],
      suiteDir: '/tmp/test',
    });
  }
  return registry;
}

function writeConfig(dir: string, config: unknown): void {
  writeFileSync(join(dir, 'permissions.json'), JSON.stringify(config));
}

describe('PermissionEngine', () => {
  let tmpDir: string;
  let suiteRegistry: SuiteRegistry;
  let capabilityLibrary: CapabilityLibrary;
  let eventBus: EventBus;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'perm-test-'));
    eventBus = new EventBus();
    capabilityLibrary = await loadRealLibrary();

    suiteRegistry = makeSuiteRegistryWithActions({
      gmail: [
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
      ],
      ticktick: [
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
      ],
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('config loading', () => {
    it('loads valid permissions.json', () => {
      writeConfig(tmpDir, { 'gmail:archive-email': 'green' });
      const engine = createPermissionEngine({ suiteRegistry, capabilityLibrary, eventBus });
      engine.initialize(tmpDir);

      expect(engine.getConfig()).toEqual({ 'gmail:archive-email': 'green' });
      engine.shutdown();
    });

    it('handles malformed JSON gracefully', () => {
      writeFileSync(join(tmpDir, 'permissions.json'), '{ invalid json }');
      const engine = createPermissionEngine({ suiteRegistry, capabilityLibrary, eventBus });
      engine.initialize(tmpDir);

      expect(engine.getConfig()).toEqual({});
      engine.shutdown();
    });

    it('rejects invalid tier values', () => {
      writeConfig(tmpDir, { 'gmail:archive-email': 'purple' });
      const engine = createPermissionEngine({ suiteRegistry, capabilityLibrary, eventBus });
      engine.initialize(tmpDir);

      expect(engine.getConfig()).toEqual({});
      engine.shutdown();
    });

    it('rejects invalid action name format', () => {
      writeConfig(tmpDir, { InvalidName: 'green' });
      const engine = createPermissionEngine({ suiteRegistry, capabilityLibrary, eventBus });
      engine.initialize(tmpDir);

      expect(engine.getConfig()).toEqual({});
      engine.shutdown();
    });

    it('handles missing config file', () => {
      const emptyDir = mkdtempSync(join(tmpdir(), 'perm-empty-'));
      const engine = createPermissionEngine({ suiteRegistry, capabilityLibrary, eventBus });
      engine.initialize(emptyDir);

      expect(engine.getConfig()).toEqual({});
      engine.shutdown();
      rmSync(emptyDir, { recursive: true, force: true });
    });

    it('creates config directory if it does not exist', () => {
      const newDir = join(tmpDir, 'subdir', 'config');
      const engine = createPermissionEngine({ suiteRegistry, capabilityLibrary, eventBus });
      engine.initialize(newDir);

      expect(engine.getConfig()).toEqual({});
      engine.shutdown();
    });
  });

  describe('tier resolution', () => {
    it('config override wins over skill default (AC #1)', () => {
      writeConfig(tmpDir, { 'gmail:archive-email': 'green' });
      const engine = createPermissionEngine({ suiteRegistry, capabilityLibrary, eventBus });
      engine.initialize(tmpDir);

      expect(engine.resolveTier('gmail:archive-email')).toBe('green');
      engine.shutdown();
    });

    it('falls back to skill default when no override (AC #2)', () => {
      writeConfig(tmpDir, {});
      const engine = createPermissionEngine({ suiteRegistry, capabilityLibrary, eventBus });
      engine.initialize(tmpDir);

      expect(engine.resolveTier('gmail:archive-email')).toBe('yellow');
      expect(engine.resolveTier('gmail:search-emails')).toBe('green');
      expect(engine.resolveTier('gmail:send-email')).toBe('red');
      engine.shutdown();
    });

    it('defaults to red for undeclared actions (AC #3)', () => {
      writeConfig(tmpDir, {});
      const engine = createPermissionEngine({ suiteRegistry, capabilityLibrary, eventBus });
      engine.initialize(tmpDir);

      expect(engine.resolveTier('unknown:action')).toBe('red');
      engine.shutdown();
    });

    it('override can promote red to green', () => {
      writeConfig(tmpDir, { 'gmail:send-email': 'green' });
      const engine = createPermissionEngine({ suiteRegistry, capabilityLibrary, eventBus });
      engine.initialize(tmpDir);

      expect(engine.resolveTier('gmail:send-email')).toBe('green');
      engine.shutdown();
    });

    it('override can demote green to red', () => {
      writeConfig(tmpDir, { 'gmail:search-emails': 'red' });
      const engine = createPermissionEngine({ suiteRegistry, capabilityLibrary, eventBus });
      engine.initialize(tmpDir);

      expect(engine.resolveTier('gmail:search-emails')).toBe('red');
      engine.shutdown();
    });
  });

  describe('file watcher', () => {
    it('reloads config on file change and emits event (AC #4)', async () => {
      writeConfig(tmpDir, {});
      const engine = createPermissionEngine({ suiteRegistry, capabilityLibrary, eventBus });
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
      const engine = createPermissionEngine({ suiteRegistry, capabilityLibrary, eventBus });
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
      expect(eventSpy).not.toHaveBeenCalled();
      engine.shutdown();
    });

    it('shutdown stops file watcher', () => {
      writeConfig(tmpDir, {});
      const engine = createPermissionEngine({ suiteRegistry, capabilityLibrary, eventBus });
      engine.initialize(tmpDir);
      engine.shutdown();
      // Should not throw — double shutdown is safe
      engine.shutdown();
    });
  });

  describe('integration: PermissionEngine + SuiteRegistry + EventBus', () => {
    it('full flow: load config, resolve tiers, reload, verify event', async () => {
      writeConfig(tmpDir, { 'ticktick:delete-task': 'yellow' });
      const engine = createPermissionEngine({ suiteRegistry, capabilityLibrary, eventBus });
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

  describe('library action source (Task 1)', () => {
    it('resolves tiers for library-only actions (not declared by any suite fixture)', () => {
      writeConfig(tmpDir, {});
      const engine = createPermissionEngine({ suiteRegistry, capabilityLibrary, eventBus });
      engine.initialize(tmpDir);

      // gmail:label-email and gmail:reply-email exist in the real library
      // config but were never added to this test's suite fixture — they
      // only resolve at all because collectActions() now merges in the
      // library.
      expect(engine.resolveTier('gmail:label-email')).toBe('yellow');
      expect(engine.resolveTier('gmail:reply-email')).toBe('red');
      engine.shutdown();
    });

    it('library wins over a conflicting suite-declared tier for the same action name', () => {
      // Real library declares gmail:send-email as 'red'. Redeclare the same
      // action name in the suite fixture with a conflicting tier — library
      // must win regardless of merge order.
      suiteRegistry = makeSuiteRegistryWithActions({
        gmail: [
          { name: 'gmail:send-email', description: 'Send', defaultTier: 'green', reversible: true },
        ],
      });

      writeConfig(tmpDir, {});
      const engine = createPermissionEngine({ suiteRegistry, capabilityLibrary, eventBus });
      engine.initialize(tmpDir);

      expect(engine.resolveTier('gmail:send-email')).toBe('red');
      engine.shutdown();
    });

    it('config/permissions.json overrides still win over the library tier', () => {
      writeConfig(tmpDir, { 'gmail:send-email': 'green' });
      const engine = createPermissionEngine({ suiteRegistry, capabilityLibrary, eventBus });
      engine.initialize(tmpDir);

      expect(engine.resolveTier('gmail:send-email')).toBe('green');
      engine.shutdown();
    });

    it('falls back to red for actions declared by neither source', () => {
      writeConfig(tmpDir, {});
      const engine = createPermissionEngine({ suiteRegistry, capabilityLibrary, eventBus });
      engine.initialize(tmpDir);

      expect(engine.resolveTier('nonexistent:action')).toBe('red');
      engine.shutdown();
    });

    it('tolerates a capability library that failed to load, using suite actions only', async () => {
      const unloadedLibrary = new CapabilityLibrary();
      writeConfig(tmpDir, {});
      const engine = createPermissionEngine({
        suiteRegistry,
        capabilityLibrary: unloadedLibrary,
        eventBus,
      });

      expect(() => engine.initialize(tmpDir)).not.toThrow();
      // Suite-declared action still resolves.
      expect(engine.resolveTier('gmail:archive-email')).toBe('yellow');
      // Library-only action (never declared by the suite fixture) is gone.
      expect(engine.resolveTier('gmail:reply-email')).toBe('red');
      engine.shutdown();
    });
  });

  describe('getActionCatalog (Task 1)', () => {
    it('returns every merged action with its resolved tier and source', () => {
      writeConfig(tmpDir, {});
      const engine = createPermissionEngine({ suiteRegistry, capabilityLibrary, eventBus });
      engine.initialize(tmpDir);

      const catalog = engine.getActionCatalog();
      const byName = new Map(catalog.map((entry) => [entry.name, entry]));

      // Every action name appears exactly once, even though gmail/ticktick
      // are declared by both the suite fixture and the real library.
      expect(catalog.length).toBe(new Set(catalog.map((e) => e.name)).size);

      const sendEmail = byName.get('gmail:send-email');
      expect(sendEmail).toBeDefined();
      expect(sendEmail?.tier).toBe('red');
      expect(sendEmail?.source).toBe('library');

      // Library-only action proves the merge actually happened.
      expect(byName.get('gmail:reply-email')?.source).toBe('library');
      engine.shutdown();
    });

    it('reflects config overrides in the catalog tier', () => {
      writeConfig(tmpDir, { 'gmail:send-email': 'green' });
      const engine = createPermissionEngine({ suiteRegistry, capabilityLibrary, eventBus });
      engine.initialize(tmpDir);

      const catalog = engine.getActionCatalog();
      const sendEmail = catalog.find((entry) => entry.name === 'gmail:send-email');
      expect(sendEmail?.tier).toBe('green');
      engine.shutdown();
    });
  });
});
