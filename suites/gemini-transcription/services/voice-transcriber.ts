import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  generateId,
  createLogger,
  SOURCE_GEMINI,
  type EventBusInterface,
  type VoiceReceivedEvent,
} from '@raven/shared';
import type { ServiceContext, SuiteService } from '@raven/core/suite-registry/service-runner.ts';

const log = createLogger('voice-transcriber');
const TRANSCRIPTION_TIMEOUT_MS = 30_000;

let eventBus: EventBusInterface | null = null;
let voiceHandler: ((event: unknown) => void) | null = null;
let pendingTimeouts: Set<ReturnType<typeof setTimeout>> = new Set();

function createTranscriber(): {
  transcribe: (audioData: string, mimeType: string) => Promise<string>;
} {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_API_KEY is not set');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  return {
    async transcribe(audioData: string, mimeType: string): Promise<string> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TRANSCRIPTION_TIMEOUT_MS);
      pendingTimeouts.add(timeout);

      try {
        const result = await model.generateContent(
          {
            contents: [
              {
                role: 'user',
                parts: [
                  { inlineData: { mimeType, data: audioData } },
                  {
                    text: 'Transcribe this audio message accurately. Return only the transcribed text.',
                  },
                ],
              },
            ],
          },
          { signal: controller.signal } as unknown as Record<string, unknown>,
        );

        return result.response.text();
      } finally {
        clearTimeout(timeout);
        pendingTimeouts.delete(timeout);
      }
    },
  };
}

async function handleVoiceReceived(
  event: VoiceReceivedEvent,
  transcriber: ReturnType<typeof createTranscriber>,
): Promise<void> {
  const { projectId, audioData, mimeType, topicId, topicName } = event.payload;

  if (!eventBus) return;

  try {
    const transcription = await transcriber.transcribe(audioData, mimeType);

    log.info(`Transcription complete for project ${projectId}: ${transcription.slice(0, 100)}`);

    // Notify user of transcribed text
    eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: SOURCE_GEMINI,
      type: 'notification',
      payload: {
        channel: 'telegram',
        title: 'Voice Transcription',
        body: `Voice: ${transcription}`,
        topicName,
      },
    });

    // Emit as user:chat:message so orchestrator processes it
    eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: SOURCE_GEMINI,
      projectId,
      type: 'user:chat:message',
      payload: {
        projectId,
        message: transcription,
        topicId,
        topicName,
      },
    });
  } catch (err) {
    const isTimeout =
      err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'));

    if (isTimeout) {
      log.warn(`Transcription timed out for project ${projectId}`);
      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: SOURCE_GEMINI,
        type: 'notification',
        payload: {
          channel: 'telegram',
          title: 'Voice Transcription',
          body: "Couldn't transcribe that — please type your message",
          topicName,
        },
      });
    } else {
      log.error(`Transcription error for project ${projectId}: ${err}`);
      eventBus.emit({
        id: generateId(),
        timestamp: Date.now(),
        source: SOURCE_GEMINI,
        type: 'notification',
        payload: {
          channel: 'telegram',
          title: 'Voice Transcription',
          body: 'Voice transcription is temporarily unavailable — please type your message',
          topicName,
        },
      });
    }
  }
}

const service: SuiteService = {
  async start(context: ServiceContext): Promise<void> {
    eventBus = context.eventBus;

    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      log.warn('GOOGLE_API_KEY not set, voice transcription disabled');
      return;
    }

    const transcriber = createTranscriber();

    voiceHandler = (event: unknown): void => {
      const voiceEvent = event as VoiceReceivedEvent;
      handleVoiceReceived(voiceEvent, transcriber).catch((err) => {
        log.error(`Unhandled error in voice handler: ${err}`);
      });
    };

    context.eventBus.on('voice:received', voiceHandler);
    log.info('Voice transcriber service started');
  },

  async stop(): Promise<void> {
    if (eventBus && voiceHandler) {
      eventBus.off('voice:received', voiceHandler);
    }
    voiceHandler = null;

    for (const timeout of pendingTimeouts) {
      clearTimeout(timeout);
    }
    pendingTimeouts = new Set();

    eventBus = null;
    log.info('Voice transcriber service stopped');
  },
};

export default service;
