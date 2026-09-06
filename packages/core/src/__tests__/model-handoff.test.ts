import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readModelHandoff, withModelHandoff } from '../session-manager/model-handoff.ts';

describe('bounded model continuation', () => {
  let directory: string;
  let path: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'raven-model-history-'));
    path = join(directory, 'transcript.jsonl');
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('preserves source message IDs and only conversational content', () => {
    writeFileSync(
      path,
      [
        { id: 'u1', role: 'user', content: 'My dissertation subject is zircon.' },
        { id: 't1', role: 'tool-result', content: 'tool output is excluded' },
        { id: 'a1', role: 'assistant', content: 'Recorded the subject.' },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\nmalformed\n',
    );
    const history = readModelHandoff(path);
    expect(history).toContain('"id":"u1"');
    expect(history).toContain('zircon');
    expect(history).toContain('"id":"a1"');
    expect(history).not.toContain('tool output');
    expect(withModelHandoff('Continue now', history)).toContain(
      'Current owner message:\nContinue now',
    );
  });

  it('bounds bytes despite huge transcripts and multibyte text', () => {
    const messages = Array.from({ length: 400 }, (_, index) => ({
      id: String(index),
      role: 'user',
      content: 'Я'.repeat(1000),
    }));
    writeFileSync(path, messages.map((message) => JSON.stringify(message)).join('\n'));
    const history = readModelHandoff(path)!;
    expect(Buffer.byteLength(history)).toBeLessThan(25 * 1024);
    expect(history).toContain('"id":"399"');
    expect(history).not.toContain('"id":"0"');
    expect(history).not.toContain('�');
  });

  it('includes completed predecessor replies while excluding the current and later turns', () => {
    writeFileSync(
      path,
      [
        { id: 'a-user', taskId: 'a', role: 'user', content: 'First question' },
        { id: 'b-user', taskId: 'b', role: 'user', content: 'Current question' },
        { id: 'c-user', taskId: 'c', role: 'user', content: 'Future question' },
        {
          id: 'a-result',
          taskId: 'a',
          role: 'assistant',
          content: 'Predecessor completed while queued',
        },
        {
          id: 'b-result',
          taskId: 'b',
          role: 'assistant',
          content: 'Current result must be excluded',
        },
      ]
        .map((message) => JSON.stringify(message))
        .join('\n'),
    );
    const history = readModelHandoff(path, 'b-user');
    expect(history).toContain('First question');
    expect(history).toContain('Predecessor completed while queued');
    expect(history).not.toContain('Current question');
    expect(history).not.toContain('Future question');
    expect(history).not.toContain('Current result');
    expect(readModelHandoff(path, 'missing-cutoff')).toBeUndefined();
  });

  it('omits missing history and an oversized incomplete tail instead of inventing context', () => {
    expect(readModelHandoff(path)).toBeUndefined();
    writeFileSync(
      path,
      JSON.stringify({ id: 'large', role: 'user', content: 'x'.repeat(100_000) }),
    );
    expect(readModelHandoff(path)).toBeUndefined();
    expect(withModelHandoff('Canonical input')).toBe('Canonical input');
  });
});
