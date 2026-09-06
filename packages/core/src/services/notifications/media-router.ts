import {
  generateId,
  SOURCE_TELEGRAM,
  createLogger,
  MediaReceivedPayloadSchema,
  type EventBusInterface,
} from '@raven/shared';
import type { ServiceContext, RavenService } from '../types.ts';

const log = createLogger('media-router');

let eventBus: EventBusInterface;

function formatFileSize(bytes: number): string {
  const kb = 1024;
  const mb = kb * kb;
  if (bytes >= mb) return `${(bytes / mb).toFixed(1)} MB`;
  if (bytes >= kb) return `${(bytes / kb).toFixed(0)} KB`;
  return `${bytes} B`;
}

function formatMediaMessage(data: {
  mediaType: 'photo' | 'document';
  filePath: string;
  mimeType: string;
  fileName: string;
  fileSize?: number;
  caption?: string;
}): string {
  const sizeInfo = data.fileSize ? `, ${formatFileSize(data.fileSize)}` : '';
  if (data.mediaType === 'photo') {
    return `[Photo attached: ${data.filePath}, ${data.mimeType}${sizeInfo}]\n\n${data.caption ?? 'User sent a photo for processing'}`;
  }
  return `[Document attached: ${data.fileName} at ${data.filePath}, ${data.mimeType}${sizeInfo}]\n\n${data.caption ?? 'User sent a document for processing'}`;
}

function emitRoutedMedia(
  data: ReturnType<typeof MediaReceivedPayloadSchema.parse>,
  message: string,
): void {
  eventBus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SOURCE_TELEGRAM,
    type: 'user:chat:message',
    projectId: data.projectId,
    payload: {
      projectId: data.projectId,
      message,
      topicId: data.topicId,
      topicName: data.topicName,
      transportOrigin: data.transportOrigin,
      requestId: data.requestId,
      sessionId: data.sessionId,
      mediaAttachment: {
        type: data.mediaType,
        filePath: data.filePath,
        mimeType: data.mimeType,
        fileName: data.fileName,
      },
    },
  });
}

function handleMediaReceived(event: unknown): void {
  try {
    const parsed = MediaReceivedPayloadSchema.safeParse((event as Record<string, unknown>).payload);
    if (!parsed.success) {
      log.error(`Invalid media:received payload: ${parsed.error.message}`);
      return;
    }

    const { projectId, mediaType, filePath, mimeType, fileName, fileSize, caption } = parsed.data;

    const message = formatMediaMessage({
      mediaType,
      filePath,
      mimeType,
      fileName,
      fileSize,
      caption,
    });

    log.info(`Routing ${mediaType} to orchestrator for project ${projectId}`);

    emitRoutedMedia(parsed.data, message);
  } catch (err) {
    log.error(`Failed to route media event: ${err}`);
  }
}

const service: RavenService = {
  async start(context: ServiceContext): Promise<void> {
    eventBus = context.eventBus;
    eventBus.on('media:received', handleMediaReceived);
    log.info('Media router service started');
  },

  async stop(): Promise<void> {
    eventBus.off('media:received', handleMediaReceived);
    log.info('Media router service stopped');
  },
};

export default service;
