import type * as NodeFs from 'node:fs';
import type * as RavenShared from '@raven/shared';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSendMessage = vi.fn().mockResolvedValue({});
const mockSendDocument = vi.fn().mockResolvedValue({});
const mockGetChat = vi.fn().mockResolvedValue({});
const mockEditMessageReplyMarkup = vi.fn().mockResolvedValue({});
const mockEditMessageText = vi.fn().mockResolvedValue({});
const mockDeleteMessage = vi.fn().mockResolvedValue({});
const mockCreateForumTopic = vi.fn().mockResolvedValue({ message_thread_id: 42 });
const mockCloseForumTopic = vi.fn().mockResolvedValue(true);
const mockStart = vi.fn().mockReturnValue(new Promise(() => {}));
const mockStop = vi.fn().mockResolvedValue(undefined);
const messageHandlers: Array<(ctx: any) => Promise<void>> = [];
const callbackHandlers: Array<(ctx: any) => Promise<void>> = [];
const voiceHandlers: Array<(ctx: any) => Promise<void>> = [];
const videoNoteHandlers: Array<(ctx: any) => Promise<void>> = [];
const photoHandlers: Array<(ctx: any) => Promise<void>> = [];
const documentHandlers: Array<(ctx: any) => Promise<void>> = [];
const generatedIds = vi.hoisted(() => ({ value: 0 }));

class MockBot {
  on(filter: string, handler: any) {
    if (filter === 'message:text') messageHandlers.push(handler);
    if (filter === 'callback_query:data') callbackHandlers.push(handler);
    if (filter === 'message:voice') voiceHandlers.push(handler);
    if (filter === 'message:video_note') videoNoteHandlers.push(handler);
    if (filter === 'message:photo') photoHandlers.push(handler);
    if (filter === 'message:document') documentHandlers.push(handler);
  }
  api = {
    sendMessage: mockSendMessage,
    sendDocument: mockSendDocument,
    getChat: mockGetChat,
    editMessageReplyMarkup: mockEditMessageReplyMarkup,
    editMessageText: mockEditMessageText,
    deleteMessage: mockDeleteMessage,
    createForumTopic: mockCreateForumTopic,
    closeForumTopic: mockCloseForumTopic,
  };
  catch = vi.fn();
  start = mockStart;
  stop = mockStop;
}

class MockInlineKeyboard {
  private rows: Array<Array<{ text: string; callback_data: string }>> = [[]];
  text(label: string, data: string) {
    this.rows[this.rows.length - 1].push({ text: label, callback_data: data });
    return this;
  }
  row() {
    this.rows.push([]);
    return this;
  }
}

class MockInputFile {
  path: string;
  constructor(path: string) {
    this.path = path;
  }
}

vi.mock('grammy', () => ({
  Bot: MockBot,
  InlineKeyboard: MockInlineKeyboard,
  InputFile: MockInputFile,
}));

const mockExistsSync = vi.fn().mockReturnValue(false);
const mockStatSync = vi.fn().mockReturnValue({ size: 0 });
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    existsSync: (...args: any[]) => mockExistsSync(...args),
    statSync: (...args: any[]) => mockStatSync(...args),
  };
});

