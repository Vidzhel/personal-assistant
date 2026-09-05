import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const DEFAULT_KILL_GRACE_MS = 1_000;
const KIBIBYTE = 1024;
const MAX_OUTPUT_BYTES = KIBIBYTE * KIBIBYTE;

export interface RunCodeProcessOptions {
  signal?: AbortSignal;
  killGraceMs?: number;
}

export interface RunCodeProcessResult {
  stdout: string;
  stderr: string;
}

export class RunCodeProcessError extends Error {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(options: {
    command: string;
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }) {
    const detail = options.signal
      ? `signal ${options.signal}`
      : `exit code ${String(options.code)}`;
    super(`${options.command} failed with ${detail}`);
    this.name = 'RunCodeProcessError';
    this.code = options.code;
    this.signal = options.signal;
    this.stdout = options.stdout;
    this.stderr = options.stderr;
  }
}

export class RunCodeOutputLimitError extends Error {
  constructor() {
    super(`Code process output exceeded ${MAX_OUTPUT_BYTES} bytes`);
    this.name = 'RunCodeOutputLimitError';
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function terminateProcess(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') child.kill('SIGTERM');
    else process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function killProcess(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

type ProcessState = {
  stdout: string;
  stderr: string;
  spawnError?: Error;
  cancellationReason?: unknown;
  killTimer?: ReturnType<typeof setTimeout>;
  terminationRequested: boolean;
  terminationFinished: boolean;
  outputError?: Error;
  finish?: () => void;
  settled: boolean;
};

type ProcessSettler = (callback: () => void) => void;

type OutputCollector = {
  done: Promise<void>;
};

function collectOutput(
  stream: NodeJS.ReadableStream | null | undefined,
  append: (chunk: string) => void,
  onOverflow: () => void,
): OutputCollector {
  if (!stream) return { done: Promise.resolve() };
  const decoder = new StringDecoder('utf8');
  let bytes = 0;
  let finished = false;
  let overflowed = false;
  const done = new Promise<void>((resolve) => {
    const finish = (): void => {
      if (finished) return;
      finished = true;
      stream.removeListener('data', onData);
      stream.removeListener('end', finish);
      stream.removeListener('close', finish);
      if (!overflowed) append(decoder.end());
      resolve();
    };
    const onData = (chunk: Buffer | string): void => {
      if (overflowed) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > MAX_OUTPUT_BYTES) {
        overflowed = true;
        onOverflow();
        return;
      }
      append(decoder.write(buffer));
    };
    stream.on('data', onData);
    stream.once('end', finish);
    stream.once('close', finish);
  });
  return { done };
}

function settleProcess(state: ProcessState, cleanup: () => void, callback: () => void): void {
  if (state.settled) return;
  state.settled = true;
  cleanup();
  callback();
}

function closeHandler(options: {
  state: ProcessState;
  command: string;
  settle: ProcessSettler;
  resolve: (result: RunCodeProcessResult) => void;
  reject: (error: unknown) => void;
  output: Promise<void>;
}): (code: number | null, signal: NodeJS.Signals | null) => void {
  const { state, command, settle, resolve, reject, output } = options;
  return (code, closeSignal) => {
    void output.then(() => {
      if (!state.terminationFinished) return;
      if (state.cancellationReason !== undefined) {
        settle(() => reject(state.cancellationReason));
      } else if (state.outputError) {
        settle(() => reject(state.outputError));
      } else if (state.spawnError) {
        settle(() => reject(state.spawnError));
      } else if (code === 0 && closeSignal === null) {
        settle(() => resolve({ stdout: state.stdout, stderr: state.stderr }));
      } else {
        settle(() =>
          reject(
            new RunCodeProcessError({
              command,
              code,
              signal: closeSignal,
              stdout: state.stdout,
              stderr: state.stderr,
            }),
          ),
        );
      }
    });
  };
}

function requestTermination(options: {
  child: ChildProcess;
  state: ProcessState;
  killGraceMs: number;
}): void {
  const { child, state, killGraceMs } = options;
  if (state.terminationRequested) return;
  state.terminationRequested = true;
  state.terminationFinished = false;
  try {
    terminateProcess(child);
  } catch (error) {
    state.spawnError = error instanceof Error ? error : new Error(String(error));
  }
  state.killTimer = setTimeout(
    () => {
      try {
        killProcess(child);
      } catch (error) {
        if (!state.spawnError)
          state.spawnError = error instanceof Error ? error : new Error(String(error));
      } finally {
        state.terminationFinished = true;
        state.finish?.();
      }
    },
    Math.max(0, killGraceMs),
  );
}

function abortHandler(options: {
  child: ChildProcess;
  state: ProcessState;
  signal: AbortSignal;
  killGraceMs: number;
}): () => void {
  const { child, state, signal, killGraceMs } = options;
  return () => {
    if (state.cancellationReason !== undefined || state.settled) return;
    state.cancellationReason = abortReason(signal);
    requestTermination({ child, state, killGraceMs });
  };
}

type MonitorOptions = {
  child: ChildProcess;
  command: string;
  signal: AbortSignal | undefined;
  killGraceMs: number;
};

function collectProcessOutput(
  child: ChildProcess,
  state: ProcessState,
  onOverflow: () => void,
): Promise<void> {
  const stdout = collectOutput(child.stdout, (chunk) => (state.stdout += chunk), onOverflow);
  const stderr = collectOutput(child.stderr, (chunk) => (state.stderr += chunk), onOverflow);
  return Promise.all([stdout.done, stderr.done]).then(() => undefined);
}

function attachProcessMonitor(options: {
  child: ChildProcess;
  command: string;
  signal: AbortSignal | undefined;
  killGraceMs: number;
  state: ProcessState;
  resolve: (result: RunCodeProcessResult) => void;
  reject: (error: unknown) => void;
}): void {
  const { child, command, signal, killGraceMs, state, resolve, reject } = options;
  const onError = (error: Error): void => {
    state.spawnError = error;
  };
  const listeners: {
    close?: (code: number | null, signal: NodeJS.Signals | null) => void;
  } = {};
  const onAbort = signal ? abortHandler({ child, state, signal, killGraceMs }) : undefined;
  const cleanup = (): void => {
    if (state.killTimer !== undefined) clearTimeout(state.killTimer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    child.removeListener('error', onError);
    if (listeners.close) child.removeListener('close', listeners.close);
  };
  const settle: ProcessSettler = (callback) => settleProcess(state, cleanup, callback);
  const onOverflow = (): void => {
    state.outputError = new RunCodeOutputLimitError();
    requestTermination({ child, state, killGraceMs });
  };
  const output = collectProcessOutput(child, state, onOverflow);
  const onClose = closeHandler({ state, command, settle, resolve, reject, output });
  const closeWithState = (code: number | null, closeSignal: NodeJS.Signals | null): void => {
    state.finish = () => onClose(code, closeSignal);
    onClose(code, closeSignal);
  };
  listeners.close = closeWithState;
  child.on('error', onError);
  child.on('close', closeWithState);
  if (onAbort && signal) {
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  }
}

function monitorProcess(options: MonitorOptions): Promise<RunCodeProcessResult> {
  return new Promise<RunCodeProcessResult>((resolve, reject) => {
    const state: ProcessState = {
      stdout: '',
      stderr: '',
      terminationRequested: false,
      terminationFinished: true,
      settled: false,
    };
    attachProcessMonitor({ ...options, state, resolve, reject });
  });
}

/**
 * Run one owned code process and settle only after its child `close` event.
 * POSIX children are detached into their own process group so cancellation
 * reaches descendants without ever targeting Raven's process group.
 */
export function runCodeProcess(
  command: string,
  args: readonly string[] = [],
  options: RunCodeProcessOptions = {},
): Promise<RunCodeProcessResult> {
  const { signal, killGraceMs = DEFAULT_KILL_GRACE_MS } = options;
  if (signal?.aborted) return Promise.reject(abortReason(signal));

  let child: ChildProcess;
  try {
    child = spawn(command, [...args], {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    return Promise.reject(error);
  }
  return monitorProcess({ child, command, signal, killGraceMs: Math.max(0, killGraceMs) });
}
