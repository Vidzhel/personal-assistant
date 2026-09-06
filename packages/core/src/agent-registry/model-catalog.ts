import { query, type ModelInfo, type Query } from '@anthropic-ai/claude-agent-sdk';
import {
  ModelEffortSchema,
  ModelIdSchema,
  type ModelCatalogEntry,
  type ModelCatalogSnapshot,
  type ModelEffort,
} from '@raven/shared';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getMandatoryThinkingPolicy, normalizeModelId, MODEL_ALIAS_IDS } from './model-settings.ts';

const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;
const ONE_MINUTE_MS = 60_000;
const MINUTES_UNTIL_STALE = 5;
const DEFAULT_STALE_AFTER_MS = MINUTES_UNTIL_STALE * ONE_MINUTE_MS;
const MAX_CATALOG_MODELS = 100;
const MAX_ERROR_LENGTH = 500;

export interface DiscoveredModel {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: ModelEffort[];
  supportsAdaptiveThinking?: boolean;
}

export type ModelDiscovery = (signal: AbortSignal) => Promise<readonly DiscoveredModel[]>;

export interface ModelCatalogOptions {
  discover?: ModelDiscovery;
  timeoutMs?: number;
  staleAfterMs?: number;
  now?: () => Date;
}

export interface SdkModelDiscoveryOptions {
  signal?: AbortSignal;
  executablePathOverride?: string;
}

export class ModelCatalog {
  private readonly discover: ModelDiscovery;
  private readonly timeoutMs: number;
  private readonly staleAfterMs: number;
  private readonly now: () => Date;
  private snapshot: ModelCatalogSnapshot = {
    models: [],
    fetchedAt: null,
    revision: 0,
    stale: true,
    error: 'Model catalog has not been refreshed',
  };
  private inFlight?: Promise<ModelCatalogSnapshot>;
  private activeController?: AbortController;
  private activeDiscovery?: Promise<readonly DiscoveredModel[]>;
  private stopped = false;

  constructor(options: ModelCatalogOptions = {}) {
    this.discover = options.discover ?? ((signal) => discoverSdkModels({ signal }));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.now = options.now ?? (() => new Date());
  }

  getSnapshot(): ModelCatalogSnapshot {
    const stale = this.snapshot.stale || this.isExpired();
    return cloneSnapshot({ ...this.snapshot, stale });
  }

