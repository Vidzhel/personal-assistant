import {
  generateId,
  SOURCE_TELEGRAM,
  createLogger,
  MediaReceivedPayloadSchema,
  type EventBusInterface,
} from '@raven/shared';
import type { ServiceContext, SuiteService } from '@raven/core/suite-registry/service-runner.ts';

const log = createLogger('media-router');

let eventBus: EventBusInterface;

function formatFileSize(bytes: number): string {
  const kb = 1024;
  const mb = kb * kb;
  if (bytes >= mb) return `${(bytes / mb).toFixed(1)} MB`;
  if (bytes >= kb) return `${(bytes / kb).toFixed(0)} KB`;
  return `${bytes} B`;
}

function handleMediaReceived(event: unknown): void {
  try {
    const parsed = MediaReceivedPayloadSchema.safeParse((event as Record<string, unknown>).payload);
    if (!parsed.success) {
      log.error(`Invalid media:received payload: ${parsed.error.message}`);
      return;
    }

    const { projectId, mediaType, filePath, mimeType, fileName, fileSize, caption, topicId, topicName } = parsed.data;

    const sizeInfo = fileSize ? `, ${formatFileSize(fileSize)}` : '';

    let message: string;
    if (mediaType === 'photo') {
      message = `[Photo attached: ${filePath}, ${mimeType}${sizeInfo}]\n\n${caption ?? 'User sent a photo for processing'}`;
    } else {
      message = `[Document attached: ${fileName} at ${filePath}, ${mimeType}${sizeInfo}]\n\n${caption ?? 'User sent a document for processing'}`;
    }

    log.info(`Routing ${mediaType} to orchestrator for project ${projectId}`);

    eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: SOURCE_TELEGRAM,
      type: 'user:chat:message',
      projectId,
      payload: {
        projectId,
        message,
        topicId,
        topicName,
        mediaAttachment: {
          type: mediaType,
          filePath,
          mimeType,
          fileName,
        },
      },
    });
  } catch (err) {
    log.error(`Failed to route media event: ${err}`);
  }
}

const service: SuiteService = {
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
