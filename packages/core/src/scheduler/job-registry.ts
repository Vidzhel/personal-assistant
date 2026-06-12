import { createLogger } from '@raven/shared';

const log = createLogger('job-registry');

export interface JobContext {
  scheduleName: string;
  params: Record<string, unknown>;
}

export interface JobResult {
  summary?: string;
}

export type JobHandler = (ctx: JobContext) => Promise<JobResult>;

export interface JobRegistry {
  register(id: string, handler: JobHandler): void;
  has(id: string): boolean;
  get(id: string): JobHandler | undefined;
  list(): string[];
}

export function createJobRegistry(): JobRegistry {
  const jobs = new Map<string, JobHandler>();
  return {
    register(id: string, handler: JobHandler): void {
      if (jobs.has(id)) {
        throw new Error(`job already registered: ${id}`);
      }
      jobs.set(id, handler);
      log.info(`Registered job: ${id}`);
    },
    has: (id: string): boolean => jobs.has(id),
    get: (id: string): JobHandler | undefined => jobs.get(id),
    list: (): string[] => [...jobs.keys()],
  };
}
