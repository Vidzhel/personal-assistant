import { readFileSync, readdirSync, watch, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { FSWatcher } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { createLogger, generateId, PipelineConfigSchema, type PipelineConfig } from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';
import { validateDag, type DagValidationResult } from './dag-validator.ts';

const log = createLogger('pipeline-loader');

const IGNORED_SUFFIXES = ['.swp', '~', '.tmp'];
const FILE_CHANGE_DEBOUNCE_MS = 200;

export interface ValidatedPipeline {
  config: PipelineConfig;
  executionOrder: string[];
  entryPoints: string[];
  filePath: string;
  loadedAt: string;
}

export interface PipelineLoader {
  loadFromDirectory: (dir: string) => void;
  getPipeline: (name: string) => ValidatedPipeline | undefined;
  getAllPipelines: () => ValidatedPipeline[];
  removePipeline: (name: string) => boolean;
  reloadPipeline: (filePath: string) => void;
  watch: (dir: string) => void;
  shutdown: () => void;
}

interface PipelineLoaderDeps {
  eventBus: EventBus;
}

function isYamlFile(filename: string): boolean {
  return /\.ya?ml$/.test(filename);
}

function isIgnoredFile(filename: string): boolean {
  return IGNORED_SUFFIXES.some((suffix) => filename.endsWith(suffix));
}

function pipelineNameFromFile(filePath: string): string {
  return basename(filePath).replace(/\.ya?ml$/, '');
}

// eslint-disable-next-line max-lines-per-function -- factory function that initializes pipeline loader with file watching and hot-reload
export function createPipelineLoader(deps: PipelineLoaderDeps): PipelineLoader {
  const { eventBus } = deps;
  const pipelines = new Map<string, ValidatedPipeline>();
  const fileToName = new Map<string, string>();
  let watcher: FSWatcher | null = null;
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function emitEvent(pipelineName: string, action: 'loaded' | 'reloaded' | 'removed'): void {
    eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: 'pipeline-loader',
      type: 'config:pipelines:reloaded',
      payload: {
        pipelineName,
        action,
        timestamp: new Date().toISOString(),
      },
    });
  }

  function loadSingleFile(filePath: string): ValidatedPipeline | null {
    const filename = basename(filePath);

    try {
      const content = readFileSync(filePath, 'utf-8');
      const raw: unknown = parseYaml(content);
      const result = PipelineConfigSchema.safeParse(raw);

      if (!result.success) {
        log.error(`Pipeline validation failed: ${filename} — ${result.error.message}`);
        return null;
      }

      const config = result.data;
      const dagResult: DagValidationResult = validateDag(config.nodes, config.connections);

      if (!dagResult.valid) {
        log.error(`Pipeline DAG validation failed: ${filename} — ${dagResult.error}`);
        return null;
      }

      return {
        config,
        executionOrder: dagResult.executionOrder ?? [],
        entryPoints: dagResult.entryPoints ?? [],
        filePath,
        loadedAt: new Date().toISOString(),
      };
    } catch (err) {
      log.error(
        `Failed to load pipeline file: ${filename} — ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  function loadFromDirectory(dir: string): void {
    if (!existsSync(dir)) {
      log.warn(`Pipeline directory does not exist: ${dir}`);
      return;
    }

    const files = readdirSync(dir).filter((f) => isYamlFile(f) && !isIgnoredFile(f));

    for (const file of files) {
      const filePath = join(dir, file);
      const validated = loadSingleFile(filePath);
      if (validated) {
        pipelines.set(validated.config.name, validated);
        fileToName.set(file, validated.config.name);
        log.info(`Pipeline loaded: ${validated.config.name} (${file})`);
      }
    }

    log.info(`Pipeline loading complete: ${pipelines.size}/${files.length} loaded`);
  }

  function reloadPipeline(filePath: string): void {
    const validated = loadSingleFile(filePath);
    if (validated) {
      const filename = basename(filePath);
      const existed = pipelines.has(validated.config.name);
      pipelines.set(validated.config.name, validated);
      fileToName.set(filename, validated.config.name);
      const action = existed ? 'reloaded' : 'loaded';
      log.info(`Pipeline ${action}: ${validated.config.name}`);
      emitEvent(validated.config.name, action);
    }
  }

  function handleFileChange(dir: string, filename: string): void {
    if (!filename || isIgnoredFile(filename) || !isYamlFile(filename)) return;

    const filePath = join(dir, filename);

    if (existsSync(filePath)) {
      reloadPipeline(filePath);
    } else {
      const name = fileToName.get(filename) ?? pipelineNameFromFile(filename);
      if (pipelines.delete(name)) {
        fileToName.delete(filename);
        log.info(`Pipeline removed: ${name}`);
        emitEvent(name, 'removed');
      }
    }
  }

  return {
    loadFromDirectory,

    getPipeline(name: string): ValidatedPipeline | undefined {
      return pipelines.get(name);
    },

    getAllPipelines(): ValidatedPipeline[] {
      return [...pipelines.values()];
    },

    removePipeline(name: string): boolean {
      const removed = pipelines.delete(name);
      if (removed) {
        emitEvent(name, 'removed');
      }
      return removed;
    },

    reloadPipeline,

    watch(dir: string): void {
      watcher = watch(dir, (_eventType, filename) => {
        if (!filename) return;
        const existing = debounceTimers.get(filename);
        if (existing) clearTimeout(existing);
        debounceTimers.set(
          filename,
          setTimeout(() => {
            debounceTimers.delete(filename);
            handleFileChange(dir, filename);
          }, FILE_CHANGE_DEBOUNCE_MS),
        );
      });
    },

    shutdown(): void {
      for (const timer of debounceTimers.values()) {
        clearTimeout(timer);
      }
      debounceTimers.clear();
      if (watcher) {
        watcher.close();
        watcher = null;
      }
    },
  };
}
