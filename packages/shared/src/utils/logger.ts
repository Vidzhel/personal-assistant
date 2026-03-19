import type { LoggerInterface } from '../types/skills.ts';
import pino from 'pino';

let pinoInstance: pino.Logger | null = null;
let logDir: string | null = null;

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

  pinoInstance = pino({ level: 'debug' }, pino.transport({ targets }));
}

/** Returns the configured log directory, or null if file logging is not initialized. */
export function getLogDir(): string | null {
  return logDir;
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
