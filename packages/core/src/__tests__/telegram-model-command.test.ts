import { describe, expect, it } from 'vitest';
import {
  formatTelegramModelStatus,
  parseTelegramModelCommand,
} from '../services/notifications/telegram-model-command.ts';

describe('Telegram /model command', () => {
  it('parses display, reset, and structurally valid future-turn settings', () => {
    expect(parseTelegramModelCommand('/model')).toEqual({ matched: true, action: 'show' });
    expect(parseTelegramModelCommand('/model@RavenBot default')).toEqual({
      matched: true,
      action: 'reset',
    });
    expect(parseTelegramModelCommand('/model opus high adaptive')).toEqual({
      matched: true,
      action: 'set',
      config: { model: 'opus', effort: 'high', thinking: 'adaptive' },
    });
    expect(parseTelegramModelCommand('/model fable-5-1 disabled')).toEqual({
      matched: true,
      action: 'set',
      config: { model: 'fable-5-1', thinking: 'disabled' },
    });
  });

  it('rejects malformed options and reset arguments before persistence', () => {
    expect(parseTelegramModelCommand('/model invalid/id')).toMatchObject({
      matched: true,
      action: 'invalid',
    });
    expect(parseTelegramModelCommand('/model sonnet extreme')).toMatchObject({
      matched: true,
      action: 'invalid',
    });
    expect(parseTelegramModelCommand('/model default high')).toMatchObject({
      matched: true,
      action: 'invalid',
    });
    expect(parseTelegramModelCommand('/model sonnet adaptive disabled')).toMatchObject({
      matched: true,
      action: 'invalid',
      error: expect.stringContaining('Specify thinking once'),
    });
  });

  it('formats effective settings, reported aliases, policy, and stale evidence', () => {
    const status = formatTelegramModelStatus({
      sessionId: 'session-1',
      effective: { model: 'claude-fable-5-1', effort: 'high', thinking: 'adaptive' },
      snapshot: {
        models: [
          {
            id: 'claude-fable-5-1',
            aliases: ['fable'],
            displayName: 'Fable 5.1',
            description: 'Fixture',
            mandatoryThinking: true,
          },
        ],
        fetchedAt: '2026-09-06T00:00:00.000Z',
        revision: 3,
        stale: true,
        error: 'refresh unavailable',
      },
    });

    expect(status).toContain('Current Raven session: session-1');
    expect(status).toContain('Effective model: claude-fable-5-1');
    expect(status).toContain('aliases: fable');
    expect(status).toContain('adaptive thinking required');
    expect(status).toContain('Catalog error: refresh unavailable');
    expect(status).toContain('Work already running keeps its captured model settings.');
  });
});
