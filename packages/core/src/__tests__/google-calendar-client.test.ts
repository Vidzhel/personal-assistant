import { describe, expect, it, vi } from 'vitest';
import {
  GoogleCalendarClient,
  type GwsRunRequest,
  type GwsRunner,
} from '../integrations/google-calendar/google-calendar-client.ts';

function clientWith(outputs: Array<string | Error>, options: { maxPages?: number } = {}) {
  const calls: GwsRunRequest[] = [];
  const runner: GwsRunner = vi.fn(async (request) => {
    calls.push(request);
    const output = outputs.shift();
    if (output instanceof Error) throw output;
    if (output === undefined) throw new Error('Missing fixture');
    return output;
  });
  const client = new GoogleCalendarClient({
    runner,
    env: { GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: '/credentials/config.json' },
    ...options,
  });
  return { client, calls };
}

describe('GoogleCalendarClient', () => {
  it('paginates calendar lists with fixed read-only arguments and retains metadata', async () => {
    const { client, calls } = clientWith([
      JSON.stringify({
        items: [
          {
            id: 'primary',
            summary: 'Owner',
            selected: true,
            accessRole: 'owner',
            timeZone: 'Europe/Kiev',
          },
        ],
        nextPageToken: 'next',
      }),
      JSON.stringify({ items: [{ id: 'shared', hidden: true, accessRole: 'reader' }] }),
    ]);

    await expect(client.listCalendars()).resolves.toEqual({
      complete: true,
      items: [
        {
          id: 'primary',
          summary: 'Owner',
          selected: true,
          accessRole: 'owner',
          timeZone: 'Europe/Kiev',
        },
        { id: 'shared', hidden: true, accessRole: 'reader' },
      ],
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.command).toBe('gws');
    expect(calls[0]?.args.slice(0, 3)).toEqual(['calendar', 'calendarList', 'list']);
    expect(calls[0]?.args.at(-2)).toBe('--format');
    expect(calls[0]?.args.at(-1)).toBe('json');
    expect(JSON.parse(calls[0]?.args[4] ?? '')).toEqual({ showHidden: true, showDeleted: false });
    expect(JSON.parse(calls[1]?.args[4] ?? '')).toEqual({
      showHidden: true,
      showDeleted: false,
      pageToken: 'next',
    });
    expect(calls[0]?.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE).toBe('/credentials/config.json');
    expect(calls[0]?.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR).toBe('/credentials/gws-cache');
    expect(calls[0]?.timeoutMs).toBe(10_000);
    expect(calls[0]?.maxOutputBytes).toBe(1024 * 1024);
  });

  it('uses Google event expansion and preserves all-day and recurrence provenance', async () => {
    const { client, calls } = clientWith([
      JSON.stringify({
        items: [
          {
            id: 'instance-1',
            status: 'confirmed',
            summary: 'Standup',
            htmlLink: 'https://calendar.google.com/event?eid=one',
            iCalUID: 'series@example.com',
            eventType: 'focusTime',
            attendees: [
              { email: 'other@example.com', responseStatus: 'accepted' },
              { email: 'owner@example.com', self: true, responseStatus: 'declined' },
            ],
            recurringEventId: 'series-1',
            originalStartTime: { dateTime: '2026-09-10T09:00:00+03:00', timeZone: 'Europe/Kiev' },
            start: { dateTime: '2026-09-10T10:00:00+03:00', timeZone: 'Europe/Kiev' },
            end: { dateTime: '2026-09-10T10:30:00+03:00', timeZone: 'Europe/Kiev' },
            transparency: 'transparent',
          },
          {
            id: 'all-day',
            status: 'confirmed',
            summary: 'Holiday',
            start: { date: '2026-09-11' },
            end: { date: '2026-09-12' },
          },
          { id: 'ooo', status: 'confirmed', eventType: 'outOfOffice' },
          { id: 'location', status: 'confirmed', eventType: 'workingLocation' },
          { id: 'cancelled', status: 'cancelled', summary: 'Ignore me' },
        ],
      }),
    ]);
    const controller = new AbortController();
    const result = await client.listEvents({
      calendarId: 'owner@example.com',
      timeMin: '2026-09-01T00:00:00+03:00',
      timeMax: '2026-10-01T00:00:00+03:00',
      timeZone: 'Europe/Kiev',
      signal: controller.signal,
    });

    expect(result.complete).toBe(true);
    expect(result.items).toHaveLength(4);
    expect(result.items[0]).toMatchObject({
      id: 'instance-1',
      calendarId: 'owner@example.com',
      recurringEventId: 'series-1',
      iCalUID: 'series@example.com',
      eventType: 'focusTime',
      selfResponseStatus: 'declined',
      originalStartTime: { dateTime: '2026-09-10T09:00:00+03:00' },
      transparency: 'transparent',
      htmlLink: 'https://calendar.google.com/event?eid=one',
    });
    expect(result.items[1]).toMatchObject({
      id: 'all-day',
      calendarId: 'owner@example.com',
      start: { date: '2026-09-11' },
      end: { date: '2026-09-12' },
    });
    expect(result.items.slice(1).map((event) => event.eventType)).toEqual([
      undefined,
      'outOfOffice',
      'workingLocation',
    ]);
    expect(result).toMatchObject({ calendarId: 'owner@example.com' });
    expect(result.items[0]).not.toHaveProperty('attendees');
    expect(calls[0]?.args.slice(0, 3)).toEqual(['calendar', 'events', 'list']);
    expect(calls[0]?.signal).toBe(controller.signal);
    expect(JSON.parse(calls[0]?.args[4] ?? '')).toEqual({
      calendarId: 'owner@example.com',
      timeMin: '2026-09-01T00:00:00+03:00',
      timeMax: '2026-10-01T00:00:00+03:00',
      timeZone: 'Europe/Kiev',
      singleEvents: true,
      showDeleted: false,
      orderBy: 'startTime',
    });
  });

  it('keeps partial results and returns safe reasons for provider errors and truncation', async () => {
    const failed = clientWith([
      JSON.stringify({ items: [{ id: 'one', summary: 'First' }], nextPageToken: 'secret-token' }),
      new Error('stderr contained bearer super-secret'),
    ]);
    await expect(failed.client.listCalendars()).resolves.toEqual({
      items: [{ id: 'one', summary: 'First' }],
      complete: false,
      reason: 'Google Calendar request failed on page 2',
    });

    const truncated = clientWith(
      [JSON.stringify({ items: [{ id: 'one' }], nextPageToken: 'more' })],
      { maxPages: 1 },
    );
    await expect(truncated.client.listCalendars()).resolves.toEqual({
      items: [{ id: 'one' }],
      complete: false,
      reason: 'Google Calendar pagination exceeded 1 pages',
    });
  });

  it('rejects repeated page tokens while retaining the pages already read', async () => {
    const { client } = clientWith([
      JSON.stringify({ items: [{ id: 'one' }], nextPageToken: 'same' }),
      JSON.stringify({ items: [{ id: 'two' }], nextPageToken: 'same' }),
    ]);
    await expect(client.listCalendars()).resolves.toEqual({
      items: [{ id: 'one' }, { id: 'two' }],
      complete: false,
      reason: 'Google Calendar returned a repeated page token',
    });
  });

  it.each(['calendar#events', 'calendar#calendarList'])(
    'accepts a valid empty %s page with omitted items',
    async (kind) => {
      const { client } = clientWith([JSON.stringify({ kind })]);
      await expect(client.listCalendars()).resolves.toEqual({ items: [], complete: true });
    },
  );

  it('continues pagination from a valid empty page with omitted items', async () => {
    const { client } = clientWith([
      JSON.stringify({ kind: 'calendar#calendarList', nextPageToken: 'next' }),
      JSON.stringify({ kind: 'calendar#calendarList', items: [{ id: 'later' }] }),
    ]);
    await expect(client.listCalendars()).resolves.toEqual({
      items: [{ id: 'later' }],
      complete: true,
    });
  });

  it.each([
    [{ error: { code: 401, message: 'secret provider detail' } }, 'request failed'],
    [{}, 'request failed'],
    [{ items: [{ summary: 'missing id' }] }, 'malformed items'],
  ])('reports invalid provider page %# as explicitly incomplete', async (page, reason) => {
    const { client } = clientWith([JSON.stringify(page)]);
    await expect(client.listCalendars()).resolves.toMatchObject({
      items: [],
      complete: false,
      reason: expect.stringContaining(reason),
    });
  });

  it('retains valid items before a malformed item on the same page', async () => {
    const { client } = clientWith([
      JSON.stringify({ items: [{ id: 'valid' }, { summary: 'missing id' }] }),
    ]);
    await expect(client.listCalendars()).resolves.toEqual({
      items: [{ id: 'valid' }],
      complete: false,
      reason: 'Google Calendar returned malformed items on page 1',
    });
  });

  it.each([
    ['not-a-date', '2026-09-02T00:00:00Z', 'UTC', /RFC3339/],
    ['2026-02-30T00:00:00Z', '2026-03-02T00:00:00Z', 'UTC', /RFC3339/],
    ['2026-09-02T00:00:00Z', '2026-09-01T00:00:00Z', 'UTC', /after/],
    ['2026-09-01T00:00:00Z', '2026-10-03T00:00:00Z', 'UTC', /31 days/],
    ['2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', 'Mars/Olympus', /IANA/],
  ])('rejects invalid event range input %#', async (timeMin, timeMax, timeZone, message) => {
    const { client, calls } = clientWith([]);
    await expect(
      client.listEvents({ calendarId: 'primary', timeMin, timeMax, timeZone }),
    ).rejects.toThrow(message);
    expect(calls).toHaveLength(0);
  });

  it('requires configured CLI credentials', () => {
    expect(() => new GoogleCalendarClient({ env: {} })).toThrow(
      'GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE',
    );
  });

  it('removes ambient credential overrides from the provider environment', async () => {
    const calls: GwsRunRequest[] = [];
    const client = new GoogleCalendarClient({
      env: {
        GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: '/safe/account.json',
        GOOGLE_WORKSPACE_CLI_TOKEN: 'wrong-token',
        GOOGLE_WORKSPACE_CLI_ACCESS_TOKEN: 'wrong-access-token',
        GOOGLE_WORKSPACE_CLI_CLIENT_ID: 'wrong-client',
        GOOGLE_WORKSPACE_CLI_CLIENT_SECRET: 'wrong-secret',
        GOOGLE_WORKSPACE_CLI_CONFIG_DIR: '/ambient/cache',
        GOOGLE_WORKSPACE_UNRELATED_OVERRIDE: 'wrong-google-value',
        TELEGRAM_BOT_TOKEN: 'unrelated-raven-secret',
        PATH: '/safe/bin',
      },
      runner: async (request) => {
        calls.push(request);
        return JSON.stringify({ items: [] });
      },
    });
    await client.listCalendars();
    expect(calls[0]?.env).toMatchObject({
      GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: '/safe/account.json',
      GOOGLE_WORKSPACE_CLI_CONFIG_DIR: '/safe/gws-cache',
      PATH: '/safe/bin',
    });
    expect(calls[0]?.env).not.toHaveProperty('GOOGLE_WORKSPACE_CLI_TOKEN');
    expect(calls[0]?.env).not.toHaveProperty('GOOGLE_WORKSPACE_CLI_ACCESS_TOKEN');
    expect(calls[0]?.env).not.toHaveProperty('GOOGLE_WORKSPACE_CLI_CLIENT_SECRET');
    expect(calls[0]?.env).not.toHaveProperty('GOOGLE_WORKSPACE_UNRELATED_OVERRIDE');
    expect(calls[0]?.env).not.toHaveProperty('TELEGRAM_BOT_TOKEN');
  });
});
