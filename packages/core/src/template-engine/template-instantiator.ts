import { createLogger } from '@raven/shared';
import type { TaskTemplate, TaskTreeNode, TemplateParam } from '@raven/shared';

const logger = createLogger('template-instantiator');

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Resolve a dot-separated path against a context object.
 * Returns `undefined` if any segment is missing.
 */
function resolveDotPath(context: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = context;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Replace `{{ expression }}` placeholders in a string.
 *
 * - Expressions that resolve from `context` are replaced with their stringified value.
 * - Unresolved expressions (e.g. runtime task references) are left as-is.
 */
export function interpolateString(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (match, expr: string) => {
    const trimmed = expr.trim();
    const value = resolveDotPath(context, trimmed);
    if (value !== undefined) return String(value);
    // Leave unresolved expressions as-is (runtime resolution)
    return match;
  });
}

/**
 * Recursively interpolate all string fields on an object.
 */
function interpolateObject<T>(obj: T, context: Record<string, unknown>): T {
  if (typeof obj === 'string') {
    return interpolateString(obj, context) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => interpolateObject(item, context)) as unknown as T;
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = interpolateObject(value, context);
    }
    return result as T;
  }
  return obj;
}

// ── Param Validation ───────────────────────────────────────────────────

function checkParamType(name: string, value: unknown, expectedType: string): string | null {
  const actualType = typeof value;
  if (actualType !== expectedType) {
    return `Param "${name}" expected type ${expectedType}, got ${actualType}`;
  }
  return null;
}

function validateSingleParam(
  name: string,
  def: TemplateParam,
  value: unknown,
): { resolvedValue?: unknown; error?: string } {
  if (value === undefined || value === null) {
    if (def.default !== undefined) return { resolvedValue: def.default };
    if (def.required) return { error: `Missing required param: "${name}"` };
    return {};
  }
  const typeError = checkParamType(name, value, def.type);
  if (typeError) return { error: typeError };
  return {};
}

function validateParams(
  paramDefs: Record<string, TemplateParam>,
  params: Record<string, unknown>,
): { resolved: Record<string, unknown>; errors: string[] } {
  const resolved: Record<string, unknown> = { ...params };
  const errors: string[] = [];

  for (const [name, def] of Object.entries(paramDefs)) {
    const { resolvedValue, error } = validateSingleParam(name, def, params[name]);
    if (resolvedValue !== undefined) resolved[name] = resolvedValue;
    if (error) errors.push(error);
  }

  return { resolved, errors };
}

// ── forEach Expansion ──────────────────────────────────────────────────

// TemplateTask from the schema includes forEach + forEachAs on top of TaskTreeNode
// We work with the raw task objects from the template which have these extra fields
interface TemplateTaskWithForEach {
  forEach?: string;
  forEachAs?: string;
  id: string;
  title: string;
  type: string;
  blockedBy?: string[];
  [key: string]: unknown;
}

function isStaticForEachSource(expr: string, context: Record<string, unknown>): unknown[] | null {
  // Try to resolve the forEach expression from context
  const trimmed = expr.replace(/\{\{\s*([^}]+)\s*\}\}/g, '$1').trim();
  const value = resolveDotPath(context, trimmed);
  if (Array.isArray(value)) return value;
  return null;
}

function expandForEach(
  task: TemplateTaskWithForEach,
  context: Record<string, unknown>,
): { nodes: TaskTreeNode[]; errors: string[]; expandedIds: string[] } {
  const errors: string[] = [];
  const forEachExpr = task.forEach;
  if (!forEachExpr) {
    return { nodes: [], errors, expandedIds: [] };
  }

  const items = isStaticForEachSource(forEachExpr, context);
  if (items === null) {
    // Check if it looks like a runtime reference (task output)
    if (/\{\{.*\.\w+/.test(forEachExpr)) {
      // Leave as-is for runtime expansion — return the original task unchanged
      const { forEach: _fe, forEachAs: _fea, ...taskNode } = task;
      return { nodes: [taskNode as TaskTreeNode], errors, expandedIds: [] };
    }
    errors.push(`forEach expression "${forEachExpr}" did not resolve to an array`);
    return { nodes: [], errors, expandedIds: [] };
  }

  const itemAlias = task.forEachAs ?? 'item';
  const expandedNodes: TaskTreeNode[] = [];
  const expandedIds: string[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const newId = `${task.id}-${i}`;
    expandedIds.push(newId);

    // Build item context
    const itemContext: Record<string, unknown> = {
      ...context,
      [itemAlias]: item,
    };

    // Strip forEach fields and set new id
    const { forEach: _fe, forEachAs: _fea, ...baseTask } = task;
    const expanded = interpolateObject({ ...baseTask, id: newId }, itemContext);
    expandedNodes.push(expanded as TaskTreeNode);
  }

  return { nodes: expandedNodes, errors, expandedIds };
}

// ── blockedBy Rewriting ────────────────────────────────────────────────

function rewriteBlockedBy(nodes: TaskTreeNode[], expansions: Map<string, string[]>): void {
  for (const node of nodes) {
    if (!node.blockedBy || node.blockedBy.length === 0) continue;
    const newBlockedBy: string[] = [];
    for (const dep of node.blockedBy) {
      const expanded = expansions.get(dep);
      newBlockedBy.push(...(expanded ?? [dep]));
    }
    (node as { blockedBy: string[] }).blockedBy = newBlockedBy;
  }
}

// ── Task Processing ────────────────────────────────────────────────────

function processTasks(
  tasks: TaskTemplate['tasks'],
  resolved: Record<string, unknown>,
): { nodes: TaskTreeNode[]; errors: string[] } {
  const resultNodes: TaskTreeNode[] = [];
  const forEachExpansions = new Map<string, string[]>();
  const errors: string[] = [];

  for (const rawTask of tasks) {
    const task = rawTask as TemplateTaskWithForEach;

    if (task.forEach) {
      const result = expandForEach(task, resolved);
      errors.push(...result.errors);
      resultNodes.push(...result.nodes);
      if (result.expandedIds.length > 0) {
        forEachExpansions.set(task.id, result.expandedIds);
      }
    } else {
      const interpolated = interpolateObject(task, resolved);
      resultNodes.push(interpolated as TaskTreeNode);
    }
  }

  if (forEachExpansions.size > 0) {
    rewriteBlockedBy(resultNodes, forEachExpansions);
  }

  return { nodes: resultNodes, errors };
}

// ── Main Instantiator ──────────────────────────────────────────────────

export function instantiateTemplate(
  template: TaskTemplate,
  params: Record<string, unknown>,
): { nodes: TaskTreeNode[]; errors: string[] } {
  const { resolved, errors: paramErrors } = validateParams(template.params, params);

  if (paramErrors.length > 0) {
    return { nodes: [], errors: paramErrors };
  }

  const { nodes, errors } = processTasks(template.tasks, resolved);

  logger.info(
    `Instantiated template "${template.name}": ${nodes.length} nodes, ${errors.length} errors`,
  );

  return { nodes, errors };
}
