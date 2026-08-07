import type {
  EventBusInterface,
  DatabaseInterface,
  LoggerInterface,
  IntegrationsConfig,
} from '@raven/shared';
import type { JobRegistry } from '../scheduler/job-registry.ts';

/**
 * Runtime dependencies handed to every background service's `start()`.
 * Mirrors the shape the former suite `ServiceContext` provided so moving
 * services here required no behavior change — only the import path moved.
 */
export interface ServiceContext {
  eventBus: EventBusInterface;
  db: DatabaseInterface;
  logger: LoggerInterface;
  config: Record<string, unknown>;
  projectRoot: string;
  integrationsConfig: IntegrationsConfig;
  jobRegistry: JobRegistry;
}

/** A background service module's default export: start it, stop it. */
export interface RavenService {
  start(context: ServiceContext): Promise<void> | void;
  stop(): Promise<void> | void;
}
