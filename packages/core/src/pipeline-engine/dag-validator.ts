import type { PipelineNode, PipelineConnection } from '@raven/shared';

export interface DagValidationResult {
  valid: boolean;
  executionOrder?: string[];
  entryPoints?: string[];
  error?: string;
}

export function validateDag(
  nodes: Record<string, PipelineNode>,
  connections: PipelineConnection[],
): DagValidationResult {
  const nodeIds = new Set(Object.keys(nodes));

  // Validate all connection references exist
  for (const conn of connections) {
    if (!nodeIds.has(conn.from)) {
      return { valid: false, error: `Connection references unknown node: '${conn.from}'` };
    }
    if (!nodeIds.has(conn.to)) {
      return { valid: false, error: `Connection references unknown node: '${conn.to}'` };
    }
  }

  // Build adjacency list and in-degree map
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const id of nodeIds) {
    inDegree.set(id, 0);
    adjacency.set(id, []);
  }

  for (const conn of connections) {
    const adj = adjacency.get(conn.from);
    if (adj) adj.push(conn.to);
    const current = inDegree.get(conn.to) ?? 0;
    inDegree.set(conn.to, current + 1);
  }

  // Find entry points (nodes with in-degree 0)
  const entryPoints: string[] = [];
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      entryPoints.push(id);
      queue.push(id);
    }
  }

  if (entryPoints.length === 0) {
    return {
      valid: false,
      error: 'No entry point nodes found (all nodes have inbound connections)',
    };
  }

  // Kahn's algorithm - BFS topological sort
  const executionOrder: string[] = [];
  // Sort queue for deterministic order
  queue.sort();

  while (queue.length > 0) {
    const node = queue.shift();
    if (!node) break;
    executionOrder.push(node);

    const neighbors = adjacency.get(node) ?? [];
    const nextBatch: string[] = [];
    for (const neighbor of neighbors) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        nextBatch.push(neighbor);
      }
    }
    // Sort for deterministic order
    nextBatch.sort();
    queue.push(...nextBatch);
  }

  if (executionOrder.length < nodeIds.size) {
    const sortedSet = new Set(executionOrder);
    const cycleNodes = [...nodeIds].filter((id) => !sortedSet.has(id));
    return {
      valid: false,
      error: `Cycle detected involving nodes: ${cycleNodes.join(', ')}`,
    };
  }

  return {
    valid: true,
    executionOrder,
    entryPoints: entryPoints.sort(),
  };
}
