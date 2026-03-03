import { ImapFlow } from 'imapflow';
import type { LoggerInterface, EventBusInterface } from '@raven/shared';
import { generateId } from '@raven/shared';

export interface ImapWatcherConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  watchFolders: string[];
}

export class ImapWatcher {
  private client: ImapFlow | null = null;
  private running = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private config: ImapWatcherConfig,
    private eventBus: EventBusInterface,
    private logger: LoggerInterface,
  ) {}

  async start(): Promise<void> {
    this.running = true;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      await this.client.logout().catch(() => {});
      this.client = null;
    }
    this.logger.info('IMAP watcher stopped');
  }

  private async connect(): Promise<void> {
    if (!this.running) return;

    try {
      this.client = new ImapFlow({
        host: this.config.host,
        port: this.config.port,
        secure: true,
        auth: {
          user: this.config.user,
          pass: this.config.password,
        },
        logger: false,
      });

      await this.client.connect();
      this.logger.info(`IMAP connected to ${this.config.host}`);

      // Start watching each folder
      for (const folder of this.config.watchFolders) {
        this.watchFolder(folder);
      }
    } catch (err) {
      this.logger.error(`IMAP connection failed: ${err instanceof Error ? err.message : err}`);
      this.scheduleReconnect();
    }
  }

  private async watchFolder(folder: string): Promise<void> {
    if (!this.client || !this.running) return;

    try {
      const lock = await this.client.getMailboxLock(folder);

      try {
        // Listen for new messages
        this.client.on(
          'exists',
          async (data: { path: string; count: number; prevCount: number }) => {
            if (data.count > data.prevCount) {
              this.logger.info(`New mail in ${data.path} (${data.count - data.prevCount} new)`);
              await this.fetchNewMessages(data.path, data.prevCount + 1, data.count);
            }
          },
        );

        // IDLE - this keeps the connection alive and receives push notifications
        this.logger.info(`Watching ${folder} via IDLE`);

        // The ImapFlow library handles IDLE automatically when the mailbox is locked
        // We keep the lock open to maintain the IDLE state
        // The 'exists' event fires when new messages arrive

        // Set up error handling for the connection
        this.client.on('close', () => {
          this.logger.warn('IMAP connection closed');
          lock.release();
          if (this.running) this.scheduleReconnect();
        });

        this.client.on('error', (err: Error) => {
          this.logger.error(`IMAP error: ${err.message}`);
        });
      } catch (err) {
        lock.release();
        throw err;
      }
    } catch (err) {
      this.logger.error(`Failed to watch ${folder}: ${err instanceof Error ? err.message : err}`);
      if (this.running) this.scheduleReconnect();
    }
  }

  private async fetchNewMessages(folder: string, from: number, to: number): Promise<void> {
    if (!this.client) return;

    try {
      const range = `${from}:${to}`;
      for await (const msg of this.client.fetch(range, { envelope: true, source: false })) {
        const envelope = msg.envelope;
        if (!envelope) continue;

        const fromAddr = envelope.from?.[0]
          ? `${envelope.from[0].name || ''} <${envelope.from[0].address || ''}>`.trim()
          : 'Unknown';

        this.eventBus.emit({
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
      this.logger.error(`Failed to fetch messages: ${err instanceof Error ? err.message : err}`);
    }
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;

    this.logger.info('Reconnecting to IMAP in 30 seconds...');
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.client) {
        await this.client.logout().catch(() => {});
        this.client = null;
      }
      await this.connect();
    }, 30000);
  }
}
