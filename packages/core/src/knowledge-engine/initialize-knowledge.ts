import { createLogger } from '@raven/shared';
import type { AppConfig } from '../config.ts';
import type { EventBus } from '../event-bus/event-bus.ts';
import { createProcessorLifecycle, type ProcessorLifecycle } from './processor-lifecycle.ts';
import { createNeo4jClient, type Neo4jClient } from './neo4j-client.ts';
import { createKnowledgeStore } from './knowledge-store.ts';
import { createIngestionProcessor } from './ingestion.ts';
import { createEmbeddingEngine } from './embeddings.ts';
import { createClusteringEngine } from './clustering.ts';
import { createChunkingEngine } from './chunking.ts';
import { createRetrievalEngine } from './retrieval.ts';
import { createKnowledgeLifecycle } from './knowledge-lifecycle.ts';
import { createRetrospective } from './retrospective.ts';
import { createKnowledgeConsolidation } from './knowledge-consolidation.ts';
import { loadKnowledgeDomainConfig } from './domain-config.ts';
import { syncProjectNodes } from './project-knowledge.ts';
import {
  refreshKnowledgeIndexes,
  reindexKnowledge,
  type KnowledgeRefreshReport,
} from './knowledge-refresh.ts';

const log = createLogger('knowledge-startup');
const factories = {
  createNeo4jClient,
  createKnowledgeStore,
  createIngestionProcessor,
  createEmbeddingEngine,
  createClusteringEngine,
  createChunkingEngine,
  createRetrievalEngine,
  createKnowledgeLifecycle,
  createRetrospective,
  createKnowledgeConsolidation,
  loadKnowledgeDomainConfig,
  syncProjectNodes,
};

interface KnowledgeStartupDeps {
  config: AppConfig;
  eventBus: EventBus;
  knowledgeDir: string;
  mediaDir: string;
  configDir: string;
  embeddingCacheDir: string;
}

export interface KnowledgeRuntime {
  neo4jClient: Neo4jClient;
  knowledgeStore: ReturnType<typeof createKnowledgeStore>;
  ingestionProcessor: ReturnType<typeof createIngestionProcessor>;
  embeddingEngine: ReturnType<typeof createEmbeddingEngine>;
  clusteringEngine: ReturnType<typeof createClusteringEngine>;
  chunkingEngine: ReturnType<typeof createChunkingEngine>;
  retrievalEngine: ReturnType<typeof createRetrievalEngine>;
  knowledgeLifecycle: ReturnType<typeof createKnowledgeLifecycle>;
  retrospective: ReturnType<typeof createRetrospective>;
  knowledgeConsolidation: ReturnType<typeof createKnowledgeConsolidation>;
  reindex(): Promise<KnowledgeRefreshReport>;
  stop(): Promise<void>;
}

type Processor = { stop(): Promise<void> };
interface StartupState {
  lifetime: ProcessorLifecycle;
  processors: Processor[];
  client?: Neo4jClient;
}

interface BuildDeps extends KnowledgeStartupDeps {
  neo4j: Neo4jClient;
  knowledgeStore: KnowledgeRuntime['knowledgeStore'];
  make: typeof factories;
  own<T extends Processor>(processor: T): T;
}

type StartedProcessors = Pick<
  KnowledgeRuntime,
  'ingestionProcessor' | 'embeddingEngine' | 'clusteringEngine' | 'chunkingEngine'
>;

async function startProcessors(deps: BuildDeps): Promise<StartedProcessors> {
  const {
    make,
    own,
    neo4j,
    eventBus,
    knowledgeStore,
    mediaDir,
    configDir,
    knowledgeDir,
    embeddingCacheDir,
  } = deps;
  const ingestionProcessor = own(
    make.createIngestionProcessor({ knowledgeStore, eventBus, mediaDir }),
  );
  ingestionProcessor.start();
  const embeddingEngine = own(
    make.createEmbeddingEngine({
      neo4j,
      eventBus,
      knowledgeStore,
      cacheDir: embeddingCacheDir,
    }),
  );
  embeddingEngine.start();
  const clusteringEngine = own(
    make.createClusteringEngine({
      neo4j,
      eventBus,
      knowledgeStore,
      embeddingEngine,
      domainConfig: make.loadKnowledgeDomainConfig(configDir),
    }),
  );
  await clusteringEngine.start();
  const chunkingEngine = own(
    make.createChunkingEngine({
      neo4j,
      eventBus,
      knowledgeStore,
      knowledgeDir,
      cacheDir: embeddingCacheDir,
    }),
  );
  chunkingEngine.start();
  return { ingestionProcessor, embeddingEngine, clusteringEngine, chunkingEngine };
}

