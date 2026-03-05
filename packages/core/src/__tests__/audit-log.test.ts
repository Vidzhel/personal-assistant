import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, getDb } from '../db/database.ts';
import { createAuditLog } from '../permission-engine/audit-log.ts';
import { registerAuditLogRoutes } from '../api/routes/audit-logs.ts';
import type { AuditLog } from '../permission-engine/audit-log.ts';
import type { AuditEntry } from '@raven/shared';

describe('Audit Log', () => {
  let tmpDir: string;
  let auditLog: AuditLog;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'audit-log-'));
    initDatabase(join(tmpDir, 'test.db'));
    auditLog = createAuditLog();
    auditLog.initialize();
  });

  afterAll(() => {
    try {
      getDb().close();
    } catch {
      /* */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('insert', () => {
    it('inserts an entry with all fields verified', () => {
      const entry = auditLog.insert({
        skillName: 'gmail',
        actionName: 'gmail:send-email',
        permissionTier: 'red',
        outcome: 'denied',
        details: 'User denied send',
        sessionId: 'sess-1',
        pipelineName: 'morning-pipeline',
      });

      expect(entry.id).toBeDefined();
      expect(entry.timestamp).toBeDefined();
      expect(entry.skillName).toBe('gmail');
      expect(entry.actionName).toBe('gmail:send-email');
      expect(entry.permissionTier).toBe('red');
      expect(entry.outcome).toBe('denied');
      expect(entry.details).toBe('User denied send');
      expect(entry.sessionId).toBe('sess-1');
      expect(entry.pipelineName).toBe('morning-pipeline');
    });

    it('auto-generates id and timestamp', () => {
      const entry1 = auditLog.insert({
        skillName: 'gmail',
        actionName: 'gmail:search-emails',
        permissionTier: 'green',
        outcome: 'executed',
      });
      const entry2 = auditLog.insert({
        skillName: 'gmail',
        actionName: 'gmail:search-emails',
        permissionTier: 'green',
        outcome: 'executed',
      });

      expect(entry1.id).not.toBe(entry2.id);
      expect(entry1.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(entry2.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('query', () => {
    let entries: AuditEntry[];

    beforeAll(() => {
      // Insert known test data
      entries = [
        auditLog.insert({
          skillName: 'ticktick',
          actionName: 'ticktick:get-tasks',
          permissionTier: 'green',
          outcome: 'executed',
        }),
        auditLog.insert({
          skillName: 'ticktick',
          actionName: 'ticktick:delete-task',
          permissionTier: 'red',
          outcome: 'queued',
        }),
        auditLog.insert({
          skillName: 'gmail',
          actionName: 'gmail:archive-email',
          permissionTier: 'yellow',
          outcome: 'executed',
        }),
        auditLog.insert({
          skillName: 'gmail',
          actionName: 'gmail:send-email',
          permissionTier: 'red',
          outcome: 'approved',
        }),
      ];
    });

    it('returns all entries when no filters', () => {
      const results = auditLog.query();
      // Should include entries from both beforeAll blocks
      expect(results.length).toBeGreaterThanOrEqual(entries.length);
    });

    it('filters by skillName', () => {
      const results = auditLog.query({ skillName: 'ticktick' });
      expect(results.length).toBe(2);
      expect(results.every((e) => e.skillName === 'ticktick')).toBe(true);
    });

    it('filters by tier', () => {
      const results = auditLog.query({ tier: 'red' });
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results.every((e) => e.permissionTier === 'red')).toBe(true);
    });

    it('filters by outcome', () => {
      const results = auditLog.query({ outcome: 'queued' });
      expect(results.length).toBe(1);
      expect(results[0].outcome).toBe('queued');
    });

    it('filters by date range (from/to)', () => {
      const past = '2000-01-01T00:00:00.000Z';
      const future = '2099-01-01T00:00:00.000Z';

      const all = auditLog.query({ from: past, to: future });
      expect(all.length).toBeGreaterThanOrEqual(entries.length);

      const none = auditLog.query({ from: future });
      expect(none.length).toBe(0);
    });

    it('filters with combined params', () => {
      const results = auditLog.query({ skillName: 'gmail', tier: 'red' });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.every((e) => e.skillName === 'gmail' && e.permissionTier === 'red')).toBe(
        true,
      );
    });

    it('supports limit and offset pagination', () => {
      const page1 = auditLog.query({ limit: 2, offset: 0 });
      const page2 = auditLog.query({ limit: 2, offset: 2 });

      expect(page1.length).toBe(2);
      expect(page2.length).toBeGreaterThanOrEqual(2);
      expect(page1[0].id).not.toBe(page2[0].id);
    });

    it('sorts by timestamp descending', () => {
      const results = auditLog.query();
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].timestamp >= results[i].timestamp).toBe(true);
      }
    });
  });

  describe('immutability', () => {
    it('only exposes insert, query, and initialize methods', () => {
      const methods = Object.keys(auditLog);
      expect(methods).toContain('insert');
      expect(methods).toContain('query');
      expect(methods).toContain('initialize');
      expect(methods).not.toContain('update');
      expect(methods).not.toContain('delete');
      expect(methods).not.toContain('remove');
      expect(methods.length).toBe(3);
    });
  });
});

describe('Audit Log API route', () => {
  let tmpDir: string;
  let app: ReturnType<typeof Fastify>;
  let auditLog: AuditLog;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'audit-api-'));
    initDatabase(join(tmpDir, 'test.db'));
    auditLog = createAuditLog();
    auditLog.initialize();

    // Insert test data
    auditLog.insert({
      skillName: 'gmail',
      actionName: 'gmail:send-email',
      permissionTier: 'red',
      outcome: 'denied',
      details: 'test detail',
    });
    auditLog.insert({
      skillName: 'ticktick',
      actionName: 'ticktick:get-tasks',
      permissionTier: 'green',
      outcome: 'executed',
    });

    app = Fastify({ logger: false });
    await app.register(cors, { origin: true });
    registerAuditLogRoutes(app, auditLog);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    try {
      getDb().close();
    } catch {
      /* */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /api/audit-logs returns 200 with array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/audit-logs' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2);
  });

  it('query param filtering works end-to-end', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/audit-logs?skillName=gmail&tier=red&limit=50',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.length).toBe(1);
    expect(body[0].skillName).toBe('gmail');
    expect(body[0].permissionTier).toBe('red');
  });

  it('invalid params return 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/audit-logs?tier=purple',
    });
    expect(res.statusCode).toBe(400);
  });

  it('response uses camelCase keys', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/audit-logs' });
    const body = JSON.parse(res.payload);
    const entry = body[0];
    expect(entry).toHaveProperty('skillName');
    expect(entry).toHaveProperty('actionName');
    expect(entry).toHaveProperty('permissionTier');
    expect(entry).not.toHaveProperty('skill_name');
    expect(entry).not.toHaveProperty('action_name');
    expect(entry).not.toHaveProperty('permission_tier');
  });
});
