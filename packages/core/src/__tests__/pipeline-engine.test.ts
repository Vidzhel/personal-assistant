import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PipelineConfigSchema } from '@raven/shared';
import { validateDag } from '../pipeline-engine/dag-validator.ts';
import { createPipelineLoader } from '../pipeline-engine/pipeline-loader.ts';
import { createPipelineEngine } from '../pipeline-engine/pipeline-engine.ts';
import { EventBus } from '../event-bus/event-bus.ts';

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeValidPipelineYaml(name = 'test-pipeline'): string {
  return `
name: ${name}
description: Test pipeline
version: 1
trigger:
  type: manual
nodes:
  step-a:
    skill: test
    action: do-thing
  step-b:
    skill: test
    action: do-other
connections:
  - from: step-a
    to: step-b
enabled: true
`;
}

function makeCyclicPipelineYaml(): string {
  return `
name: cyclic-pipeline
version: 1
trigger:
  type: manual
nodes:
  a:
    skill: test
    action: one
  b:
    skill: test
    action: two
connections:
  - from: a
    to: b
  - from: b
    to: a
enabled: true
`;
}

function makeInvalidPipelineYaml(): string {
  return `
name: 123_bad_name!!
version: -1
trigger:
  type: nope
nodes: {}
`;
}

// ─── Zod Schema Validation (AC #7) ────────────────────────────────────────

