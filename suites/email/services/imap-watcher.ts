import { ImapFlow } from 'imapflow';
import { generateId, type EventBusInterface, type LoggerInterface } from '@raven/shared';
import type { ServiceContext, SuiteService } from '@raven/core/suite-registry/service-runner.ts';

let client: ImapFlow | null = null;
let running = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let eventBus: EventBusInterface;
let logger: LoggerInterface;
let watchFolders: string[];

async function connect(): Promise<void> {
  if (!running) return;

  const user = process.env.GMAIL_IMAP_USER;
  const password = process.env.GMAIL_IMAP_PASSWORD;
  if (!user || !password) return;

  try {
    client = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: { user, pass: password },
      logger: false,
    });

    await client.connect();
    logger.info(`IMAP connected to imap.gmail.com`);

    for (const folder of watchFolders) {
      watchFolder(folder);
    }
  } catch (err) {
    logger.error(`IMAP connection failed: ${err instanceof Error ? err.message : err}`);
    scheduleReconnect();
  }
}

async function watchFolder(folder: string): Promise<void> {
  if (!client || !running) return;

  try {
    const lock = await client.getMailboxLock(folder);

    try {
      client.on('exists', async (data: { path: string; count: number; prevCount: number }) => {
        if (data.count > data.prevCount) {
          logger.info(`New mail in ${data.path} (${data.count - data.prevCount} new)`);
          await fetchNewMessages(data.path, data.prevCount + 1, data.count);
        }
      });

      logger.info(`Watching ${folder} via IDLE`);

      client.on('close', () => {
        logger.warn('IMAP connection closed');
        lock.release();
        if (running) scheduleReconnect();
      });

      client.on('error', (err: Error) => {
        logger.error(`IMAP error: ${err.message}`);
      });
    } catch (err) {
      lock.release();
      throw err;
    }
  } catch (err) {
    logger.error(`Failed to watch ${folder}: ${err instanceof Error ? err.message : err}`);
    if (running) scheduleReconnect();
  }
}

async function fetchNewMessages(folder: string, from: number, to: number): Promise<void> {
  if (!client) return;

  try {
    const range = `${from}:${to}`;
    for await (const msg of client.fetch(range, { envelope: true, source: false })) {
      const envelope = msg.envelope;
      if (!envelope) continue;

      const fromAddr = envelope.from?.[0]
        ? `${envelope.from[0].name || ''} <${envelope.from[0].address || ''}>`.trim()
        : 'Unknown';

      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: 'gmail',
        type: 'email:new',
        payload: {
          from: fromAddr,
          subject: envelope.subject || '(no subject)',
          snippet: '',
          messageId: envelope.messageId || '',
          receivedAt: envelope.date ? new Date(envelope.date).getTime() : Date.now(),
        },
      } as unknown);
    }
  } catch (err) {
    logger.error(`Failed to fetch messages: ${err instanceof Error ? err.message : err}`);
  }
}

function scheduleReconnect(): void {
  if (!running || reconnectTimer) return;

  logger.info('Reconnecting to IMAP in 30 seconds...');
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (client) {
      await client.logout().catch(() => {});
      client = null;
    }
    await connect();
  }, 30000);
}

const service: SuiteService = {
  async start(context: ServiceContext): Promise<void> {
    eventBus = context.eventBus;
    logger = context.logger;
    const configFolders = (context.config as { watchFolders?: string[] }).watchFolders;
    watchFolders = configFolders ?? ['INBOX'];

    const user = process.env.GMAIL_IMAP_USER;
    const password = process.env.GMAIL_IMAP_PASSWORD;

    if (user && password) {
      running = true;
      connect().catch((err) => {
        logger.error(`IMAP watcher failed to start: ${err}`);
      });
      logger.info(`Gmail IMAP watcher started for ${user}`);
    } else {
      logger.warn('Gmail IMAP credentials not configured, watcher disabled');
    }
  },

  async stop(): Promise<void> {
    running = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (client) {
      await client.logout().catch(() => {});
      client = null;
    }
    logger.info('IMAP watcher stopped');
  },
};

export default service;
