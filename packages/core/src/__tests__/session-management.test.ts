import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, getDb } from '../db/database.ts';
import { SessionManager } from '../session-manager/session-manager.ts';
import {
  createReference,
  getReferencesFrom,
  getReferencesTo,
  getAllReferences,
  deleteReference,
  buildSessionReferencesContext,
} from '../session-manager/session-references.ts';

describe('Session Management (10.8)', () => {
  let tmpDir: string;
  let sm: SessionManager;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'session-mgmt-'));
    initDatabase(join(tmpDir, 'test.db'));
    sm = new SessionManager();

    // Create a test project
    const db = getDb();
    const now = Date.now();
    db.prepare(
      'INSERT INTO projects (id, name, description, skills, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('proj-1', 'Test Project', '', '[]', now, now);
  });

  afterAll(() => {
    try {
      getDb().close();
    } catch {
      /* */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('SessionManager.updateSession', () => {
    it('updates name, description, and pinned', () => {
      const session = sm.createSession('proj-1');
      sm.updateSession(session.id, { name: 'My Session', description: 'A test', pinned: true });
      const updated = sm.getSession(session.id)!;
      expect(updated.name).toBe('My Session');
      expect(updated.description).toBe('A test');
      expect(updated.pinned).toBe(true);
    });

    it('partially updates fields', () => {
      const session = sm.createSession('proj-1');
      sm.updateSession(session.id, { name: 'Named' });
      const updated = sm.getSession(session.id)!;
      expect(updated.name).toBe('Named');
      expect(updated.pinned).toBe(false);
    });
  });

  describe('SessionManager.updateSummary', () => {
    it('sets summary on a session', () => {
      const session = sm.createSession('proj-1');
      sm.updateSummary(session.id, 'Session summary here');
      const updated = sm.getSession(session.id)!;
      expect(updated.summary).toBe('Session summary here');
    });
  });

  describe('SessionManager.autoGenerateName', () => {
    it('sets name from first message when name is null', () => {
      const session = sm.createSession('proj-1');
      sm.autoGenerateName(session.id, 'Hello, can you help me with my project?');
      const updated = sm.getSession(session.id)!;
      expect(updated.name).toBe('Hello, can you help me with my project?');
    });

    it('truncates long messages at word boundary', () => {
      const session = sm.createSession('proj-1');
      const longMsg =
        'This is a very long message that exceeds sixty characters and should be truncated at a word boundary';
      sm.autoGenerateName(session.id, longMsg);
      const updated = sm.getSession(session.id)!;
      expect(updated.name!.length).toBeLessThanOrEqual(63); // 60 + "..."
      expect(updated.name!.endsWith('...')).toBe(true);
    });

    it('does NOT overwrite existing name', () => {
      const session = sm.createSession('proj-1');
      sm.updateSession(session.id, { name: 'Custom Name' });
      sm.autoGenerateName(session.id, 'Ignore this message');
      const updated = sm.getSession(session.id)!;
      expect(updated.name).toBe('Custom Name');
    });
  });

  describe('Session ordering', () => {
    it('pinned sessions appear first', () => {
      // Create fresh sessions
      const s1 = sm.createSession('proj-1');
      const s2 = sm.createSession('proj-1');

      // Pin s1 (older)
      sm.updateSession(s1.id, { pinned: true });

      const sessions = sm.getProjectSessions('proj-1');
      // s1 should appear first because it's pinned, even though s2 is newer
      const pinnedIdx = sessions.findIndex((s) => s.id === s1.id);
      const unpinnedIdx = sessions.findIndex((s) => s.id === s2.id);
      expect(pinnedIdx).toBeLessThan(unpinnedIdx);
    });
  });

  describe('Session references', () => {
    let sessionA: string;
    let sessionB: string;
    let sessionC: string;

    beforeAll(() => {
      // Create sessions for reference tests — direct DB insert to avoid archiving
      const db = getDb();
      const now = Date.now();
      for (const id of ['ref-a', 'ref-b', 'ref-c']) {
        db.prepare(
          'INSERT INTO sessions (id, project_id, status, created_at, last_active_at, turn_count, pinned) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(id, 'proj-1', 'idle', now, now, 0, 0);
      }
      sessionA = 'ref-a';
      sessionB = 'ref-b';
      sessionC = 'ref-c';
    });

    it('creates a reference between sessions', () => {
      const ref = createReference(sessionA, sessionB, 'Related discussion');
      expect(ref.id).toBeDefined();
      expect(ref.sourceSessionId).toBe(sessionA);
      expect(ref.targetSessionId).toBe(sessionB);
      expect(ref.context).toBe('Related discussion');
    });

    it('gets references from a session', () => {
      const refs = getReferencesFrom(sessionA);
      expect(refs.length).toBeGreaterThanOrEqual(1);
      expect(refs.some((r) => r.targetSessionId === sessionB)).toBe(true);
    });

    it('gets references to a session', () => {
      const refs = getReferencesTo(sessionB);
      expect(refs.length).toBeGreaterThanOrEqual(1);
      expect(refs.some((r) => r.sourceSessionId === sessionA)).toBe(true);
    });

    it('getAllReferences returns both directions', () => {
      createReference(sessionC, sessionA, 'Followup');
      const { from, to } = getAllReferences(sessionA);
      expect(from.some((r) => r.targetSessionId === sessionB)).toBe(true);
      expect(to.some((r) => r.sourceSessionId === sessionC)).toBe(true);
    });

    it('deletes a reference', () => {
      const ref = createReference(sessionA, sessionC, 'To delete');
      expect(deleteReference(ref.id)).toBe(true);
      const refs = getReferencesFrom(sessionA);
      expect(refs.some((r) => r.id === ref.id)).toBe(false);
    });

    it('returns false when deleting non-existent reference', () => {
      expect(deleteReference('non-existent-id')).toBe(false);
    });
  });

  describe('buildSessionReferencesContext', () => {
    it('returns undefined when no references exist', () => {
      const session = sm.createSession('proj-1');
      expect(buildSessionReferencesContext(session.id)).toBeUndefined();
    });

    it('returns formatted markdown with referenced session info', () => {
      const db = getDb();
      const now = Date.now();

      // Create source and target sessions directly
      db.prepare(
        'INSERT INTO sessions (id, project_id, status, created_at, last_active_at, turn_count, pinned, name, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run('ctx-src', 'proj-1', 'idle', now, now, 0, 0, 'Source', null);
      db.prepare(
        'INSERT INTO sessions (id, project_id, status, created_at, last_active_at, turn_count, pinned, name, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run('ctx-tgt', 'proj-1', 'idle', now, now, 0, 0, 'Target Session', 'Key findings about X');

      createReference('ctx-src', 'ctx-tgt', 'Discussed X');

      const result = buildSessionReferencesContext('ctx-src');
      expect(result).toBeDefined();
      expect(result).toContain('Target Session');
      expect(result).toContain('Key findings about X');
      expect(result).toContain('Discussed X');
    });
  });
});
