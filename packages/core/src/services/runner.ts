import { createLogger } from '@raven/shared';
import type { ServiceDefinition } from './registry.ts';
import type { ServiceContext } from './types.ts';

const log = createLogger('service-runner');

export interface ServiceRunner {
  startServices(defs: ServiceDefinition[], context: ServiceContext): Promise<void>;
  stopAll(): Promise<void>;
  /** Number of services currently running (started successfully via startServices). */
  getRunningCount(): number;
}

interface RunningService {
  name: string;
  stop: ServiceDefinition['stop'];
}

/**
 * Starts/stops the compiled `SERVICE_DEFINITIONS`, gating each on its
 * declared `requiresEnv`. Mirrors the semantics of the former suite
 * `ServiceRunner`: missing env vars skip the service with a log line
 * (never fatal to boot); a `start()` failure is logged and boot continues.
 */
export function createServiceRunner(): ServiceRunner {
  let running: RunningService[] = [];

  async function startServices(defs: ServiceDefinition[], context: ServiceContext): Promise<void> {
    for (const def of defs) {
      const missing = def.requiresEnv.filter((v) => !process.env[v]);
      if (missing.length > 0) {
        log.error(
          `Service "${def.name}" cannot start: missing required env vars: ${missing.join(', ')}`,
        );
        continue;
      }

      try {
        await def.start(context);
        running.push({ name: def.name, stop: def.stop });
        log.info(`Service started: ${def.name}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`Failed to start service "${def.name}": ${msg}`);
      }
    }
  }

  async function stopAll(): Promise<void> {
    for (const svc of running.reverse()) {
      try {
        await svc.stop();
        log.info(`Service stopped: ${svc.name}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`Failed to stop service "${svc.name}": ${msg}`);
      }
    }
    running = [];
  }

  function getRunningCount(): number {
    return running.length;
  }

  return { startServices, stopAll, getRunningCount };
}
