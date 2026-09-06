import { z } from 'zod';

export interface TickTickActionResult {
  success: boolean;
  result?: string;
  error?: string;
}

export interface TickTickActionRequest {
  actionName: string;
  skillName: 'ticktick';
  details: string;
}

export interface TickTickProject {
  id: string;
  name: string;
}

export interface TickTickTaskSnapshot {
  id: string;
  projectId?: string;
  title: string;
  content?: string;
  priority?: number;
  dueDate?: string | null;
  startDate?: string | null;
  tags?: string[];
  status?: number;
  timeZone?: string;
  isAllDay?: boolean;
  repeatFlag?: string | null;
  recurrence?: string | null;
  link?: string;
  sourceScopes: string[];
}

export interface TickTickCoverageFailure {
  scope: string;
  error: string;
}

export interface TickTickWorkloadSnapshot {
  projects: TickTickProject[];
  tasks: TickTickTaskSnapshot[];
  coverage: {
    status: 'observed' | 'partial';
    observedScopes: string[];
    failedScopes: TickTickCoverageFailure[];
    caveat: string;
  };
}

interface CollectOptions {
  request: (request: TickTickActionRequest) => Promise<TickTickActionResult | undefined>;
  signal: AbortSignal;
  now?: Date;
  timeZone: string;
}

interface WorkloadAccumulator {
  projects: TickTickProject[];
  tasks: Map<string, TickTickTaskSnapshot>;
  observedScopes: string[];
  failedScopes: TickTickCoverageFailure[];
}

interface ScopeQuery {
  scope: string;
  actionName: string;
  details: string;
  defaultProjectId?: string;
}

const MAX_PROJECT_QUERIES = 40;
const MAX_TASKS_PER_SCOPE = 1_000;
const MAX_TOTAL_TASKS = 5_000;
const MAX_RESULT_BYTES = 1_000_000;
const DATE_WINDOW_DAYS = 13;
const ISO_DATE_PARTS = 3;
const COVERAGE_CAVEAT =
  'Official TickTick queries returned for every requested scope; this is query evidence, not an independent account audit.';

const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});

const TaskSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1).optional(),
  title: z.string().min(1),
  content: z.string().optional(),
  priority: z.number().optional(),
  dueDate: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  status: z.number().optional(),
  timeZone: z.string().optional(),
  isAllDay: z.boolean().optional(),
  repeatFlag: z.string().nullable().optional(),
  recurrence: z.string().nullable().optional(),
  link: z.string().optional(),
});

const ProjectEnvelopeSchema = z
  .object({
    projects: z.array(ProjectSchema).max(MAX_PROJECT_QUERIES),
    complete: z.literal(true),
    nextCursor: z.null().optional(),
    hasMore: z.literal(false).optional(),
    truncated: z.literal(false).optional(),
  })
  .strict();

const TaskEnvelopeSchema = z
  .object({
    tasks: z.array(TaskSchema).max(MAX_TASKS_PER_SCOPE),
    complete: z.literal(true),
    nextCursor: z.null().optional(),
    hasMore: z.literal(false).optional(),
    truncated: z.literal(false).optional(),
  })
  .strict();

