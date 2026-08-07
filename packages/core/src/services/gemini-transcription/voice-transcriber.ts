import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager, type FileMetadataResponse } from '@google/generative-ai/server';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  generateId,
  createLogger,
  SOURCE_GEMINI,
  TranscriptionRequestPayloadSchema,
  type EventBusInterface,
  type VoiceReceivedEvent,
  type TranscriptionRequestEvent,
} from '@raven/shared';
import type { ServiceContext, RavenService } from '../types.ts';

const log = createLogger('voice-transcriber');
const TRANSCRIPTION_TIMEOUT_MS = 30_000;
const FILE_TRANSCRIPTION_TIMEOUT_MS = 600_000; // 10 minutes for long files
const TRANSCRIPTS_DIR = 'data/files/transcripts';
const FILE_PROCESSING_POLL_INTERVAL_MS = 5000; // delay between "still processing" checks
const ISO_DATE_LENGTH = 10; // length of the YYYY-MM-DD prefix of an ISO timestamp
const TRANSCRIPTION_LOG_PREVIEW_LENGTH = 100; // chars of transcript to include in log lines

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

async function uploadAndAwaitProcessing(
  fileManager: GoogleAIFileManager,
  filePath: string,
  mimeType: string,
): Promise<FileMetadataResponse> {
  log.info(`Uploading file for transcription: ${filePath}`);
  const uploadResult = await fileManager.uploadFile(filePath, {
    mimeType,
    displayName: basename(filePath),
  });

  let file = uploadResult.file;
  while (file.state === 'PROCESSING') {
    log.info(`Waiting for file processing: ${file.name} (state: ${file.state})`);
    await new Promise((r) => setTimeout(r, FILE_PROCESSING_POLL_INTERVAL_MS));
    file = await fileManager.getFile(file.name);
  }

  if (file.state === 'FAILED') {
    throw new Error(`File processing failed: ${file.name}`);
  }

  return file;
}

async function transcribeFile(filePath: string, mimeType: string): Promise<string> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY is not set');

  const fileManager = new GoogleAIFileManager(apiKey);
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const file = await uploadAndAwaitProcessing(fileManager, filePath, mimeType);

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
              { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
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

  const date = new Date().toISOString().slice(0, ISO_DATE_LENGTH);
  const sourceName = basename(filePath).replace(/\.[^.]+$/, '');
  const transcriptPath = join(TRANSCRIPTS_DIR, `${date}-${sourceName}.txt`);

  writeFileSync(transcriptPath, transcript, 'utf-8');
  log.info(`Transcript saved to ${transcriptPath}`);
  return transcriptPath;
}

interface VoiceTranscriptionContext {
  bus: EventBusInterface;
  projectId: string;
  topicId: number | undefined;
  topicName: string | undefined;
}

function emitVoiceNotification(
  bus: EventBusInterface,
  topicName: string | undefined,
  body: string,
): void {
  bus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SOURCE_GEMINI,
    type: 'notification',
    payload: {
      channel: 'telegram',
      title: 'Voice Transcription',
      body,
      topicName,
    },
  });
}

function emitTranscribedChatMessage(ctx: VoiceTranscriptionContext, message: string): void {
  ctx.bus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SOURCE_GEMINI,
    projectId: ctx.projectId,
    type: 'user:chat:message',
    payload: {
      projectId: ctx.projectId,
      message,
      topicId: ctx.topicId,
      topicName: ctx.topicName,
    },
  });
}

function handleVoiceTranscriptionError(ctx: VoiceTranscriptionContext, err: unknown): void {
  const isTimeout =
    err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'));

  if (isTimeout) {
    log.warn(`Transcription timed out for project ${ctx.projectId}`);
    emitVoiceNotification(
      ctx.bus,
      ctx.topicName,
      "Couldn't transcribe that — please type your message",
    );
  } else {
    log.error(`Transcription error for project ${ctx.projectId}: ${err}`);
    emitVoiceNotification(
      ctx.bus,
      ctx.topicName,
      'Voice transcription is temporarily unavailable — please type your message',
    );
  }
}

async function handleVoiceReceived(
  event: VoiceReceivedEvent,
  transcriber: ReturnType<typeof createTranscriber>,
): Promise<void> {
  const { projectId, audioData, mimeType, topicId, topicName } = event.payload;

  if (!eventBus) return;
  const ctx: VoiceTranscriptionContext = { bus: eventBus, projectId, topicId, topicName };

  try {
    const transcription = await transcriber.transcribe(audioData, mimeType);

    log.info(
      `Transcription complete for project ${projectId}: ${transcription.slice(0, TRANSCRIPTION_LOG_PREVIEW_LENGTH)}`,
    );

    // Notify user of transcribed text
    emitVoiceNotification(ctx.bus, ctx.topicName, `Voice: ${transcription}`);

    // Emit as user:chat:message so orchestrator processes it
    emitTranscribedChatMessage(ctx, transcription);
  } catch (err) {
    handleVoiceTranscriptionError(ctx, err);
  }
}

function emitTranscriptionSuccess(
  bus: EventBusInterface,
  transcriptPath: string,
  data: TranscriptionRequestEvent['payload'],
): void {
  const { filePath, projectId, createKnowledgeBubble, topicId, topicName } = data;

  bus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SOURCE_GEMINI,
    type: 'transcription:complete',
    payload: { filePath, transcriptPath, projectId, topicId, topicName },
  });

  if (createKnowledgeBubble) {
    bus.emit({
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

  bus.emit({
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
}

async function processTranscriptionRequest(
  bus: EventBusInterface,
  data: TranscriptionRequestEvent['payload'],
): Promise<void> {
  const { filePath, mimeType, projectId } = data;

  try {
    const transcript = await transcribeFile(filePath, mimeType);
    const transcriptPath = saveTranscript(filePath, transcript);

    emitTranscriptionSuccess(bus, transcriptPath, data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`File transcription failed: ${msg}`);
    bus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: SOURCE_GEMINI,
      type: 'transcription:failed',
      payload: { filePath, error: msg, projectId },
    });
  }
}

function createTranscriptionRequestHandler(bus: EventBusInterface): (event: unknown) => void {
  return (event: unknown): void => {
    const parsed = TranscriptionRequestPayloadSchema.safeParse(
      (event as Record<string, unknown>).payload,
    );
    if (!parsed.success) {
      log.error(`Invalid transcription:request payload: ${parsed.error.message}`);
      return;
    }

    processTranscriptionRequest(bus, parsed.data).catch((err) => {
      log.error(`Unhandled error in transcription handler: ${err}`);
    });
  };
}

const service: RavenService = {
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

    transcriptionHandler = createTranscriptionRequestHandler(context.eventBus);
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
