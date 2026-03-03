import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler } from '../scheduler/scheduler.js';
import { EventBus } from '../event-bus/event-bus.js';
import { initDatabase, getDb } from '../db/database.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { RavenEvent } from '@raven/shared';

describe('Scheduler', () => {
  let tmpDir: string;
  let eventBus: EventBus;
  let scheduler: Scheduler;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-sched-'));
    initDatabase(join(tmpDir, 'test.db'));
    eventBus = new EventBus();
    scheduler = new Scheduler(eventBus, 'UTC');
  });

  afterEach(() => {
    scheduler.shutdown();
    try { getDb().close(); } catch { /* */ }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('initializes with default schedules seeded to DB', async () => {
    await scheduler.initialize([
      {
        id: 'sched-1',
        name: 'Morning Digest',
        cron: '0 8 * * *',
        taskType: 'daily-digest',
        skillName: 'digest',
        enabled: true,
      },
    ]);

    const schedules = scheduler.getSchedules();
    expect(schedules).toHaveLength(1);
    expect(schedules[0].name).toBe('Morning Digest');
    expect(schedules[0].enabled).toBe(true);
  });

  it('does not duplicate schedules on re-initialization', async () => {
    const configs = [
      {
        id: 'sched-1',
        name: 'Digest',
        cron: '0 8 * * *',
        taskType: 'daily-digest',
        skillName: 'digest',
        enabled: true,
      },
    ];

    await scheduler.initialize(configs);
    scheduler.shutdown();

    // Re-create scheduler and re-initialize
    scheduler = new Scheduler(eventBus, 'UTC');
    await scheduler.initialize(configs);

    const schedules = scheduler.getSchedules();
    expect(schedules).toHaveLength(1);
  });

  it('addSchedule creates a new schedule', async () => {
    await scheduler.initialize([]);

    scheduler.addSchedule({
      id: 'sched-new',
      name: 'Custom Job',
      cron: '*/5 * * * *',
      timezone: 'UTC',
      taskType: 'custom-task',
      skillName: 'test-skill',
      enabled: true,
    });

    const schedules = scheduler.getSchedules();
    expect(schedules).toHaveLength(1);
    expect(schedules[0].name).toBe('Custom Job');
  });

  it('removeSchedule deletes a schedule', async () => {
    await scheduler.initialize([
      {
        id: 'sched-del',
        name: 'To Delete',
        cron: '0 0 * * *',
        taskType: 'delete-me',
        skillName: 'test',
        enabled: true,
      },
    ]);

    scheduler.removeSchedule('sched-del');
    const schedules = scheduler.getSchedules();
    expect(schedules).toHaveLength(0);
  });

  it('disabled schedules do not register cron jobs', async () => {
    await scheduler.initialize([
      {
        id: 'sched-off',
        name: 'Disabled',
        cron: '* * * * * *',
        taskType: 'disabled-task',
        skillName: 'test',
        enabled: false,
      },
    ]);

    const schedules = scheduler.getSchedules();
    expect(schedules).toHaveLength(1);
    expect(schedules[0].enabled).toBe(false);

    // No event should be emitted for a disabled schedule
    const handler = vi.fn();
    eventBus.on('schedule:triggered', handler);

    // Wait a tiny bit — if it were registered, it would fire (cron is every second)
    await new Promise((r) => setTimeout(r, 1500));
    expect(handler).not.toHaveBeenCalled();
  });

  it('shutdown stops all jobs', async () => {
    await scheduler.initialize([
      {
        id: 'sched-stop',
        name: 'Stopme',
        cron: '0 0 * * *',
        taskType: 'stop-task',
        skillName: 'test',
        enabled: true,
      },
    ]);

    scheduler.shutdown();
    // After shutdown, getSchedules still reads from DB
    const schedules = scheduler.getSchedules();
    expect(schedules).toHaveLength(1);
  });
});
