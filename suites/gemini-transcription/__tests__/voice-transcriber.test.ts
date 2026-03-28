import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGenerateContent = vi.fn();

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel() {
      return { generateContent: mockGenerateContent };
    }
  },
}));

vi.mock('@google/generative-ai/server', () => ({
  GoogleAIFileManager: class {
    async uploadFile() {
      return { file: { name: 'file-1', state: 'ACTIVE', mimeType: 'audio/mp3', uri: 'gs://f' } };
    }
    async getFile() {
      return { name: 'file-1', state: 'ACTIVE', mimeType: 'audio/mp3', uri: 'gs://f' };
    }
    async deleteFile() {}
  },
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => true),
  };
});

vi.mock('@raven/shared', async () => {
  const { z } = await import('zod');
  return {
    generateId: vi.fn(() => 'test-id'),
    createLogger: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
    SOURCE_GEMINI: 'gemini',
    TranscriptionRequestPayloadSchema: z.object({
      filePath: z.string(),
      mimeType: z.string(),
      projectId: z.string().optional(),
      createKnowledgeBubble: z.boolean().default(true),
      topicId: z.number().optional(),
      topicName: z.string().optional(),
    }),
  };
});

vi.mock('@raven/core/suite-registry/service-runner.ts', () => ({}));