vi.mock('@raven/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof RavenShared>()),
  generateId: vi.fn(() => `test-id-${++generatedIds.value}`),
  SOURCE_TELEGRAM: 'telegram',
  PROJECT_TELEGRAM_DEFAULT: 'telegram-default',
  META_PROJECT_ID: 'meta',
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
vi.mock('node:fs/promises', () => ({
  mkdir: (...args: any[]) => mockMkdir(...args),
  writeFile: (...args: any[]) => mockWriteFile(...args),
}));

describe('telegram-bot service', () => {
  const originalEnv = { ...process.env };
  let service: any;
  let mockEventBus: any;
  let mockLogger: any;
  let eventHandlers: Record<string, Array<(event: any) => void>>;

  beforeEach(() => {
    process.env = { ...originalEnv };
    messageHandlers.length = 0;
    callbackHandlers.length = 0;
    voiceHandlers.length = 0;
    videoNoteHandlers.length = 0;
    photoHandlers.length = 0;
    documentHandlers.length = 0;
    // clearAllMocks preserves queued mock implementations such as
    // mockRejectedValueOnce, so a rejection from one test can leak into the
    // next provider call. Reset the mutable module mocks explicitly, then
    // restore their normal defaults below.
    for (const mock of [
      mockSendMessage,
      mockSendDocument,
      mockGetChat,
      mockEditMessageReplyMarkup,
      mockEditMessageText,
      mockDeleteMessage,
      mockCreateForumTopic,
      mockCloseForumTopic,
      mockStart,
      mockStop,
      mockExistsSync,
      mockStatSync,
      mockMkdir,
      mockWriteFile,
    ]) {
      mock.mockReset();
    }
    generatedIds.value = 0;
    mockSendMessage.mockResolvedValue({ message_id: 500 });
    mockSendDocument.mockResolvedValue({ message_id: 501 });
    mockGetChat.mockResolvedValue({});
    mockEditMessageReplyMarkup.mockResolvedValue({});
    mockEditMessageText.mockResolvedValue({});
    mockDeleteMessage.mockResolvedValue({});
    mockStart.mockReturnValue(new Promise(() => {}));
    mockStop.mockResolvedValue(undefined);
    mockExistsSync.mockReturnValue(false);
    mockStatSync.mockReturnValue({ size: 0 });
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockCreateForumTopic.mockResolvedValue({ message_thread_id: 42 });
    mockCloseForumTopic.mockResolvedValue(true);

    eventHandlers = {};
    mockEventBus = {
      emit: vi.fn(),
      on: vi.fn((type: string, handler: any) => {
        if (!eventHandlers[type]) eventHandlers[type] = [];
        eventHandlers[type].push(handler);
      }),
      off: vi.fn((type: string, handler: any) => {
        eventHandlers[type] = (eventHandlers[type] ?? []).filter((item) => item !== handler);
      }),
    };
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  async function loadService() {
    const mod = await import('../../../services/notifications/telegram-bot.ts');
    service = mod.default;
    return mod;
  }

  function createMockContext(overrides: Record<string, any> = {}) {
    return {
      from: { id: 123 },
      chat: { id: -1001234567890 },
      message: {
        text: 'Hello Raven',
        message_thread_id: undefined,
        ...overrides.message,
      },
      reply: vi.fn().mockResolvedValue({ message_id: 100 }),
      answerCallbackQuery: vi.fn().mockResolvedValue({}),
      ...overrides,
    };
  }

  async function createRealDb() {
    const { createTestDb } = await import('./helpers/test-db.ts');
    return createTestDb();
  }

  async function enqueueTelegramNotification(
    db: any,
    overrides: Record<string, any> = {},
  ): Promise<string> {
    const { enqueueNotification } =
      await import('../../../notification-engine/notification-queue.ts');
    return enqueueNotification(db, {
      source: 'test',
      title: 'Test',
      body: 'Body',
      channel: 'telegram',
      destination: { kind: 'global', topic: 'general' },
      urgencyTier: 'green',
      deliveryMode: 'tell-now',
      status: 'pending',
      dedupeKey: `telegram-test:${generatedIds.value}:${Math.random()}`,
      ...overrides,
    });
  }

  function deliverQueuedNotification(queueId: string, overrides: Record<string, any> = {}): void {
    const handler = eventHandlers['notification:deliver']?.[0];
    expect(handler).toBeDefined();
    handler({
      type: 'notification:deliver',
      payload: {
        queueId,
        channel: 'telegram',
        title: 'Test',
        body: 'Body',
        destination: { kind: 'global', topic: 'general' },
        ...overrides,
      },
    });
  }

  describe('direct mode (legacy)', () => {
    beforeEach(async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = '123';
      delete process.env.TELEGRAM_GROUP_ID;
      delete process.env.TELEGRAM_TOPIC_GENERAL;
      delete process.env.TELEGRAM_TOPIC_SYSTEM;
      delete process.env.TELEGRAM_TOPIC_MAP;
    });

    it('starts in direct mode when no TELEGRAM_GROUP_ID', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('direct mode'));
      expect(mockStart).toHaveBeenCalled();
    });

    it('emits user:chat:message without topic fields', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const ctx = createMockContext({
        from: { id: 123 },
        chat: { id: 123 },
      });
      await messageHandlers[0](ctx);

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'user:chat:message',
          source: 'telegram',
          payload: expect.objectContaining({
            projectId: 'telegram-default',
            message: 'Hello Raven',
          }),
        }),
      );
      // Should NOT have topicId or topicName
      const emittedPayload = mockEventBus.emit.mock.calls[0][0].payload;
      expect(emittedPayload.topicId).toBeUndefined();
      expect(emittedPayload.topicName).toBeUndefined();
    });

    it('persists a fresh private message before any Raven session exists', async () => {
      const { createTestDb } = await import('./helpers/test-db.ts');
      const db = createTestDb();
      db.run(
        `INSERT INTO projects (id, name, skills, fs_path, created_at, updated_at)
         VALUES ('telegram-default', 'Inbox / Today', '[]', 'telegram-default', 1, 1)`,
      );
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });
      const ctx = createMockContext({
        from: { id: 123 },
        chat: { id: 123 },
        message: { text: 'First private message', message_id: 701 },
      });

      await expect(messageHandlers[0](ctx)).resolves.not.toThrow();

      expect(
        db.get<any>(
          `SELECT project_id, session_id, request_id, direction
           FROM telegram_message_bindings WHERE chat_id = '123' AND message_id = 701`,
        ),
      ).toMatchObject({
        project_id: 'telegram-default',
        session_id: null,
        request_id: expect.any(String),
        direction: 'incoming',
      });
      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'user:chat:message' }),
      );
    });

    it('rejects messages from unauthorized chat', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const ctx = createMockContext({
        from: { id: 999 },
        chat: { id: 999 },
      });
      await messageHandlers[0](ctx);

      expect(mockEventBus.emit).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('unauthorized'));
    });

    it('sendMessage without messageThreadId in direct mode', async () => {
      const db = await createRealDb();
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });
      const queueId = await enqueueTelegramNotification(db);

      deliverQueuedNotification(queueId);

      // Wait for async sendMessage
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      // Should send to chatId without message_thread_id
      const callArgs = mockSendMessage.mock.calls[0];
      expect(callArgs[0]).toBe('123'); // chatId
      expect(callArgs[2]).not.toHaveProperty('message_thread_id');
    });
  });

  describe('group mode', () => {
    beforeEach(async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = '123';
      process.env.TELEGRAM_GROUP_ID = '-1001234567890';
      process.env.TELEGRAM_TOPIC_GENERAL = '1';
      process.env.TELEGRAM_TOPIC_SYSTEM = '42';
      process.env.TELEGRAM_TOPIC_MAP = '{"Work":5,"Personal":7}';
    });

    it('starts in group mode when TELEGRAM_GROUP_ID is set', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('group mode'));
      expect(mockGetChat).toHaveBeenCalledWith('-1001234567890');
    });

    it('routes the configured General topic to Inbox/Today', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const ctx = createMockContext({
        chat: { id: -1001234567890 },
        message: { text: 'Test in General', message_thread_id: 1 },
      });
      await messageHandlers[0](ctx);

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'user:chat:message',
          payload: expect.objectContaining({
            message: 'Test in General',
            topicId: 1,
            projectId: 'telegram-default',
          }),
        }),
      );
    });

    it('rejects an unknown topic with a working binding instruction', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const ctx = createMockContext({
        chat: { id: -1001234567890 },
        message: { text: 'Unknown topic', message_thread_id: 999 },
      });
      await messageHandlers[0](ctx);

      expect(mockEventBus.emit).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Run /project <project-id> here to bind it.'),
        { message_thread_id: 999 },
      );
    });

    it('handles messages without message_thread_id in group mode', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const ctx = createMockContext({
        chat: { id: -1001234567890 },
        message: { text: 'No topic', message_thread_id: undefined },
      });
      await messageHandlers[0](ctx);

      const payload = mockEventBus.emit.mock.calls[0][0].payload;
      expect(payload.topicId).toBeUndefined();
      expect(payload.topicName).toBeUndefined();
    });

    it('rejects messages from unauthorized group', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const ctx = createMockContext({
        chat: { id: -999 },
        message: { text: 'Bad group' },
      });
      await messageHandlers[0](ctx);

      expect(mockEventBus.emit).not.toHaveBeenCalled();
    });

    it('notification routes to an explicit System destination', async () => {
      const db = await createRealDb();
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });
      const destination = { kind: 'global', topic: 'system' } as const;
      const queueId = await enqueueTelegramNotification(db, {
        title: 'Alert',
        body: 'Content',
        destination,
      });

      deliverQueuedNotification(queueId, { title: 'Alert', body: 'Content', destination });

      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      const callArgs = mockSendMessage.mock.calls[0];
      expect(callArgs[0]).toBe('-1001234567890'); // groupId
      expect(callArgs[2]).toHaveProperty('message_thread_id', 42);
    });

    it('notification routes to an explicit General destination', async () => {
      const db = await createRealDb();
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });
      const destination = { kind: 'global', topic: 'general' } as const;
      const queueId = await enqueueTelegramNotification(db, {
        title: 'Alert',
        body: 'Content',
        destination,
      });

      deliverQueuedNotification(queueId, { title: 'Alert', body: 'Content', destination });

      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      const callArgs = mockSendMessage.mock.calls[0];
      expect(callArgs[2]).toHaveProperty('message_thread_id', 1); // General topic
    });

    it('system:health:alert always routes to System topic', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const handler = eventHandlers['system:health:alert']?.[0];
      expect(handler).toBeDefined();
      handler({
        payload: { severity: 'error', message: 'DB down', source: 'database' },
      });

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'notification',
          payload: expect.objectContaining({
            destination: { kind: 'global', topic: 'system' },
          }),
        }),
      );
    });

    it('does not publish a completion without an explicit Telegram origin', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const handler = eventHandlers['agent:task:complete']?.[0];
      handler({
        payload: { result: 'Done!', success: true },
        source: 'agent-manager',
        projectId: 'some-project',
      });
      await Promise.resolve();
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('does not spill a rejected topic delivery into General', async () => {
      const db = await createRealDb();
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });

      mockSendMessage.mockRejectedValueOnce(new Error('Thread not found'));
      const queueId = await enqueueTelegramNotification(db);

      deliverQueuedNotification(queueId);

      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalledTimes(1);
      });

      // First call: with message_thread_id
      expect(mockSendMessage.mock.calls[0][2]).toHaveProperty('message_thread_id', 1);
      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('failed'));
    });
  });

  describe('durable project delivery', () => {
    beforeEach(() => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = '123';
      process.env.TELEGRAM_GROUP_ID = '-1001234567890';
      process.env.TELEGRAM_TOPIC_GENERAL = '1';
      process.env.TELEGRAM_TOPIC_SYSTEM = '42';
    });

    async function createBoundProjectDb() {
      const { createTestDb } = await import('./helpers/test-db.ts');
      const { bindProjectTopic } = await import('../../../services/notifications/topic-store.ts');
      const db = createTestDb();
      db.run(
        `INSERT INTO projects (id, name, skills, fs_path, created_at, updated_at)
         VALUES (?, ?, '[]', ?, ?, ?)`,
        'project-id',
        'Project Display Name',
        'project-id',
        Date.now(),
        Date.now(),
      );
      bindProjectTopic(db, {
        groupId: '-1001234567890',
        topicId: 7,
        projectId: 'project-id',
      });
      return db;
    }

    async function enqueueProjectNotification(db: any, dedupeKey = 'delivery:test') {
      const { enqueueNotification } =
        await import('../../../notification-engine/notification-queue.ts');
      return enqueueNotification(db, {
        source: 'test',
        title: 'Project result',
        body: 'Completed',
        channel: 'telegram',
        destination: { kind: 'project', projectId: 'project-id' },
        urgencyTier: 'green',
        deliveryMode: 'tell-now',
        status: 'pending',
        dedupeKey,
      });
    }

    it('restores a stable project binding and carries exact Telegram origin', async () => {
      const db = await createBoundProjectDb();
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });
      const ctx = createMockContext({
        message: { text: 'Continue here', message_thread_id: 7, message_id: 88 },
      });

      await messageHandlers[0](ctx);

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'user:chat:message',
          projectId: 'project-id',
          payload: expect.objectContaining({
            projectId: 'project-id',
            transportOrigin: {
              transport: 'telegram',
              chatId: '-1001234567890',
              topicId: 7,
              messageId: 88,
            },
          }),
        }),
      );
      const persisted = db.get<any>(
        `SELECT project_id, session_id, request_id
         FROM telegram_message_bindings WHERE chat_id = ? AND message_id = ?`,
        '-1001234567890',
        88,
      );
      expect(persisted).toMatchObject({
        project_id: 'project-id',
        session_id: null,
        request_id: expect.any(String),
      });
    });

    it('deduplicates /new and accepts only this bot username suffix', async () => {
      const db = await createBoundProjectDb();
      const createAdditionalSession = vi
        .fn()
        .mockReturnValueOnce({ id: 'session-one' })
        .mockReturnValueOnce({ id: 'session-two' });
      await loadService();
      await service.start({
        eventBus: mockEventBus,
        logger: mockLogger,
        db,
        config: {
          sessionManager: { createAdditionalSession },
          projectRegistry: {
            listProjects: () => [
              { id: 'project-id', name: 'Project Display Name', metadata: { id: 'project-id' } },
            ],
          },
        },
      });
      const ownCommand = createMockContext({
        me: { username: 'RavenBot' },
        message: { text: '/new@RavenBot', message_thread_id: 7, message_id: 901 },
      });

      await messageHandlers[0](ownCommand);
      await messageHandlers[0](ownCommand);
      const otherBot = createMockContext({
        me: { username: 'RavenBot' },
        message: { text: '/new@OtherBot', message_thread_id: 7, message_id: 902 },
      });
      await messageHandlers[0](otherBot);

      expect(createAdditionalSession).toHaveBeenCalledTimes(1);
      expect(otherBot.reply).not.toHaveBeenCalled();
      expect(
        db.get<any>(
          `SELECT session_id FROM telegram_message_bindings
           WHERE chat_id = '-1001234567890' AND message_id = 901`,
        ),
      ).toEqual({ session_id: 'session-one' });
    });

    it('claims a queued delivery once and records Telegram acceptance', async () => {
      const db = await createBoundProjectDb();
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });
      const queueId = await enqueueProjectNotification(db);
      const event = {
        payload: {
          queueId,
          channel: 'telegram',
          title: 'Project result',
          body: 'Completed',
          destination: { kind: 'project', projectId: 'project-id' },
        },
      };

      eventHandlers['notification:deliver'][0](event);
      eventHandlers['notification:deliver'][0](event);

      await vi.waitFor(() => {
        expect(
          db.get<any>(
            'SELECT status, last_error AS lastError FROM notification_queue WHERE id = ?',
            queueId,
          ),
        ).toEqual({ status: 'delivered', lastError: null });
      });
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage.mock.calls[0][2]).toHaveProperty('message_thread_id', 7);
      expect(
        db.get<any>('SELECT attempt_count FROM notification_queue WHERE id = ?', queueId),
      ).toEqual({ attempt_count: 1 });
      expect(
        db.get<any>(
          'SELECT outcome, provider_message_id FROM notification_delivery_attempts WHERE notification_id = ?',
          queueId,
        ),
      ).toEqual({ outcome: 'accepted', provider_message_id: '500' });
    });

    it('records formatting fallback failure without marking delivery complete', async () => {
      const db = await createBoundProjectDb();
      mockSendMessage.mockRejectedValue(new Error("Bad Request: can't parse entities"));
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });
      const queueId = await enqueueProjectNotification(db, 'delivery:format-failure');

      eventHandlers['notification:deliver'][0]({
        payload: {
          queueId,
          channel: 'telegram',
          title: 'Project result',
          body: 'Completed',
          destination: { kind: 'project', projectId: 'project-id' },
        },
      });

      await vi.waitFor(() => {
        expect(db.get<any>('SELECT status FROM notification_queue WHERE id = ?', queueId)).toEqual({
          status: 'failed',
        });
      });
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      expect(
        db.get<any>('SELECT attempt_count FROM notification_queue WHERE id = ?', queueId),
      ).toEqual({ attempt_count: 2 });
    });

    it('records a network timeout as unknown and does not retry it', async () => {
      const db = await createBoundProjectDb();
      mockSendMessage.mockRejectedValue(new Error('network timeout'));
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });
      const queueId = await enqueueProjectNotification(db, 'delivery:unknown');

      eventHandlers['notification:deliver'][0]({
        payload: {
          queueId,
          channel: 'telegram',
          title: 'Project result',
          body: 'Completed',
          destination: { kind: 'project', projectId: 'project-id' },
        },
      });

      await vi.waitFor(() => {
        expect(db.get<any>('SELECT status FROM notification_queue WHERE id = ?', queueId)).toEqual({
          status: 'unknown',
        });
      });
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });

    it('drains an owned provider call before stop returns', async () => {
      const db = await createBoundProjectDb();
      let acceptSend!: (value: { message_id: number }) => void;
      mockSendMessage.mockReturnValueOnce(
        new Promise((resolve) => {
          acceptSend = resolve;
        }),
      );
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });
      const queueId = await enqueueProjectNotification(db, 'delivery:drain');
      eventHandlers['notification:deliver'][0]({
        payload: {
          queueId,
          channel: 'telegram',
          title: 'Project result',
          body: 'Completed',
          destination: { kind: 'project', projectId: 'project-id' },
        },
      });
      await vi.waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(1));

      let stopped = false;
      const stopping = service.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      acceptSend({ message_id: 777 });
      await stopping;

      expect(db.get<any>('SELECT status FROM notification_queue WHERE id = ?', queueId)).toEqual({
        status: 'delivered',
      });
    });
  });

  describe('Telegram session model commands', () => {
    const freshCatalog = {
      models: [
        {
          id: 'claude-sonnet-5',
          aliases: ['sonnet'],
          displayName: 'Sonnet 5',
          description: 'Fixture model',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high'],
          supportsAdaptiveThinking: true,
        },
      ],
      fetchedAt: '2026-09-06T00:00:00.000Z',
      revision: 1,
      stale: false,
      error: null,
    };

    beforeEach(() => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = '123';
      process.env.TELEGRAM_GROUP_ID = '-1001234567890';
      process.env.TELEGRAM_TOPIC_GENERAL = '1';
      process.env.TELEGRAM_TOPIC_SYSTEM = '42';
      delete process.env.TELEGRAM_TOPIC_MAP;
    });

    async function createModelCommandDb(sessionId: string | null = 'session-current') {
      const db = await createRealDb();
      const { bindProjectTopic } = await import('../../../services/notifications/topic-store.ts');
      const { saveTelegramConversation } =
        await import('../../../services/notifications/telegram-conversation-store.ts');
      for (const [id, name] of [
        ['project-id', 'Project One'],
        ['project-two', 'Project Two'],
      ]) {
        db.run(
          `INSERT INTO projects (id, name, skills, fs_path, created_at, updated_at)
           VALUES (?, ?, '[]', ?, 1, 1)`,
          id,
          name,
          id,
        );
      }
      bindProjectTopic(db, {
        groupId: '-1001234567890',
        topicId: 7,
        projectId: 'project-id',
      });
      saveTelegramConversation(db, {
        chatId: '-1001234567890',
        topicId: 7,
        projectId: 'project-id',
        sessionId: sessionId ?? undefined,
      });
      return db;
    }

    function createModelCommandDeps() {
      const sessions = new Map<string, any>([
        ['session-current', { id: 'session-current', projectId: 'project-id', status: 'idle' }],
        ['session-old', { id: 'session-old', projectId: 'project-id', status: 'idle' }],
      ]);
      let newSessionCount = 0;
      const getSession = vi.fn((id: string) => sessions.get(id));
      const updateSession = vi.fn((id: string, updates: Record<string, any>) => {
        const session = sessions.get(id);
        if (!session) return;
        sessions.set(id, {
          ...session,
          modelConfig: updates.modelConfig ?? undefined,
        });
      });
      const createAdditionalSession = vi.fn((projectId: string) => {
        const id = `session-new-${++newSessionCount}`;
        const session = { id, projectId, status: 'idle' };
        sessions.set(id, session);
        return session;
      });
      const getSnapshot = vi.fn(() => freshCatalog);
      const refresh = vi.fn().mockResolvedValue(freshCatalog);
      const resolveModel = vi.fn((input: Record<string, any>) => {
        const stored = input.sessionId ? sessions.get(input.sessionId)?.modelConfig : undefined;
        const selected = input.session === undefined ? stored : (input.session ?? undefined);
        return {
          model: 'claude-sonnet-5',
          effort: selected?.effort,
          thinking: selected?.thinking,
        };
      });
      return {
        sessions,
        getSession,
        updateSession,
        createAdditionalSession,
        modelCatalog: { getSnapshot, refresh },
        resolveModel,
      };
    }

    function modelProjectRegistry() {
      return {
        listProjects: () => [
          { id: 'project-id', name: 'Project One', metadata: { id: 'project-id' } },
          { id: 'project-two', name: 'Project Two', metadata: { id: 'project-two' } },
        ],
      };
    }

    async function startModelCommandService(
      db: any,
      deps: ReturnType<typeof createModelCommandDeps>,
    ) {
      await loadService();
      await service.start({
        eventBus: mockEventBus,
        logger: mockLogger,
        db,
        config: {
          sessionManager: {
            getSession: deps.getSession,
            updateSession: deps.updateSession,
            createAdditionalSession: deps.createAdditionalSession,
          },
          modelCatalog: deps.modelCatalog,
          resolveModel: deps.resolveModel,
          projectRegistry: modelProjectRegistry(),
        },
      });
    }

    function modelContext(text: string, messageId: number, overrides: Record<string, any> = {}) {
      return createMockContext({
        me: { username: 'RavenBot' },
        message: { text, message_thread_id: 7, message_id: messageId, ...overrides },
      });
    }

    it('shows effective choices, then sets and resets the selected session override', async () => {
      const db = await createModelCommandDb();
      const deps = createModelCommandDeps();
      await startModelCommandService(db, deps);

      const show = modelContext('/model', 2001);
      await messageHandlers[0](show);
      expect(show.reply).toHaveBeenCalledWith(
        expect.stringContaining('Effective model: claude-sonnet-5'),
        { message_thread_id: 7 },
      );
      expect(show.reply).toHaveBeenCalledWith(expect.stringContaining('Sonnet 5'), {
        message_thread_id: 7,
      });

      await messageHandlers[0](modelContext('/model sonnet high adaptive', 2002));
      expect(deps.resolveModel).toHaveBeenCalledWith({
        projectId: 'project-id',
        sessionId: 'session-current',
        session: { model: 'sonnet', effort: 'high', thinking: 'adaptive' },
      });
      expect(deps.updateSession).toHaveBeenCalledWith('session-current', {
        modelConfig: { model: 'sonnet', effort: 'high', thinking: 'adaptive' },
      });

      await messageHandlers[0](modelContext('/model default', 2003));
      expect(deps.updateSession).toHaveBeenLastCalledWith('session-current', {
        modelConfig: null,
      });
      expect(deps.modelCatalog.refresh).not.toHaveBeenCalled();
    });

    it('does not refresh or mutate when no Raven session is selected', async () => {
      const db = await createModelCommandDb(null);
      const deps = createModelCommandDeps();
      deps.modelCatalog.getSnapshot.mockReturnValue({ ...freshCatalog, stale: true });
      await startModelCommandService(db, deps);

      const ctx = modelContext('/model sonnet high', 2010);
      await messageHandlers[0](ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('No Raven session'), {
        message_thread_id: 7,
      });
      expect(deps.modelCatalog.refresh).not.toHaveBeenCalled();
      expect(deps.resolveModel).not.toHaveBeenCalled();
      expect(deps.updateSession).not.toHaveBeenCalled();
    });

    it('reports metadata validation rejection without mutating the session', async () => {
      const db = await createModelCommandDb();
      const deps = createModelCommandDeps();
      deps.resolveModel.mockImplementation(() => {
        throw new Error('Model does not support effort "max"');
      });
      await startModelCommandService(db, deps);

      const ctx = modelContext('/model sonnet max', 2020);
      await messageHandlers[0](ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('Model setting rejected: Error: Model does not support effort'),
        { message_thread_id: 7 },
      );
      expect(deps.updateSession).not.toHaveBeenCalled();
    });

    it.each([
      ['/new', 2031],
      ['/project project-two', 2032],
    ])('does not mutate a stale session after delayed discovery and %s', async (change, id) => {
      const db = await createModelCommandDb();
      const deps = createModelCommandDeps();
      let finishRefresh!: (snapshot: typeof freshCatalog) => void;
      deps.modelCatalog.getSnapshot.mockReturnValue({ ...freshCatalog, stale: true });
      deps.modelCatalog.refresh.mockReturnValue(
        new Promise((resolve) => {
          finishRefresh = resolve;
        }),
      );
      await startModelCommandService(db, deps);
      const model = modelContext('/model sonnet high', 2030);

      const pendingModel = messageHandlers[0](model);
      await vi.waitFor(() => expect(deps.modelCatalog.refresh).toHaveBeenCalledTimes(1));
      await messageHandlers[0](modelContext(change, id));
      finishRefresh(freshCatalog);
      await pendingModel;

      expect(deps.updateSession).not.toHaveBeenCalled();
      expect(model.reply).toHaveBeenCalledWith(expect.stringContaining('conversation changed'), {
        message_thread_id: 7,
      });
    });

    it('updates an older session selected through an outgoing reply binding', async () => {
      const db = await createModelCommandDb();
      const { saveTelegramMessageBinding } =
        await import('../../../services/notifications/telegram-conversation-store.ts');
      saveTelegramMessageBinding(db, {
        chatId: '-1001234567890',
        messageId: 777,
        topicId: 7,
        projectId: 'project-id',
        sessionId: 'session-old',
        direction: 'outgoing',
      });
      const deps = createModelCommandDeps();
      await startModelCommandService(db, deps);

      await messageHandlers[0](
        modelContext('/model sonnet medium', 2040, { reply_to_message: { message_id: 777 } }),
      );

      expect(deps.resolveModel).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'project-id', sessionId: 'session-old' }),
      );
      expect(deps.updateSession).toHaveBeenCalledWith('session-old', {
        modelConfig: { model: 'sonnet', effort: 'medium' },
      });
    });

    it('accepts its own bot suffix and ignores another bot suffix', async () => {
      const db = await createModelCommandDb();
      const deps = createModelCommandDeps();
      await startModelCommandService(db, deps);
      const own = modelContext('/model@RavenBot sonnet high', 2050);
      const other = modelContext('/model@OtherBot sonnet low', 2051);

      await messageHandlers[0](own);
      await messageHandlers[0](other);

      expect(deps.updateSession).toHaveBeenCalledTimes(1);
      expect(own.reply).toHaveBeenCalled();
      expect(other.reply).not.toHaveBeenCalled();
    });
  });

  describe('T0/T1 review regressions', () => {
    beforeEach(() => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = '123';
      process.env.TELEGRAM_GROUP_ID = '-1001234567890';
      process.env.TELEGRAM_TOPIC_GENERAL = '1';
      process.env.TELEGRAM_TOPIC_SYSTEM = '42';
      delete process.env.TELEGRAM_TOPIC_MAP;
    });

    async function createProjectDb() {
      const db = await createRealDb();
      const { bindProjectTopic } = await import('../../../services/notifications/topic-store.ts');
      for (const [id, name] of [
        ['project-id', 'Project One'],
        ['project-two', 'Project Two'],
      ]) {
        db.run(
          `INSERT INTO projects (id, name, skills, fs_path, created_at, updated_at)
           VALUES (?, ?, '[]', ?, 1, 1)`,
          id,
          name,
          id,
        );
      }
      bindProjectTopic(db, {
        groupId: '-1001234567890',
        topicId: 7,
        projectId: 'project-id',
      });
      return db;
    }

    function projectRegistry() {
      return {
        listProjects: () => [
          { id: 'project-id', name: 'Project One', metadata: { id: 'project-id' } },
          { id: 'project-two', name: 'Project Two', metadata: { id: 'project-two' } },
        ],
      };
    }

    it('B2 keeps a newer /new session when delayed acceptance arrives', async () => {
      const db = await createProjectDb();
      const createAdditionalSession = vi.fn().mockReturnValue({ id: 'new-session' });
      await loadService();
      await service.start({
        eventBus: mockEventBus,
        logger: mockLogger,
        db,
        config: { sessionManager: { createAdditionalSession }, projectRegistry: projectRegistry() },
      });

      await messageHandlers[0](
        createMockContext({
          message: { text: 'Start slow work', message_thread_id: 7, message_id: 1001 },
        }),
      );
      const admitted = mockEventBus.emit.mock.calls.find(
        (call: any[]) => call[0].type === 'user:chat:message',
      )?.[0];
      expect(admitted?.payload.requestId).toEqual(expect.any(String));

      await messageHandlers[0](
        createMockContext({
          message: { text: '/new', message_thread_id: 7, message_id: 1002 },
        }),
      );
      eventHandlers['user:chat:accepted'][0]({
        projectId: 'project-id',
        payload: {
          requestId: admitted.payload.requestId,
          projectId: 'project-id',
          sessionId: 'slow-session',
          messageId: 'accepted-message',
        },
      });

      expect(
        db.get<any>(
          `SELECT project_id, session_id FROM telegram_conversations
           WHERE chat_id = '-1001234567890' AND topic_id = 7`,
        ),
      ).toEqual({ project_id: 'project-id', session_id: 'new-session' });
      expect(
        db.get<any>(
          `SELECT session_id FROM telegram_message_bindings
           WHERE chat_id = '-1001234567890' AND message_id = 1001`,
        ),
      ).toEqual({ session_id: 'slow-session' });
    });

    it('B3 rejects a late completion after topic rebind and clears its status', async () => {
      const db = await createProjectDb();
      await loadService();
      await service.start({
        eventBus: mockEventBus,
        logger: mockLogger,
        db,
        config: { projectRegistry: projectRegistry() },
      });
      const original = createMockContext({
        message: { text: 'Work here', message_thread_id: 7, message_id: 1101 },
        reply: vi.fn().mockResolvedValue({ message_id: 701 }),
      });
      await messageHandlers[0](original);

      await messageHandlers[0](
        createMockContext({
          message: { text: '/project project-two', message_thread_id: 7, message_id: 1102 },
        }),
      );
      eventHandlers['agent:task:complete'][0]({
        projectId: 'project-id',
        payload: {
          taskId: 'late-task',
          sessionId: 'old-session',
          agentName: 'Raven',
          result: 'Private result',
          durationMs: 10,
          success: true,
          transportOrigin: {
            transport: 'telegram',
            chatId: '-1001234567890',
            topicId: 7,
            messageId: 1101,
          },
        },
      });

      await vi.waitFor(() => {
        expect(
          db.get<any>(
            `SELECT status, last_error FROM notification_queue
             WHERE source = 'telegram-chat-result'`,
          ),
        ).toEqual({
          status: 'failed',
          last_error: 'Telegram reply topic is no longer bound to the originating project',
        });
      });
      expect(mockDeleteMessage).toHaveBeenCalledWith('-1001234567890', 701, expect.anything());
      expect(mockSendMessage).not.toHaveBeenCalled();

      eventHandlers['agent:message'][0]({
        payload: {
          taskId: 'late-task',
          messageType: 'tool_use',
          content: 'Read: stale',
          transportOrigin: {
            transport: 'telegram',
            chatId: '-1001234567890',
            topicId: 7,
            messageId: 1101,
          },
        },
      });
      await Promise.resolve();
      expect(mockEditMessageText).not.toHaveBeenCalled();
    });

    it('B5 recovers an unattempted notification with its exact reply origin and session', async () => {
      const db = await createProjectDb();
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });
      await service.stop();
      const destination = { kind: 'project', projectId: 'project-id' } as const;
      await enqueueTelegramNotification(db, {
        title: 'Recovered result',
        body: 'Still addressed correctly',
        destination,
        transportOrigin: {
          transport: 'telegram',
          chatId: '-1001234567890',
          topicId: 7,
          messageId: 1201,
        },
        sessionId: 'origin-session',
        taskId: 'origin-task',
      });

      mockSendMessage.mockClear();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });

      await vi.waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(1));
      expect(mockSendMessage.mock.calls[0][2]).toMatchObject({
        message_thread_id: 7,
        reply_parameters: { message_id: 1201 },
      });
      await vi.waitFor(() => {
        expect(
          db.get<any>(
            `SELECT project_id, session_id, task_id, direction
             FROM telegram_message_bindings
             WHERE chat_id = '-1001234567890' AND message_id = 500`,
          ),
        ).toEqual({
          project_id: 'project-id',
          session_id: 'origin-session',
          task_id: 'origin-task',
          direction: 'outgoing',
        });
      });
    });

    it('B6 never re-sends after provider acceptance when evidence finalization fails', async () => {
      const realDb = await createProjectDb();
      let failEvidenceWrite = false;
      const db = {
        ...realDb,
        run: (sql: string, ...params: unknown[]) => {
          if (
            failEvidenceWrite &&
            sql.includes('UPDATE notification_delivery_attempts') &&
            sql.includes('SET outcome = ?')
          ) {
            failEvidenceWrite = false;
            throw new Error('simulated evidence recorder failure');
          }
          realDb.run(sql, ...params);
        },
      };
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });
      const destination = { kind: 'project', projectId: 'project-id' } as const;
      const queueId = await enqueueTelegramNotification(db, { destination });
      failEvidenceWrite = true;

      deliverQueuedNotification(queueId, { destination });

      await vi.waitFor(() => {
        expect(db.get<any>('SELECT status FROM notification_queue WHERE id = ?', queueId)).toEqual({
          status: 'delivered',
        });
      });
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('evidence could not be finalized'),
      );
      expect(mockSendMessage).toHaveBeenCalledTimes(1);

      await service.stop();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });
      await Promise.resolve();
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });

    it('B7 releases a known predispatch failure so the same input can be redelivered', async () => {
      const realDb = await createProjectDb();
      let failRegistration = true;
      const db = {
        ...realDb,
        run: (sql: string, ...params: unknown[]) => {
          if (failRegistration && sql.includes('INSERT OR IGNORE INTO telegram_conversations')) {
            failRegistration = false;
            throw new Error('simulated predispatch persistence failure');
          }
          realDb.run(sql, ...params);
        },
      };
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });
      const ctx = createMockContext({
        message: { text: 'Retry me', message_thread_id: 7, message_id: 1301 },
      });

      await expect(messageHandlers[0](ctx)).rejects.toThrow('predispatch persistence failure');
      await expect(messageHandlers[0](ctx)).resolves.not.toThrow();

      expect(
        mockEventBus.emit.mock.calls.filter((call: any[]) => call[0].type === 'user:chat:message'),
      ).toHaveLength(1);
      expect(
        db.get<any>(
          `SELECT direction FROM telegram_message_bindings
           WHERE chat_id = '-1001234567890' AND message_id = 1301`,
        ),
      ).toEqual({ direction: 'incoming' });
    });

    it('B7 does not replay an input whose prior dispatch outcome is unknown after restart', async () => {
      const db = await createProjectDb();
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });
      const ctx = createMockContext({
        message: { text: 'Potential duplicate', message_thread_id: 7, message_id: 1302 },
      });
      await messageHandlers[0](ctx);
      expect(
        mockEventBus.emit.mock.calls.filter((call: any[]) => call[0].type === 'user:chat:message'),
      ).toHaveLength(1);

      await service.stop();
      mockEventBus.emit.mockClear();
      ctx.reply.mockClear();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });
      await messageHandlers.at(-1)!(ctx);

      expect(mockEventBus.emit).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('prior processing outcome is unknown'),
        { message_thread_id: 7 },
      );
    });

    it('B8 releases completed in-memory reservations without test-only inspection hooks', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      for (let messageId = 1400; messageId < 1500; messageId++) {
        await messageHandlers[0](
          createMockContext({
            message: { text: `Message ${messageId}`, message_thread_id: 1, message_id: messageId },
          }),
        );
      }
      await messageHandlers[0](
        createMockContext({
          message: { text: 'Reuse released key', message_thread_id: 1, message_id: 1400 },
        }),
      );

      expect(
        mockEventBus.emit.mock.calls.filter((call: any[]) => call[0].type === 'user:chat:message'),
      ).toHaveLength(101);
    });

    it('B10 records a partial outcome when an attachment disappears after text acceptance', async () => {
      const db = await createProjectDb();
      mockExistsSync.mockReturnValue(true);
      mockStatSync.mockImplementation(() => {
        throw new Error('ENOENT during stat');
      });
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });
      const destination = { kind: 'project', projectId: 'project-id' } as const;
      const queueId = await enqueueTelegramNotification(db, {
        destination,
        filePath: '/data/files/disappearing.pdf',
      });

      deliverQueuedNotification(queueId, {
        destination,
        filePath: '/data/files/disappearing.pdf',
      });

      await vi.waitFor(() => {
        expect(
          db.get<any>(
            'SELECT status, attempt_count, last_error FROM notification_queue WHERE id = ?',
            queueId,
          ),
        ).toEqual({
          status: 'partial',
          attempt_count: 1,
          last_error: 'Attachment file could not be read: Error: ENOENT during stat',
        });
      });
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendDocument).not.toHaveBeenCalled();
    });

    it.each([
      ['an AbortError', new DOMException('The operation was aborted', 'AbortError')],
      ['a generic fetch failure', new TypeError('fetch failed')],
    ])('B13 keeps %s uncertain and does not retry it', async (_label, providerError) => {
      const db = await createProjectDb();
      mockSendMessage.mockRejectedValue(providerError);
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });
      const destination = { kind: 'project', projectId: 'project-id' } as const;
      const queueId = await enqueueTelegramNotification(db, { destination });

      deliverQueuedNotification(queueId, { destination });

      await vi.waitFor(() => {
        expect(db.get<any>('SELECT status FROM notification_queue WHERE id = ?', queueId)).toEqual({
          status: 'unknown',
        });
      });
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(
        db.get<any>(
          `SELECT outcome FROM notification_delivery_attempts WHERE notification_id = ?`,
          queueId,
        ),
      ).toEqual({ outcome: 'unknown' });

      await service.stop();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });
      await Promise.resolve();
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['General', 1, 'telegram-default', 'general-session'],
      ['System', 42, 'meta', 'system-session'],
    ])(
      'E1 resumes an older %s reply through its reserved project and session',
      async (_name, topicId, projectId, sessionId) => {
        const db = await createProjectDb();
        const { saveTelegramMessageBinding } =
          await import('../../../services/notifications/telegram-conversation-store.ts');
        saveTelegramMessageBinding(db, {
          chatId: '-1001234567890',
          messageId: 1600 + topicId,
          topicId,
          projectId,
          sessionId,
          direction: 'outgoing',
        });
        await loadService();
        await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });

        await messageHandlers[0](
          createMockContext({
            message: {
              text: 'Continue the older answer',
              message_thread_id: topicId,
              message_id: 1700 + topicId,
              reply_to_message: { message_id: 1600 + topicId },
            },
          }),
        );

        expect(mockEventBus.emit).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'user:chat:message',
            projectId,
            payload: expect.objectContaining({ projectId, sessionId }),
          }),
        );
      },
    );

    it('E10 restores an accepted reply binding after restart without re-sending', async () => {
      const db = await createProjectDb();
      const { beginDeliveryAttempt, claimNotificationDelivery, finishDeliveryAttempt } =
        await import('../../../notification-engine/notification-queue.ts');
      const destination = { kind: 'project', projectId: 'project-id' } as const;
      const queueId = await enqueueTelegramNotification(db, {
        title: 'Accepted before crash',
        body: 'Restore this reply association',
        destination,
        transportOrigin: {
          transport: 'telegram',
          chatId: '-1001234567890',
          topicId: 7,
          messageId: 2101,
        },
        sessionId: 'recovered-session',
        taskId: 'recovered-task',
      });
      const claimId = claimNotificationDelivery(db, queueId);
      expect(claimId).toEqual(expect.any(String));
      const attempt = beginDeliveryAttempt(db, {
        notificationId: queueId,
        claimId: claimId!,
        channel: 'telegram',
        part: 'text',
        chatId: '-1001234567890',
        topicId: 7,
      });
      finishDeliveryAttempt(db, attempt.id, {
        outcome: 'accepted',
        providerMessageId: '2500',
      });
      expect(
        db.get<any>(
          `SELECT 1 AS found FROM telegram_message_bindings
           WHERE chat_id = '-1001234567890' AND message_id = 2500`,
        ),
      ).toBeUndefined();

      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });

      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(
        db.get<any>(
          `SELECT project_id, session_id, task_id, direction
           FROM telegram_message_bindings
           WHERE chat_id = '-1001234567890' AND message_id = 2500`,
        ),
      ).toEqual({
        project_id: 'project-id',
        session_id: 'recovered-session',
        task_id: 'recovered-task',
        direction: 'outgoing',
      });

      await messageHandlers[0](
        createMockContext({
          message: {
            text: 'Continue the recovered answer',
            message_thread_id: 7,
            message_id: 2501,
            reply_to_message: { message_id: 2500 },
          },
        }),
      );

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'user:chat:message',
          projectId: 'project-id',
          payload: expect.objectContaining({
            projectId: 'project-id',
            sessionId: 'recovered-session',
            transportOrigin: expect.objectContaining({
              replyToMessageId: 2500,
              messageId: 2501,
            }),
          }),
        }),
      );
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('E2 routes an Inbox project notification through General without creating a project topic', async () => {
      const db = await createProjectDb();
      const mod = await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });
      const destination = { kind: 'project', projectId: 'telegram-default' } as const;
      const queueId = await enqueueTelegramNotification(db, { destination });

      deliverQueuedNotification(queueId, { destination });

      await vi.waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(1));
      expect(mockSendMessage.mock.calls[0][2]).toHaveProperty('message_thread_id', 1);
      expect(await mod.ensureProjectTopic('telegram-default', 'Inbox / Today')).toBe(1);
      expect(mockCreateForumTopic).not.toHaveBeenCalled();
      expect(
        db.get<any>(
          `SELECT COUNT(*) AS count FROM telegram_topics WHERE project_id = 'telegram-default'`,
        ),
      ).toEqual({ count: 0 });
    });

    it('keeps the reserved System project available for a new conversation', async () => {
      const db = await createProjectDb();
      const createAdditionalSession = vi.fn().mockReturnValue({ id: 'system-session' });
      await loadService();
      await service.start({
        eventBus: mockEventBus,
        logger: mockLogger,
        db,
        config: {
          sessionManager: { createAdditionalSession },
          projectRegistry: {
            listProjects: () => [
              { id: 'meta', name: 'System', isMeta: true, metadata: { id: 'meta' } },
            ],
          },
        },
      });
      const ctx = createMockContext({
        message: { text: '/new', message_thread_id: 42, message_id: 1750 },
      });

      await messageHandlers[0](ctx);

      expect(createAdditionalSession).toHaveBeenCalledWith('meta');
      expect(
        db.get<any>(
          `SELECT project_id, session_id FROM telegram_conversations
           WHERE chat_id = '-1001234567890' AND topic_id = 42`,
        ),
      ).toEqual({ project_id: 'meta', session_id: 'system-session' });
    });

    it('routes a reserved System project notification without a stored project-topic row', async () => {
      const db = await createProjectDb();
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });
      const destination = { kind: 'project', projectId: 'meta' } as const;
      const queueId = await enqueueTelegramNotification(db, { destination });

      deliverQueuedNotification(queueId, { destination });

      await vi.waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(1));
      expect(mockSendMessage.mock.calls[0][2]).toHaveProperty('message_thread_id', 42);
      expect(
        db.get<any>(`SELECT COUNT(*) AS count FROM telegram_topics WHERE project_id = 'meta'`),
      ).toEqual({ count: 0 });
    });

    it('E3 dispatches chat even when the processing acknowledgement is rejected', async () => {
      const db = await createProjectDb();
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });
      const ctx = createMockContext({
        message: { text: 'Dispatch anyway', message_thread_id: 7, message_id: 1801 },
        reply: vi.fn().mockRejectedValue(new Error('ack rejected')),
      });

      await expect(messageHandlers[0](ctx)).resolves.not.toThrow();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('processing acknowledgement failed'),
      );
      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'user:chat:message',
          payload: expect.objectContaining({ projectId: 'project-id' }),
        }),
      );
    });

    it('E5 bounds a failing stop and ignores provider completion after a new runtime starts', async () => {
      const realOldDb = await createProjectDb();
      let oldDbDisposed = false;
      let writesAfterDispose = 0;
      const oldDb = {
        ...realOldDb,
        run: (sql: string, ...params: unknown[]) => {
          if (oldDbDisposed) writesAfterDispose++;
          realOldDb.run(sql, ...params);
        },
      };
      let finishProvider!: (value: { message_id: number }) => void;
      mockSendMessage.mockReturnValueOnce(
        new Promise((resolve) => {
          finishProvider = resolve;
        }),
      );
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: oldDb, config: {} });
      const destination = { kind: 'project', projectId: 'project-id' } as const;
      const queueId = await enqueueTelegramNotification(oldDb, { destination });
      deliverQueuedNotification(queueId, { destination });
      await vi.waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(1));

      mockStop.mockRejectedValueOnce(new Error('polling stop failed'));
      vi.useFakeTimers();
      try {
        const stopping = service.stop();
        await vi.advanceTimersByTimeAsync(5_001);
        await stopping;
      } finally {
        vi.useRealTimers();
      }
      oldDbDisposed = true;

      const newDb = await createProjectDb();
      const newHandlers: Record<string, Array<(event: any) => void>> = {};
      const newBus = {
        emit: vi.fn(),
        on: vi.fn((type: string, handler: any) => {
          (newHandlers[type] ??= []).push(handler);
        }),
        off: vi.fn(),
      };
      await service.start({ eventBus: newBus, logger: mockLogger, db: newDb, config: {} });
      finishProvider({ message_id: 1901 });
      await Promise.resolve();
      await Promise.resolve();

      expect(writesAfterDispose).toBe(0);
      expect(newBus.emit).not.toHaveBeenCalled();
      expect(newDb.get<any>('SELECT COUNT(*) AS count FROM notification_queue')).toEqual({
        count: 0,
      });
      expect(
        realOldDb.get<any>('SELECT status FROM notification_queue WHERE id = ?', queueId),
      ).toEqual({ status: 'sending' });
    });
  });

  describe('file attachment sending', () => {
    beforeEach(async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = '123';
      process.env.TELEGRAM_GROUP_ID = '-1001234567890';
      process.env.TELEGRAM_TOPIC_GENERAL = '1';
      process.env.TELEGRAM_TOPIC_SYSTEM = '42';
      process.env.TELEGRAM_TOPIC_MAP = '{"Work":5}';
    });

    it('calls sendDocument when filePath is present and file exists within size limit', async () => {
      mockExistsSync.mockReturnValue(true);
      mockStatSync.mockReturnValue({ size: 1024 }); // 1KB — well under 50MB

      const db = await createRealDb();
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });
      const queueId = await enqueueTelegramNotification(db, {
        title: 'Report Ready',
        body: 'See attached file',
        filePath: '/data/files/report.pdf',
      });

      deliverQueuedNotification(queueId, {
        title: 'Report Ready',
        body: 'See attached file',
        filePath: '/data/files/report.pdf',
      });

      await vi.waitFor(() => {
        expect(mockSendDocument).toHaveBeenCalled();
      });

      const [chatArg, fileArg, optsArg] = mockSendDocument.mock.calls[0];
      expect(chatArg).toBe('-1001234567890');
      expect(fileArg).toBeInstanceOf(MockInputFile);
      expect((fileArg as MockInputFile).path).toBe('/data/files/report.pdf');
      expect(optsArg).toHaveProperty('message_thread_id', 1);
    });

    it('sends download link when filePath exceeds 50MB limit', async () => {
      mockExistsSync.mockReturnValue(true);
      mockStatSync.mockReturnValue({ size: 60 * 1024 * 1024 }); // 60MB — over limit

      const db = await createRealDb();
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });
      const queueId = await enqueueTelegramNotification(db, {
        title: 'Large File',
        body: 'File is ready',
        filePath: 'data/files/large-export.zip',
      });

      deliverQueuedNotification(queueId, {
        title: 'Large File',
        body: 'File is ready',
        filePath: 'data/files/large-export.zip',
      });

      await vi.waitFor(() => {
        // Text message + download link message = 2 calls to sendMessage
        expect(mockSendMessage).toHaveBeenCalledTimes(2);
      });

      expect(mockSendDocument).not.toHaveBeenCalled();
      const downloadCall = mockSendMessage.mock.calls[1];
      expect(downloadCall[1]).toContain('File too large for Telegram');
      expect(downloadCall[1]).toContain('/api/files/large-export.zip');
    });

    it('does not call sendDocument when filePath is absent', async () => {
      const db = await createRealDb();
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });
      const queueId = await enqueueTelegramNotification(db, {
        title: 'Plain',
        body: 'No file',
      });

      deliverQueuedNotification(queueId, { title: 'Plain', body: 'No file' });

      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      expect(mockSendDocument).not.toHaveBeenCalled();
    });
  });

  describe('parseTopicConfig', () => {
    it('does not treat display-name topic configuration as a project binding', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = '123';
      process.env.TELEGRAM_GROUP_ID = '-100';
      process.env.TELEGRAM_TOPIC_GENERAL = '1';
      process.env.TELEGRAM_TOPIC_SYSTEM = '42';
      process.env.TELEGRAM_TOPIC_MAP = '{"Work":5,"Personal":7}';

      await loadService();
      // Need to call start to initialize logger before parseTopicConfig
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const ctx = createMockContext({
        chat: { id: -100 },
        message: { text: 'Hi', message_thread_id: 5 },
      });
      await messageHandlers[0](ctx);

      expect(mockEventBus.emit).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('/project <project-id>'), {
        message_thread_id: 5,
      });
    });

    it('handles malformed TELEGRAM_TOPIC_MAP JSON gracefully', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = '123';
      process.env.TELEGRAM_GROUP_ID = '-100';
      process.env.TELEGRAM_TOPIC_MAP = 'not-valid-json';

      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'));
    });

    it('handles empty TELEGRAM_TOPIC_MAP', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = '123';
      process.env.TELEGRAM_GROUP_ID = '-100';
      delete process.env.TELEGRAM_TOPIC_MAP;

      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('group mode'));
    });
  });

  describe('getTopicThreadId', () => {
    it('resolves known topic names', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = '123';
      process.env.TELEGRAM_GROUP_ID = '-100';
      process.env.TELEGRAM_TOPIC_GENERAL = '1';
      process.env.TELEGRAM_TOPIC_SYSTEM = '42';
      process.env.TELEGRAM_TOPIC_MAP = '{"Work":5}';

      const mod = await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      expect(mod.getTopicThreadId('General')).toBe(1);
      expect(mod.getTopicThreadId('System')).toBe(42);
      expect(mod.getTopicThreadId('Work')).toBe(5);
      expect(mod.getTopicThreadId('Unknown')).toBeUndefined();
    });
  });

  describe('bot disabled', () => {
    it('does nothing when credentials missing', async () => {
      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.TELEGRAM_CHAT_ID;

      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('not configured'));
      expect(mockStart).not.toHaveBeenCalled();
    });
  });

  describe('group membership validation', () => {
    it('logs error when bot cannot verify group membership', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = '123';
      process.env.TELEGRAM_GROUP_ID = '-100';

      mockGetChat.mockRejectedValueOnce(new Error('Forbidden'));

      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('may not be a member'));
    });
  });

  describe('stop() cleanup', () => {
    it('stops the bot and clears state', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = '123';
      process.env.TELEGRAM_GROUP_ID = '-1001234567890';
      process.env.TELEGRAM_TOPIC_MAP = '{"Work":5}';

      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      // Simulate incoming message to populate projectTopicMap
      const ctx = createMockContext({
        chat: { id: -1001234567890 },
        message: { text: 'Hello', message_thread_id: 5 },
      });
      await messageHandlers[0](ctx);

      await service.stop();

      expect(mockStop).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith('Telegram bot stopped');
    });
  });

  describe('callback_query authorization', () => {
    it('rejects callbacks from unauthorized group in group mode', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = '123';
      process.env.TELEGRAM_GROUP_ID = '-1001234567890';

      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const ctx = {
        callbackQuery: {
          data: 'action:test',
          from: { id: 123 },
          message: { chat: { id: -999 } },
        },
        answerCallbackQuery: vi.fn().mockResolvedValue({}),
      };
      await callbackHandlers[0](ctx);

      expect(mockEventBus.emit).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('unauthorized'));
    });

    it('accepts callbacks from configured group in group mode', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = '123';
      process.env.TELEGRAM_GROUP_ID = '-1001234567890';

      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const ctx = {
        callbackQuery: {
          data: 'action:test',
          from: { id: 123 },
          message: { chat: { id: -1001234567890 } },
        },
        answerCallbackQuery: vi.fn().mockResolvedValue({}),
      };
      await callbackHandlers[0](ctx);

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'user:chat:message',
          payload: expect.objectContaining({ message: 'action:test' }),
        }),
      );
    });

    it('rejects a callback from another user in the configured group', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = '123';
      process.env.TELEGRAM_GROUP_ID = '-1001234567890';
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      await callbackHandlers[0]({
        callbackQuery: {
          data: 'action:test',
          from: { id: 456 },
          message: { chat: { id: -1001234567890 } },
        },
        answerCallbackQuery: vi.fn(),
      });

      expect(mockEventBus.emit).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('unauthorized'));
    });

    it('rejects a group callback without chat metadata', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = '123';
      process.env.TELEGRAM_GROUP_ID = '-1001234567890';
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      await callbackHandlers[0]({
        callbackQuery: { data: 'action:test', from: { id: 123 } },
        answerCallbackQuery: vi.fn(),
      });

      expect(mockEventBus.emit).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('unauthorized'));
    });

    it('rejects callbacks from unauthorized user in direct mode', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = '123';
      delete process.env.TELEGRAM_GROUP_ID;

      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const ctx = {
        callbackQuery: {
          data: 'action:test',
          from: { id: 999 },
        },
        answerCallbackQuery: vi.fn().mockResolvedValue({}),
      };
      await callbackHandlers[0](ctx);

      expect(mockEventBus.emit).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('unauthorized'));
    });
  });

  describe('topic map validation', () => {
    it('rejects TELEGRAM_TOPIC_MAP with non-number values', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = '123';
      process.env.TELEGRAM_GROUP_ID = '-100';
      process.env.TELEGRAM_TOPIC_MAP = '{"Work":"five"}';

      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('invalid structure'));
    });
  });

  describe('inline keyboard rendering', () => {
    beforeEach(async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = '123';
      process.env.TELEGRAM_GROUP_ID = '-1001234567890';
      process.env.TELEGRAM_TOPIC_GENERAL = '1';
      process.env.TELEGRAM_TOPIC_SYSTEM = '42';
      process.env.TELEGRAM_TOPIC_MAP = '{"Work":5}';
    });

    it('sends notification with inline keyboard when actions present', async () => {
      const db = await createRealDb();
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });
      const destination = { kind: 'global', topic: 'system' } as const;
      const actions = [
        { label: 'Approve', action: 'a:y:id1' },
        { label: 'Deny', action: 'a:n:id1' },
        { label: 'View Details', action: 'a:v:id1' },
      ];
      const queueId = await enqueueTelegramNotification(db, {
        title: 'Approval Required',
        body: 'Action needs approval',
        destination,
        actionsJson: JSON.stringify(actions),
      });

      deliverQueuedNotification(queueId, {
        title: 'Approval Required',
        body: 'Action needs approval',
        destination,
        actions,
      });

      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      const callArgs = mockSendMessage.mock.calls[0];
      expect(callArgs[2]).toHaveProperty('reply_markup');
      expect(callArgs[2]).toHaveProperty('message_thread_id', 42); // System topic
    });

    it('sends notification without keyboard when no actions', async () => {
      const db = await createRealDb();
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });
      const queueId = await enqueueTelegramNotification(db, {
        title: 'Plain',
        body: 'No actions',
      });

      deliverQueuedNotification(queueId, { title: 'Plain', body: 'No actions' });

      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      const callArgs = mockSendMessage.mock.calls[0];
      expect(callArgs[2]).not.toHaveProperty('reply_markup');
    });
  });

  describe('callback routing with deps', () => {
    let mockConfig: any;

    beforeEach(async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = '123';
      process.env.TELEGRAM_GROUP_ID = '-1001234567890';
      process.env.TELEGRAM_TOPIC_GENERAL = '1';
      process.env.TELEGRAM_TOPIC_SYSTEM = '42';

      mockConfig = {
        pendingApprovals: {
          resolve: vi.fn().mockReturnValue({
            id: 'ap1',
            actionName: 'gmail:send',
            skillName: 'email',
            details: 'Send to bob',
          }),
          query: vi.fn().mockReturnValue([]),
          getById: vi.fn().mockReturnValue(undefined),
        },
        agentManager: {
          executeAction: vi.fn().mockResolvedValue({ success: true }),
        },
        auditLog: {
          insert: vi.fn(),
        },
      };
    });

    it('routes structured callback to handleCallback and edits message', async () => {
      await loadService();
      await service.start({
        eventBus: mockEventBus,
        logger: mockLogger,
        db: {},
        config: mockConfig,
      });

      const ctx = {
        callbackQuery: {
          data: 'a:y:ap1',
          from: { id: 123 },
          message: { chat: { id: -1001234567890 }, message_id: 100 },
        },
        answerCallbackQuery: vi.fn().mockResolvedValue({}),
        api: { editMessageReplyMarkup: vi.fn().mockResolvedValue({}) },
      };
      await callbackHandlers[0](ctx);

      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
        text: expect.stringContaining('Approved'),
      });
      expect(mockConfig.pendingApprovals.resolve).toHaveBeenCalledWith('ap1', 'approved');
    });

    it('falls back to user:chat:message for unrecognized callback data', async () => {
      await loadService();
      await service.start({
        eventBus: mockEventBus,
        logger: mockLogger,
        db: {},
        config: mockConfig,
      });

      const ctx = {
        callbackQuery: {
          data: 'some:unknown:format:extra',
          from: { id: 123 },
          message: { chat: { id: -1001234567890 } },
        },
        answerCallbackQuery: vi.fn().mockResolvedValue({}),
      };
      await callbackHandlers[0](ctx);

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'user:chat:message',
          payload: expect.objectContaining({ message: 'some:unknown:format:extra' }),
        }),
      );
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Processing...' });
    });

    it('answerCallbackQuery always called even on error', async () => {
      await loadService();

      mockConfig.pendingApprovals.resolve = vi.fn().mockImplementation(() => {
        throw new Error('DB crash');
      });

      await service.start({
        eventBus: mockEventBus,
        logger: mockLogger,
        db: {},
        config: mockConfig,
      });

      const ctx = {
        callbackQuery: {
          data: 'a:y:ap1',
          from: { id: 123 },
          message: { chat: { id: -1001234567890 } },
        },
        answerCallbackQuery: vi.fn().mockResolvedValue({}),
      };
      await callbackHandlers[0](ctx);

      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
        text: 'Error processing action',
      });
    });

    it('shows system not ready when deps not injected', async () => {
      await loadService();
      await service.start({
        eventBus: mockEventBus,
        logger: mockLogger,
        db: {},
        config: {}, // no deps injected
      });

      const ctx = {
        callbackQuery: {
          data: 'a:y:ap1',
          from: { id: 123 },
          message: { chat: { id: -1001234567890 } },
        },
        answerCallbackQuery: vi.fn().mockResolvedValue({}),
      };
      await callbackHandlers[0](ctx);

      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
        text: 'System not ready, try again',
      });
    });

    it('A2 rebuilds callback dependencies against the restarted runtime', async () => {
      await loadService();
      await service.start({
        eventBus: mockEventBus,
        logger: mockLogger,
        db: {},
        config: mockConfig,
      });
      const firstCtx = {
        callbackQuery: {
          data: 'a:y:ap1',
          from: { id: 123 },
          message: { chat: { id: -1001234567890 }, message_id: 200 },
        },
        answerCallbackQuery: vi.fn().mockResolvedValue({}),
        api: { editMessageReplyMarkup: vi.fn().mockResolvedValue({}) },
      };
      await callbackHandlers[0](firstCtx);
      expect(mockConfig.pendingApprovals.resolve).toHaveBeenCalledTimes(1);

      await service.stop();
      const restartedConfig = {
        pendingApprovals: {
          resolve: vi.fn().mockReturnValue({
            id: 'ap2',
            actionName: 'calendar:create',
            skillName: 'calendar',
            details: 'Create event',
          }),
          query: vi.fn().mockReturnValue([]),
          getById: vi.fn().mockReturnValue(undefined),
        },
        agentManager: { executeAction: vi.fn().mockResolvedValue({ success: true }) },
        auditLog: { insert: vi.fn() },
      };
      const restartedHandlers: Record<string, Array<(event: any) => void>> = {};
      const restartedBus = {
        emit: vi.fn(),
        on: vi.fn((type: string, handler: any) => {
          (restartedHandlers[type] ??= []).push(handler);
        }),
        off: vi.fn(),
      };
      await service.start({
        eventBus: restartedBus,
        logger: mockLogger,
        db: {},
        config: restartedConfig,
      });
      const restartedCtx = {
        callbackQuery: {
          data: 'a:y:ap2',
          from: { id: 123 },
          message: { chat: { id: -1001234567890 }, message_id: 201 },
        },
        answerCallbackQuery: vi.fn().mockResolvedValue({}),
        api: { editMessageReplyMarkup: vi.fn().mockResolvedValue({}) },
      };

      await callbackHandlers.at(-1)!(restartedCtx);

      expect(restartedConfig.pendingApprovals.resolve).toHaveBeenCalledWith('ap2', 'approved');
      expect(mockConfig.pendingApprovals.resolve).toHaveBeenCalledTimes(1);
      expect(restartedCtx.answerCallbackQuery).toHaveBeenCalledWith({
        text: expect.stringContaining('Approved'),
      });
    });
  });

  describe('permission:blocked notification', () => {
    it('emits notification with approval buttons when permission:blocked fires', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = '123';
      process.env.TELEGRAM_GROUP_ID = '-1001234567890';
      process.env.TELEGRAM_TOPIC_SYSTEM = '42';

      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const handler = eventHandlers['permission:blocked']?.[0];
      expect(handler).toBeDefined();

      handler({
        type: 'permission:blocked',
        payload: {
          actionName: 'gmail:send',
          skillName: 'email',
          tier: 'red',
          approvalId: 'ap99',
        },
      });

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'notification',
          payload: expect.objectContaining({
            channel: 'telegram',
            title: 'Approval Required',
            topicName: 'System',
            actions: expect.arrayContaining([
              expect.objectContaining({ label: 'Approve', action: 'a:y:ap99' }),
              expect.objectContaining({ label: 'Deny', action: 'a:n:ap99' }),
              expect.objectContaining({ label: 'View Details', action: 'a:v:ap99' }),
            ]),
          }),
        }),
      );
    });
  });

  describe('voice message handling', () => {
    const mockFetch = vi.fn();

    beforeEach(async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = '123';
      process.env.TELEGRAM_GROUP_ID = '-1001234567890';
      process.env.TELEGRAM_TOPIC_GENERAL = '1';
      process.env.TELEGRAM_TOPIC_SYSTEM = '42';
      process.env.TELEGRAM_TOPIC_MAP = '{"Work":5,"Personal":7}';

      // Mock global fetch for file download
      vi.stubGlobal('fetch', mockFetch);
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function createVoiceContext(overrides: Record<string, any> = {}) {
      return {
        from: { id: 123 },
        chat: { id: -1001234567890 },
        message: {
          message_id: 401,
          message_thread_id: 1,
          voice: {
            file_id: 'voice-file-id',
            duration: 5,
            mime_type: 'audio/ogg',
            file_size: 1024,
          },
          ...overrides.message,
        },
        getFile: vi.fn().mockResolvedValue({ file_path: 'voice/file_0.oga' }),
        reply: vi.fn().mockResolvedValue({ message_id: 200 }),
        ...overrides,
      };
    }

    it('emits voice:received event with correct payload on voice message', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      expect(voiceHandlers.length).toBeGreaterThan(0);

      const ctx = createVoiceContext();
      await voiceHandlers[0](ctx);

      // Should reply with "Transcribing..."
      expect(ctx.reply).toHaveBeenCalledWith('Transcribing voice message...', {
        message_thread_id: 1,
      });

      // Should download file
      expect(ctx.getFile).toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.telegram.org/file/bottest-token/voice/file_0.oga',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );

      // Should emit voice:received event
      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'voice:received',
          source: 'telegram',
          projectId: 'telegram-default',
          payload: expect.objectContaining({
            projectId: 'telegram-default',
            mimeType: 'audio/ogg',
            duration: 5,
            topicId: 1,
            topicName: 'General',
            replyMessageId: 200,
          }),
        }),
      );

      // audioData should be base64 encoded
      const emittedPayload = mockEventBus.emit.mock.calls.find(
        (call: any[]) => call[0].type === 'voice:received',
      )?.[0]?.payload;
      expect(emittedPayload.audioData).toBeDefined();
      expect(typeof emittedPayload.audioData).toBe('string');
    });

    it('ignores voice from unauthorized chat in group mode', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const ctx = createVoiceContext({
        chat: { id: -999 },
      });
      await voiceHandlers[0](ctx);

      expect(mockEventBus.emit).not.toHaveBeenCalled();
      expect(ctx.reply).not.toHaveBeenCalled();
    });

    it('rejects voice messages larger than 20MB', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const ctx = createVoiceContext({
        message: {
          message_id: 402,
          message_thread_id: 1,
          voice: {
            file_id: 'big-file',
            duration: 60,
            mime_type: 'audio/ogg',
            file_size: 25 * 1024 * 1024, // 25MB
          },
        },
      });
      await voiceHandlers[0](ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Voice message too large to transcribe', {
        message_thread_id: 1,
      });
      expect(mockEventBus.emit).not.toHaveBeenCalled();
    });

    it('handles video_note messages', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      expect(videoNoteHandlers.length).toBeGreaterThan(0);

      const ctx = {
        from: { id: 123 },
        chat: { id: -1001234567890 },
        message: {
          message_id: 403,
          message_thread_id: 1,
          video_note: {
            file_id: 'videonote-file-id',
            duration: 10,
            file_size: 2048,
          },
        },
        getFile: vi.fn().mockResolvedValue({ file_path: 'video/note_0.mp4' }),
        reply: vi.fn().mockResolvedValue({ message_id: 201 }),
      };
      await videoNoteHandlers[0](ctx);

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'voice:received',
          payload: expect.objectContaining({
            mimeType: 'audio/ogg',
            duration: 10,
          }),
        }),
      );
    });

    it('routes private voice through the project selected for the direct conversation', async () => {
      delete process.env.TELEGRAM_GROUP_ID;
      const db = await createRealDb();
      db.run(
        `INSERT INTO projects (id, name, skills, fs_path, created_at, updated_at)
         VALUES ('private-project', 'Private Project', '[]', 'private-project', 1, 1)`,
      );
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });
      await messageHandlers[0](
        createMockContext({
          from: { id: 123 },
          chat: { id: 123 },
          message: { text: '/project private-project', message_id: 1902 },
        }),
      );
      const ctx = createVoiceContext({
        from: { id: 123 },
        chat: { id: 123 },
        message: {
          message_id: 1903,
          voice: {
            file_id: 'private-voice',
            duration: 4,
            mime_type: 'audio/ogg',
            file_size: 512,
          },
        },
      });

      await voiceHandlers[0](ctx);

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'voice:received',
          projectId: 'private-project',
          payload: expect.objectContaining({ projectId: 'private-project' }),
        }),
      );
    });
  });

  describe('media message handling', () => {
    const mockFetch = vi.fn();

    beforeEach(async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = '123';
      process.env.TELEGRAM_GROUP_ID = '-1001234567890';
      process.env.TELEGRAM_TOPIC_GENERAL = '1';
      process.env.TELEGRAM_TOPIC_SYSTEM = '42';
      process.env.TELEGRAM_TOPIC_MAP = '{"Work":5,"Personal":7}';

      vi.stubGlobal('fetch', mockFetch);
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
      });

      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function createPhotoContext(overrides: Record<string, any> = {}) {
      return {
        from: { id: 123 },
        chat: { id: -1001234567890 },
        message: {
          message_id: 404,
          message_thread_id: 1,
          photo: [
            { file_id: 'small-id', file_unique_id: 's1', width: 90, height: 90, file_size: 1000 },
            {
              file_id: 'medium-id',
              file_unique_id: 'm1',
              width: 320,
              height: 320,
              file_size: 5000,
            },
            {
              file_id: 'large-id',
              file_unique_id: 'l1',
              width: 800,
              height: 800,
              file_size: 50000,
            },
          ],
          caption: undefined,
          ...overrides.message,
        },
        getFile: vi.fn().mockResolvedValue({ file_path: 'photos/file_0.jpg' }),
        reply: vi.fn().mockResolvedValue({ message_id: 300 }),
        ...overrides,
      };
    }

    function createDocumentContext(overrides: Record<string, any> = {}) {
      return {
        from: { id: 123 },
        chat: { id: -1001234567890 },
        message: {
          message_id: 405,
          message_thread_id: 1,
          document: {
            file_id: 'doc-file-id',
            file_unique_id: 'd1',
            file_name: 'report.pdf',
            mime_type: 'application/pdf',
            file_size: 80000,
          },
          caption: undefined,
          ...overrides.message,
        },
        getFile: vi.fn().mockResolvedValue({ file_path: 'documents/report.pdf' }),
        reply: vi.fn().mockResolvedValue({ message_id: 301 }),
        ...overrides,
      };
    }

    it('emits media:received event for photo with correct payload', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      expect(photoHandlers.length).toBeGreaterThan(0);

      const ctx = createPhotoContext();
      await photoHandlers[0](ctx);

      // Should reply with "Processing media..."
      expect(ctx.reply).toHaveBeenCalledWith('Processing media...', {
        message_thread_id: 1,
      });

      // Should download file
      expect(ctx.getFile).toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.telegram.org/file/bottest-token/photos/file_0.jpg',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );

      // Should save to disk
      expect(mockMkdir).toHaveBeenCalled();
      expect(mockWriteFile).toHaveBeenCalled();

      // Should emit media:received event
      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'media:received',
          source: 'telegram',
          projectId: 'telegram-default',
          payload: expect.objectContaining({
            projectId: 'telegram-default',
            mediaType: 'photo',
            mimeType: 'image/jpeg',
            topicId: 1,
            topicName: 'General',
            replyMessageId: 300,
          }),
        }),
      );
    });

    it('emits media:received for document with original filename', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      expect(documentHandlers.length).toBeGreaterThan(0);

      const ctx = createDocumentContext();
      await documentHandlers[0](ctx);

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'media:received',
          payload: expect.objectContaining({
            mediaType: 'document',
            mimeType: 'application/pdf',
          }),
        }),
      );

      // fileName should contain original name
      const emittedPayload = mockEventBus.emit.mock.calls.find(
        (call: any[]) => call[0].type === 'media:received',
      )?.[0]?.payload;
      expect(emittedPayload.fileName).toContain('report.pdf');
    });

    it('preserves caption in photo event payload', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const ctx = createPhotoContext({
        message: {
          message_thread_id: 1,
          photo: [
            {
              file_id: 'large-id',
              file_unique_id: 'l1',
              width: 800,
              height: 800,
              file_size: 50000,
            },
          ],
          caption: 'Check this screenshot',
        },
      });
      await photoHandlers[0](ctx);

      const emittedPayload = mockEventBus.emit.mock.calls.find(
        (call: any[]) => call[0].type === 'media:received',
      )?.[0]?.payload;
      expect(emittedPayload.caption).toBe('Check this screenshot');
    });

    it('rejects files larger than 20MB', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const ctx = createDocumentContext({
        message: {
          message_thread_id: 1,
          document: {
            file_id: 'big-doc',
            file_unique_id: 'b1',
            file_name: 'huge.pdf',
            mime_type: 'application/pdf',
            file_size: 25 * 1024 * 1024, // 25MB
          },
        },
      });
      await documentHandlers[0](ctx);

      expect(ctx.reply).toHaveBeenCalledWith('File too large to process', {
        message_thread_id: 1,
      });
      expect(mockEventBus.emit).not.toHaveBeenCalled();
    });

    it('rejects unsupported document types before download', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const ctx = createDocumentContext({
        message: {
          message_thread_id: 1,
          document: {
            file_id: 'sheet-doc',
            file_unique_id: 's1',
            file_name: 'budget.xlsx',
            mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            file_size: 1000,
          },
        },
      });
      await documentHandlers[0](ctx);

      expect(ctx.reply).toHaveBeenCalledWith("I can't process this file type yet", {
        message_thread_id: 1,
      });
      expect(ctx.getFile).not.toHaveBeenCalled();
      expect(mockEventBus.emit).not.toHaveBeenCalled();
    });

    it('ignores media from unauthorized chat in group mode', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const ctx = createPhotoContext({
        chat: { id: -999 },
      });
      await photoHandlers[0](ctx);

      expect(mockEventBus.emit).not.toHaveBeenCalled();
      expect(ctx.reply).not.toHaveBeenCalled();
    });

    it('picks highest resolution photo (last element in array)', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const ctx = createPhotoContext();
      await photoHandlers[0](ctx);

      // The getFile call should be for the largest photo
      // The handler uses ctx.getFile() which we mock, but the file_size should be from the last element
      const emittedPayload = mockEventBus.emit.mock.calls.find(
        (call: any[]) => call[0].type === 'media:received',
      )?.[0]?.payload;
      expect(emittedPayload.fileSize).toBe(50000); // last element's file_size
    });

    it('emits a correlated rejection on download failure', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const ctx = createPhotoContext();
      ctx.getFile.mockRejectedValueOnce(new Error('Network error'));

      await photoHandlers[0](ctx);

      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to download'));
      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'user:chat:rejected',
          projectId: 'telegram-default',
          payload: expect.objectContaining({
            requestId: expect.any(String),
            error: 'Failed to process media',
          }),
        }),
      );
    });

    it('sends error reply when file_path is undefined', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const ctx = createPhotoContext();
      ctx.getFile.mockResolvedValueOnce({ file_path: undefined });

      await photoHandlers[0](ctx);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Media file is unavailable'),
      );
      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'user:chat:rejected' }),
      );
    });

    it('sends error reply on non-ok fetch response', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const ctx = createPhotoContext();
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      await photoHandlers[0](ctx);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('file download failed: 404'),
      );
      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'user:chat:rejected' }),
      );
    });

    it('sanitizes document filenames before saving to disk', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const ctx = createDocumentContext({
        message: {
          message_thread_id: 1,
          document: {
            file_id: 'doc-file-id',
            file_unique_id: 'd1',
            file_name: '../../secret?.pdf',
            mime_type: 'application/pdf',
            file_size: 80000,
          },
        },
      });
      await documentHandlers[0](ctx);

      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringMatching(/data\/media\/\d+-secret_\.pdf$/),
        expect.any(Buffer),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('routes private media through the project selected for the direct conversation', async () => {
      delete process.env.TELEGRAM_GROUP_ID;
      const db = await createRealDb();
      db.run(
        `INSERT INTO projects (id, name, skills, fs_path, created_at, updated_at)
         VALUES ('private-project', 'Private Project', '[]', 'private-project', 1, 1)`,
      );
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });
      await messageHandlers[0](
        createMockContext({
          from: { id: 123 },
          chat: { id: 123 },
          message: { text: '/project private-project', message_id: 1904 },
        }),
      );
      const ctx = createPhotoContext({
        from: { id: 123 },
        chat: { id: 123 },
        message: {
          message_id: 1905,
          photo: [
            {
              file_id: 'private-photo',
              file_unique_id: 'private-photo-unique',
              width: 800,
              height: 800,
              file_size: 50000,
            },
          ],
        },
      });

      await photoHandlers[0](ctx);

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'media:received',
          projectId: 'private-project',
          payload: expect.objectContaining({ projectId: 'private-project' }),
        }),
      );
    });
  });

  describe('topic persistence', () => {
    beforeEach(() => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = '123';
      process.env.TELEGRAM_GROUP_ID = '-1001234567890';
      delete process.env.TELEGRAM_TOPIC_GENERAL;
      delete process.env.TELEGRAM_TOPIC_SYSTEM;
      delete process.env.TELEGRAM_TOPIC_MAP;
    });

    it('does not bootstrap Telegram topics from filesystem agent names', async () => {
      const { createTestDb } = await import('./helpers/test-db.ts');
      const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');

      const projectRoot = mkdtempSync(join(tmpdir(), 'raven-tg-boot-'));
      mkdirSync(join(projectRoot, 'projects', 'agents', 'raven'), { recursive: true });
      writeFileSync(
        join(projectRoot, 'projects', 'agents', 'raven', 'agent.yaml'),
        'name: raven\n',
      );
      mkdirSync(join(projectRoot, 'projects', 'agents', '_evaluator'), { recursive: true });
      writeFileSync(
        join(projectRoot, 'projects', 'agents', '_evaluator', 'agent.yaml'),
        'name: _evaluator\n',
      );

      const db = createTestDb();
      await loadService();
      await service.start({
        eventBus: mockEventBus,
        logger: mockLogger,
        db,
        config: {},
        projectRoot,
      });

      await Promise.resolve();
      expect(mockCreateForumTopic).not.toHaveBeenCalled();
    });

    it('reuses a persisted project topic across restarts', async () => {
      const { createTestDb } = await import('./helpers/test-db.ts');
      const db = createTestDb();
      const mod = await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });
      await mod.ensureProjectTopic('proj-1', 'My Project');
      expect(mockCreateForumTopic).toHaveBeenCalledTimes(1);

      await service.stop();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });

      const threadId = await mod.ensureProjectTopic('proj-1', 'My Project');
      expect(threadId).toBe(42);
      expect(mockCreateForumTopic).toHaveBeenCalledTimes(1);
    });

    it('deletes the persisted mapping when a project topic is closed', async () => {
      const { createTestDb } = await import('./helpers/test-db.ts');
      const { getStoredTopic } = await import('../../../services/notifications/topic-store.ts');
      const db = createTestDb();
      const mod = await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });
      await mod.ensureProjectTopic('proj-1', 'My Project');

      await mod.closeProjectTopic('proj-1');

      expect(mockCloseForumTopic).toHaveBeenCalledTimes(1);
      expect(
        getStoredTopic(db, { projectId: 'proj-1', groupId: '-1001234567890' }),
      ).toBeUndefined();
    });

    it('invalidates a stale topic mapping when Telegram reports thread not found', async () => {
      const { createTestDb } = await import('./helpers/test-db.ts');
      const { getStoredTopic, saveStoredTopic } =
        await import('../../../services/notifications/topic-store.ts');
      const db = createTestDb();
      saveStoredTopic(db, { projectId: 'proj-1', groupId: '-1001234567890' }, 42);

      const mod = await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db, config: {} });

      // Topic 42 was deleted in Telegram: sends to it fail, fallback (no thread) succeeds
      mockSendMessage.mockImplementation((_chat: string, _text: string, opts: any) => {
        if (opts?.message_thread_id === 42) {
          return Promise.reject(new Error('Bad Request: message thread not found'));
        }
        return Promise.resolve({});
      });

      const { enqueueNotification } =
        await import('../../../notification-engine/notification-queue.ts');
      const queueId = enqueueNotification(db, {
        source: 'test',
        title: 'Alert',
        body: 'Content',
        channel: 'telegram',
        destination: { kind: 'project', projectId: 'proj-1' },
        urgencyTier: 'yellow',
        deliveryMode: 'tell-now',
        status: 'pending',
        dedupeKey: 'delivery:stale-topic',
      });
      const handler = eventHandlers['notification:deliver']?.[0];
      handler({
        type: 'notification',
        payload: {
          queueId,
          channel: 'telegram',
          title: 'Alert',
          body: 'Content',
          destination: { kind: 'project', projectId: 'proj-1' },
        },
      });

      await vi.waitFor(() => {
        // stale mapping removed from the persistent store
        expect(
          getStoredTopic(db, { projectId: 'proj-1', groupId: '-1001234567890' }),
        ).toBeUndefined();
      });

      // Next ensure recreates the topic exactly once
      mockCreateForumTopic.mockResolvedValue({ message_thread_id: 77 });
      const newId = await mod.ensureProjectTopic('proj-1', 'Project One');
      expect(newId).toBe(77);
      expect(mockCreateForumTopic).toHaveBeenCalledTimes(1);
    });
  });
});
