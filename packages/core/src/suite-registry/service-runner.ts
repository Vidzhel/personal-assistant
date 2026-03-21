import { join, resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import {
  createLogger,
  type EventBusInterface,
  type DatabaseInterface,
  type LoggerInterface,
  type IntegrationsConfig,
} from '@raven/shared';
import type { LoadedSuite } from './suite-loader.ts';

const log = createLogger('service-runner');

export interface ServiceContext {
  eventBus: EventBusInterface;
  db: DatabaseInterface;
  logger: LoggerInterface;
  config: Record<string, unknown>;
  projectRoot: string;
  integrationsConfig: IntegrationsConfig;
}

export interface SuiteService {
  start(context: ServiceContext): Promise<void>;
  stop(): Promise<void>;
}

interface RunningService {
  suiteName: string;
  serviceName: string;
  instance: SuiteService;
}

export class ServiceRunner {
  private running: RunningService[] = [];

  async startServices(suites: LoadedSuite[], context: ServiceContext): Promise<void> {
    for (const suite of suites) {
      if (suite.manifest.services.length === 0) continue;

      for (const serviceName of suite.manifest.services) {
        const servicePath = join(suite.suiteDir, 'services', `${serviceName}.ts`);

        if (!(await exists(servicePath))) {
          log.warn(
            `Suite "${suite.manifest.name}" declares service "${serviceName}" but ${servicePath} not found`,
          );
          continue;
        }

        try {
          const mod = await import(resolve(servicePath));
          const service = (mod.default ?? mod) as SuiteService;

          if (typeof service.start !== 'function' || typeof service.stop !== 'function') {
            log.warn(
              `Service "${serviceName}" in suite "${suite.manifest.name}" does not export start/stop`,
            );
            continue;
          }

          await service.start(context);
          this.running.push({
            suiteName: suite.manifest.name,
            serviceName,
            instance: service,
          });
          log.info(`Service started: ${suite.manifest.name}/${serviceName}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(
            `Failed to start service "${serviceName}" in suite "${suite.manifest.name}": ${msg}`,
          );
        }
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const svc of this.running.reverse()) {
      try {
        await svc.instance.stop();
        log.info(`Service stopped: ${svc.suiteName}/${svc.serviceName}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`Failed to stop service "${svc.serviceName}": ${msg}`);
      }
    }
    this.running = [];
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
