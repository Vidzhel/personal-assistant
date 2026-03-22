import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, getDb } from '../db/database.ts';
import { createTaskStore } from '../task-manager/task-store.ts';
import { createTemplateLoader } from '../task-manager/template-loader.ts';
import { vi } from 'vitest';

function makeMockEventBus() {
  return { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
}

describe('TemplateLoader', () => {
  let tmpDir: string;
  let templatesDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'raven-tmpl-'));
    templatesDir = join(tmpDir, 'templates');
    mkdirSync(templatesDir);

    // Write test templates
    writeFileSync(
      join(templatesDir, 'research.yaml'),
      `
name: research
title: Research Topic
description: Research a topic
prompt: Research thoroughly
defaultAgentId: orchestrator
projectId: default-project
`,
    );

    writeFileSync(
      join(templatesDir, 'invalid.yaml'),
      `
title: Missing name field
`,
    );

    initDatabase(join(tmpDir, 'test.db'));
  });

  afterAll(() => {
    try {
      getDb().close();
    } catch {
      /* */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads valid templates from directory', () => {
    const db = getDb();
    const taskStore = createTaskStore({
      db: {
        run: (sql: string, ...p: unknown[]) => db.prepare(sql).run(...p),
        get: <T>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as T | undefined,
        all: <T>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[],
      },
      eventBus: makeMockEventBus(),
    });
    const loader = createTemplateLoader({ templatesDir, taskStore });

    const templates = loader.listTemplates();
    expect(templates).toHaveLength(1); // invalid.yaml skipped
    expect(templates[0].name).toBe('research');
  });

  it('getTemplate returns template by name', () => {
    const db = getDb();
    const taskStore = createTaskStore({
      db: {
        run: (sql: string, ...p: unknown[]) => db.prepare(sql).run(...p),
        get: <T>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as T | undefined,
        all: <T>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[],
      },
      eventBus: makeMockEventBus(),
    });
    const loader = createTemplateLoader({ templatesDir, taskStore });

    const tmpl = loader.getTemplate('research');
    expect(tmpl).toBeDefined();
    expect(tmpl!.title).toBe('Research Topic');
    expect(tmpl!.defaultAgentId).toBe('orchestrator');

    expect(loader.getTemplate('nonexistent')).toBeUndefined();
  });

  it('createTaskFromTemplate creates task with template defaults', () => {
    const db = getDb();
    const taskStore = createTaskStore({
      db: {
        run: (sql: string, ...p: unknown[]) => db.prepare(sql).run(...p),
        get: <T>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as T | undefined,
        all: <T>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[],
      },
      eventBus: makeMockEventBus(),
    });
    const loader = createTemplateLoader({ templatesDir, taskStore });

    const task = loader.createTaskFromTemplate('research');
    expect(task.title).toBe('Research Topic');
    expect(task.description).toBe('Research a topic');
    expect(task.prompt).toBe('Research thoroughly');
    expect(task.assignedAgentId).toBe('orchestrator');
    expect(task.projectId).toBe('default-project');
    expect(task.source).toBe('template');
  });

  it('createTaskFromTemplate applies overrides', () => {
    const db = getDb();
    const taskStore = createTaskStore({
      db: {
        run: (sql: string, ...p: unknown[]) => db.prepare(sql).run(...p),
        get: <T>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as T | undefined,
        all: <T>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[],
      },
      eventBus: makeMockEventBus(),
    });
    const loader = createTemplateLoader({ templatesDir, taskStore });

    const task = loader.createTaskFromTemplate('research', {
      title: 'Custom Title',
      projectId: 'custom-project',
    });
    expect(task.title).toBe('Custom Title');
    expect(task.projectId).toBe('custom-project');
    expect(task.description).toBe('Research a topic'); // from template
  });

  it('createTaskFromTemplate throws for unknown template', () => {
    const db = getDb();
    const taskStore = createTaskStore({
      db: {
        run: (sql: string, ...p: unknown[]) => db.prepare(sql).run(...p),
        get: <T>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as T | undefined,
        all: <T>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[],
      },
      eventBus: makeMockEventBus(),
    });
    const loader = createTemplateLoader({ templatesDir, taskStore });

    expect(() => loader.createTaskFromTemplate('nonexistent')).toThrow('Template not found');
  });

  it('handles nonexistent templates directory gracefully', () => {
    const db = getDb();
    const taskStore = createTaskStore({
      db: {
        run: (sql: string, ...p: unknown[]) => db.prepare(sql).run(...p),
        get: <T>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as T | undefined,
        all: <T>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[],
      },
      eventBus: makeMockEventBus(),
    });
    const loader = createTemplateLoader({
      templatesDir: '/nonexistent/path',
      taskStore,
    });
    expect(loader.listTemplates()).toHaveLength(0);
  });
});