describe('PipelineConfigSchema', () => {
  it('validates a correct pipeline config', () => {
    const config = {
      name: 'test-pipeline',
      version: 1,
      trigger: { type: 'cron', schedule: '0 6 * * *' },
      nodes: {
        'fetch-data': { skill: 'gmail', action: 'search' },
      },
      connections: [],
      enabled: true,
    };

    const result = PipelineConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('test-pipeline');
      expect(result.data.trigger.type).toBe('cron');
    }
  });

  it('rejects missing name', () => {
    const config = {
      version: 1,
      trigger: { type: 'manual' },
      nodes: { a: { skill: 'test', action: 'run' } },
    };
    const result = PipelineConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('rejects invalid name format', () => {
    const config = {
      name: 'Bad Name!!',
      version: 1,
      trigger: { type: 'manual' },
      nodes: { a: { skill: 'test', action: 'run' } },
    };
    const result = PipelineConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('rejects invalid trigger type', () => {
    const config = {
      name: 'test',
      version: 1,
      trigger: { type: 'invalid' },
      nodes: { a: { skill: 'test', action: 'run' } },
    };
    const result = PipelineConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('rejects empty nodes', () => {
    const config = {
      name: 'test',
      version: 1,
      trigger: { type: 'manual' },
      nodes: {},
    };
    const result = PipelineConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('applies defaults for version, connections, enabled', () => {
    const config = {
      name: 'minimal',
      trigger: { type: 'manual' },
      nodes: { a: { skill: 'test', action: 'run' } },
    };
    const result = PipelineConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.version).toBe(1);
      expect(result.data.connections).toEqual([]);
      expect(result.data.enabled).toBe(true);
    }
  });

  it('validates all trigger types', () => {
    const triggers = [
      { type: 'cron', schedule: '0 * * * *' },
      { type: 'event', event: 'email:new' },
      { type: 'manual' },
      { type: 'webhook' },
    ];

    for (const trigger of triggers) {
      const config = {
        name: 'test',
        trigger,
        nodes: { a: { skill: 'test', action: 'run' } },
      };
      const result = PipelineConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    }
  });

  it('validates settings with retry and onError', () => {
    const config = {
      name: 'test',
      trigger: { type: 'manual' },
      settings: {
        retry: { maxAttempts: 5, backoffMs: 1000 },
        timeout: 30000,
        onError: 'goto:error-handler',
      },
      nodes: { a: { skill: 'test', action: 'run' } },
    };
    const result = PipelineConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });
});

// ─── DAG Validator (AC #2) ─────────────────────────────────────────────────

describe('validateDag', () => {
  it('validates a linear chain: A → B → C', () => {
    const nodes = {
      a: { skill: 'test', action: 'one' },
      b: { skill: 'test', action: 'two' },
      c: { skill: 'test', action: 'three' },
    };
    const connections = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ];

    const result = validateDag(nodes, connections);
    expect(result.valid).toBe(true);
    expect(result.executionOrder).toEqual(['a', 'b', 'c']);
    expect(result.entryPoints).toEqual(['a']);
  });

  it('validates parallel branches: A + B → C', () => {
    const nodes = {
      a: { skill: 'test', action: 'one' },
      b: { skill: 'test', action: 'two' },
      c: { skill: 'test', action: 'three' },
    };
    const connections = [
      { from: 'a', to: 'c' },
      { from: 'b', to: 'c' },
    ];

    const result = validateDag(nodes, connections);
    expect(result.valid).toBe(true);
    expect(result.entryPoints).toEqual(['a', 'b']);
    expect(result.executionOrder!.indexOf('c')).toBeGreaterThan(
      result.executionOrder!.indexOf('a'),
    );
    expect(result.executionOrder!.indexOf('c')).toBeGreaterThan(
      result.executionOrder!.indexOf('b'),
    );
  });

  it('validates diamond merge: A → B + C → D', () => {
    const nodes = {
      a: { skill: 'test', action: 'one' },
      b: { skill: 'test', action: 'two' },
      c: { skill: 'test', action: 'three' },
      d: { skill: 'test', action: 'four' },
    };
    const connections = [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' },
      { from: 'b', to: 'd' },
      { from: 'c', to: 'd' },
    ];

    const result = validateDag(nodes, connections);
    expect(result.valid).toBe(true);
    expect(result.entryPoints).toEqual(['a']);
    expect(result.executionOrder![0]).toBe('a');
    expect(result.executionOrder![3]).toBe('d');
  });

  it('detects cycle: A → B → A (rejected as no entry points)', () => {
    const nodes = {
      a: { skill: 'test', action: 'one' },
      b: { skill: 'test', action: 'two' },
    };
    const connections = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ];

    const result = validateDag(nodes, connections);
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('detects cycle in larger graph with entry point', () => {
    const nodes = {
      entry: { skill: 'test', action: 'start' },
      a: { skill: 'test', action: 'one' },
      b: { skill: 'test', action: 'two' },
    };
    const connections = [
      { from: 'entry', to: 'a' },
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ];

    const result = validateDag(nodes, connections);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Cycle detected');
  });

  it('rejects missing node reference in connection', () => {
    const nodes = {
      a: { skill: 'test', action: 'one' },
    };
    const connections = [{ from: 'a', to: 'nonexistent' }];

    const result = validateDag(nodes, connections);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('nonexistent');
  });

  it('handles disconnected nodes (all are entry points)', () => {
    const nodes = {
      a: { skill: 'test', action: 'one' },
      b: { skill: 'test', action: 'two' },
    };
    const connections: { from: string; to: string }[] = [];

    const result = validateDag(nodes, connections);
    expect(result.valid).toBe(true);
    expect(result.entryPoints).toEqual(['a', 'b']);
    expect(result.executionOrder).toHaveLength(2);
  });

  it('rejects graph with no entry points (all-cycle)', () => {
    const nodes = {
      a: { skill: 'test', action: 'one' },
      b: { skill: 'test', action: 'two' },
      c: { skill: 'test', action: 'three' },
    };
    const connections = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'a' },
    ];

    const result = validateDag(nodes, connections);
    expect(result.valid).toBe(false);
  });
});

// ─── Pipeline Loader (AC #1, #3) ──────────────────────────────────────────

describe('PipelineLoader', () => {
  let tmpDir: string;
  let eventBus: EventBus;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pipeline-test-'));
    eventBus = new EventBus();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads valid pipelines from directory', () => {
    writeFileSync(join(tmpDir, 'test.yaml'), makeValidPipelineYaml());
    const loader = createPipelineLoader({ eventBus });
    loader.loadFromDirectory(tmpDir);

    const all = loader.getAllPipelines();
    expect(all).toHaveLength(1);
    expect(all[0].config.name).toBe('test-pipeline');
    expect(all[0].executionOrder).toEqual(['step-a', 'step-b']);
  });

  it('skips invalid YAML files and continues loading valid ones', () => {
    writeFileSync(join(tmpDir, 'valid.yaml'), makeValidPipelineYaml('good-pipeline'));
    writeFileSync(join(tmpDir, 'invalid.yaml'), makeInvalidPipelineYaml());

    const loader = createPipelineLoader({ eventBus });
    loader.loadFromDirectory(tmpDir);

    const all = loader.getAllPipelines();
    expect(all).toHaveLength(1);
    expect(all[0].config.name).toBe('good-pipeline');
  });

  it('skips pipelines with DAG cycles', () => {
    writeFileSync(join(tmpDir, 'cyclic.yaml'), makeCyclicPipelineYaml());
    const loader = createPipelineLoader({ eventBus });
    loader.loadFromDirectory(tmpDir);

    expect(loader.getAllPipelines()).toHaveLength(0);
  });

  it('gets a pipeline by name', () => {
    writeFileSync(join(tmpDir, 'test.yaml'), makeValidPipelineYaml());
    const loader = createPipelineLoader({ eventBus });
    loader.loadFromDirectory(tmpDir);

    expect(loader.getPipeline('test-pipeline')).toBeDefined();
    expect(loader.getPipeline('nonexistent')).toBeUndefined();
  });

  it('removes a pipeline by name', () => {
    writeFileSync(join(tmpDir, 'test.yaml'), makeValidPipelineYaml());
    const loader = createPipelineLoader({ eventBus });
    loader.loadFromDirectory(tmpDir);

    expect(loader.removePipeline('test-pipeline')).toBe(true);
    expect(loader.getAllPipelines()).toHaveLength(0);
    expect(loader.removePipeline('nonexistent')).toBe(false);
  });

  it('reloads a pipeline from file', () => {
    const filePath = join(tmpDir, 'test.yaml');
    writeFileSync(filePath, makeValidPipelineYaml());
    const loader = createPipelineLoader({ eventBus });
    loader.loadFromDirectory(tmpDir);

    // Modify and reload
    writeFileSync(filePath, makeValidPipelineYaml('test-pipeline'));
    loader.reloadPipeline(filePath);

    const pipeline = loader.getPipeline('test-pipeline');
    expect(pipeline).toBeDefined();
  });

  it('emits event on reload', () => {
    const filePath = join(tmpDir, 'test.yaml');
    writeFileSync(filePath, makeValidPipelineYaml());
    const loader = createPipelineLoader({ eventBus });
    loader.loadFromDirectory(tmpDir);

    const events: any[] = [];
    eventBus.on('config:pipelines:reloaded', (e) => events.push(e));

    loader.reloadPipeline(filePath);
    expect(events).toHaveLength(1);
    expect(events[0].payload.pipelineName).toBe('test-pipeline');
    expect(events[0].payload.action).toBe('reloaded');
  });

  it('handles nonexistent directory gracefully', () => {
    const loader = createPipelineLoader({ eventBus });
    loader.loadFromDirectory(join(tmpDir, 'nonexistent'));
    expect(loader.getAllPipelines()).toHaveLength(0);
  });

  it('ignores non-YAML files', () => {
    writeFileSync(join(tmpDir, 'readme.md'), '# Not a pipeline');
    writeFileSync(join(tmpDir, 'test.yaml'), makeValidPipelineYaml());

    const loader = createPipelineLoader({ eventBus });
    loader.loadFromDirectory(tmpDir);
    expect(loader.getAllPipelines()).toHaveLength(1);
  });

  it('shuts down cleanly', () => {
    const loader = createPipelineLoader({ eventBus });
    loader.loadFromDirectory(tmpDir);
    loader.watch(tmpDir);
    loader.shutdown();
    // No error thrown
  });
});

// ─── File Watcher (AC #4) ──────────────────────────────────────────────────

describe('PipelineLoader file watcher', () => {
  let tmpDir: string;
  let eventBus: EventBus;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pipeline-watch-'));
    eventBus = new EventBus();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects new file addition', async () => {
    const loader = createPipelineLoader({ eventBus });
    loader.loadFromDirectory(tmpDir);
    loader.watch(tmpDir);

    const events: any[] = [];
    eventBus.on('config:pipelines:reloaded', (e) => events.push(e));

    // Add a new file
    writeFileSync(join(tmpDir, 'new-pipeline.yaml'), makeValidPipelineYaml('new-pipeline'));

    // Wait for debounce
    await new Promise((r) => setTimeout(r, 500));

    expect(loader.getPipeline('new-pipeline')).toBeDefined();
    expect(events.length).toBeGreaterThanOrEqual(1);

    loader.shutdown();
  });

  it('detects file modification', async () => {
    const filePath = join(tmpDir, 'existing.yaml');
    writeFileSync(filePath, makeValidPipelineYaml('existing'));

    const loader = createPipelineLoader({ eventBus });
    loader.loadFromDirectory(tmpDir);
    loader.watch(tmpDir);

    const events: any[] = [];
    eventBus.on('config:pipelines:reloaded', (e) => events.push(e));

    // Modify the file
    writeFileSync(filePath, makeValidPipelineYaml('existing'));

    await new Promise((r) => setTimeout(r, 500));

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].payload.action).toBe('reloaded');

    loader.shutdown();
  });

  it('detects file deletion', async () => {
    const filePath = join(tmpDir, 'to-delete.yaml');
    writeFileSync(filePath, makeValidPipelineYaml('to-delete'));

    const loader = createPipelineLoader({ eventBus });
    loader.loadFromDirectory(tmpDir);
    loader.watch(tmpDir);

    expect(loader.getPipeline('to-delete')).toBeDefined();

    const events: any[] = [];
    eventBus.on('config:pipelines:reloaded', (e) => events.push(e));

    unlinkSync(filePath);

    await new Promise((r) => setTimeout(r, 500));

    expect(loader.getPipeline('to-delete')).toBeUndefined();
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].payload.action).toBe('removed');

    loader.shutdown();
  });
});

