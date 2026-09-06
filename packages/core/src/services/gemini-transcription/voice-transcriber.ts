import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  GoogleAIFileManager,
  type FileMetadataResponse,
  type SingleRequestOptions,
} from '@google/generative-ai/server';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  generateId,
  createLogger,
  SOURCE_GEMINI,
  TranscriptionRequestPayloadSchema,
  type EventBusInterface,
  type VoiceReceivedEvent,
  type TranscriptionRequestEvent,
  type UserChatRejectedEvent,
} from '@raven/shared';
import type { ServiceContext, RavenService } from '../types.ts';
import {
  createTranscriptionLifetime,
  type TranscriptionLifetime,
  type TranscriptionRequest,
} from './transcription-lifetime.ts';
import type { GeminiUploadCleanup } from './upload-cleanup.ts';

const log = createLogger('voice-transcriber');
const TRANSCRIPTION_TIMEOUT_MS = 30_000;
const FILE_TRANSCRIPTION_TIMEOUT_MS = 600_000; // 10 minutes for long files
const FILE_PROCESSING_POLL_INTERVAL_MS = 5000; // delay between "still processing" checks
const ISO_DATE_LENGTH = 10; // length of the YYYY-MM-DD prefix of an ISO timestamp
const TRANSCRIPTION_LOG_PREVIEW_LENGTH = 100; // chars of transcript to include in log lines

interface ActiveService {
  bus: EventBusInterface;
  lifetime: TranscriptionLifetime;
  voiceHandler: (event: unknown) => void;
  transcriptionHandler: (event: unknown) => void;
}
let activeService: ActiveService | null = null;
let stopping = Promise.resolve();

function createTranscriber(): {
  transcribe: (
    audioData: string,
    mimeType: string,
    request: TranscriptionRequest,
  ) => Promise<string>;
} {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_API_KEY is not set');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  return {
    async transcribe(audioData, mimeType, request): Promise<string> {
      const result = await request.wait(() =>
        model.generateContent(
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
          { signal: request.signal },
        ),
      );
      return result.response.text();
    },
  };
}

async function uploadAndAwaitProcessing(input: {
  fileManager: GoogleAIFileManager;
  data: { filePath: string; mimeType: string };
  request: TranscriptionRequest;
  uploadCleanup: GeminiUploadCleanup;
  cleanupId: string;
}): Promise<FileMetadataResponse> {
  const { fileManager, data, request, uploadCleanup, cleanupId } = input;
  const { filePath, mimeType } = data;
  log.info(`Uploading file for transcription: ${filePath}`);
  const uploadResult = await request.wait(() => {
    const uploadPromise = fileManager.uploadFile(filePath, {
      mimeType,
      displayName: basename(filePath),
    });
    return uploadCleanup.observeUpload(cleanupId, uploadPromise);
  });

  const uploaded = readProviderFile(uploadResult?.file);
  if (!uploaded) {
    throw new Error('Upload response missing valid remote file metadata');
  }
  const remoteName = uploaded.name;
  return awaitFileProcessing({ fileManager, file: uploaded, remoteName, request });
}

