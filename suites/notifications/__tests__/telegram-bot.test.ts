import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSendMessage = vi.fn().mockResolvedValue({});
const mockGetChat = vi.fn().mockResolvedValue({});
const mockEditMessageReplyMarkup = vi.fn().mockResolvedValue({});
const mockStart = vi.fn();
const mockStop = vi.fn().mockResolvedValue(undefined);
const messageHandlers: Array<(ctx: any) => Promise<void>> = [];
const callbackHandlers: Array<(ctx: any) => Promise<void>> = [];

class MockBot {
  on(filter: string, handler: any) {
    if (filter === 'message:text') messageHandlers.push(handler);
    if (filter === 'callback_query:data') callbackHandlers.push(handler);
  }
  api = { sendMessage: mockSendMessage, getChat: mockGetChat, editMessageReplyMarkup: mockEditMessageReplyMarkup };
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

vi.mock('grammy', () => ({ Bot: MockBot, InlineKeyboard: MockInlineKeyboard }));

vi.mock('@raven/shared', () => ({
  generateId: vi.fn(() => 'test-id'),
  SOURCE_TELEGRAM: 'telegram',
  PROJECT_TELEGRAM_DEFAULT: 'telegram-default',
}));

vi.mock('@raven/core/suite-registry/service-runner.ts', () => ({}));

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
    vi.clearAllMocks();

