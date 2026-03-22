import { createLogger, generateId, SOURCE_CONFIG_MANAGER, PipelineConfigSchema, type EventBusInterface } from '@raven/shared';
import type { ConfigChangeAction, ConfigResourceType } from '@raven/shared';
import { parse as parseYaml } from 'yaml';

const log = createLogger('config-applier');

export interface ConfigApplierDeps {
  eventBus: EventBusInterface;
  pipelineEngine: {
    savePipeline: (name: string, yamlContent: string) => { config: unknown };
    deletePipeline: (name: string) => boolean;
  };
  suiteScaffolder: {
    scaffoldSuite: (input: { name: string; displayName: string; description: string; mcpServers?: Record<string, unknown> }) => { suitePath: string };
  };
  namedAgentStore: {
    createAgent: (input: { name: string; description?: string; instructions?: string; suiteIds: string[] }) => { id: string; name: string };
    updateAgent: (id: string, input: { name?: string; description?: string; instructions?: string; suiteIds?: string[] }) => { id: string; name: string };
    deleteAgent: (id: string) => void;
    getAgentByName: (name: string) => { id: string; name: string } | undefined;
  };
  scheduler: {
    addSchedule: (record: { id: string; name: string; cron: string; timezone: string; taskType: string; skillName: string; enabled: boolean }) => void;
    removeSchedule: (id: string) => void;
    getSchedules: () => Array<{ id: string; name: string }>;
  };
}

export interface ApplyResult {
  success: boolean;
  message: string;
  error?: string;
}

/**
 * Validates a config change before applying — Zod schemas for pipelines,
 * structural checks for agents/schedules.
 */