  refresh(signal?: AbortSignal): Promise<ModelCatalogSnapshot> {
    if (this.stopped) return Promise.resolve(this.getSnapshot());
    if (!this.inFlight) {
      this.inFlight = this.performRefresh(signal).finally(() => {
        this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.snapshot = {
      ...this.snapshot,
      revision: this.snapshot.revision + 1,
      stale: true,
      error: 'Model catalog is stopped',
    };
    this.activeController?.abort(new Error('Model catalog stopped during discovery'));
    if (this.inFlight) await settleBounded(this.inFlight, this.timeoutMs);
  }

  private async performRefresh(signal?: AbortSignal): Promise<ModelCatalogSnapshot> {
    const controller = new AbortController();
    this.activeController = controller;
    const detach = relayAbort(signal, controller);
    const timeout = setTimeout(
      () => controller.abort(new Error(`Model discovery timed out after ${this.timeoutMs}ms`)),
      this.timeoutMs,
    );
    timeout.unref?.();
    const discovery = Promise.resolve().then(() => this.discover(controller.signal));
    this.activeDiscovery = discovery;
    try {
      const discovered = await Promise.race([discovery, rejectWhenAborted(controller.signal)]);
      if (this.stopped) return this.getSnapshot();
      const models = normalizeCatalogEntries(discovered).slice(0, MAX_CATALOG_MODELS);
      if (models.length === 0) throw new Error('Model discovery returned no models');
      this.snapshot = {
        models,
        fetchedAt: this.now().toISOString(),
        revision: this.snapshot.revision + 1,
        stale: false,
        error: null,
      };
    } catch (error) {
      if (!this.stopped) {
        this.snapshot = {
          ...this.snapshot,
          revision: this.snapshot.revision + 1,
          stale: true,
          error: sanitizeDiscoveryError(error),
        };
      }
    } finally {
      clearTimeout(timeout);
      detach();
      controller.abort();
      await settleBounded(discovery, this.timeoutMs);
      if (this.activeController === controller) this.activeController = undefined;
      if (this.activeDiscovery === discovery) this.activeDiscovery = undefined;
    }
    return this.getSnapshot();
  }

  private isExpired(): boolean {
    if (!this.snapshot.fetchedAt) return true;
    return this.now().getTime() - Date.parse(this.snapshot.fetchedAt) > this.staleAfterMs;
  }
}

export async function discoverSdkModels(
  options: SdkModelDiscoveryOptions = {},
): Promise<DiscoveredModel[]> {
  const cwd = await mkdtemp(join(tmpdir(), 'raven-model-discovery-'));
  const controller = new AbortController();
  const detach = relayAbort(options.signal, controller);
  const input = openEmptyInput();
  let sdkQuery: Query | undefined;
  try {
    sdkQuery = query({
      prompt: input.prompt,
      options: {
        cwd,
        env: discoveryEnvironment(),
        settingSources: [],
        permissionMode: 'default',
        strictMcpConfig: true,
        mcpServers: {},
        tools: [],
        allowedTools: [],
        persistSession: false,
        abortController: controller,
        pathToClaudeCodeExecutable: options.executablePathOverride,
      },
    });
    const models = await sdkQuery.supportedModels();
    return models.map(toDiscoveredModel);
  } finally {
    detach();
    controller.abort();
    input.close();
    if (sdkQuery) {
      await settleBounded(Promise.resolve(sdkQuery.close()), DEFAULT_DISCOVERY_TIMEOUT_MS);
    }
    await rm(cwd, { recursive: true, force: true });
  }
}

export function normalizeCatalogEntries(
  discovered: readonly DiscoveredModel[],
): ModelCatalogEntry[] {
  const entries = new Map<string, ModelCatalogEntry>();
  for (const model of discovered) mergeDiscoveredModel(entries, model);
  return [...entries.values()].sort((left, right) =>
    left.displayName.localeCompare(right.displayName),
  );
}

function mergeDiscoveredModel(
  entries: Map<string, ModelCatalogEntry>,
  model: DiscoveredModel,
): void {
  const value = ModelIdSchema.parse(model.value);
  const id = normalizeModelId(model.resolvedModel ?? value);
  const entry = entries.get(id) ?? {
    id,
    aliases: [],
    displayName: model.displayName,
    description: model.description,
  };
  entry.aliases = catalogAliases(id, value, entry.aliases);
  if (model.supportsEffort) entry.supportsEffort = true;
  if (model.supportedEffortLevels) {
    entry.supportedEffortLevels = normalizeEffortLevels([
      ...(entry.supportedEffortLevels ?? []),
      ...model.supportedEffortLevels,
    ]);
  }
  if (model.supportsAdaptiveThinking) entry.supportsAdaptiveThinking = true;
  entries.set(id, {
    ...entry,
    mandatoryThinking: Boolean(getMandatoryThinkingPolicy(id)) || undefined,
  });
}

function catalogAliases(id: string, value: string, existing: string[]): string[] {
  const aliases = new Set(existing);
  if (value !== id) aliases.add(value);
  for (const [alias, aliasId] of Object.entries(MODEL_ALIAS_IDS)) {
    if (aliasId === id) aliases.add(alias);
  }
  return [...aliases].sort();
}

function normalizeEffortLevels(values: readonly ModelEffort[]): ModelEffort[] {
  return [...new Set(values.map((value) => ModelEffortSchema.parse(value)))];
}

function toDiscoveredModel(model: ModelInfo): DiscoveredModel {
  return {
    value: model.value,
    resolvedModel: model.resolvedModel,
    displayName: model.displayName,
    description: model.description,
    supportsEffort: model.supportsEffort,
    supportedEffortLevels: model.supportedEffortLevels,
    supportsAdaptiveThinking: model.supportsAdaptiveThinking,
  };
}

function openEmptyInput(): { prompt: AsyncIterable<never>; close: () => void } {
  let close = (): void => undefined;
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  return {
    prompt: (async function* () {
      await closed;
      for (const message of [] as never[]) yield message;
    })(),
    close,
  };
}

function discoveryEnvironment(): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  return env;
}

function relayAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => undefined;
  const abort = (): void => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const rejectAbort = (): void =>
      reject(signal.reason instanceof Error ? signal.reason : new Error('Model discovery aborted'));
    if (signal.aborted) rejectAbort();
    else signal.addEventListener('abort', rejectAbort, { once: true });
  });
}

function sanitizeDiscoveryError(error: unknown): string {
  return String(error)
    .replace(/sk-ant-[a-zA-Z0-9_-]+/g, '[redacted]')
    .replace(/(authorization|token)\s*[:=]\s*bearer\s+\S+/gi, '$1=[redacted]')
    .replace(/(authorization|api[-_ ]?key|token)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .slice(0, MAX_ERROR_LENGTH);
}

function cloneSnapshot(snapshot: ModelCatalogSnapshot): ModelCatalogSnapshot {
  return {
    ...snapshot,
    models: snapshot.models.map((model) => ({
      ...model,
      aliases: [...model.aliases],
      supportedEffortLevels: model.supportedEffortLevels
        ? [...model.supportedEffortLevels]
        : undefined,
    })),
  };
}

async function settleBounded(work: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([
      work.then(
        () => undefined,
        () => undefined,
      ),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
