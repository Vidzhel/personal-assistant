import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { closeDatabase, getDb, initDatabase } from '../db/database.ts';
import { SessionManager } from '../session-manager/session-manager.ts';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

describe('persisted SDK session resume revisions', () => {
  let root: string;
  let manager: SessionManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'raven-sdk-resume-'));
    initDatabase(join(root, 'raven.db'));
    const now = Date.now();
    getDb()
      .prepare(
        'INSERT INTO projects (id, name, skills, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('project', 'Project', '[]', now, now);
    manager = new SessionManager();
  });

  afterEach(() => {
    closeDatabase();
    rmSync(root, { recursive: true, force: true });
  });

  it('persists and reloads a revisioned SDK session link', () => {
    const session = manager.createSession('project');
    manager.linkSdkSession(session.id, 'sdk-session', 'workspace-v1');

    expect(new SessionManager().getSdkSessionId(session.id, 'workspace-v1')).toBe('sdk-session');
    expect(new SessionManager().getSdkResumeState(session.id, 'workspace-v1')).toEqual({
      status: 'matched',
      sessionId: 'sdk-session',
    });
    expect(manager.getSession(session.id)?.sdkSessionId).toBe('sdk-session');
    expect(
      getDb().prepare('SELECT sdk_resume_revision FROM sessions WHERE id = ?').get(session.id),
    ).toEqual({ sdk_resume_revision: 'workspace-v1' });
  });

  it('rejects a stale revision and clears its SDK lineage', () => {
    const session = manager.createSession('project');
    manager.linkSdkSession(session.id, 'sdk-session', 'workspace-v1');

    expect(manager.getSdkResumeState(session.id, 'workspace-v2')).toEqual({ status: 'changed' });
    expect(manager.getSdkSessionId(session.id, 'workspace-v1')).toBeUndefined();
    expect(
      getDb()
        .prepare('SELECT sdk_session_id, sdk_resume_revision FROM sessions WHERE id = ?')
        .get(session.id),
    ).toEqual({ sdk_session_id: null, sdk_resume_revision: null });
  });

  it('reports missing for unknown sessions and sessions without SDK lineage', () => {
    const session = manager.createSession('project');

    expect(manager.getSdkResumeState(session.id)).toEqual({ status: 'missing' });
    expect(manager.getSdkResumeState('missing')).toEqual({ status: 'missing' });
  });

  it('treats an omitted revision as the explicit null revision', () => {
    const session = manager.createSession('project');
    manager.linkSdkSession(session.id, 'legacy-sdk');
    expect(manager.getSdkSessionId(session.id)).toBe('legacy-sdk');

    manager.linkSdkSession(session.id, 'workspace-sdk', 'workspace-v1');
    expect(manager.getSdkSessionId(session.id)).toBeUndefined();
    expect(manager.getSdkSessionId(session.id, 'workspace-v1')).toBeUndefined();
  });

  it('clears both persisted values explicitly', () => {
    const session = manager.createSession('project');
    manager.linkSdkSession(session.id, 'sdk-session', 'workspace-v1');
    manager.clearSdkSession(session.id);

    expect(manager.getSdkSessionId(session.id, 'workspace-v1')).toBeUndefined();
    expect(
      getDb()
        .prepare('SELECT sdk_session_id, sdk_resume_revision FROM sessions WHERE id = ?')
        .get(session.id),
    ).toEqual({ sdk_session_id: null, sdk_resume_revision: null });
  });
});