function parseJsonResult(text: string): unknown {
  if (Buffer.byteLength(text, 'utf8') > MAX_RESULT_BYTES) {
    throw new Error('response exceeds the bounded snapshot size');
  }
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

function parseProjects(text: string): TickTickProject[] {
  const parsed = ProjectEnvelopeSchema.safeParse(parseJsonResult(text));
  if (!parsed.success) throw new Error('project discovery returned an invalid or truncated list');
  const ids = parsed.data.projects.map((project) => project.id);
  if (new Set(ids).size !== ids.length) throw new Error('project discovery returned duplicate IDs');
  return parsed.data.projects;
}

function parseTasks(text: string, defaultProjectId?: string): TickTickTaskSnapshot[] {
  const parsed = TaskEnvelopeSchema.safeParse(parseJsonResult(text));
  if (!parsed.success) throw new Error('task query returned invalid or excessive records');
  return parsed.data.tasks.map((task) => ({
    ...task,
    projectId: task.projectId ?? defaultProjectId,
    sourceScopes: [],
  }));
}

const TASK_COMPARISON_FIELDS = [
  'projectId',
  'title',
  'content',
  'priority',
  'dueDate',
  'startDate',
  'tags',
  'status',
  'timeZone',
  'isAllDay',
  'repeatFlag',
  'recurrence',
  'link',
] as const;

function tasksConflict(existing: TickTickTaskSnapshot, incoming: TickTickTaskSnapshot): boolean {
  return TASK_COMPARISON_FIELDS.some((field) => {
    const left = existing[field];
    const right = incoming[field];
    return (
      left !== undefined && right !== undefined && JSON.stringify(left) !== JSON.stringify(right)
    );
  });
}

function mergeTaskFields(
  existing: TickTickTaskSnapshot | undefined,
  incoming: TickTickTaskSnapshot,
  scope: string,
): TickTickTaskSnapshot {
  const definedIncoming = Object.fromEntries(
    Object.entries(incoming).filter(([, value]) => value !== undefined),
  ) as Partial<TickTickTaskSnapshot>;
  return {
    ...(existing ?? incoming),
    ...definedIncoming,
    sourceScopes: [...new Set([...(existing?.sourceScopes ?? []), scope])],
  };
}

function mergeTasks(
  accumulator: WorkloadAccumulator,
  tasks: TickTickTaskSnapshot[],
  scope: string,
): void {
  if (accumulator.tasks.size + tasks.length > MAX_TOTAL_TASKS) {
    accumulator.failedScopes.push({ scope, error: 'combined task snapshot exceeds its bound' });
    return;
  }
  for (const task of tasks) {
    const existing = accumulator.tasks.get(task.id);
    if (existing && tasksConflict(existing, task)) {
      accumulator.failedScopes.push({ scope, error: `conflicting fields for task ${task.id}` });
      continue;
    }
    accumulator.tasks.set(task.id, mergeTaskFields(existing, task, scope));
  }
}

async function queryTaskScope(
  options: CollectOptions,
  accumulator: WorkloadAccumulator,
  query: ScopeQuery,
): Promise<void> {
  options.signal.throwIfAborted();
  try {
    const response = await options.request({
      actionName: query.actionName,
      skillName: 'ticktick',
      details: query.details,
    });
    options.signal.throwIfAborted();
    if (!response?.success || !response.result) {
      throw new Error(response?.error ?? 'query returned no result');
    }
    mergeTasks(accumulator, parseTasks(response.result, query.defaultProjectId), query.scope);
    accumulator.observedScopes.push(query.scope);
  } catch (error) {
    if (options.signal.aborted) throw error;
    accumulator.failedScopes.push({
      scope: query.scope,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function dateOnly(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (!value.year || !value.month || !value.day) throw new Error('could not resolve local date');
  return [value.year, value.month, value.day].slice(0, ISO_DATE_PARTS).join('-');
}

function supplementalQueries(now: Date, timeZone: string): ScopeQuery[] {
  const today = dateOnly(now, timeZone);
  const [year, month, day] = today.split('-').map(Number);
  const end = new Date(Date.UTC(year, month - 1, day));
  end.setUTCDate(end.getUTCDate() + DATE_WINDOW_DAYS);
  const envelope =
    'Return ONLY {"tasks":[...],"complete":true,"nextCursor":null}. Set complete only after exhausting pagination; expose truncation instead of summarizing.';
  return [
    {
      scope: 'dated-window',
      actionName: 'ticktick:list-undone-tasks-by-date',
      details: `Call list_undone_tasks_by_date for ${today} through ${dateOnly(end, 'UTC')} in ${timeZone} (the documented 14-day maximum). ${envelope}`,
    },
    {
      scope: 'inbox',
      actionName: 'ticktick:filter-tasks',
      details: `Call filter_tasks for every open task in the TickTick Inbox. Preserve task and project IDs. ${envelope}`,
    },
    {
      scope: 'undated',
      actionName: 'ticktick:filter-tasks',
      details: `Call filter_tasks for every open task with no due date, across the account. Preserve task and project IDs. ${envelope}`,
    },
    {
      scope: 'overdue',
      actionName: 'ticktick:filter-tasks',
      details: `Call filter_tasks for every open task due before ${today} in ${timeZone}. Preserve task and project IDs. ${envelope}`,
    },
  ];
}

async function discoverProjects(
  options: CollectOptions,
  accumulator: WorkloadAccumulator,
): Promise<void> {
  try {
    const response = await options.request({
      actionName: 'ticktick:list-projects',
      skillName: 'ticktick',
      details:
        'Call list_projects and exhaust pagination. Return ONLY {"projects":[{"id":"...","name":"..."}],"complete":true,"nextCursor":null}. Expose truncation instead of setting complete.',
    });
    options.signal.throwIfAborted();
    if (!response?.success || !response.result) {
      throw new Error(response?.error ?? 'project discovery returned no result');
    }
    accumulator.projects = parseProjects(response.result);
    accumulator.observedScopes.push('projects');
  } catch (error) {
    if (options.signal.aborted) throw error;
    accumulator.failedScopes.push({
      scope: 'projects',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function projectQuery(project: TickTickProject): ScopeQuery {
  return {
    scope: `project:${project.id}`,
    actionName: 'ticktick:get-project-with-undone-tasks',
    defaultProjectId: project.id,
    details: `Call get_project_with_undone_tasks for exact project ID ${JSON.stringify(project.id)} and exhaust pagination. Return ONLY {"tasks":[...],"complete":true,"nextCursor":null}; do not summarize or omit undated tasks, and expose truncation instead of setting complete.`,
  };
}

export async function collectTickTickWorkload(
  options: CollectOptions,
): Promise<TickTickWorkloadSnapshot> {
  const accumulator: WorkloadAccumulator = {
    projects: [],
    tasks: new Map(),
    observedScopes: [],
    failedScopes: [],
  };
  await discoverProjects(options, accumulator);
  for (const project of accumulator.projects) {
    await queryTaskScope(options, accumulator, projectQuery(project));
  }
  for (const query of supplementalQueries(options.now ?? new Date(), options.timeZone)) {
    await queryTaskScope(options, accumulator, query);
  }
  return {
    projects: accumulator.projects,
    tasks: [...accumulator.tasks.values()],
    coverage: {
      status: accumulator.failedScopes.length === 0 ? 'observed' : 'partial',
      observedScopes: accumulator.observedScopes,
      failedScopes: accumulator.failedScopes,
      caveat: COVERAGE_CAVEAT,
    },
  };
}
