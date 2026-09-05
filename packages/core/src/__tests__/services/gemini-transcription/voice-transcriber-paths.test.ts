import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseInterface, TranscriptionCompleteEvent, RavenEvent } from '@raven/shared';
import type { ServiceContext } from '../../../services/types.ts';
import { closeDatabase, createDbInterface, initDatabase } from '../../../db/database.ts';
import {
  createGeminiUploadCleanup,
  type GeminiUploadCleanup,
} from '../../../services/gemini-transcription/upload-cleanup.ts';
import service from '../../../services/gemini-transcription/voice-transcriber.ts';

const gemini = vi.hoisted(() => ({ generateContent: vi.fn() }));
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel() {
      return { generateContent: gemini.generateContent };
    }
  },
}));
vi.mock('@google/generative-ai/server', () => ({
  GoogleAIFileManager: class {
    async uploadFile() {
      return {
        file: { name: 'fixture', state: 'ACTIVE', mimeType: 'audio/mp3', uri: 'fake:audio' },
      };
    }
    async deleteFile() {}
  },
}));

describe('voice transcript runtime paths', () => {
  let root: string;
  let originalCwd: string;
  let workingDir: string;
  let inputPath: string;
  let events: RavenEvent[];
  let handlers: Map<string, (event: unknown) => void>;
  let database: DatabaseInterface;
  let uploadCleanup: GeminiUploadCleanup;

  beforeEach(() => {
    originalCwd = process.cwd();
    root = mkdtempSync(join(tmpdir(), 'raven-voice-paths-'));
    workingDir = join(root, 'unrelated-cwd');
    mkdirSync(workingDir);
    process.chdir(workingDir);
    inputPath = join(root, 'lecture.mp3');
    writeFileSync(inputPath, 'Fixture audio; Gemini execution is mocked');
    initDatabase(join(root, 'raven.db'));
    database = createDbInterface();
    uploadCleanup = createGeminiUploadCleanup({
      db: database,
      deleteFile: async () => {},
    });
    vi.stubEnv('GOOGLE_API_KEY', 'fake-transcription-key');
    gemini.generateContent.mockReset().mockResolvedValue({
      response: { text: () => 'Fixture transcript' },
    });
    events = [];
    handlers = new Map();
  });

  afterEach(async () => {
    try {
      await service.stop();
      await uploadCleanup.stop();
      closeDatabase();
    } finally {
      process.chdir(originalCwd);
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  function context(projectRoot: string): ServiceContext {
    return {
      eventBus: {
        emit: (event) => events.push(event as RavenEvent),
        on: (type, handler) => handlers.set(type, handler),
        off: (type, handler) => {
          if (handlers.get(type) === handler) handlers.delete(type);
        },
      },
      projectRoot,
      db: database,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      config: {},
      geminiUploadCleanup: uploadCleanup,
      integrationsConfig: {} as ServiceContext['integrationsConfig'],
      jobRegistry: {} as ServiceContext['jobRegistry'],
    };
  }

  async function transcribe(): Promise<TranscriptionCompleteEvent> {
    const before = events.length;
    handlers.get('transcription:request')!({
      payload: { filePath: inputPath, mimeType: 'audio/mp3', projectId: 'fixture-project' },
    });
    await vi.waitFor(() => {
      expect(events.slice(before).some((event) => event.type === 'transcription:complete')).toBe(
        true,
      );
    });
    return events.slice(before).find((event) => event.type === 'transcription:complete')!;
  }

  it('writes under the configured root captured at startup, independent of CWD', async () => {
    const runtimeRoot = join(root, 'runtime');
    const startContext = context(runtimeRoot);
    await service.start(startContext);
    startContext.projectRoot = join(root, 'changed-context');
    const completed = await transcribe();
    const outputDir = join(runtimeRoot, 'data/files/transcripts');
    expect(completed.payload.transcriptPath).toBe(
      join(outputDir, `${new Date().toISOString().slice(0, 10)}-lecture.txt`),
    );
    expect(readFileSync(completed.payload.transcriptPath, 'utf8')).toBe('Fixture transcript');
    expect(existsSync(join(workingDir, 'data'))).toBe(false);
    expect(existsSync(startContext.projectRoot)).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'knowledge:ingest:request',
        payload: expect.objectContaining({ filePath: completed.payload.transcriptPath }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'notification',
        payload: expect.objectContaining({ filePath: completed.payload.transcriptPath }),
      }),
    );
  });

  it('uses the new configured root after a stop and restart', async () => {
    const firstRoot = join(root, 'first-runtime');
    const secondRoot = join(root, 'second-runtime');
    await service.start(context(firstRoot));
    const first = await transcribe();
    await service.stop();
    expect(handlers.size).toBe(0);
    gemini.generateContent.mockResolvedValue({ response: { text: () => 'Second transcript' } });
    await service.start(context(secondRoot));
    const second = await transcribe();
    expect(second.payload.transcriptPath).toBe(
      join(
        secondRoot,
        'data/files/transcripts',
        `${new Date().toISOString().slice(0, 10)}-lecture.txt`,
      ),
    );
    expect(readFileSync(first.payload.transcriptPath, 'utf8')).toBe('Fixture transcript');
    expect(readFileSync(second.payload.transcriptPath, 'utf8')).toBe('Second transcript');
    expect(existsSync(join(workingDir, 'data'))).toBe(false);
  });
});
