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

const log = createLogger('permission-engine');
const CONFIG_FILENAME = 'permissions.json';

export interface PermissionEngine {
  initialize: (configDir: string) => void;
  resolveTier: (actionName: string) => PermissionTier;
  shutdown: () => void;
  getConfig: () => PermissionConfig;
}

interface PermissionEngineDeps {
  suiteRegistry: SuiteRegistry;
  eventBus: EventBus;
}

export function createPermissionEngine(deps: PermissionEngineDeps): PermissionEngine {
  const { suiteRegistry, eventBus } = deps;
  let currentConfig: PermissionConfig = {};
  let actionMap: Map<string, SkillAction> = new Map();
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

  function refreshActionMap(): void {
    const allActions = suiteRegistry.collectActions();
    actionMap = new Map(allActions.map((a) => [a.name, a]));
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
        debounceTimer = setTimeout(handleFileChange, 100);
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
