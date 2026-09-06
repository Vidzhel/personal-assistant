import { describe, it, expect, beforeEach } from 'vitest';
import type { DatabaseInterface } from '@raven/shared';
import { createTestDb } from './helpers/test-db.ts';
import {
  getStoredTopic,
  saveStoredTopic,
  deleteStoredTopic,
  bindProjectTopic,
  getStoredProjectForTopic,
} from '../../../services/notifications/topic-store.ts';

describe('topic-store', () => {
  let db: DatabaseInterface;
  const ref = { projectId: 'project-a', groupId: '-100123' };

  beforeEach(() => {
    db = createTestDb();
  });

  it('returns undefined when no mapping stored', () => {
    expect(getStoredTopic(db, ref)).toBeUndefined();
  });

  it('returns stored topic id after save', () => {
    saveStoredTopic(db, ref, 42);
    expect(getStoredTopic(db, ref)).toBe(42);
  });

  it('upserts on duplicate save for the same project and group', () => {
    saveStoredTopic(db, ref, 42);
    saveStoredTopic(db, ref, 99);
    expect(getStoredTopic(db, ref)).toBe(99);
  });

  it('scopes lookups by project and groupId', () => {
    saveStoredTopic(db, ref, 42);
    expect(getStoredTopic(db, { ...ref, projectId: 'other' })).toBeUndefined();
    expect(getStoredTopic(db, { ...ref, groupId: '-999' })).toBeUndefined();
  });

  it('deletes a stored mapping', () => {
    saveStoredTopic(db, ref, 42);
    deleteStoredTopic(db, ref);
    expect(getStoredTopic(db, ref)).toBeUndefined();
  });

  it('rebinds one topic from project A to project B', () => {
    bindProjectTopic(db, { groupId: ref.groupId, topicId: 42, projectId: 'project-a' });
    bindProjectTopic(db, { groupId: ref.groupId, topicId: 42, projectId: 'project-b' });

    expect(getStoredTopic(db, ref)).toBeUndefined();
    expect(getStoredProjectForTopic(db, ref.groupId, 42)).toBe('project-b');
  });

  it('moves project A to another topic and frees its former topic', () => {
    bindProjectTopic(db, { groupId: ref.groupId, topicId: 42, projectId: 'project-a' });
    bindProjectTopic(db, { groupId: ref.groupId, topicId: 77, projectId: 'project-a' });

    expect(getStoredTopic(db, ref)).toBe(77);
    expect(getStoredProjectForTopic(db, ref.groupId, 42)).toBeUndefined();
    expect(getStoredProjectForTopic(db, ref.groupId, 77)).toBe('project-a');
  });
});