// ─── Pipeline Engine Facade (AC #1, #4) ────────────────────────────────────

describe('PipelineEngine', () => {
  let tmpDir: string;
  let eventBus: EventBus;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'engine-test-'));
    eventBus = new EventBus();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('initializes and loads pipelines', () => {
    writeFileSync(join(tmpDir, 'test.yaml'), makeValidPipelineYaml());

    const engine = createPipelineEngine({ eventBus });
    engine.initialize(tmpDir);

    expect(engine.getAllPipelines()).toHaveLength(1);
    expect(engine.getPipeline('test-pipeline')).toBeDefined();

    engine.shutdown();
  });

  it('returns empty list before initialization', () => {
    const engine = createPipelineEngine({ eventBus });
    expect(engine.getAllPipelines()).toEqual([]);
    expect(engine.getPipeline('anything')).toBeUndefined();
  });

  it('shuts down cleanly', () => {
    const engine = createPipelineEngine({ eventBus });
    engine.initialize(tmpDir);
    engine.shutdown();
    // No error
  });
});

// ─── API Routes (AC #5, #6) ────────────────────────────────────────────────

describe('Pipeline API routes', () => {
  let tmpDir: string;
  let eventBus: EventBus;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pipeline-api-'));
    eventBus = new EventBus();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /api/pipelines returns all pipelines', async () => {
    writeFileSync(join(tmpDir, 'test.yaml'), makeValidPipelineYaml());

    const engine = createPipelineEngine({ eventBus });
    engine.initialize(tmpDir);

    const { default: Fastify } = await import('fastify');
    const { registerPipelineRoutes } = await import('../api/routes/pipelines.ts');

    const app = Fastify({ logger: false });
    registerPipelineRoutes(app, { pipelineEngine: engine });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/pipelines' });
    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.payload);
    expect(body).toHaveLength(1);
    expect(body[0].config.name).toBe('test-pipeline');

    engine.shutdown();
    await app.close();
  });

  it('GET /api/pipelines/:name returns single pipeline', async () => {
    writeFileSync(join(tmpDir, 'test.yaml'), makeValidPipelineYaml());

    const engine = createPipelineEngine({ eventBus });
    engine.initialize(tmpDir);

    const { default: Fastify } = await import('fastify');
    const { registerPipelineRoutes } = await import('../api/routes/pipelines.ts');

    const app = Fastify({ logger: false });
    registerPipelineRoutes(app, { pipelineEngine: engine });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/pipelines/test-pipeline' });
    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.payload);
    expect(body.config.name).toBe('test-pipeline');

    engine.shutdown();
    await app.close();
  });

  it('GET /api/pipelines/:name returns 404 for unknown', async () => {
    const engine = createPipelineEngine({ eventBus });
    engine.initialize(tmpDir);

    const { default: Fastify } = await import('fastify');
    const { registerPipelineRoutes } = await import('../api/routes/pipelines.ts');

    const app = Fastify({ logger: false });
    registerPipelineRoutes(app, { pipelineEngine: engine });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/api/pipelines/nonexistent' });
    expect(response.statusCode).toBe(404);

    engine.shutdown();
    await app.close();
  });
});
