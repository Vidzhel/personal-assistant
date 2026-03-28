import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  generateId,
  createLogger,
  SOURCE_GEMINI,
  TranscriptionRequestPayloadSchema,
  type EventBusInterface,
  type VoiceReceivedEvent,
} from '@raven/shared';
import type { ServiceContext, SuiteService } from '@raven/core/suite-registry/service-runner.ts';

const log = createLogger('voice-transcriber');
const TRANSCRIPTION_TIMEOUT_MS = 30_000;
const FILE_TRANSCRIPTION_TIMEOUT_MS = 600_000; // 10 minutes for long files
const TRANSCRIPTS_DIR = 'data/files/transcripts';

let eventBus: EventBusInterface | null = null;
let voiceHandler: ((event: unknown) => void) | null = null;
let transcriptionHandler: ((event: unknown) => void) | null = null;
let pendingTimeouts: Set<ReturnType<typeof setTimeout>> = new Set();

function createTranscriber(): {
  transcribe: (audioData: string, mimeType: string) => Promise<string>;
} {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_API_KEY is not set');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

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

async function transcribeFile(filePath: string, mimeType: string): Promise<string> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY is not set');

  const fileManager = new GoogleAIFileManager(apiKey);
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  log.info(`Uploading file for transcription: ${filePath}`);
  const uploadResult = await fileManager.uploadFile(filePath, {
    mimeType,
    displayName: basename(filePath),
  });

  let file = uploadResult.file;
  while (file.state === 'PROCESSING') {
    log.info(`Waiting for file processing: ${file.name} (state: ${file.state})`);
    await new Promise((r) => setTimeout(r, 5000));
    file = await fileManager.getFile(file.name);
  }

  if (file.state === 'FAILED') {
    throw new Error(`File processing failed: ${file.name}`);
  }

  log.info(`File ready, starting transcription: ${file.name}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FILE_TRANSCRIPTION_TIMEOUT_MS);
  pendingTimeouts.add(timeout);

  try {
    const result = await model.generateContent(
      {
        contents: [
          {
            role: 'user',
            parts: [
              { fileData: { mimeType: file.mimeType!, fileUri: file.uri } },
              {
                text: 'Transcribe this audio/video accurately. Return only the transcribed text with natural paragraph breaks. Preserve speaker changes if detectable.',
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
    try {
      await fileManager.deleteFile(file.name);
    } catch {
      log.warn(`Failed to delete remote file: ${file.name}`);
    }
  }
}

function saveTranscript(filePath: string, transcript: string): string {
  if (!existsSync(TRANSCRIPTS_DIR)) {
    mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  }

  const date = new Date().toISOString().slice(0, 10);
  const sourceName = basename(filePath).replace(/\.[^.]+$/, '');
  const transcriptPath = join(TRANSCRIPTS_DIR, `${date}-${sourceName}.txt`);

  writeFileSync(transcriptPath, transcript, 'utf-8');
  log.info(`Transcript saved to ${transcriptPath}`);
  return transcriptPath;
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

    transcriptionHandler = async (event: unknown): Promise<void> => {
      const parsed = TranscriptionRequestPayloadSchema.safeParse(
        (event as Record<string, unknown>).payload,
      );
      if (!parsed.success) {
        log.error(`Invalid transcription:request payload: ${parsed.error.message}`);
        return;
      }

      const { filePath, mimeType, projectId, createKnowledgeBubble, topicId, topicName } =
        parsed.data;

      try {
        const transcript = await transcribeFile(filePath, mimeType);
        const transcriptPath = saveTranscript(filePath, transcript);

        eventBus!.emit({
          id: generateId(),
          timestamp: Date.now(),
          source: SOURCE_GEMINI,
          type: 'transcription:complete',
          payload: { filePath, transcriptPath, projectId, topicId, topicName },
        });

        if (createKnowledgeBubble) {
          eventBus!.emit({
            id: generateId(),
            timestamp: Date.now(),
            source: SOURCE_GEMINI,
            type: 'knowledge:ingest:request',
            payload: {
              type: 'file' as const,
              filePath: transcriptPath,
              source: 'transcription',
              title: `Transcript: ${basename(filePath)}`,
            },
          });
        }

        eventBus!.emit({
          id: generateId(),
          timestamp: Date.now(),
          source: SOURCE_GEMINI,
          type: 'notification',
          payload: {
            channel: 'telegram' as const,
            title: 'Transcription Complete',
            body: `Transcribed: ${basename(filePath)}`,
            filePath: transcriptPath,
            topicName,
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`File transcription failed: ${msg}`);
        eventBus!.emit({
          id: generateId(),
          timestamp: Date.now(),
          source: SOURCE_GEMINI,
          type: 'transcription:failed',
          payload: { filePath, error: msg, projectId },
        });
      }
    };

    context.eventBus.on('transcription:request', transcriptionHandler);
    log.info('Voice transcriber service started');
  },

  async stop(): Promise<void> {
    if (eventBus && voiceHandler) {
      eventBus.off('voice:received', voiceHandler);
    }
    if (eventBus && transcriptionHandler) {
      eventBus.off('transcription:request', transcriptionHandler);
    }
    voiceHandler = null;
    transcriptionHandler = null;

    for (const timeout of pendingTimeouts) {
      clearTimeout(timeout);
    }
    pendingTimeouts = new Set();

    eventBus = null;
    log.info('Voice transcriber service stopped');
  },
};

export default service;
