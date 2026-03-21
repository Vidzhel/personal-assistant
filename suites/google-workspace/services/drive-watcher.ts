import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { generateId, SOURCE_GWS_DRIVE, type EventBusInterface, type LoggerInterface } from '@raven/shared';
import type { GDriveNewFileEvent } from '@raven/shared';
import type { ServiceContext, SuiteService } from '@raven/core/suite-registry/service-runner.ts';

const PAGE_TOKEN_FILE = 'data/gdrive-page-token.txt';

let running = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let eventBus: EventBusInterface;
let logger: LoggerInterface;
let credFile: string;
let monitoredFolderIds: string[];
let pageToken: string;
let pollIntervalMs: number;
let projectRoot: string;
let configReloadedHandler: ((event: unknown) => void) | null = null;

function runGwsCommand(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = credFile;

    const proc = spawn('gws', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`gws exited ${code}: ${stderr}`));
    });
  });
}

async function fetchStartPageToken(): Promise<string> {
  const output = await runGwsCommand(['drive', 'changes', 'getStartPageToken', '--format', 'json']);
  const parsed = JSON.parse(output.trim()) as { startPageToken: string };
  return parsed.startPageToken;
}

async function persistPageToken(token: string): Promise<void> {
  const tokenPath = resolve(projectRoot, PAGE_TOKEN_FILE);
  await mkdir(dirname(tokenPath), { recursive: true });
  await writeFile(tokenPath, token, 'utf-8');
}

async function loadPersistedPageToken(): Promise<string | null> {
  try {
    const tokenPath = resolve(projectRoot, PAGE_TOKEN_FILE);
    const token = await readFile(tokenPath, 'utf-8');
    return token.trim() || null;
  } catch {
    return null;
  }
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  modifiedTime: string;
  size?: string;
  webViewLink?: string;
}

interface DriveChange {
  file?: DriveFile;
  removed?: boolean;
}

interface ChangesResponse {
  changes?: DriveChange[];
  newStartPageToken?: string;
}

async function poll(): Promise<void> {
  if (!running) return;

  try {
    const params = JSON.stringify({
      pageToken,
      spaces: 'drive',
      fields: '*',
    });

    const output = await runGwsCommand([
      'drive', 'changes', 'list',
      '--params', params,
      '--format', 'json',
      '--page-all',
    ]);

    // Parse NDJSON (may be multi-page)
    const lines = output.trim().split('\n').filter(Boolean);
    let newToken: string | undefined;

    for (const line of lines) {
      const parsed = JSON.parse(line) as ChangesResponse;

      if (parsed.newStartPageToken) {
        newToken = parsed.newStartPageToken;
      }

      if (parsed.changes) {
        for (const change of parsed.changes) {
          if (change.removed || !change.file) continue;

          const file = change.file;
          const matchingFolder = file.parents?.find((p) => monitoredFolderIds.includes(p));

          if (matchingFolder) {
            const event: GDriveNewFileEvent = {
              id: generateId(),
              timestamp: Date.now(),
              source: SOURCE_GWS_DRIVE,
              type: 'gdrive:new-file',
              payload: {
                fileId: file.id,
                name: file.name,
                mimeType: file.mimeType,
                folderId: matchingFolder,
                modifiedTime: file.modifiedTime,
                size: file.size ? Number(file.size) : 0,
                webViewLink: file.webViewLink,
              },
            };
            eventBus.emit(event as unknown);
          }
        }
      }
    }

    if (newToken) {
      pageToken = newToken;
      await persistPageToken(newToken);
    }
  } catch (err) {
    logger.warn(`Drive poll failed: ${(err as Error).message}`);
  }
}

const service: SuiteService = {
  async start(context: ServiceContext): Promise<void> {
    eventBus = context.eventBus;
    logger = context.logger;
    projectRoot = context.projectRoot;

    const rawCred = process.env.GWS_PRIMARY_CREDENTIALS_FILE ?? '';
    credFile = rawCred ? resolve(context.projectRoot, rawCred) : '';

    if (!credFile) {
      logger.warn('GWS_PRIMARY_CREDENTIALS_FILE not set, drive watcher disabled');
      return;
    }

    const config = context.config as Record<string, unknown>;
    monitoredFolderIds = (config.driveFolders as string[]) ?? [];
    pollIntervalMs = (config.drivePollingIntervalMs as number) ?? 300_000;

    if (monitoredFolderIds.length === 0) {
      logger.warn('No driveFolders configured, drive watcher disabled');
      return;
    }

    // Load persisted page token or fetch a new one
    const persisted = await loadPersistedPageToken();
    if (persisted) {
      pageToken = persisted;
      logger.info(`Drive watcher loaded persisted pageToken`);
    } else {
      try {
        pageToken = await fetchStartPageToken();
        await persistPageToken(pageToken);
        logger.info(`Drive watcher fetched initial pageToken`);
      } catch (err) {
        logger.warn(`Failed to fetch start page token: ${(err as Error).message}`);
        return;
      }
    }

    running = true;

    // Initial poll
    await poll();

    // Schedule recurring polls
    pollTimer = setInterval(() => {
      void poll();
    }, pollIntervalMs);

    // Listen for config reloads — re-read suites.json from disk
    configReloadedHandler = (event: unknown) => {
      const e = event as { payload?: { configType?: string } };
      if (e.payload?.configType !== 'suites') return;

      try {
        const suitesPath = resolve(projectRoot, 'config', 'suites.json');
        if (!existsSync(suitesPath)) return;
        const raw = JSON.parse(readFileSync(suitesPath, 'utf-8')) as Record<string, { config?: Record<string, unknown> }>;
        const gwsConfig = raw['google-workspace']?.config;
        if (!gwsConfig) return;

        if (Array.isArray(gwsConfig.driveFolders)) {
          monitoredFolderIds = gwsConfig.driveFolders as string[];
          logger.info(`Drive watcher updated monitored folders: ${monitoredFolderIds.join(', ')}`);
        }
        if (typeof gwsConfig.drivePollingIntervalMs === 'number') {
          pollIntervalMs = gwsConfig.drivePollingIntervalMs as number;
          if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = setInterval(() => {
              void poll();
            }, pollIntervalMs);
          }
          logger.info(`Drive watcher updated poll interval: ${pollIntervalMs}ms`);
        }
      } catch (err) {
        logger.warn(`Failed to reload drive config: ${(err as Error).message}`);
      }
    };
    eventBus.on('config:reloaded', configReloadedHandler);

    logger.info('GWS drive watcher service started');
  },

  async stop(): Promise<void> {
    running = false;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (configReloadedHandler && eventBus) {
      eventBus.off('config:reloaded', configReloadedHandler);
      configReloadedHandler = null;
    }
    if (pageToken) {
      await persistPageToken(pageToken).catch(() => {});
    }
    logger?.info('GWS drive watcher service stopped');
  },
};

export default service;
