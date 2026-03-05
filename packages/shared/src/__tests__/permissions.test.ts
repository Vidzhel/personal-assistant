import { describe, it, expect } from 'vitest';
import { PermissionTierSchema, SkillActionSchema } from '../types/permissions.ts';

describe('PermissionTierSchema', () => {
  it('accepts valid tiers', () => {
    expect(PermissionTierSchema.parse('green')).toBe('green');
    expect(PermissionTierSchema.parse('yellow')).toBe('yellow');
    expect(PermissionTierSchema.parse('red')).toBe('red');
  });

  it('rejects invalid tiers', () => {
    expect(() => PermissionTierSchema.parse('blue')).toThrow();
    expect(() => PermissionTierSchema.parse('')).toThrow();
    expect(() => PermissionTierSchema.parse(42)).toThrow();
  });
});

describe('SkillActionSchema', () => {
  const validAction = {
    name: 'ticktick:create-task',
    description: 'Create a new task',
    defaultTier: 'yellow',
    reversible: true,
  };

  it('accepts valid skill actions', () => {
    const result = SkillActionSchema.parse(validAction);
    expect(result).toEqual(validAction);
  });

  it('rejects action names without colon separator', () => {
    expect(() =>
      SkillActionSchema.parse({ ...validAction, name: 'ticktick-create-task' }),
    ).toThrow();
  });

  it('rejects action names with uppercase', () => {
    expect(() =>
      SkillActionSchema.parse({ ...validAction, name: 'TickTick:create-task' }),
    ).toThrow();
  });

  it('rejects action names with spaces', () => {
    expect(() =>
      SkillActionSchema.parse({ ...validAction, name: 'ticktick:create task' }),
    ).toThrow();
  });

  it('rejects empty description', () => {
    expect(() => SkillActionSchema.parse({ ...validAction, description: '' })).toThrow();
  });

  it('rejects invalid tier in action', () => {
    expect(() => SkillActionSchema.parse({ ...validAction, defaultTier: 'orange' })).toThrow();
  });

  it('rejects missing fields', () => {
    expect(() => SkillActionSchema.parse({ name: 'a:b' })).toThrow();
  });

  it('accepts various valid kebab-case names', () => {
    expect(SkillActionSchema.parse({ ...validAction, name: 'gmail:search-emails' })).toBeTruthy();
    expect(SkillActionSchema.parse({ ...validAction, name: 'a:b' })).toBeTruthy();
    expect(SkillActionSchema.parse({ ...validAction, name: 'skill123:action456' })).toBeTruthy();
  });

  it('rejects names starting with number or hyphen', () => {
    expect(() => SkillActionSchema.parse({ ...validAction, name: '1skill:action' })).toThrow();
    expect(() => SkillActionSchema.parse({ ...validAction, name: 'skill:1action' })).toThrow();
    expect(() => SkillActionSchema.parse({ ...validAction, name: '-skill:action' })).toThrow();
  });
});
