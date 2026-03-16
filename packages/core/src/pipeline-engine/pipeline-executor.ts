import {
  createLogger,
  generateId,
  type RavenEvent,
  type AgentTaskCompleteEvent,
  type PipelineRunRecord,
} from '@raven/shared';
import type { EventBus } from '../event-bus/event-bus.ts';
import type { SuiteRegistry } from '../suite-registry/suite-registry.ts';
import type { McpManager } from '../mcp-manager/mcp-manager.ts';
import type { PipelineStore } from './pipeline-store.ts';
import type { ValidatedPipeline } from './pipeline-loader.ts';
import { evaluateCondition } from './condition-evaluator.ts';

const log = createLogger('pipeline-executor');

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_POLL_INTERVAL_MS = 5000;

type NodeStatus = 'pending' | 'running' | 'complete' | 'failed' | 'skipped';

export interface PipelineRunResult {
  runId: string;
  pipelineName: string;
  status: 'completed' | 'failed';
  startedAt: string;
  completedAt: string;
  durationMs: number;
  nodeResults: Record<
    string,
    { status: string; output?: unknown; error?: string; durationMs: number }
  >;
  error?: string;
}

export interface ExecutePipelineOptions {
  runId?: string;
}

export interface PipelineExecutor {
  executePipeline: (
    pipeline: ValidatedPipeline,
    triggerType: string,
    options?: ExecutePipelineOptions,
  ) => Promise<PipelineRunResult>;
}

export interface PipelineExecutorDeps {
  eventBus: EventBus;
  suiteRegistry: SuiteRegistry;
  mcpManager: McpManager;
  pipelineStore: PipelineStore;
}

