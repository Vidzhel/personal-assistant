import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger } from '../utils/logger.js';
import { generateId } from '../utils/id.js';

describe('createLogger', () => {
  it('returns a logger with all required methods', () => {
    const log = createLogger('test');
    expect(log.info).toBeTypeOf('function');
    expect(log.warn).toBeTypeOf('function');
    expect(log.error).toBeTypeOf('function');
    expect(log.debug).toBeTypeOf('function');
  });

  it('info logs with prefix', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = createLogger('mymod');
    log.info('hello world');
    expect(spy).toHaveBeenCalledWith('[mymod]', 'hello world');
    spy.mockRestore();
  });

  it('warn logs with prefix', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = createLogger('mymod');
    log.warn('warning msg');
    expect(spy).toHaveBeenCalledWith('[mymod]', 'warning msg');
    spy.mockRestore();
  });

  it('error logs with prefix', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = createLogger('mymod');
    log.error('error msg');
    expect(spy).toHaveBeenCalledWith('[mymod]', 'error msg');
    spy.mockRestore();
  });

  it('debug only logs when LOG_LEVEL=debug', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const origLevel = process.env.LOG_LEVEL;

    process.env.LOG_LEVEL = 'info';
    const log = createLogger('test');
    log.debug('should not appear');
    expect(spy).not.toHaveBeenCalled();

    process.env.LOG_LEVEL = 'debug';
    log.debug('should appear');
    expect(spy).toHaveBeenCalledWith('[test]', 'should appear');

    process.env.LOG_LEVEL = origLevel;
    spy.mockRestore();
  });
});

describe('generateId', () => {
  it('returns a valid UUID v4', () => {
    const id = generateId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});
