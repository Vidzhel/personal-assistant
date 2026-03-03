import type { LoggerInterface } from '../types/skills.ts';

/* eslint-disable no-console -- logger wraps console on purpose */
export function createLogger(name: string): LoggerInterface {
  const prefix = `[${name}]`;
  return {
    info: (msg, ...args) => console.log(prefix, msg, ...args),
    warn: (msg, ...args) => console.warn(prefix, msg, ...args),
    error: (msg, ...args) => console.error(prefix, msg, ...args),
    debug: (msg, ...args) => {
      if (process.env.LOG_LEVEL === 'debug') {
        console.debug(prefix, msg, ...args);
      }
    },
  };
}
/* eslint-enable no-console */
