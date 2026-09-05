import type {
  EventBusInterface,
  DatabaseInterface,
  LoggerInterface,
  IntegrationsConfig,
} from '@raven/shared';
import type { KnowledgeRefreshReport } from '../knowledge-engine/knowledge-refresh.ts';
import type { KnowledgeReconciliationReport } from '../knowledge-engine/knowledge-reconciliation.ts';
import type { JobRegistry } from '../scheduler/job-registry.ts';
import type { ExecutionLogger } from '../agent-manager/execution-logger.ts';

/**
 * Runtime dependencies handed to every background service's `start()`.
 * Mirrors the shape the former suite `ServiceContext` provided so moving
 * services here required no behavior change — only the import path moved.
 */
export interface ServiceContext {
  eventBus: EventBusInterface;
  db: DatabaseInterface;
  /** Optional for services that do not consume agent-run history. */
  executionLogger?: ExecutionLogger;
  logger: LoggerInterface;
  config: Record<string, unknown>;
  projectRoot: string;
  /** Override configuration storage without changing runtime data locations. */
  configDir?: string;
  projectsDir?: string;
  libraryDir?: string;
  /** Resolve the actual bound port, including ephemeral ports after HTTP startup. */
  getApiPort?: () => number;
  /** Reuses the knowledge processors to retry stale derived indexes. */
  maintainKnowledge?: () => Promise<
    | {
        refresh: KnowledgeRefreshReport;
        reconciliation: KnowledgeReconciliationReport;
      }
    | undefined
  >;
  integrationsConfig: IntegrationsConfig;
  jobRegistry: JobRegistry;
}

/** A background service module's default export: start it, stop it. */
export interface RavenService {
  start(context: ServiceContext): Promise<void> | void;
  stop(): Promise<void> | void;
}
