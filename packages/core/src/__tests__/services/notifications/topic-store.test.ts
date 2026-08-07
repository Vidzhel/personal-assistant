import { describe, it, expect, beforeEach } from 'vitest';
import type { DatabaseInterface } from '@raven/shared';
import { createTestDb } from './helpers/test-db.ts';
import {
  getStoredTopic,
  saveStoredTopic,
  deleteStoredTopic,
} from '../../../services/notifications/topic-store.ts';

describe('topic-store', () => {
  let db: DatabaseInterface;
  const ref = { scope: 'agent' as const, key: 'raven', groupId: '-100123' };

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

  it('upserts on duplicate save (same scope/key/group)', () => {
    saveStoredTopic(db, ref, 42);
    saveStoredTopic(db, ref, 99);
    expect(getStoredTopic(db, ref)).toBe(99);
  });

  it('scopes lookups by scope, key, and groupId', () => {
    saveStoredTopic(db, ref, 42);
    expect(getStoredTopic(db, { ...ref, scope: 'project' })).toBeUndefined();
    expect(getStoredTopic(db, { ...ref, key: 'other' })).toBeUndefined();
    expect(getStoredTopic(db, { ...ref, groupId: '-999' })).toBeUndefined();
  });

  it('deletes a stored mapping', () => {
    saveStoredTopic(db, ref, 42);
    deleteStoredTopic(db, ref);
    expect(getStoredTopic(db, ref)).toBeUndefined();
  });
});
