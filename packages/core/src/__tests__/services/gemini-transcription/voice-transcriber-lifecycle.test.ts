import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as GeminiServer from '@google/generative-ai/server';
import type { RavenEvent } from '@raven/shared';
import type { ServiceContext } from '../../../services/types.ts';
import service from '../../../services/gemini-transcription/voice-transcriber.ts';

const gemini = vi.hoisted(() => ({
  generateContent: vi.fn(),
  fileManager: vi.fn(),
  uploadFile: vi.fn(),
  getFile: vi.fn(),
  deleteFile: vi.fn(),
}));
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel() {
      return { generateContent: gemini.generateContent };
    }
  },
}));
vi.mock('@google/generative-ai/server', () => ({
  GoogleAIFileManager: vi.fn(function FileManager(...args: unknown[]) {
    return gemini.fileManager(...args);
  }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const readyFile = { name: 'fixture', state: 'ACTIVE', mimeType: 'audio/mp3', uri: 'fake:audio' };
const transcript = (text: string) => ({ response: { text: () => text } });

describe('voice request shutdown and deadlines', () => {
  let root: string;
  let inputPath: string;
  let events: RavenEvent[];
  let handlers: Map<string, (event: unknown) => void>;
  let fileSignal: AbortSignal;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('GOOGLE_API_KEY', 'fake-lifecycle-key');
    root = mkdtempSync(join(tmpdir(), 'raven-voice-lifecycle-'));
    inputPath = join(root, 'lecture.mp3');
    writeFileSync(inputPath, 'Fake audio for isolated SDK transport');
    events = [];
    handlers = new Map();
    gemini.generateContent.mockReset().mockResolvedValue(transcript('Fresh transcript'));
    gemini.uploadFile.mockReset().mockResolvedValue({ file: readyFile });
    gemini.getFile.mockReset().mockResolvedValue(readyFile);
    gemini.deleteFile.mockReset().mockResolvedValue(undefined);
    gemini.fileManager.mockReset().mockImplementation((_key, options) => {
      fileSignal = options.signal;
      return gemini;
    });
  });

  afterEach(async () => {
    await service.stop();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(root, { recursive: true, force: true });
  });

  function context(projectRoot = root): ServiceContext {
    return {
      eventBus: {
        emit: (event) => events.push(event as RavenEvent),
        on: (type, handler) => handlers.set(type, handler),
        off: (type, handler) => {
          if (handlers.get(type) === handler) handlers.delete(type);
        },
      },
      projectRoot,
      db: { run: vi.fn(), get: () => undefined, all: () => [] },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      config: {},
      integrationsConfig: {} as ServiceContext['integrationsConfig'],
      jobRegistry: {} as ServiceContext['jobRegistry'],
    };
  }

  function dispatchVoice() {
    handlers.get('voice:received')!({
      payload: {
        projectId: 'fixture',
        audioData: 'fake-audio',
        mimeType: 'audio/ogg',
      },
    });
  }
  function dispatchFile() {
    handlers.get('transcription:request')!({
      payload: {
        filePath: inputPath,
        mimeType: 'audio/mp3',
        projectId: 'fixture',
      },
    });
  }
  async function settle() {
    await vi.advanceTimersByTimeAsync(0);
  }
  function expectStopped() {
    expect(handlers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(events).toEqual([]);
    expect(existsSync(join(root, 'data/files/transcripts'))).toBe(false);
  }

  it('settles queued work without invoking Gemini after stop', async () => {
    await service.start(context());
    dispatchVoice();
    await service.stop();
    expect(gemini.generateContent).not.toHaveBeenCalled();
    expectStopped();
  });

  it('aborts an active voice request and ignores its late result across restart', async () => {
    const late = deferred<ReturnType<typeof transcript>>();
    gemini.generateContent.mockReturnValueOnce(late.promise);
    await service.start(context());
    const oldHandler = handlers.get('voice:received')!;
    dispatchVoice();
    await settle();
    const signal: AbortSignal = gemini.generateContent.mock.calls[0][1].signal;
    await service.stop();
    expect(signal.aborted).toBe(true);
    expectStopped();
    await service.start(context(join(root, 'restart')));
    oldHandler({ payload: {} });
    dispatchVoice();
    await settle();
    late.resolve(transcript('Stale transcript'));
    await settle();
    expect(events.filter((event) => event.type === 'user:chat:message')).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ message: 'Fresh transcript' }),
      }),
    ]);
    expect(gemini.generateContent).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not poll or infer when an upload resolves after stop', async () => {
    const late = deferred<{ file: typeof readyFile }>();
    gemini.uploadFile.mockReturnValue(late.promise);
    await service.start(context());
    dispatchFile();
    await settle();
    await service.stop();
    expect(fileSignal.aborted).toBe(true);
    late.resolve({ file: readyFile });
    await settle();
    expect(gemini.getFile).not.toHaveBeenCalled();
    expect(gemini.generateContent).not.toHaveBeenCalled();
    expectStopped();
  });

  it('clears the processing poll delay and deadline on stop', async () => {
    gemini.uploadFile.mockResolvedValue({ file: { ...readyFile, state: 'PROCESSING' } });
    await service.start(context());
    dispatchFile();
    await settle();
    expect(vi.getTimerCount()).toBe(2);
    await service.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(gemini.getFile).not.toHaveBeenCalled();
    expectStopped();
  });

  it('ignores a late processing response without starting inference', async () => {
    const late = deferred<typeof readyFile>();
    gemini.uploadFile.mockResolvedValue({ file: { ...readyFile, state: 'PROCESSING' } });
    gemini.getFile.mockReturnValue(late.promise);
    await service.start(context());
    dispatchFile();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(gemini.getFile).toHaveBeenCalledTimes(1);
    await service.stop();
    late.resolve(readyFile);
    await settle();
    expect(gemini.generateContent).not.toHaveBeenCalled();
    expectStopped();
  });

  it.each(['inference', 'cleanup'])(
    'suppresses file and event output after stop during %s',
    async (phase) => {
      const late = deferred<ReturnType<typeof transcript> | undefined>();
      if (phase === 'inference') gemini.generateContent.mockReturnValue(late.promise);
      else gemini.deleteFile.mockReturnValue(late.promise);
      await service.start(context());
      dispatchFile();
      await settle();
      expect(gemini.generateContent).toHaveBeenCalledTimes(1);
      if (phase === 'cleanup') expect(gemini.deleteFile).toHaveBeenCalledTimes(1);
      await service.stop();
      expect(fileSignal.aborted).toBe(true);
      late.resolve(phase === 'inference' ? transcript('Stale file') : undefined);
      await settle();
      expectStopped();
    },
  );

  it('times out a noncooperative voice request once and suppresses its later success', async () => {
    const late = deferred<ReturnType<typeof transcript>>();
    gemini.generateContent.mockReturnValue(late.promise);
    await service.start(context());
    dispatchVoice();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'notification',
        payload: expect.objectContaining({
          body: "Couldn't transcribe that — please type your message",
        }),
      }),
    ]);
    expect(gemini.generateContent.mock.calls[0][1].signal.aborted).toBe(true);
    late.resolve(transcript('Too late'));
    await settle();
    expect(events).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds the complete upload/processing journey by the file deadline', async () => {
    gemini.uploadFile.mockReturnValue(new Promise(() => {}));
    await service.start(context());
    dispatchFile();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fileSignal.aborted).toBe(true);
    expect(events).toEqual([expect.objectContaining({ type: 'transcription:failed' })]);
    expect(gemini.generateContent).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('deletes a known upload when provider processing fails before inference', async () => {
    gemini.uploadFile.mockResolvedValue({ file: { ...readyFile, state: 'FAILED' } });
    await service.start(context());
    dispatchFile();
    await settle();
    expect(gemini.deleteFile).toHaveBeenCalledExactlyOnceWith('fixture');
    expect(gemini.generateContent).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({
        type: 'transcription:failed',
        payload: expect.objectContaining({ error: 'File processing failed: fixture' }),
      }),
    ]);
    expect(vi.getTimerCount()).toBe(0);
    expect(existsSync(join(root, 'data/files/transcripts'))).toBe(false);
  });

  it('stops further output when an event listener synchronously stops the service', async () => {
    const serviceContext = context();
    let stopped: Promise<void> | void = undefined;
    serviceContext.eventBus.emit = (event) => {
      events.push(event as RavenEvent);
      stopped = service.stop();
    };
    await service.start(serviceContext);
    dispatchVoice();
    await settle();
    await stopped;
    expect(events.map((event) => event.type)).toEqual(['notification']);
    expect(handlers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['upload', 'delete'])(
    'aborts the installed FileManager %s transport through its constructor signal',
    async (phase) => {
      const actual = await vi.importActual<typeof GeminiServer>('@google/generative-ai/server');
      gemini.fileManager.mockImplementation(
        (key, options) => new actual.GoogleAIFileManager(key, options),
      );
      let transportSignal: AbortSignal | undefined;
      const fetch = vi.fn((_url: unknown, options: RequestInit) => {
        if (phase === 'delete' && options.method === 'POST') {
          return Promise.resolve(new Response(JSON.stringify({ file: readyFile })));
        }
        transportSignal = options.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          transportSignal!.addEventListener('abort', () => reject(transportSignal!.reason), {
            once: true,
          });
        });
      });
      vi.stubGlobal('fetch', fetch);
      await service.start(context());
      dispatchFile();
      await settle();
      expect(fetch).toHaveBeenCalledTimes(phase === 'upload' ? 1 : 2);
      expect(transportSignal?.aborted).toBe(false);
      await service.stop();
      expect(transportSignal?.aborted).toBe(true);
      expectStopped();
    },
  );
});
