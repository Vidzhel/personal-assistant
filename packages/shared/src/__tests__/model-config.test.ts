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

  it('accepts the SDK extended-context suffix without allowing arbitrary brackets', () => {
    for (const model of ['opus[1m]', 'claude-opus-5[1m]', 'claude-fable-5[1m]']) {
      expect(ModelIdSchema.parse(model)).toBe(model);
    }
    for (const model of ['opus[]', 'opus[other]', 'opus[1m][1m]', 'opus[1m]/file']) {
      expect(ModelIdSchema.safeParse(model).success).toBe(false);
    }
  });

  it('uses null only as a whole-override reset', () => {
    expect(ModelConfigOverrideSchema.parse(null)).toBeNull();
    expect(() => ModelConfigSchema.parse({ model: null })).toThrow();
  });
});
