import type * as Neo4jModule from 'neo4j-driver';
import type * as ClientModule from '../knowledge-engine/neo4j-client.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const driver = vi.hoisted(() => ({
  run: vi.fn(async () => ({ records: [] })),
  closeSession: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  create: vi.fn(),
}));
vi.mock('neo4j-driver', async (original) => {
  const actual = await original<typeof Neo4jModule>();
  driver.create.mockImplementation(() => ({
    session: () => ({ run: driver.run, close: driver.closeSession }),
    close: driver.close,
  }));
  return { ...actual, default: { ...actual.default, driver: driver.create } };
});

// Bypass only the real-client guard; the driver's network boundary above remains fake.
const { createNeo4jClient } = await vi.importActual<typeof ClientModule>(
  '../knowledge-engine/neo4j-client.ts',
);

describe('Neo4j schema startup contract', () => {
  beforeEach(() => {
    driver.run.mockReset().mockResolvedValue({ records: [] });
    driver.close.mockClear();
    driver.closeSession.mockClear();
  });

  function client() {
    return createNeo4jClient({ uri: 'bolt://fake.invalid', user: 'fake', password: 'fake' });
  }

  it('uses IF NOT EXISTS for every schema statement and can run twice', async () => {
    const graph = client();
    await graph.ensureSchema();
    const firstCalls = driver.run.mock.calls.length;
    await graph.ensureSchema();
    expect(driver.run).toHaveBeenCalledTimes(firstCalls * 2);
    for (const [cypher] of driver.run.mock.calls as unknown as Array<[string]>) {
      if (cypher.startsWith('CREATE')) expect(cypher).toContain('IF NOT EXISTS');
    }
    expect(driver.closeSession).toHaveBeenCalledTimes(firstCalls * 2);
    await graph.close();
  });

  it.each([
    'ServiceUnavailable',
    'Neo.ClientError.Security.Forbidden',
    'Neo.ClientError.Schema.ConstraintValidationFailed',
    'Neo.ClientError.Statement.SyntaxError',
  ])('propagates genuine %s failures instead of announcing successful setup', async (code) => {
    const graph = client();
    const error = Object.assign(new Error('equivalent already exists is not an error policy'), {
      code,
    });
    driver.run.mockRejectedValueOnce(error);
    await expect(graph.ensureSchema()).rejects.toBe(error);
    expect(driver.run).toHaveBeenCalledTimes(1);
    expect(driver.closeSession).toHaveBeenCalledTimes(1);
    await graph.close();
  });

  it('propagates required backfill failure and refuses new work after close', async () => {
    const graph = client();
    driver.run.mockImplementation(async (...args: unknown[]) => {
      if (String(args[0]).startsWith('MATCH')) throw new Error('backfill unavailable');
      return { records: [] };
    });
    await expect(graph.ensureSchema()).rejects.toThrow('backfill unavailable');
    await graph.close();
    await graph.close();
    expect(driver.close).toHaveBeenCalledTimes(1);
    const count = driver.run.mock.calls.length;
    await expect(graph.run('RETURN 1')).rejects.toThrow('closed');
    expect(driver.run).toHaveBeenCalledTimes(count);
  });
});