async function awaitFileProcessing(input: {
  fileManager: GoogleAIFileManager;
  file: FileMetadataResponse;
  remoteName: string;
  request: TranscriptionRequest;
}): Promise<FileMetadataResponse> {
  const { fileManager, remoteName, request } = input;
  let file = input.file;
  while (file.state === 'PROCESSING') {
    log.info(`Waiting for file processing: ${remoteName} (state: ${file.state})`);
    await request.delay(FILE_PROCESSING_POLL_INTERVAL_MS);
    const polled = await request.wait(() =>
      fileManager.getFile(remoteName, { signal: request.signal }),
    );
    const nextFile = readProviderFile(polled);
    if (!nextFile) {
      throw new Error(`Provider file metadata invalid for ${remoteName}`);
    }
    if (nextFile.name !== remoteName) {
      throw new Error(`Provider file identity changed for ${remoteName}`);
    }
    file = nextFile;
  }

  if (file.state === 'FAILED') {
    throw new Error(`File processing failed: ${remoteName}`);
  }
  if (file.state !== 'ACTIVE' || !isNonEmptyString(file.mimeType) || !isNonEmptyString(file.uri)) {
    throw new Error(`Provider file metadata is not ready for ${remoteName}`);
  }

  return file;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isValidRemoteName(value: unknown): value is string {
  return typeof value === 'string' && /^(?:files\/)?[A-Za-z0-9_-]+$/.test(value);
}

function readProviderFile(value: unknown): FileMetadataResponse | null {
  if (!value || typeof value !== 'object') return null;
  const file = value as Partial<FileMetadataResponse>;
  if (!isValidRemoteName(file.name)) return null;
  if (
    file.state !== 'STATE_UNSPECIFIED' &&
    file.state !== 'PROCESSING' &&
    file.state !== 'ACTIVE' &&
    file.state !== 'FAILED'
  ) {
    return null;
  }
  return file as FileMetadataResponse;
}

async function transcribeFile(input: {
  filePath: string;
  mimeType: string;
  request: TranscriptionRequest;
  uploadCleanup: GeminiUploadCleanup | undefined;
  correlationId: string;
  projectId: string | undefined;
}): Promise<string> {
  const { filePath, mimeType, request, uploadCleanup, correlationId, projectId } = input;
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY is not set');
  if (!uploadCleanup) throw new Error('Gemini upload cleanup coordinator is unavailable');

  // The installed SDK forwards these options to upload, get and delete fetches.
  // Own the deadline locally: the SDK's timeout option leaves its timer behind.
  const requestOptions: SingleRequestOptions = { signal: request.signal };
  const fileManager = new GoogleAIFileManager(apiKey, requestOptions);
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const cleanupId = uploadCleanup.begin({ correlationId, projectId, sourceFilePath: filePath });
  try {
    const file = await uploadAndAwaitProcessing({
      fileManager,
      data: { filePath, mimeType },
      request,
      uploadCleanup,
      cleanupId,
    });

    log.info(`File ready, starting transcription: ${file.name}`);
    return await inferFile(model, file, request);
  } finally {
    // finish() durably records the outcome and owns its independent bounded
    // deletion attempt; it must not delay transcription cancellation.
    uploadCleanup.finish(cleanupId);
  }
}

async function inferFile(
  model: ReturnType<GoogleGenerativeAI['getGenerativeModel']>,
  file: FileMetadataResponse,
  request: TranscriptionRequest,
): Promise<string> {
  const result = await request.wait(() =>
    model.generateContent(
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
      { signal: request.signal },
    ),
  );

  return result.response.text();
}

function saveTranscript(outputDir: string, filePath: string, transcript: string): string {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const date = new Date().toISOString().slice(0, ISO_DATE_LENGTH);
  const sourceName = basename(filePath).replace(/\.[^.]+$/, '');
  const transcriptPath = join(outputDir, `${date}-${sourceName}.txt`);

  writeFileSync(transcriptPath, transcript, 'utf-8');
  log.info(`Transcript saved to ${transcriptPath}`);
  return transcriptPath;
}

interface VoiceTranscriptionContext {
  bus: TranscriptionLifetime;
  projectId: string;
  topicId: number | undefined;
  topicName: string | undefined;
  transportOrigin: VoiceReceivedEvent['payload']['transportOrigin'];
  requestId: string | undefined;
  sessionId: string | undefined;
}

function emitVoiceNotification(
  bus: TranscriptionLifetime,
  input: { projectId: string; topicName?: string; body: string },
): void {
  bus.emit({
    id: generateId(),
    timestamp: Date.now(),
    source: SOURCE_GEMINI,
    type: 'notification',
    payload: {
      channel: 'telegram',
      title: 'Voice Transcription',
      body: input.body,
      topicName: input.topicName,
      destination: { kind: 'project', projectId: input.projectId },
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
      transportOrigin: ctx.transportOrigin,
      requestId: ctx.requestId,
      sessionId: ctx.sessionId,
    },
  });
}

function handleVoiceTranscriptionError(ctx: VoiceTranscriptionContext, err: unknown): void {
  const isTimeout =
    err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'));

  const body = isTimeout
    ? "Couldn't transcribe that — please type your message"
    : 'Voice transcription is temporarily unavailable — please type your message';
  if (isTimeout) {
    log.warn(`Transcription timed out for project ${ctx.projectId}`);
  } else {
    log.error(`Transcription error for project ${ctx.projectId}: ${err}`);
  }
  if (ctx.requestId) {
    ctx.bus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: SOURCE_GEMINI,
      type: 'user:chat:rejected',
      projectId: ctx.projectId,
      payload: {
        requestId: ctx.requestId,
        projectId: ctx.projectId,
        sessionId: ctx.sessionId,
        error: body,
      },
    } satisfies UserChatRejectedEvent);
  } else {
    emitVoiceNotification(ctx.bus, {
      projectId: ctx.projectId,
      topicName: ctx.topicName,
      body,
    });
  }
}