    eventHandlers = {};
    mockEventBus = {
      emit: vi.fn(),
      on: vi.fn((type: string, handler: any) => {
        if (!eventHandlers[type]) eventHandlers[type] = [];
        eventHandlers[type].push(handler);
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
    const mod = await import('../services/telegram-bot.ts');
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
      reply: vi.fn().mockResolvedValue({}),
      answerCallbackQuery: vi.fn().mockResolvedValue({}),
      ...overrides,
    };
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
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      // Trigger a notification event
      const handler = eventHandlers['notification']?.[0];
      expect(handler).toBeDefined();
      handler({
        type: 'notification',
        payload: { channel: 'telegram', title: 'Test', body: 'Body' },
      });

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

    it('emits user:chat:message with topicId and topicName for known topic', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const ctx = createMockContext({
        chat: { id: -1001234567890 },
        message: { text: 'Test in Work', message_thread_id: 5 },
      });
      await messageHandlers[0](ctx);

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'user:chat:message',
          payload: expect.objectContaining({
            message: 'Test in Work',
            topicId: 5,
            topicName: 'Work',
            projectId: 'telegram-work',
          }),
        }),
      );
    });

    it('emits user:chat:message with topicId but no topicName for unknown topic', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const ctx = createMockContext({
        chat: { id: -1001234567890 },
        message: { text: 'Unknown topic', message_thread_id: 999 },
      });
      await messageHandlers[0](ctx);

      const payload = mockEventBus.emit.mock.calls[0][0].payload;
      expect(payload.topicId).toBe(999);
      expect(payload.topicName).toBeUndefined();
      expect(payload.projectId).toBe('telegram-default');
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

    it('notification routes to specified topicName', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const handler = eventHandlers['notification']?.[0];
      handler({
        type: 'notification',
        payload: { channel: 'telegram', title: 'Alert', body: 'Content', topicName: 'Work' },
      });

      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      const callArgs = mockSendMessage.mock.calls[0];
      expect(callArgs[0]).toBe('-1001234567890'); // groupId
      expect(callArgs[2]).toHaveProperty('message_thread_id', 5); // Work topic
    });

    it('notification defaults to General topic when no topicName', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const handler = eventHandlers['notification']?.[0];
      handler({
        type: 'notification',
        payload: { channel: 'telegram', title: 'Alert', body: 'Content' },
      });

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

      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      const callArgs = mockSendMessage.mock.calls[0];
      expect(callArgs[0]).toBe('-1001234567890');
      expect(callArgs[2]).toHaveProperty('message_thread_id', 42); // System topic
    });

    it('agent:task:complete routes back to source topic via projectId', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      // First, simulate an incoming message from Work topic to populate projectTopicMap
      const ctx = createMockContext({
        chat: { id: -1001234567890 },
        message: { text: 'Do work', message_thread_id: 5 },
      });
      await messageHandlers[0](ctx);

      // Clear previous sendMessage calls
      mockSendMessage.mockClear();

      // Now simulate agent:task:complete
      const handler = eventHandlers['agent:task:complete']?.[0];
      handler({
        payload: { result: 'Done!', success: true },
        source: 'agent-manager',
        projectId: 'telegram-work',
      });

      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalledTimes(1);
      });

      const callArgs = mockSendMessage.mock.calls[0];
      expect(callArgs[0]).toBe('-1001234567890');
      expect(callArgs[2]).toHaveProperty('message_thread_id', 5); // Work topic
    });

    it('sendMessage falls back to non-topic on failure', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      // First call fails, second succeeds
      mockSendMessage
        .mockRejectedValueOnce(new Error('Thread not found'))
        .mockResolvedValueOnce({});

      const handler = eventHandlers['notification']?.[0];
      handler({
        type: 'notification',
        payload: { channel: 'telegram', title: 'Test', body: 'Body', topicName: 'Work' },
      });

      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalledTimes(2);
      });

      // First call: with message_thread_id
      expect(mockSendMessage.mock.calls[0][2]).toHaveProperty('message_thread_id', 5);
      // Second call (fallback): without message_thread_id
      expect(mockSendMessage.mock.calls[1][2]).not.toHaveProperty('message_thread_id');
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('falling back'));
    });
  });

  describe('parseTopicConfig', () => {
    it('parses valid TELEGRAM_TOPIC_MAP JSON', async () => {
      process.env.TELEGRAM_BOT_TOKEN = 'test-token';
      process.env.TELEGRAM_CHAT_ID = '123';
      process.env.TELEGRAM_GROUP_ID = '-100';
      process.env.TELEGRAM_TOPIC_GENERAL = '1';
      process.env.TELEGRAM_TOPIC_SYSTEM = '42';
      process.env.TELEGRAM_TOPIC_MAP = '{"Work":5,"Personal":7}';

      await loadService();
      // Need to call start to initialize logger before parseTopicConfig
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      // Verify through the behavior: a message in topic 5 should resolve to "Work"
      const ctx = createMockContext({
        chat: { id: -100 },
        message: { text: 'Hi', message_thread_id: 5 },
      });
      await messageHandlers[0](ctx);

      const payload = mockEventBus.emit.mock.calls[0][0].payload;
      expect(payload.topicName).toBe('Work');
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
          from: { id: 456 },
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
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const handler = eventHandlers['notification']?.[0];
      handler({
        type: 'notification',
        payload: {
          channel: 'telegram',
          title: 'Approval Required',
          body: 'Action needs approval',
          topicName: 'System',
          actions: [
            { label: 'Approve', action: 'a:y:id1' },
            { label: 'Deny', action: 'a:n:id1' },
            { label: 'View Details', action: 'a:v:id1' },
          ],
        },
      });

      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      const callArgs = mockSendMessage.mock.calls[0];
      expect(callArgs[2]).toHaveProperty('reply_markup');
      expect(callArgs[2]).toHaveProperty('message_thread_id', 42); // System topic
    });

    it('sends notification without keyboard when no actions', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const handler = eventHandlers['notification']?.[0];
      handler({
        type: 'notification',
        payload: { channel: 'telegram', title: 'Plain', body: 'No actions' },
      });

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
          executeApprovedAction: vi.fn().mockResolvedValue({ success: true }),
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
          from: { id: 456 },
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
          from: { id: 456 },
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
          from: { id: 456 },
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
          from: { id: 456 },
          message: { chat: { id: -1001234567890 } },
        },
        answerCallbackQuery: vi.fn().mockResolvedValue({}),
      };
      await callbackHandlers[0](ctx);

      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({
        text: 'System not ready, try again',
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
});
