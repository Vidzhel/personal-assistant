import type { ExecutionTask } from '@raven/shared';
import { createLogger } from '@raven/shared';

const log = createLogger('dependency-resolver');

/**
 * Build reverse adjacency map and in-degree map from a task map.
 * Shared by validateDag and topologicalSort.
 */
function buildGraph(tasks: Map<string, ExecutionTask>): {
  inDegree: Map<string, number>;
  dependents: Map<string, string[]>;
} {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const id of tasks.keys()) {
    inDegree.set(id, 0);
    dependents.set(id, []);
  }

  for (const [, task] of tasks) {
    const depCount = task.node.blockedBy.filter((dep) => tasks.has(dep)).length;
    inDegree.set(task.id, depCount);

    for (const dep of task.node.blockedBy) {
      dependents.get(dep)?.push(task.id);
    }
  }

  return { inDegree, dependents };
}

/**
 * Run Kahn's algorithm on the graph, returning the topological order.
 * If the order length < task count, the graph has cycles.
 */
function kahnSort(
  tasks: Map<string, ExecutionTask>,
  inDegree: Map<string, number>,
  dependents: Map<string, string[]>,
): string[] {
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      queue.push(id);
    }
  }
  queue.sort();

  const order: string[] = [];

  while (queue.length > 0) {
    // Safe: loop condition guarantees length > 0
    const node = queue.shift() as string;
    order.push(node);

    const nextBatch: string[] = [];
    for (const dependent of dependents.get(node) ?? []) {
      const newDegree = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, newDegree);
      if (newDegree === 0) {
        nextBatch.push(dependent);
      }
    }
    nextBatch.sort();
    queue.push(...nextBatch);
  }

  return order;
}

/**
 * Validate that a task map forms a valid DAG.
 * Returns an array of error strings (empty = valid).
 */
export function validateDag(tasks: Map<string, ExecutionTask>): string[] {
  const errors: string[] = [];

  // Check all blockedBy references point to existing task IDs
  for (const [id, task] of tasks) {
    for (const dep of task.node.blockedBy) {
      if (!tasks.has(dep)) {
        errors.push(`Task '${id}' references missing dependency '${dep}'`);
      }
    }
  }

  if (errors.length > 0) {
    return errors;
  }

  // Kahn's algorithm: detect cycles via in-degree counting
  const { inDegree, dependents } = buildGraph(tasks);
  const order = kahnSort(tasks, inDegree, dependents);

  if (order.length < tasks.size) {
    const sortedSet = new Set(order);
    const cycleNodes = [...tasks.keys()].filter((id) => !sortedSet.has(id));
    const msg = `Cycle detected involving tasks: ${cycleNodes.join(', ')}`;
    log.warn(msg);
    errors.push(msg);
  }

  return errors;
}

/**
 * Find task IDs that are ready to execute.
 * A task is ready when its status is 'todo' and all blockedBy deps are 'completed' or 'skipped'.
 */
export function findReadyTasks(tasks: Map<string, ExecutionTask>): string[] {
  const ready: string[] = [];

  for (const [id, task] of tasks) {
    if (task.status !== 'todo') {
      continue;
    }

    const allDepsSatisfied = task.node.blockedBy.every((depId) => {
      const depTask = tasks.get(depId);
      return depTask != null && (depTask.status === 'completed' || depTask.status === 'skipped');
    });

    if (allDepsSatisfied) {
      ready.push(id);
    }
  }

  return ready;
}

/**
 * Return task IDs in a valid topological execution order (respecting dependencies).
 * Uses Kahn's algorithm. Sorts within each level for determinism.
 */
export function topologicalSort(tasks: Map<string, ExecutionTask>): string[] {
  const { inDegree, dependents } = buildGraph(tasks);
  return kahnSort(tasks, inDegree, dependents);
}
