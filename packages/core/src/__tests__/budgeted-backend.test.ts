import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentBackend, BackendOptions } from '../agent-manager/agent-backend.ts';
import { createBudgetedBackend } from '../agent-manager/budgeted-backend.ts';
import type { ModelBudget } from '../agent-manager/model-budget.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function options(
  overrides: Partial<BackendOptions> & { taskId?: string; maxBudgetUsd?: number } = {},
): BackendOptions {
  return {
    prompt: 'prompt',
    systemPrompt: 'system',
    allowedTools: [],
    model: 'model',
    maxTurns: 1,
    mcpServers: {},
    agents: {},
    onAssistantMessage: vi.fn(),
    onStderr: vi.fn(),
    ...overrides,
  };
}

function fixture() {
  const reserve = vi.fn<ModelBudget['reserve']>(() => ({ id: 'lease-1', maxBudgetUsd: 0.25 }));
  const settle = vi.fn<ModelBudget['settle']>();
  const releaseBeforeStart = vi.fn<ModelBudget['releaseBeforeStart']>();
  const budget = { reserve, settle, releaseBeforeStart } as unknown as ModelBudget;
  const backend = vi.fn<AgentBackend>(async () => ({ result: 'ok', success: true, errors: [] }));
  return { budget, reserve, settle, releaseBeforeStart, backend };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('budgeted backend', () => {
  it('does not reserve or dispatch when already aborted', async () => {
    const { budget, reserve, backend } = fixture();
    const controller = new AbortController();
    controller.abort();

    const result = await createBudgetedBackend({ backend, budget })(
      options({ signal: controller.signal }),
    );

    expect(result).toEqual({ result: '', success: false, errors: ['cancelled'] });
    expect(reserve).not.toHaveBeenCalled();
    expect(backend).not.toHaveBeenCalled();
  });

  it('returns a clear exhausted result without calling the provider', async () => {
    const { budget, reserve, backend } = fixture();
    reserve.mockReturnValueOnce(undefined);

    const result = await createBudgetedBackend({ backend, budget })(options());

    expect(result.success).toBe(false);
    expect(result.errors).toEqual([expect.stringContaining('budget exhausted')]);
    expect(backend).not.toHaveBeenCalled();
  });

  it('forwards the admitted cap and settles a valid known estimate before returning', async () => {
    const { budget, reserve, settle, backend } = fixture();
    backend.mockResolvedValueOnce({
      result: 'ok',
      success: true,
      errors: [],
      estimatedCostUsd: 0.12,
    });

    const result = await createBudgetedBackend({ backend, budget })(options({ taskId: 'task-7' }));

    expect(result.success).toBe(true);
    expect(reserve).toHaveBeenCalledWith({ taskId: 'task-7', model: 'model' });
    expect(backend.mock.calls[0]?.[0]).toMatchObject({ maxBudgetUsd: 0.25 });
    expect(settle).toHaveBeenCalledWith('lease-1', { costUsd: 0.12, reason: 'completed' });
  });

  it('charges unknown usage for failed results and preserves provider errors', async () => {
    const { budget, settle, backend } = fixture();
    backend.mockResolvedValueOnce({
      result: '',
      success: false,
      errors: ['provider failed'],
      estimatedCostUsd: Number.NaN,
    });

    const result = await createBudgetedBackend({ backend, budget })(options());

    expect(result).toMatchObject({ success: false, errors: ['provider failed'] });
    expect(settle).toHaveBeenCalledWith('lease-1', { reason: 'failed' });
  });

  it('settles unknown usage and rethrows a provider exception', async () => {
    const { budget, settle, backend } = fixture();
    const failure = new Error('provider crashed');
    backend.mockRejectedValueOnce(failure);

    await expect(createBudgetedBackend({ backend, budget })(options())).rejects.toBe(failure);

    expect(settle).toHaveBeenCalledWith('lease-1', { reason: 'failed' });
  });

  it('releases a lease if cancellation arrives after admission but before dispatch', async () => {
    const { budget, reserve, releaseBeforeStart, backend } = fixture();
    const controller = new AbortController();
    reserve.mockImplementationOnce(() => {
      controller.abort();
      return { id: 'lease-1', maxBudgetUsd: 0.25 };
    });

    const result = await createBudgetedBackend({ backend, budget })(
      options({ signal: controller.signal }),
    );

    expect(result.errors).toEqual(['cancelled']);
    expect(releaseBeforeStart).toHaveBeenCalledWith('lease-1');
    expect(backend).not.toHaveBeenCalled();
  });

  it('settles cancellation once while observing an uncooperative backend', async () => {
    vi.useFakeTimers();
    const { budget, settle, backend } = fixture();
    const started = deferred<undefined>();
    const late = deferred<Awaited<ReturnType<AgentBackend>>>();
    backend.mockImplementationOnce(async () => {
      started.resolve(undefined);
      return late.promise;
    });
    const controller = new AbortController();
    const call = createBudgetedBackend({ backend, budget })(options({ signal: controller.signal }));
    await started.promise;
    controller.abort();
    await vi.advanceTimersByTimeAsync(1000);

    await expect(call).resolves.toMatchObject({ errors: ['cancelled'], success: false });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith('lease-1', { reason: 'cancelled' });
    late.resolve({ result: 'late', success: true, errors: [] });
    await late.promise;
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('generates correlation for standalone calls', async () => {
    const { budget, reserve } = fixture();
    await createBudgetedBackend({ backend: fixture().backend, budget })(options());

    expect(reserve).toHaveBeenCalledWith({
      taskId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      model: 'model',
    });
  });
});
