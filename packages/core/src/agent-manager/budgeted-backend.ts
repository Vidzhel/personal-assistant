import { randomUUID } from 'node:crypto';
import type { AgentBackend, BackendOptions, BackendResult } from './agent-backend.ts';
import { runCancellableBackend } from './agent-backend.ts';
import type { ModelBudget } from './model-budget.ts';

const BUDGET_EXHAUSTED = 'budget exhausted: no model budget remains for this query';

function cancelledResult(): BackendResult {
  return { result: '', success: false, errors: ['cancelled'] };
}

function validCost(result: BackendResult): number | undefined {
  return typeof result.estimatedCostUsd === 'number' &&
    Number.isFinite(result.estimatedCostUsd) &&
    result.estimatedCostUsd >= 0
    ? result.estimatedCostUsd
    : undefined;
}

function settlementReason(result: BackendResult): string {
  if (result.errors.some((error) => error.toLowerCase().includes('cancel'))) return 'cancelled';
  return result.success ? 'completed' : 'failed';
}

function settleResult(budget: ModelBudget, id: string, result: BackendResult): void {
  const reason = settlementReason(result);
  const costUsd = validCost(result);
  if (costUsd === undefined) {
    budget.settle(id, { reason });
  } else {
    budget.settle(id, { costUsd, reason });
  }
}

/** Add the single shared model-budget admission boundary around a backend. */
export function createBudgetedBackend(deps: {
  backend: AgentBackend;
  budget: ModelBudget;
}): AgentBackend {
  return async (options: BackendOptions): Promise<BackendResult> => {
    if (options.signal?.aborted) return cancelledResult();

    const lease = deps.budget.reserve({
      taskId: options.taskId ?? randomUUID(),
      model: options.model,
    });
    if (!lease) return { result: '', success: false, errors: [BUDGET_EXHAUSTED] };

    // A synchronous reserve can observe cancellation from an admission hook.
    // Release that lease before invoking the provider in this case.
    if (options.signal?.aborted) {
      deps.budget.releaseBeforeStart(lease.id);
      return cancelledResult();
    }

    try {
      const result = await runCancellableBackend(deps.backend, {
        ...options,
        maxBudgetUsd: lease.maxBudgetUsd,
      });
      settleResult(deps.budget, lease.id, result);
      return result;
    } catch (error) {
      deps.budget.settle(lease.id, { reason: 'failed' });
      throw error;
    }
  };
}
