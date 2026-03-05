import { Cron } from 'croner';
import { createLogger, generateId } from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { ScheduleConfig } from '../config.ts';
import type { ScheduleRecord } from '@raven/shared';
import { getDb } from '../db/database.ts';

const log = createLogger('scheduler');

export class Scheduler {
  private jobs = new Map<string, Cron>();

  constructor(
    private eventBus: EventBus,
    private timezone: string,
  ) {}

  async initialize(defaultSchedules: ScheduleConfig[]): Promise<void> {
    const db = getDb();

    // Seed default schedules that don't exist yet
    for (const sched of defaultSchedules) {
      const existing = db.prepare('SELECT id FROM schedules WHERE id = ?').get(sched.id);
      if (!existing) {
        const now = Date.now();
        db.prepare(
          'INSERT INTO schedules (id, name, cron, timezone, task_type, skill_name, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(
          sched.id,
          sched.name,
          sched.cron,
          this.timezone,
          sched.taskType,
          sched.skillName,
          sched.enabled ? 1 : 0,
          now,
          now,
        );
      }
    }

    // Load all enabled schedules from DB
    const schedules = db
      .prepare('SELECT * FROM schedules WHERE enabled = 1')
      .all() as ScheduleDbRow[];

    for (const s of schedules) {
      this.registerJob(s);
    }

    log.info(`Scheduler initialized with ${this.jobs.size} jobs`);
  }

  private registerJob(schedule: ScheduleDbRow): void {
    const job = new Cron(
      schedule.cron,
      {
        timezone: schedule.timezone || this.timezone,
      },
      () => {
        log.info(`Firing schedule: ${schedule.name} (${schedule.task_type})`);
        this.eventBus.emit({
          id: generateId(),
          timestamp: Date.now(),
          source: 'scheduler',
          type: 'schedule:triggered',
          payload: {
            scheduleId: schedule.id,
            scheduleName: schedule.name,
            taskType: schedule.task_type,
          },
        });
      },
    );

    this.jobs.set(schedule.id, job);
    const next = job.nextRun();
    log.info(`Registered: ${schedule.name} (${schedule.cron}) → next: ${next?.toISOString()}`);
  }

  addSchedule(record: Omit<ScheduleRecord, 'createdAt' | 'updatedAt'>): void {
    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT INTO schedules (id, name, cron, timezone, task_type, skill_name, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      record.id,
      record.name,
      record.cron,
      record.timezone,
      record.taskType,
      record.skillName,
      record.enabled ? 1 : 0,
      now,
      now,
    );

    if (record.enabled) {
      this.registerJob({
        id: record.id,
        name: record.name,
        cron: record.cron,
        timezone: record.timezone,
        task_type: record.taskType,
        skill_name: record.skillName,
        enabled: 1,
        created_at: Date.now(),
        updated_at: Date.now(),
      });
    }
  }

  removeSchedule(id: string): void {
    const job = this.jobs.get(id);
    if (job) {
      job.stop();
      this.jobs.delete(id);
    }
    const db = getDb();
    db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
  }

  getSchedules(): ScheduleRecord[] {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM schedules ORDER BY name').all() as ScheduleDbRow[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      cron: r.cron,
      timezone: r.timezone,
      taskType: r.task_type,
      skillName: r.skill_name,
      enabled: r.enabled === 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  getActiveJobCount(): number {
    return this.jobs.size;
  }

  shutdown(): void {
    for (const job of this.jobs.values()) {
      job.stop();
    }
    this.jobs.clear();
    log.info('Scheduler stopped');
  }
}

interface ScheduleDbRow {
  id: string;
  name: string;
  cron: string;
  timezone: string;
  task_type: string;
  skill_name: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}
