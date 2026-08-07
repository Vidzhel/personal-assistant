import { readFileSync, watch, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FSWatcher } from 'node:fs';
import {
  createLogger,
  generateId,
  PermissionConfigSchema,
  type PermissionConfig,
  type PermissionTier,
  type SkillAction,
} from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { SuiteRegistry } from '../suite-registry/suite-registry.ts';
import type { CapabilityLibrary } from '../capability-library/capability-library.ts';

const log = createLogger('permission-engine');
const CONFIG_FILENAME = 'permissions.json';
const FILE_CHANGE_DEBOUNCE_MS = 100;

export type ActionSource = 'library' | 'suite';

export interface ActionCatalogEntry {
  name: string;
  tier: PermissionTier;
  source: ActionSource;
}

export interface PermissionEngine {
  initialize: (configDir: string) => void;
  resolveTier: (actionName: string) => PermissionTier;
  getActionCatalog: () => ActionCatalogEntry[];
  shutdown: () => void;
  getConfig: () => PermissionConfig;
}

interface PermissionEngineDeps {
  suiteRegistry: SuiteRegistry;
  capabilityLibrary: CapabilityLibrary;
  eventBus: EventBus;
}

// eslint-disable-next-line max-lines-per-function -- factory function that initializes permission engine with config loading and file watching
export function createPermissionEngine(deps: PermissionEngineDeps): PermissionEngine {
  const { suiteRegistry, capabilityLibrary, eventBus } = deps;
  let currentConfig: PermissionConfig = {};
  let actionMap: Map<string, SkillAction> = new Map();
  let actionSourceMap: Map<string, ActionSource> = new Map();
  let watcher: FSWatcher | null = null;
  let configFilePath = '';

  function loadAndValidateConfig(filePath: string): PermissionConfig | null {
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      const result = PermissionConfigSchema.safeParse(parsed);
      if (!result.success) {
        log.error(`Invalid permissions config: ${result.error.message}`);
        return null;
      }
      return result.data;
    } catch (err) {
      log.error(`Failed to read permissions config: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  function emitReloadEvent(): void {
    eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'permission-engine',
      type: 'config:reloaded',
      payload: {
        configType: 'permissions',
        timestamp: new Date().toISOString(),
      },
    });
  }

  function handleFileChange(): void {
    const newConfig = loadAndValidateConfig(configFilePath);
    if (newConfig !== null) {
      currentConfig = newConfig;
      log.info('Permission config reloaded successfully');
      emitReloadEvent();
    } else {
      log.warn('Permission config reload failed — keeping previous config');
    }
  }

  // Merges the two action sources during the suites -> library migration
  // (Phase 2 Task 3b deletes suiteRegistry as an action source entirely).
  // Both sources describe the same shape (SkillAction / ActionDefinition are
  // structurally identical — see @raven/shared's suites/define.ts). Where an
  // action name is declared by both (16 byte-identical dupes exist today —
  // suites/*/actions.json mirrors library/skills/*/config.json), the
  // library's declaration wins: it is the surviving capability system going
  // forward, so its tier is authoritative even before suiteRegistry is
  // deleted.
  function refreshActionMap(): void {
    const merged = new Map<string, { action: SkillAction; source: ActionSource }>();

    for (const action of suiteRegistry.collectActions()) {
      merged.set(action.name, { action, source: 'suite' });
    }

    // capabilityLibrary.collectActions() throws if the library failed to
    // load (raven.ts's boot sequence tolerates that and continues with the
    // suite registry only — see the try/catch around capabilityLibrary.load
    // there) — mirror that tolerance here rather than crashing engine init.
    try {
      for (const action of capabilityLibrary.collectActions()) {
        merged.set(action.name, { action, source: 'library' });
      }
    } catch (err) {
      log.warn(
        `Capability library actions unavailable, using suite registry only: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    actionMap = new Map();
    actionSourceMap = new Map();
    for (const [name, entry] of merged) {
      actionMap.set(name, entry.action);
      actionSourceMap.set(name, entry.source);
    }
  }

  return {
    initialize(configDir: string): void {
      if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
      }

      configFilePath = resolve(configDir, CONFIG_FILENAME);

      if (existsSync(configFilePath)) {
        const loaded = loadAndValidateConfig(configFilePath);
        if (loaded !== null) {
          currentConfig = loaded;
          log.info(`Permission config loaded (${Object.keys(currentConfig).length} overrides)`);
        } else {
          log.warn('Permission config invalid on startup — using empty config');
          currentConfig = {};
        }
      } else {
        log.info('No permissions.json found — using skill defaults');
        currentConfig = {};
      }

      refreshActionMap();

      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      watcher = watch(configDir, (_eventType, filename) => {
        if (!filename || filename !== CONFIG_FILENAME) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(handleFileChange, FILE_CHANGE_DEBOUNCE_MS);
      });

      watcher.on('error', (err) => {
        log.error(`File watcher error: ${err.message}`);
      });
    },

    resolveTier(actionName: string): PermissionTier {
      const override = currentConfig[actionName];
      if (override) return override;

      const action = actionMap.get(actionName);
      if (action) return action.defaultTier;

      return 'red';
    },

    getActionCatalog(): ActionCatalogEntry[] {
      return Array.from(actionMap.entries()).map(([name, action]) => ({
        name,
        // Config overrides win over the declared default tier here too —
        // resolveTier() is the single source of truth for "what tier does
        // this action actually resolve to right now".
        tier: currentConfig[name] ?? action.defaultTier,
        source: actionSourceMap.get(name) ?? 'suite',
      }));
    },

    shutdown(): void {
      if (watcher) {
        watcher.close();
        watcher = null;
      }
    },

    getConfig(): PermissionConfig {
      return { ...currentConfig };
    },
  };
}
