import { describe, expect, it } from 'vitest';
import {
  ModelConfigOverrideSchema,
  ModelConfigSchema,
  ModelIdSchema,
} from '../types/model-config.ts';

describe('model config schema', () => {
  it('accepts aliases and open validated model identifiers', () => {
    expect(
      ModelConfigSchema.parse({ model: 'sonnet', effort: 'high', thinking: 'adaptive' }),
    ).toEqual({ model: 'sonnet', effort: 'high', thinking: 'adaptive' });
    expect(ModelIdSchema.parse('claude-fable-5-1-20260901')).toBe('claude-fable-5-1-20260901');
  });

  it('rejects unknown properties and malformed identifiers', () => {
    expect(() => ModelConfigSchema.parse({ model: 'sonnet', budgetTokens: 8_000 })).toThrow();
    expect(() => ModelIdSchema.parse('../model')).toThrow(/Invalid model identifier/);
    expect(() => ModelConfigSchema.parse({ thinking: 'fixed' })).toThrow();
  });

  it('uses null only as a whole-override reset', () => {
    expect(ModelConfigOverrideSchema.parse(null)).toBeNull();
    expect(() => ModelConfigSchema.parse({ model: null })).toThrow();
  });
});
