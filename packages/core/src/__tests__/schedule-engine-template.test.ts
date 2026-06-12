import { describe, it, expect, vi } from 'vitest';
import { runScheduledTemplate } from '../scheduler/schedule-engine.ts';
import type { ScheduleYaml } from '@raven/shared';

const tplDef: ScheduleYaml = {
  name: 'morning-digest',
  cron: '0 8 * * *',
  timezone: 'UTC',
  enabled: true,
  params: { foo: 'bar' },
  run: { kind: 'template', ref: 'morning-digest' },
};

describe('runScheduledTemplate', () => {
  it('fires the template with scheduleId + params', async () => {
    const fireTemplate = vi.fn().mockReturnValue('tree-xyz');
    await runScheduledTemplate(tplDef, { fireTemplate });
    expect(fireTemplate).toHaveBeenCalledWith('morning-digest', {
      scheduleId: 'morning-digest',
      params: { foo: 'bar' },
    });
  });

  it('does not throw when fireTemplate rejects (logs instead)', async () => {
    const fireTemplate = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(runScheduledTemplate(tplDef, { fireTemplate })).resolves.toBeUndefined();
  });
});
