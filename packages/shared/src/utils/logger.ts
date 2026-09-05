import type { LoggerInterface } from '../types/skills.ts';
import pino from 'pino';

let pinoInstance: pino.Logger | null = null;
let logDir: string | null = null;
// The thread-stream worker behind pino.transport() — tracked so it can be
// end()ed on re-init or shutdown. Nobody was closing this before: the worker
// thread outlived process teardown, and in tests it raced rmSync() deleting
// the log directory out from under it (unhandled ENOENT). See
// closeFileLogging() and raven.ts's stop().
let transportStream: ReturnType<typeof pino.transport> | null = null;

export interface FileLoggingOptions {
  logDir: string;
  maxDays?: number;
  pretty?: boolean;
}

/**
 * Initialize file-based logging with daily rotation.
 * Must be called once during boot, before subsystems start.
 * Pre-init loggers (console-based) continue to work; post-init they delegate to Pino.
 */
export function initFileLogging(opts: FileLoggingOptions): void {
  // A previous transport's worker thread must be told to shut down before
  // we replace the singleton, or it leaks for the life of the process.
  if (transportStream) {
    transportStream.end();
  }

  logDir = opts.logDir;
  const DEFAULT_RETENTION_DAYS = 7;
  const maxDays = opts.maxDays ?? DEFAULT_RETENTION_DAYS;
  const targets: pino.TransportTargetOptions[] = [
    {
      target: 'pino-roll',
      options: {
        file: `${opts.logDir}/raven`,
        frequency: 'daily',
        limit: { count: maxDays },
        mkdir: true,
      },
      level: 'debug',
    },
  ];

  if (opts.pretty) {
    targets.push({
      target: 'pino-pretty',
      options: { destination: 1 }, // stdout
      level: 'debug',
    });
  }

  transportStream = pino.transport({ targets });
  pinoInstance = pino({ level: 'debug' }, transportStream);
}

/** Returns the configured log directory, or null if file logging is not initialized. */
export function getLogDir(): string | null {
  return logDir;
}

/**
 * Gracefully shuts down the file-logging transport's worker thread. Ends the
 * stream and waits for its 'close' event before nulling the singleton
 * state, so callers (raven.ts's stop(), as its last step) can be certain no
 * async writes are still in flight before anything deletes the log
 * directory. A no-op if file logging was never initialized.
 */
export function closeFileLogging(): Promise<void> {
  const stream = transportStream;
  if (!stream) return Promise.resolve();

  return new Promise((resolve) => {
    // The installed thread-stream runtime exposes ref(), but its declarations
    // omit it. Narrow the runtime method without weakening the stream type.
    const keepAlive = (): void => {
      if ('ref' in stream && typeof stream.ref === 'function') stream.ref();
    };
    // Pino also unrefs on ready, which can arrive after an immediate shutdown.
    stream.once('ready', keepAlive);
    stream.once('close', () => {
      stream.removeListener('ready', keepAlive);
      pinoInstance = null;
      logDir = null;
      transportStream = null;
      resolve();
    });
    // Pino unrefs its worker during normal operation. Keep shutdown alive until
    // the final writes and worker close complete, even with no other open handles.
    keepAlive();
    stream.end();
  });
}

/* eslint-disable no-console -- logger wraps console on purpose */
export function createLogger(name: string): LoggerInterface {
  // Return a logger that checks pinoInstance at call time (not creation time).
  // This way loggers created before initFileLogging() still route through Pino once it's ready.
  return {
    info: (msg, ...args) => {
      if (pinoInstance) {
        pinoInstance.child({ component: name }).info(formatMsg(msg, args));
      } else {
        console.log(`[${name}]`, msg, ...args);
      }
    },
    warn: (msg, ...args) => {
      if (pinoInstance) {
        pinoInstance.child({ component: name }).warn(formatMsg(msg, args));
      } else {
        console.warn(`[${name}]`, msg, ...args);
      }
    },
    error: (msg, ...args) => {
      if (pinoInstance) {
        pinoInstance.child({ component: name }).error(formatMsg(msg, args));
      } else {
        console.error(`[${name}]`, msg, ...args);
      }
    },
    debug: (msg, ...args) => {
      if (pinoInstance) {
        pinoInstance.child({ component: name }).debug(formatMsg(msg, args));
      } else if (process.env.LOG_LEVEL === 'debug') {
        console.debug(`[${name}]`, msg, ...args);
      }
    },
  };
}
/* eslint-enable no-console */

function formatMsg(msg: string, args: unknown[]): string {
  return args.length > 0 ? `${msg} ${args.map(String).join(' ')}` : msg;
}
