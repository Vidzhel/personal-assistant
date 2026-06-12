import { describe, it, expect } from 'vitest';
import { ScheduleYamlSchema } from '../project/schemas.ts';

describe('ScheduleYamlSchema', () => {
  it('parses the new run:{kind,ref} shape', () => {
    const s = ScheduleYamlSchema.parse({
      name: 'task-archival',
      cron: '0 * * * *',
      run: { kind: 'job', ref: 'task-archival' },
    });
    expect(s.run).toEqual({ kind: 'job', ref: 'task-archival' });
    expect(s.timezone).toBe('UTC');
    expect(s.enabled).toBe(true);
  });

  it('normalizes the legacy template: field into run', () => {
    const s = ScheduleYamlSchema.parse({
      name: 'morning-digest',
      cron: '0 8 * * *',
      template: 'morning-digest',
    });
    expect(s.run).toEqual({ kind: 'template', ref: 'morning-digest' });
  });

  it('rejects a def with neither run nor template', () => {
    expect(() => ScheduleYamlSchema.parse({ name: 'x', cron: '0 0 * * *' })).toThrow();
  });

  it('rejects an unknown run kind', () => {
    expect(() =>
      ScheduleYamlSchema.parse({ name: 'x', cron: '0 0 * * *', run: { kind: 'nope', ref: 'y' } }),
    ).toThrow();
  });
});