describe('voice-transcriber service', () => {
  const originalEnv = { ...process.env };
  let service: any;
  let mockEventBus: any;
  let mockLogger: any;
  let eventHandlers: Record<string, Array<(event: any) => void>>;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.GOOGLE_API_KEY = 'test-api-key';
    vi.clearAllMocks();

    eventHandlers = {};
    mockEventBus = {
      emit: vi.fn(),
      on: vi.fn((type: string, handler: any) => {
        if (!eventHandlers[type]) eventHandlers[type] = [];
        eventHandlers[type].push(handler);
      }),
      off: vi.fn(),
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
    const mod = await import('../services/voice-transcriber.ts');
    service = mod.default;
    return mod;
  }

  function createVoiceEvent(overrides: Record<string, any> = {}) {
    return {
      id: 'ev-1',
      timestamp: Date.now(),
      source: 'telegram',
      type: 'voice:received',
      projectId: 'telegram-work',
      payload: {
        projectId: 'telegram-work',
        audioData: 'base64audiodata',
        mimeType: 'audio/ogg',
        duration: 5,
        topicId: 5,
        topicName: 'Work',
        replyMessageId: 100,
        ...overrides,
      },
    };
  }

  describe('start and event subscription', () => {
    it('subscribes to voice:received on start', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      expect(mockEventBus.on).toHaveBeenCalledWith('voice:received', expect.any(Function));
    });

    it('skips start when GOOGLE_API_KEY is not set', async () => {
      delete process.env.GOOGLE_API_KEY;
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      expect(mockEventBus.on).not.toHaveBeenCalled();
    });
  });

  describe('successful transcription', () => {
    it('calls Gemini API with correct audio data and emits events', async () => {
      mockGenerateContent.mockResolvedValue({
        response: { text: () => 'Hello, please check my tasks' },
      });

      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const handler = eventHandlers['voice:received']?.[0];
      expect(handler).toBeDefined();

      const event = createVoiceEvent();
      handler(event);

      // Wait for async handler
      await vi.waitFor(() => {
        expect(mockEventBus.emit).toHaveBeenCalled();
      });

      // Verify Gemini API called with correct params
      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          contents: [
            expect.objectContaining({
              parts: expect.arrayContaining([
                expect.objectContaining({
                  inlineData: { mimeType: 'audio/ogg', data: 'base64audiodata' },
                }),
              ]),
            }),
          ],
        }),
        expect.anything(),
      );

      // Should emit notification with transcribed text
      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'notification',
          payload: expect.objectContaining({
            channel: 'telegram',
            body: 'Voice: Hello, please check my tasks',
            topicName: 'Work',
          }),
        }),
      );

      // Should emit user:chat:message with transcribed text
      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'user:chat:message',
          source: 'gemini',
          projectId: 'telegram-work',
          payload: expect.objectContaining({
            projectId: 'telegram-work',
            message: 'Hello, please check my tasks',
            topicId: 5,
            topicName: 'Work',
          }),
        }),
      );
    });
  });

  describe('timeout handling', () => {
    it('emits timeout notification when transcription takes too long', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      mockGenerateContent.mockRejectedValue(abortError);

      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const handler = eventHandlers['voice:received']?.[0];
      handler(createVoiceEvent());

      await vi.waitFor(() => {
        expect(mockEventBus.emit).toHaveBeenCalled();
      });

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'notification',
          payload: expect.objectContaining({
            body: "Couldn't transcribe that — please type your message",
            topicName: 'Work',
          }),
        }),
      );
    });
  });

  describe('API error handling', () => {
    it('emits unavailable notification on network error', async () => {
      mockGenerateContent.mockRejectedValue(new Error('Network error'));

      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const handler = eventHandlers['voice:received']?.[0];
      handler(createVoiceEvent());

      await vi.waitFor(() => {
        expect(mockEventBus.emit).toHaveBeenCalled();
      });

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'notification',
          payload: expect.objectContaining({
            body: 'Voice transcription is temporarily unavailable — please type your message',
          }),
        }),
      );
    });

    it('emits unavailable notification on auth/quota error', async () => {
      mockGenerateContent.mockRejectedValue(new Error('PERMISSION_DENIED: quota exceeded'));

      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const handler = eventHandlers['voice:received']?.[0];
      handler(createVoiceEvent());

      await vi.waitFor(() => {
        expect(mockEventBus.emit).toHaveBeenCalled();
      });

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'notification',
          payload: expect.objectContaining({
            body: 'Voice transcription is temporarily unavailable — please type your message',
          }),
        }),
      );
    });
  });

  describe('topic context preservation', () => {
    it('preserves topicId, topicName, and projectId through transcription', async () => {
      mockGenerateContent.mockResolvedValue({
        response: { text: () => 'Transcribed text' },
      });

      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const handler = eventHandlers['voice:received']?.[0];
      handler(
        createVoiceEvent({
          projectId: 'telegram-personal',
          topicId: 7,
          topicName: 'Personal',
        }),
      );

      await vi.waitFor(() => {
        expect(mockEventBus.emit).toHaveBeenCalledTimes(2);
      });

      // Check user:chat:message event preserves context
      const chatEmit = mockEventBus.emit.mock.calls.find(
        (call: any[]) => call[0].type === 'user:chat:message',
      );
      expect(chatEmit).toBeDefined();
      expect(chatEmit[0].payload).toEqual(
        expect.objectContaining({
          projectId: 'telegram-personal',
          topicId: 7,
          topicName: 'Personal',
          message: 'Transcribed text',
        }),
      );
    });
  });

  describe('transcription:request handling', () => {
    it('subscribes to transcription:request on start', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      expect(mockEventBus.on).toHaveBeenCalledWith(
        'transcription:request',
        expect.any(Function),
      );
    });

    it('transcribes file and emits completion events', async () => {
      mockGenerateContent.mockResolvedValue({
        response: { text: () => 'Transcribed file content' },
      });

      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const handler = eventHandlers['transcription:request']?.[0];
      expect(handler).toBeDefined();

      handler({
        payload: {
          filePath: '/tmp/lecture.mp3',
          mimeType: 'audio/mp3',
          projectId: 'proj-1',
          createKnowledgeBubble: true,
          topicName: 'Work',
        },
      });

      await vi.waitFor(() => {
        expect(mockEventBus.emit).toHaveBeenCalled();
      });

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'transcription:complete',
          payload: expect.objectContaining({
            filePath: '/tmp/lecture.mp3',
            projectId: 'proj-1',
          }),
        }),
      );

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'notification',
          payload: expect.objectContaining({
            title: 'Transcription Complete',
            body: 'Transcribed: lecture.mp3',
          }),
        }),
      );
    });

    it('emits transcription:failed on error', async () => {
      mockGenerateContent.mockRejectedValue(new Error('Gemini quota exceeded'));

      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });

      const handler = eventHandlers['transcription:request']?.[0];
      handler({
        payload: {
          filePath: '/tmp/big-video.mp4',
          mimeType: 'video/mp4',
          projectId: 'proj-2',
        },
      });

      await vi.waitFor(() => {
        expect(mockEventBus.emit).toHaveBeenCalled();
      });

      expect(mockEventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'transcription:failed',
          payload: expect.objectContaining({
            filePath: '/tmp/big-video.mp4',
            error: 'Gemini quota exceeded',
            projectId: 'proj-2',
          }),
        }),
      );
    });
  });

  describe('stop and cleanup', () => {
    it('unsubscribes from event bus on stop', async () => {
      await loadService();
      await service.start({ eventBus: mockEventBus, logger: mockLogger, db: {}, config: {} });
      await service.stop();

      expect(mockEventBus.off).toHaveBeenCalledWith('voice:received', expect.any(Function));
      expect(mockEventBus.off).toHaveBeenCalledWith(
        'transcription:request',
        expect.any(Function),
      );
    });
  });
});