async function buildKnowledge(
  deps: BuildDeps,
  stop: () => Promise<void>,
): Promise<Omit<KnowledgeRuntime, 'reindex'>> {
  const { make, own, neo4j, knowledgeStore, eventBus, knowledgeDir, embeddingCacheDir } = deps;
  const processors = await startProcessors(deps);
  const { embeddingEngine, chunkingEngine } = processors;
  const retrievalEngine = make.createRetrievalEngine({
    neo4j,
    knowledgeStore,
    knowledgeDir,
    cacheDir: embeddingCacheDir,
  });
  const knowledgeLifecycle = own(
    make.createKnowledgeLifecycle({
      neo4j,
      knowledgeStore,
      eventBus,
      embeddingEngine,
      chunkingEngine,
      knowledgeDir,
    }),
  );
  const retrospective = own(
    make.createRetrospective({ neo4j, eventBus, lifecycle: knowledgeLifecycle }),
  );
  const knowledgeConsolidation = own(
    make.createKnowledgeConsolidation({
      neo4j,
      eventBus,
      knowledgeStore,
      embeddingEngine,
      chunkingEngine,
    }),
  );
  return {
    ...processors,
    neo4jClient: neo4j,
    knowledgeStore,
    retrievalEngine,
    knowledgeLifecycle,
    retrospective,
    knowledgeConsolidation,
    stop,
  };
}

async function disposeKnowledge(state: StartupState): Promise<void> {
  // Invoke every stop before waiting: siblings cease accepting work together.
  const results = await Promise.allSettled(
    [state.lifetime, ...state.processors].map(async (processor) => processor.stop()),
  );
  for (const result of results) {
    if (result.status === 'rejected')
      log.warn(`Knowledge processor cleanup failed: ${result.reason}`);
  }
  try {
    await state.client?.close();
  } catch (err) {
    log.warn(`Knowledge driver cleanup failed: ${err}`);
  }
}

function guardGraph(client: Neo4jClient, lifetime: ProcessorLifecycle): Neo4jClient {
  return lifetime.guard({
    ...client,
    withTransaction: (operation, mode) =>
      client.withTransaction((tx) => operation(lifetime.guard(tx)), mode),
  });
}

function initializeRefresh(
  runtime: Omit<KnowledgeRuntime, 'reindex'>,
  initial: Awaited<ReturnType<KnowledgeRuntime['knowledgeStore']['reindexAll']>>,
  lifetime: ProcessorLifecycle,
): KnowledgeRuntime {
  const refreshDeps = { ...runtime, signal: lifetime.signal };
  let pending: Promise<KnowledgeRefreshReport> | undefined;
  const refresh = (source?: typeof initial): Promise<KnowledgeRefreshReport> => {
    lifetime.assertActive();
    if (pending) return pending;
    const work = lifetime.run(() =>
      source ? refreshKnowledgeIndexes(refreshDeps, source) : reindexKnowledge(refreshDeps),
    );
    pending = work;
    void work
      .finally(() => {
        if (pending === work) pending = undefined;
      })
      .catch(() => {});
    return work;
  };
  // Derived generation may download/load a model. Keep diagnostics and the rest
  // of Raven available while this owned work settles; manual repair shares it.
  void refresh(initial).then(
    (refreshed) => {
      if (refreshed.refreshErrors.length > 0)
        log.warn(`Knowledge refresh remains pending: ${JSON.stringify(refreshed.refreshErrors)}`);
    },
    (error: unknown) => {
      if (!lifetime.signal.aborted) log.warn(`Knowledge refresh failed: ${String(error)}`);
    },
  );
  return { ...runtime, reindex: () => refresh() };
}

/** Compose the existing engines privately; callers publish only a successful result. */
export async function initializeKnowledge(
  deps: KnowledgeStartupDeps,
  overrides: Partial<typeof factories> = {},
): Promise<KnowledgeRuntime | undefined> {
  if (!deps.config.NEO4J_ENABLED) {
    log.info('Knowledge graph disabled by configuration');
    return undefined;
  }
  const make = { ...factories, ...overrides };
  const lifetime = createProcessorLifecycle(deps.eventBus, 'knowledge');
  const state: StartupState = { lifetime, processors: [] };
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => (stopping ??= disposeKnowledge(state));
  function own<T extends Processor>(processor: T): T {
    state.processors.push(processor);
    return processor;
  }
  try {
    const { config, knowledgeDir } = deps;
    state.client = make.createNeo4jClient({
      uri: config.NEO4J_URI,
      user: config.NEO4J_USER,
      password: config.NEO4J_PASSWORD,
    });
    const neo4j = guardGraph(state.client, lifetime);
    await neo4j.ensureSchema();
    await make.syncProjectNodes(neo4j);
    const knowledgeStore = lifetime.guard(
      make.createKnowledgeStore({ neo4j, knowledgeDir, signal: lifetime.signal }),
    );
    const reindex = await knowledgeStore.reindexAll();
    if (reindex.errors.length > 0)
      log.warn(`Knowledge files need repair: ${reindex.errors.join('; ')}`);
    const runtime = await buildKnowledge({ ...deps, neo4j, knowledgeStore, make, own }, stop);
    const ready = initializeRefresh(runtime, reindex, lifetime);
    log.info('Knowledge graph and processors initialized');
    return ready;
  } catch (err) {
    log.warn(`Knowledge initialization failed — continuing without graph: ${err}`);
    await stop();
    return undefined;
  }
}