export function validateConfigChange(
  change: {
    action: ConfigChangeAction;
    resourceType: ConfigResourceType;
    resourceName: string;
    content?: string;
  },
): { valid: boolean; errors: string[] } {
  const { action, resourceType, content } = change;

  // View and delete don't need content validation
  if (action === 'view' || action === 'delete') {
    return { valid: true, errors: [] };
  }

  if (!content) {
    return { valid: false, errors: [`${resourceType} content is required for ${action}`] };
  }

  const errors: string[] = [];

  if (resourceType === 'pipeline') {
    try {
      const parsed = parseYaml(content) as Record<string, unknown>;
      const result = PipelineConfigSchema.safeParse(parsed);
      if (!result.success) {
        for (const issue of result.error.issues) {
          errors.push(`Pipeline schema: ${issue.path.join('.')}: ${issue.message}`);
        }
      }
    } catch (err) {
      errors.push(`Invalid YAML: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (resourceType === 'agent') {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (parsed.name && typeof parsed.name === 'string' && !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(parsed.name)) {
        errors.push('Agent name must be kebab-case');
      }
    } catch (err) {
      errors.push(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (resourceType === 'schedule') {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (!parsed.cron || typeof parsed.cron !== 'string' || (parsed.cron as string).split(' ').length < 5) {
        errors.push('Schedule must have a valid 5-field cron expression');
      }
      if (!parsed.taskType) {
        errors.push('Schedule must have a taskType');
      }
    } catch (err) {
      errors.push(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (resourceType === 'suite') {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (parsed.name && typeof parsed.name === 'string' && !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(parsed.name)) {
        errors.push('Suite name must be kebab-case');
      }
    } catch (err) {
      errors.push(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Applies a config change using existing CRUD infrastructure.
 * Each resource type delegates to its native engine/store.
 * Validates content before applying.
 */
export function applyConfigChange(
  deps: ConfigApplierDeps,
  change: {
    changeId: string;
    action: ConfigChangeAction;
    resourceType: ConfigResourceType;
    resourceName: string;
    content?: string;
  },
): ApplyResult {
  const { action, resourceType, resourceName, content, changeId } = change;

  log.info(`Applying config change ${changeId}: ${action} ${resourceType} "${resourceName}"`);

  // Validate before applying (Task 3.7 + Task 12.3)
  const validation = validateConfigChange({ action, resourceType, resourceName, content });
  if (!validation.valid) {
    log.warn(`Config validation failed: ${validation.errors.join('; ')}`);
    return { success: false, message: `Validation failed: ${validation.errors.join('; ')}` };
  }

  try {
    switch (resourceType) {
      case 'pipeline':
        return applyPipelineChange(deps, action, resourceName, content);
      case 'suite':
        return applySuiteChange(deps, action, resourceName, content);
      case 'agent':
        return applyAgentChange(deps, action, resourceName, content);
      case 'schedule':
        return applyScheduleChange(deps, action, resourceName, content);
      default:
        return { success: false, message: `Unknown resource type: ${resourceType as string}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Config change failed: ${message}`);

    deps.eventBus.emit({
      id: generateId(),
      timestamp: Date.now(),
      source: SOURCE_CONFIG_MANAGER,
      type: 'config:change:rejected',
      payload: {
        changeId,
        action,
        resourceType,
        resourceName,
      },
    });

    return { success: false, message: `Failed to apply: ${message}`, error: message };
  }
}

function applyPipelineChange(
  deps: ConfigApplierDeps,
  action: ConfigChangeAction,
  name: string,
  content?: string,
): ApplyResult {
  if (action === 'create' || action === 'update') {
    if (!content) {
      return { success: false, message: 'Pipeline content (YAML) is required for create/update' };
    }
    deps.pipelineEngine.savePipeline(name, content);
    return { success: true, message: `Pipeline "${name}" ${action === 'create' ? 'created' : 'updated'}` };
  }

  if (action === 'delete') {
    const deleted = deps.pipelineEngine.deletePipeline(name);
    if (!deleted) {
      return { success: false, message: `Pipeline "${name}" not found` };
    }
    return { success: true, message: `Pipeline "${name}" deleted` };
  }

  return { success: false, message: `Unsupported pipeline action: ${action}` };
}

function applySuiteChange(
  deps: ConfigApplierDeps,
  action: ConfigChangeAction,
  name: string,
  content?: string,
): ApplyResult {
  if (action === 'create') {
    if (!content) {
      return { success: false, message: 'Suite definition content is required' };
    }
    const parsed = JSON.parse(content) as {
      name: string;
      displayName: string;
      description: string;
      mcpServers?: Record<string, unknown>;
    };
    const { suitePath } = deps.suiteScaffolder.scaffoldSuite({
      name: parsed.name || name,
      displayName: parsed.displayName || name,
      description: parsed.description || '',
      mcpServers: parsed.mcpServers,
    });
    return { success: true, message: `Suite "${name}" scaffolded at ${suitePath}` };
  }

  if (action === 'delete') {
    return { success: false, message: 'Suite deletion must be done manually (involves removing directories and updating config)' };
  }

  return { success: false, message: `Unsupported suite action: ${action}` };
}

function applyAgentChange(
  deps: ConfigApplierDeps,
  action: ConfigChangeAction,
  name: string,
  content?: string,
): ApplyResult {
  if (action === 'create') {
    if (!content) {
      return { success: false, message: 'Agent definition content is required' };
    }
    const parsed = JSON.parse(content) as {
      name: string;
      description?: string;
      instructions?: string;
      suite_ids?: string[];
    };
    const agent = deps.namedAgentStore.createAgent({
      name: parsed.name || name,
      description: parsed.description,
      instructions: parsed.instructions,
      suiteIds: parsed.suite_ids ?? [],
    });
    return { success: true, message: `Agent "${agent.name}" created` };
  }

  if (action === 'update') {
    if (!content) {
      return { success: false, message: 'Agent update content is required' };
    }
    const existing = deps.namedAgentStore.getAgentByName(name);
    if (!existing) {
      return { success: false, message: `Agent "${name}" not found` };
    }
    const parsed = JSON.parse(content) as {
      name?: string;
      description?: string;
      instructions?: string;
      suite_ids?: string[];
    };
    const agent = deps.namedAgentStore.updateAgent(existing.id, {
      name: parsed.name,
      description: parsed.description,
      instructions: parsed.instructions,
      suiteIds: parsed.suite_ids,
    });
    return { success: true, message: `Agent "${agent.name}" updated` };
  }

  if (action === 'delete') {
    const existing = deps.namedAgentStore.getAgentByName(name);
    if (!existing) {
      return { success: false, message: `Agent "${name}" not found` };
    }
    deps.namedAgentStore.deleteAgent(existing.id);
    return { success: true, message: `Agent "${name}" deleted` };
  }

  return { success: false, message: `Unsupported agent action: ${action}` };
}

function applyScheduleChange(
  deps: ConfigApplierDeps,
  action: ConfigChangeAction,
  name: string,
  content?: string,
): ApplyResult {
  if (action === 'create') {
    if (!content) {
      return { success: false, message: 'Schedule definition content is required' };
    }
    const parsed = JSON.parse(content) as {
      id?: string;
      name: string;
      cron: string;
      timezone?: string;
      taskType: string;
      skillName: string;
      enabled?: boolean;
    };
    deps.scheduler.addSchedule({
      id: parsed.id ?? generateId(),
      name: parsed.name || name,
      cron: parsed.cron,
      timezone: parsed.timezone ?? process.env.TZ ?? 'UTC',
      taskType: parsed.taskType,
      skillName: parsed.skillName,
      enabled: parsed.enabled ?? true,
    });
    return { success: true, message: `Schedule "${parsed.name || name}" created` };
  }

  if (action === 'delete') {
    const schedules = deps.scheduler.getSchedules();
    const match = schedules.find((s) => s.name === name || s.id === name);
    if (!match) {
      return { success: false, message: `Schedule "${name}" not found` };
    }
    deps.scheduler.removeSchedule(match.id);
    return { success: true, message: `Schedule "${name}" deleted` };
  }

  if (action === 'update') {
    // Validate and parse content BEFORE deleting old schedule (atomic safety)
    if (!content) {
      return { success: false, message: 'Schedule update content is required' };
    }
    const parsed = JSON.parse(content) as {
      id?: string;
      name: string;
      cron: string;
      timezone?: string;
      taskType: string;
      skillName: string;
      enabled?: boolean;
    };

    const schedules = deps.scheduler.getSchedules();
    const match = schedules.find((s) => s.name === name || s.id === name);
    if (!match) {
      return { success: false, message: `Schedule "${name}" not found` };
    }

    // Delete old, then create new
    deps.scheduler.removeSchedule(match.id);
    deps.scheduler.addSchedule({
      id: parsed.id ?? match.id,
      name: parsed.name || name,
      cron: parsed.cron,
      timezone: parsed.timezone ?? process.env.TZ ?? 'UTC',
      taskType: parsed.taskType,
      skillName: parsed.skillName,
      enabled: parsed.enabled ?? true,
    });
    return { success: true, message: `Schedule "${name}" updated` };
  }

  return { success: false, message: `Unsupported schedule action: ${action}` };
}
