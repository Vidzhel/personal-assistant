import { statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@raven/shared';

const log = createLogger('resource-monitor');

const BYTES_PER_MB = 1_048_576;
const DB_SIZE_WARN_MB = 500;
const LOG_SIZE_WARN_MB = 1024;
const HEAP_WARN_PERCENT = 0.8;
const FAILURE_RATE_WARN = 0.1;

export interface HealthStatus {
  status: string;
  heapUsedMB: number;
  heapTotalMB: number;
  failureRate?: number;
  uptime?: number;
  subsystems?: Record<string, unknown>;
}

export interface ResourceReport {
  dbSizeMB: number;
  logSizeMB: number;
  sessionSizeMB: number;
  healthStatus: HealthStatus | null;
  concerns: string[];
  checkedAt: string;
}

interface HealthResponse {
  status: string;
  uptime: number;
  memory: { heapUsedMB: number; heapTotalMB: number };
  taskStats?: { total1h?: number; failed1h?: number };
  subsystems?: Record<string, unknown>;
}

export async function checkResources(dataDir: string, healthUrl: string): Promise<ResourceReport> {
  log.info('Checking system resources');

  const [dbSizeMB, logSizeMB, sessionSizeMB, healthStatus] = await Promise.all([
    getFileSizeMB(join(dataDir, 'raven.db')),
    getDirSizeMB(join(dataDir, 'logs')),
    getDirSizeMB(join(dataDir, 'sessions')),
    fetchHealthStatus(healthUrl),
  ]);

  const concerns = evaluateConcerns(dbSizeMB, logSizeMB, healthStatus);

  log.info(
    `Resources: DB=${dbSizeMB.toFixed(1)}MB, Logs=${logSizeMB.toFixed(1)}MB, Sessions=${sessionSizeMB.toFixed(1)}MB, Concerns=${String(concerns.length)}`,
  );

  return {
    dbSizeMB,
    logSizeMB,
    sessionSizeMB,
    healthStatus,
    concerns,
    checkedAt: new Date().toISOString(),
  };
}

function getFileSizeMB(filePath: string): number {
  try {
    const s = statSync(filePath);
    return s.size / BYTES_PER_MB;
  } catch {
    log.warn(`File not found: ${filePath}`);
    return 0;
  }
}

async function getDirSizeMB(dirPath: string): Promise<number> {
  try {
    const entries = await readdir(dirPath, { recursive: true });
    let totalBytes = 0;

    for (const entry of entries) {
      try {
        const fileStat = await stat(join(dirPath, entry));
        if (fileStat.isFile()) {
          totalBytes += fileStat.size;
        }
      } catch {
        // Skip inaccessible files
      }
    }

    return totalBytes / BYTES_PER_MB;
  } catch {
    log.warn(`Directory not accessible: ${dirPath}`);
    return 0;
  }
}

async function fetchHealthStatus(healthUrl: string): Promise<HealthStatus | null> {
  try {
    const response = await fetch(healthUrl);
    if (!response.ok) {
      log.warn(`Health endpoint returned ${String(response.status)}`);
      return null;
    }

    const data = (await response.json()) as HealthResponse;

    let failureRate: number | undefined;
    if (data.taskStats?.total1h && data.taskStats.total1h > 0) {
      failureRate = (data.taskStats.failed1h ?? 0) / data.taskStats.total1h;
    }

    return {
      status: data.status,
      heapUsedMB: data.memory.heapUsedMB,
      heapTotalMB: data.memory.heapTotalMB,
      failureRate,
      uptime: data.uptime,
      subsystems: data.subsystems,
    };
  } catch (err) {
    log.error(`Failed to fetch health status: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function evaluateConcerns(
  dbSizeMB: number,
  logSizeMB: number,
  healthStatus: HealthStatus | null,
): string[] {
  const concerns: string[] = [];

  if (dbSizeMB > DB_SIZE_WARN_MB) {
    concerns.push(
      `Database size (${dbSizeMB.toFixed(0)} MB) exceeds ${String(DB_SIZE_WARN_MB)} MB threshold`,
    );
  }

  if (logSizeMB > LOG_SIZE_WARN_MB) {
    concerns.push(
      `Log volume (${logSizeMB.toFixed(0)} MB) exceeds ${String(LOG_SIZE_WARN_MB)} MB threshold`,
    );
  }

  if (healthStatus) {
    const heapRatio = healthStatus.heapUsedMB / healthStatus.heapTotalMB;
    if (heapRatio > HEAP_WARN_PERCENT) {
      concerns.push(
        `Heap usage at ${(heapRatio * 100).toFixed(0)}% (${healthStatus.heapUsedMB.toFixed(0)}/${healthStatus.heapTotalMB.toFixed(0)} MB)`,
      );
    }

    if (healthStatus.failureRate !== undefined && healthStatus.failureRate > FAILURE_RATE_WARN) {
      concerns.push(
        `Task failure rate at ${(healthStatus.failureRate * 100).toFixed(1)}% (threshold: ${String(FAILURE_RATE_WARN * 100)}%)`,
      );
    }

    if (healthStatus.status !== 'ok') {
      concerns.push(`System status is "${healthStatus.status}" (expected "ok")`);
    }
  } else {
    concerns.push('Health endpoint unreachable');
  }

  return concerns;
}
