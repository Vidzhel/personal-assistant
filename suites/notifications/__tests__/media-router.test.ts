import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@raven/shared', async () => {
  const actual = await vi.importActual<typeof import('@raven/shared')>('@raven/shared');
  return {
    generateId: vi.fn(() => 'test-id'),
    SOURCE_TELEGRAM: 'telegram',
    MediaReceivedPayloadSchema: actual.MediaReceivedPayloadSchema,
    createLogger: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  };
});

vi.mock('@raven/core/suite-registry/service-runner.ts', () => ({}));

describe('media-router service', () => {
  let service: any;
  let mockEventBus: any;
  let mediaReceivedHandler: ((event: unknown) => void) | null;

  beforeEach(async () => {
    vi.resetModules();
    mediaReceivedHandler = null;

    mockEventBus = {
      emit: vi.fn(),
      on: vi.fn((type: string, handler: any) => {
        if (type === 'media:received') {
          mediaReceivedHandler = handler;
        }
      }),
      off: vi.fn(),
    };

    const mod = await import('../services/media-router.ts');
    service = mod.default;
  });

  async function startService() {
    await service.start({
      eventBus: mockEventBus,
      db: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      config: {},
    });
  }

  it('subscribes to media:received on start', async () => {
    await startService();
    expect(mockEventBus.on).toHaveBeenCalledWith('media:received', expect.any(Function));
    expect(mediaReceivedHandler).not.toBeNull();
  });

  it('unsubscribes from media:received on stop', async () => {
    await startService();
    await service.stop();
    expect(mockEventBus.off).toHaveBeenCalledWith('media:received', expect.any(Function));
  });

  it('routes photo media:received to user:chat:message with photo context', async () => {
    await startService();

    mediaReceivedHandler!({
      type: 'media:received',
      payload: {
        projectId: 'telegram-work',
        mediaType: 'photo',
        filePath: '/data/media/123-photo.jpg',
        mimeType: 'image/jpeg',
        fileName: '123-photo.jpg',
        fileSize: 50000,
        topicId: 5,
        topicName: 'Work',
      },
    });

    expect(mockEventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'user:chat:message',
        source: 'telegram',
        projectId: 'telegram-work',
        payload: expect.objectContaining({
          projectId: 'telegram-work',
          message: expect.stringContaining('[Photo attached:'),
          topicId: 5,
          topicName: 'Work',
          mediaAttachment: {
            type: 'photo',
            filePath: '/data/media/123-photo.jpg',
            mimeType: 'image/jpeg',
            fileName: '123-photo.jpg',
          },
        }),
      }),
    );
  });

  it('routes document media:received to user:chat:message with document context', async () => {
    await startService();

    mediaReceivedHandler!({
      type: 'media:received',
      payload: {
        projectId: 'telegram-work',
        mediaType: 'document',
        filePath: '/data/media/123-report.pdf',
        mimeType: 'application/pdf',
        fileName: '123-report.pdf',
        fileSize: 100000,
        topicId: 5,
        topicName: 'Work',
      },
    });

    expect(mockEventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'user:chat:message',
        payload: expect.objectContaining({
          message: expect.stringContaining('[Document attached:'),
          mediaAttachment: {
            type: 'document',
            filePath: '/data/media/123-report.pdf',
            mimeType: 'application/pdf',
            fileName: '123-report.pdf',
          },
        }),
      }),
    );
  });

  it('includes caption text as message content when provided', async () => {
    await startService();

    mediaReceivedHandler!({
      type: 'media:received',
      payload: {
        projectId: 'telegram-work',
        mediaType: 'photo',
        filePath: '/data/media/123-photo.jpg',
        mimeType: 'image/jpeg',
        fileName: '123-photo.jpg',
        caption: 'Check this screenshot',
        topicId: 5,
        topicName: 'Work',
      },
    });

    const emittedPayload = mockEventBus.emit.mock.calls[0][0].payload;
    expect(emittedPayload.message).toContain('Check this screenshot');
  });

  it('uses generic routing text when no caption provided', async () => {
    await startService();

    mediaReceivedHandler!({
      type: 'media:received',
      payload: {
        projectId: 'telegram-default',
        mediaType: 'photo',
        filePath: '/data/media/123-photo.jpg',
        mimeType: 'image/jpeg',
        fileName: '123-photo.jpg',
      },
    });

    const emittedPayload = mockEventBus.emit.mock.calls[0][0].payload;
    expect(emittedPayload.message).toContain('User sent a photo for processing');
  });

  it('uses generic document text when no caption provided for document', async () => {
    await startService();

    mediaReceivedHandler!({
      type: 'media:received',
      payload: {
        projectId: 'telegram-default',
        mediaType: 'document',
        filePath: '/data/media/123-doc.pdf',
        mimeType: 'application/pdf',
        fileName: '123-doc.pdf',
      },
    });

    const emittedPayload = mockEventBus.emit.mock.calls[0][0].payload;
    expect(emittedPayload.message).toContain('User sent a document for processing');
  });

  it('preserves topicId, topicName, and projectId through routing', async () => {
    await startService();

    mediaReceivedHandler!({
      type: 'media:received',
      payload: {
        projectId: 'telegram-personal',
        mediaType: 'photo',
        filePath: '/data/media/123-photo.jpg',
        mimeType: 'image/jpeg',
        fileName: '123-photo.jpg',
        topicId: 7,
        topicName: 'Personal',
      },
    });

    const emitted = mockEventBus.emit.mock.calls[0][0];
    expect(emitted.projectId).toBe('telegram-personal');
    expect(emitted.payload.projectId).toBe('telegram-personal');
    expect(emitted.payload.topicId).toBe(7);
    expect(emitted.payload.topicName).toBe('Personal');
  });
});