// eslint-disable-next-line max-lines-per-function -- factory function that initializes pipeline executor with node execution, retry, and DAG traversal
export function createPipelineExecutor(deps: PipelineExecutorDeps): PipelineExecutor {
  const { eventBus, suiteRegistry, mcpManager, pipelineStore } = deps;

  function emitEvent(event: RavenEvent): void {
    eventBus.emit(event);
  }

  function waitForTaskCompletion(
    taskId: string,
    timeoutMs: number,
  ): Promise<{ result?: string; error?: string }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        eventBus.off('agent:task:complete', handler);
        resolve({ error: `Task ${taskId} timed out after ${timeoutMs}ms` });
      }, timeoutMs);

      const handler = (event: RavenEvent): void => {
        const e = event as AgentTaskCompleteEvent;
        if (e.payload.taskId === taskId) {
          clearTimeout(timer);
          eventBus.off('agent:task:complete', handler);
          if (e.payload.success) {
            resolve({ result: e.payload.result });
          } else {
            resolve({
              error: e.payload.errors?.join(', ') ?? 'Task failed',
            });
          }
        }
      };
      // Both success and failure come through agent:task:complete
      eventBus.on('agent:task:complete', handler);
    });
  }

  // eslint-disable-next-line complexity -- topological sort with in-degree tracking
  function groupByTopologicalLevel(
    executionOrder: string[],
    connections: ValidatedPipeline['config']['connections'],
  ): string[][] {
    // Build in-degree map
    const inDegree = new Map<string, Set<string>>();
    for (const nodeId of executionOrder) {
      inDegree.set(nodeId, new Set());
    }
    for (const conn of connections) {
      inDegree.get(conn.to)?.add(conn.from);
    }

    const levels: string[][] = [];
    const placed = new Set<string>();

    while (placed.size < executionOrder.length) {
      const level: string[] = [];
      for (const nodeId of executionOrder) {
        if (placed.has(nodeId)) continue;
        const deps = inDegree.get(nodeId);
        if (!deps || [...deps].every((d) => placed.has(d))) {
          level.push(nodeId);
        }
      }
      if (level.length === 0) break; // prevent infinite loop
      for (const nodeId of level) {
        placed.add(nodeId);
      }
      levels.push(level);
    }

    return levels;
  }

  interface RetryConfig {
    maxAttempts: number;
    backoffMs: number;
  }

  interface NodeContext {
    pipeline: ValidatedPipeline;
    nodeId: string;
    nodeOutputs: Map<string, unknown>;
    conditionResults: Map<string, boolean>;
    timeoutMs: number;
  }

  async function executeNode(ctx: NodeContext): Promise<{ output?: unknown; error?: string }> {
    const node = ctx.pipeline.config.nodes[ctx.nodeId];
    if (!node) return { error: `Node not found: ${ctx.nodeId}` };

    // Determine node type
    if (node.type === 'condition') {
      return executeConditionNode(ctx, node);
    }

    if (node.type === 'delay') {
      return executeDelayNode(node);
    }

    if (node.type === 'merge') {
      return { output: null };
    }

    if (node.type === 'code' || node.type === 'switch') {
      log.warn(`Node type '${node.type}' not yet implemented, skipping: ${ctx.nodeId}`);
      return { output: null };
    }

    // Default: skill-action node
    return executeSkillActionNode(ctx, node);
  }

  function executeConditionNode(
    ctx: NodeContext,
    node: { expression?: string },
  ): { output?: unknown; error?: string } {
    if (!node.expression) {
      return { error: `Condition node ${ctx.nodeId} has no expression` };
    }
    const outputs: Record<string, unknown> = {};
    for (const [key, value] of ctx.nodeOutputs) {
      outputs[key] = value;
    }
    const result = evaluateCondition(node.expression, outputs);
    ctx.conditionResults.set(ctx.nodeId, result);
    return { output: result };
  }

  async function executeDelayNode(node: { duration?: number }): Promise<{ output?: unknown }> {
    const duration = node.duration ?? 0;
    if (duration > 0) {
      await new Promise((resolve) => setTimeout(resolve, duration));
    }
    return { output: null };
  }

  async function executeSkillActionNode(
    ctx: NodeContext,
    node: {
      skill?: string;
      action?: string;
      params?: Record<string, unknown>;
    },
  ): Promise<{ output?: unknown; error?: string }> {
    const skillName = node.skill;
    if (!skillName) {
      return { error: `Node ${ctx.nodeId} has no skill specified` };
    }

    const suite = suiteRegistry.getSuite(skillName);
    if (!suite) {
      return { error: `Suite not found: ${skillName}` };
    }

    const mcpServers = mcpManager.resolveForSuite(skillName);
    const agentDefinitions = suiteRegistry.collectAgentDefinitions([skillName]);

    const taskId = generateId();
    const prompt = buildPrompt(node, ctx.nodeOutputs);

    const completionPromise = waitForTaskCompletion(taskId, ctx.timeoutMs);

    emitEvent({
      id: generateId(),
      timestamp: Date.now(),
      source: 'pipeline-executor',
      type: 'agent:task:request',
      payload: {
        taskId,
        prompt,
        skillName,
        actionName: node.action,
        pipelineName: ctx.pipeline.config.name,
        mcpServers,
        agentDefinitions,
        priority: 'normal',
      },
    });

    const completion = await completionPromise;
    if (completion.error) {
      return { error: completion.error };
    }
    return { output: completion.result };
  }

  async function executeNodeWithRetry(
    ctx: NodeContext,
    retryConfig: RetryConfig,
    runId: string,
  ): Promise<{ output?: unknown; error?: string; attempts: number }> {
    const node = ctx.pipeline.config.nodes[ctx.nodeId];
    // Only retry skill-action nodes (no type field = skill-action)
    const isRetryable = !node?.type;
    const maxAttempts = isRetryable ? retryConfig.maxAttempts : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await executeNode(ctx);

      if (!result.error || attempt === maxAttempts) {
        return { ...result, attempts: attempt };
      }

      // Emit retry event before waiting
      const backoffMs = retryConfig.backoffMs * Math.pow(2, attempt - 1);
      emitEvent({
        id: generateId(),
        timestamp: Date.now(),
        source: 'pipeline-executor',
        type: 'pipeline:step:retry',
        payload: {
          runId,
          pipelineName: ctx.pipeline.config.name,
          nodeId: ctx.nodeId,
          attempt,
          maxAttempts,
          backoffMs,
          timestamp: new Date().toISOString(),
        },
      });

      log.warn(
        `Retrying node ${ctx.nodeId} (attempt ${String(attempt + 1)}/${String(maxAttempts)}) after ${String(backoffMs)}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }

    // Should not reach here, but TypeScript needs it
    return { error: 'Retry logic error', attempts: maxAttempts };
  }

  function buildPrompt(
    node: {
      action?: string;
      params?: Record<string, unknown>;
    },
    nodeOutputs: Map<string, unknown>,
  ): string {
    const parts: string[] = [];
    if (node.action) {
      parts.push(`Execute action: ${node.action}`);
    }
    if (node.params && Object.keys(node.params).length > 0) {
      parts.push(`Parameters: ${JSON.stringify(node.params)}`);
    }
    if (nodeOutputs.size > 0) {
      const context: Record<string, unknown> = {};
      for (const [key, value] of nodeOutputs) {
        context[key] = value;
      }
      parts.push(`Previous node outputs: ${JSON.stringify(context)}`);
    }
    return parts.join('\n') || 'Execute pipeline node';
  }

  return {
    // eslint-disable-next-line max-lines-per-function, complexity -- core pipeline execution with DAG traversal, condition routing, and retry logic
    async executePipeline(
      pipeline: ValidatedPipeline,
      triggerType: string,
      options?: ExecutePipelineOptions,
    ): Promise<PipelineRunResult> {
      const runId = options?.runId ?? generateId();
      const pipelineName = pipeline.config.name;
      const startedAt = new Date().toISOString();
      const startTime = Date.now();
      const onError = pipeline.config.settings?.onError ?? 'stop';
      const timeoutMs = pipeline.config.settings?.timeout ?? DEFAULT_TIMEOUT_MS;
      const retrySettings = pipeline.config.settings?.retry;
      const retryConfig: RetryConfig = {
        maxAttempts: retrySettings?.maxAttempts ?? 1,
        backoffMs: retrySettings?.backoffMs ?? DEFAULT_POLL_INTERVAL_MS,
      };

      const nodeOutputs = new Map<string, unknown>();
      const nodeStatus = new Map<string, NodeStatus>();
      const nodeResults: Record<
        string,
        { status: string; output?: unknown; error?: string; durationMs: number }
      > = {};
      const conditionResults = new Map<string, boolean>();

      // Initialize all nodes as pending
      for (const nodeId of pipeline.executionOrder) {
        nodeStatus.set(nodeId, 'pending');
      }

      // Insert pipeline run record
      const runRecord: PipelineRunRecord = {
        id: runId,
        pipeline_name: pipelineName,
        trigger_type: triggerType,
        status: 'running',
        started_at: startedAt,
      };
      pipelineStore.insertRun(runRecord);

      // Emit pipeline:started
      emitEvent({
        id: generateId(),
        timestamp: Date.now(),
        source: 'pipeline-executor',
        type: 'pipeline:started',
        payload: {
          runId,
          pipelineName,
          triggerType,
          timestamp: startedAt,
        },
      });

      log.info(`Pipeline started: ${pipelineName} (run: ${runId}, trigger: ${triggerType})`);

      let pipelineFailed = false;
      let pipelineError: string | undefined;

      try {
        const levels = groupByTopologicalLevel(
          pipeline.executionOrder,
          pipeline.config.connections,
        );

        for (const level of levels) {
          // Filter nodes that are ready to execute
          const readyNodes = level.filter((nodeId) => {
            const status = nodeStatus.get(nodeId);
            if (status !== 'pending') return false;

            // Check if node should be skipped due to condition routing
            const upstreamConnections = pipeline.config.connections.filter((c) => c.to === nodeId);

            // If node has upstream conditional connections, check if any are active
            if (upstreamConnections.length > 0) {
              const hasActiveUpstream = upstreamConnections.some((conn) => {
                const fromStatus = nodeStatus.get(conn.from);
                if (fromStatus !== 'complete') return false;
                // Unconditional connections are always active
                if (conn.condition === undefined) return true;
                // Check condition routing
                const condResult = conditionResults.get(conn.from);
                if (condResult === undefined) return true;
                return conn.condition === String(condResult);
              });

              if (!hasActiveUpstream) {
                // Check if all upstream nodes are complete/skipped
                const allUpstreamDone = upstreamConnections.every((conn) => {
                  const s = nodeStatus.get(conn.from);
                  return s === 'complete' || s === 'skipped' || s === 'failed';
                });
                if (allUpstreamDone) {
                  nodeStatus.set(nodeId, 'skipped');
                  nodeResults[nodeId] = {
                    status: 'skipped',
                    durationMs: 0,
                  };
                  return false;
                }
                return false;
              }

              // Check if any upstream failed and onError is stop
              if (onError === 'stop') {
                const hasFailedUpstream = upstreamConnections.some((conn) => {
                  return nodeStatus.get(conn.from) === 'failed';
                });
                if (hasFailedUpstream) {
                  nodeStatus.set(nodeId, 'skipped');
                  nodeResults[nodeId] = {
                    status: 'skipped',
                    durationMs: 0,
                  };
                  return false;
                }
              }
            }

            return true;
          });

          // Execute ready nodes in parallel
          const results = await Promise.all(
            // eslint-disable-next-line max-lines-per-function -- node execution with success/failure event emission
            readyNodes.map(async (nodeId) => {
              nodeStatus.set(nodeId, 'running');
              const nodeStartTime = Date.now();

              const retryResult = await executeNodeWithRetry(
                { pipeline, nodeId, nodeOutputs, conditionResults, timeoutMs },
                retryConfig,
                runId,
              );

              const nodeDurationMs = Date.now() - nodeStartTime;

              if (retryResult.error) {
                nodeStatus.set(nodeId, 'failed');
                nodeResults[nodeId] = {
                  status: 'failed',
                  error: retryResult.error,
                  durationMs: nodeDurationMs,
                };
                nodeOutputs.set(nodeId, { error: retryResult.error });

                emitEvent({
                  id: generateId(),
                  timestamp: Date.now(),
                  source: 'pipeline-executor',
                  type: 'pipeline:step:failed',
                  payload: {
                    runId,
                    pipelineName,
                    nodeId,
                    error: retryResult.error,
                    durationMs: nodeDurationMs,
                    timestamp: new Date().toISOString(),
                    attempt: retryResult.attempts,
                    maxAttempts: retryConfig.maxAttempts,
                  },
                });

                return { nodeId, failed: true, error: retryResult.error };
              }

              nodeStatus.set(nodeId, 'complete');
              nodeOutputs.set(nodeId, retryResult.output);
              nodeResults[nodeId] = {
                status: 'complete',
                output: retryResult.output,
                durationMs: nodeDurationMs,
              };

              emitEvent({
                id: generateId(),
                timestamp: Date.now(),
                source: 'pipeline-executor',
                type: 'pipeline:step:complete',
                payload: {
                  runId,
                  pipelineName,
                  nodeId,
                  output: retryResult.output,
                  durationMs: nodeDurationMs,
                  timestamp: new Date().toISOString(),
                  attempt: retryResult.attempts,
                  maxAttempts: retryConfig.maxAttempts,
                },
              });

              return { nodeId, failed: false };
            }),
          );

          // Check for failures
          const failures = results.filter((r) => r.failed);
          if (failures.length > 0 && onError === 'stop') {
            pipelineFailed = true;
            pipelineError = `Node(s) failed: ${failures.map((f) => f.nodeId).join(', ')}`;
            // Mark remaining pending nodes as skipped
            for (const nodeId of pipeline.executionOrder) {
              if (nodeStatus.get(nodeId) === 'pending') {
                nodeStatus.set(nodeId, 'skipped');
                nodeResults[nodeId] = { status: 'skipped', durationMs: 0 };
              }
            }
            break;
          }
        }

        // With onError: continue, mark as failed if ALL nodes failed
        if (!pipelineFailed && onError === 'continue') {
          const anySucceeded = pipeline.executionOrder.some(
            (nodeId) => nodeStatus.get(nodeId) === 'complete',
          );
          if (!anySucceeded) {
            pipelineFailed = true;
            pipelineError = 'All nodes failed';
          }
        }
      } catch (err) {
        pipelineFailed = true;
        pipelineError = err instanceof Error ? err.message : String(err);
      }

      const completedAt = new Date().toISOString();
      const durationMs = Date.now() - startTime;
      const finalStatus = pipelineFailed ? 'failed' : 'completed';

      // Update pipeline run record
      pipelineStore.updateRun(runId, {
        status: finalStatus,
        completed_at: completedAt,
        node_results: JSON.stringify(nodeResults),
        error: pipelineError,
      });

      // Emit completion event
      if (pipelineFailed) {
        emitEvent({
          id: generateId(),
          timestamp: Date.now(),
          source: 'pipeline-executor',
          type: 'pipeline:failed',
          payload: {
            runId,
            pipelineName,
            status: 'failed',
            error: pipelineError ?? 'Unknown error',
            durationMs,
            timestamp: completedAt,
          },
        });
      } else {
        emitEvent({
          id: generateId(),
          timestamp: Date.now(),
          source: 'pipeline-executor',
          type: 'pipeline:complete',
          payload: {
            runId,
            pipelineName,
            status: 'completed',
            durationMs,
            timestamp: completedAt,
          },
        });
      }

      log.info(`Pipeline ${finalStatus}: ${pipelineName} (run: ${runId}, ${durationMs}ms)`);

      return {
        runId,
        pipelineName,
        status: finalStatus,
        startedAt,
        completedAt,
        durationMs,
        nodeResults,
        error: pipelineError,
      };
    },
  };
}