async function handleVoiceReceived(
  event: VoiceReceivedEvent,
  options: { transcriber: ReturnType<typeof createTranscriber>; lifetime: TranscriptionLifetime },
  request: TranscriptionRequest,
): Promise<void> {
  const { transcriber, lifetime } = options;
  const {
    projectId,
    audioData,
    mimeType,
    topicId,
    topicName,
    transportOrigin,
    requestId,
    sessionId,
  } = event.payload;

  const ctx: VoiceTranscriptionContext = {
    bus: lifetime,
    projectId,
    topicId,
    topicName,
    transportOrigin,
    requestId,
    sessionId,
  };

  try {
    const transcription = await transcriber.transcribe(audioData, mimeType, request);
    request.signal.throwIfAborted();

    log.info(
      `Transcription complete for project ${projectId}: ${transcription.slice(0, TRANSCRIPTION_LOG_PREVIEW_LENGTH)}`,
    );

    // Notify user of transcribed text
    emitVoiceNotification(ctx.bus, {
      projectId: ctx.projectId,
      topicName: ctx.topicName,
      body: `Voice: ${transcription}`,
    });

    // Emit as user:chat:message so orchestrator processes it
    emitTranscribedChatMessage(ctx, transcription);
  } catch (err) {
    if (lifetime.isActive()) handleVoiceTranscriptionError(ctx, err);
  }
}

function emitTranscriptionSuccess(
  bus: TranscriptionLifetime,
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
        taskId: generateId(),
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
      destination: projectId
        ? { kind: 'project' as const, projectId }
        : { kind: 'global' as const, topic: 'general' as const },
    },
  });
}

async function processTranscriptionRequest(input: {
  context: { bus: TranscriptionLifetime; outputDir: string };
  data: TranscriptionRequestEvent['payload'];
  request: TranscriptionRequest;
  uploadCleanup: GeminiUploadCleanup | undefined;
  correlationId: string;
}): Promise<void> {
  const { context, data, request, uploadCleanup, correlationId } = input;
  const { bus, outputDir } = context;
  const { filePath, mimeType, projectId } = data;

  try {
    const transcript = await transcribeFile({
      filePath,
      mimeType,
      request,
      uploadCleanup,
      correlationId,
      projectId,
    });
    request.signal.throwIfAborted();
    const transcriptPath = saveTranscript(outputDir, filePath, transcript);

    emitTranscriptionSuccess(bus, transcriptPath, data);
  } catch (err) {
    if (!bus.isActive()) return;
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

function createTranscriptionRequestHandler(
  bus: TranscriptionLifetime,
  outputDir: string,
  uploadCleanup: GeminiUploadCleanup | undefined,
): (event: unknown) => void {
  return (event: unknown): void => {
    if (!bus.isActive()) return;
    const parsed = TranscriptionRequestPayloadSchema.safeParse(
      (event as Record<string, unknown>).payload,
    );
    if (!parsed.success) {
      log.error(`Invalid transcription:request payload: ${parsed.error.message}`);
      return;
    }

    const eventId = (event as { id?: unknown }).id;
    const correlationId = isNonEmptyString(eventId) ? eventId : generateId();

    void bus
      .run(FILE_TRANSCRIPTION_TIMEOUT_MS, (request) =>
        processTranscriptionRequest({
          context: { bus, outputDir },
          data: parsed.data,
          request,
          uploadCleanup,
          correlationId,
        }),
      )
      .catch((err: unknown) => {
        if (bus.isActive()) log.error(`Unhandled error in transcription handler: ${err}`);
      });
  };
}

function stopCurrentService(): Promise<void> {
  const current = activeService;
  activeService = null;
  if (!current) return stopping;
  const stopped = current.lifetime.stop();
  current.bus.off('voice:received', current.voiceHandler);
  current.bus.off('transcription:request', current.transcriptionHandler);
  stopping = Promise.all([stopping, stopped]).then(() => {});
  return stopping;
}

const service: RavenService = {
  async start(context: ServiceContext): Promise<void> {
    const stopped = stopCurrentService();

    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      log.warn('GOOGLE_API_KEY not set, voice transcription disabled');
      await stopped;
      return;
    }

    const transcriber = createTranscriber();
    const lifetime = createTranscriptionLifetime(context.eventBus);
    const uploadCleanup = context.geminiUploadCleanup;

    const voiceHandler = (event: unknown): void => {
      const voiceEvent = event as VoiceReceivedEvent;
      void lifetime
        .run(TRANSCRIPTION_TIMEOUT_MS, (request) =>
          handleVoiceReceived(voiceEvent, { transcriber, lifetime }, request),
        )
        .catch((err: unknown) => {
          if (lifetime.isActive()) log.error(`Unhandled error in voice handler: ${err}`);
        });
    };

    const transcriptionHandler = createTranscriptionRequestHandler(
      lifetime,
      resolve(context.projectRoot, 'data/files/transcripts'),
      uploadCleanup,
    );
    activeService = { bus: context.eventBus, lifetime, voiceHandler, transcriptionHandler };
    context.eventBus.on('voice:received', voiceHandler);
    context.eventBus.on('transcription:request', transcriptionHandler);
    await stopped;
    log.info('Voice transcriber service started');
  },

  async stop(): Promise<void> {
    await stopCurrentService();
    log.info('Voice transcriber service stopped');
  },
};

export default service;
