import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import {
  generateId,
  SOURCE_GWS_GMAIL,
  type EventBusInterface,
  type LoggerInterface,
} from '@raven/shared';
import type { ServiceContext, RavenService } from '../types.ts';

const RECONNECT_DELAY_MS = 30_000;
const MS_PER_SECOND = 1000;
const NDJSON_LOG_PREVIEW_LENGTH = 100; // chars of an unparseable line to include in the warning

let child: ChildProcess | null = null;
let running = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let eventBus: EventBusInterface;
let logger: LoggerInterface;
let credFile: string;
let gcpProjectId: string;

function buildGmailWatchArgs(projectId: string): string[] {
  return [
    'gmail',
    '+watch',
    '--project',
    projectId,
    '--label-ids',
    'INBOX',
    '--msg-format',
    'metadata',
    '--format',
    'json',
  ];
}

function spawnWatcher(): void {
  if (!running) return;

  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = credFile;

  child = spawn('gws', buildGmailWatchArgs(gcpProjectId), {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let buffer = '';

  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed) as Record<string, unknown>;
        emitEmailEvent(msg);
      } catch {
        logger.warn(`Failed to parse NDJSON line: ${trimmed.slice(0, NDJSON_LOG_PREVIEW_LENGTH)}`);
      }
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) logger.warn(`gws gmail +watch stderr: ${text}`);
  });

  child.on('error', (err: Error) => {
    logger.error(`gws gmail +watch error: ${err.message}`);
    scheduleReconnect();
  });

  child.on('exit', (code) => {
    logger.warn(`gws gmail +watch exited with code ${code}`);
    child = null;
    if (running) scheduleReconnect();
  });

  logger.info('gws gmail +watch started');
}

function emitEmailEvent(msg: Record<string, unknown>): void {
  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SOURCE_GWS_GMAIL,
    type: 'email:new',
    payload: {
      from: (msg.from as string) || 'Unknown',
      subject: (msg.subject as string) || '(no subject)',
      snippet: (msg.snippet as string) || '',
      messageId: (msg.messageId as string) || (msg.id as string) || '',
      receivedAt: msg.date ? new Date(msg.date as string).getTime() : Date.now(),
    },
  } as unknown);
}

function scheduleReconnect(): void {
  if (!running || reconnectTimer) return;

  logger.info(`Reconnecting gws gmail +watch in ${RECONNECT_DELAY_MS / MS_PER_SECOND} seconds...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    spawnWatcher();
  }, RECONNECT_DELAY_MS);
}

const service: RavenService = {
  async start(context: ServiceContext): Promise<void> {
    eventBus = context.eventBus;
    logger = context.logger;

    const rawCred = process.env.GWS_PRIMARY_CREDENTIALS_FILE ?? '';
    credFile = rawCred ? resolve(context.projectRoot, rawCred) : '';
    gcpProjectId = process.env.GWS_GCP_PROJECT_ID ?? '';

    if (!credFile) {
      logger.warn('GWS_PRIMARY_CREDENTIALS_FILE not set, email watcher disabled');
      return;
    }
    if (!gcpProjectId) {
      logger.warn('GWS_GCP_PROJECT_ID not set, email watcher disabled');
      return;
    }

    running = true;
    spawnWatcher();
    logger.info('GWS email watcher service started');
  },

  async stop(): Promise<void> {
    running = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (child) {
      child.kill();
      child = null;
    }
    logger?.info('GWS email watcher service stopped');
  },
};

export default service;
