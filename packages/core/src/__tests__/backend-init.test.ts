import { describe, it, expect, vi } from 'vitest';

// Mock the SDK to avoid real imports
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

vi.mock('../config.ts', () => ({
  getConfig: () => ({
    ANTHROPIC_API_KEY: '',
    CLAUDE_MODEL: 'test-model',
    RAVEN_AGENT_MAX_TURNS: 10,
  }),
}));

// Spy on the backend factories
vi.mock('../agent-manager/sdk-backend.ts', () => ({
  createSdkBackend: vi.fn(() => vi.fn()),
}));

vi.mock('../agent-manager/cli-backend.ts', () => ({
  createCliBackend: vi.fn(() => vi.fn()),
}));

import { initializeBackend } from '../agent-manager/agent-session.ts';
import { createSdkBackend } from '../agent-manager/sdk-backend.ts';
import { createCliBackend } from '../agent-manager/cli-backend.ts';

describe('Backend initialization', () => {
  it('selects SDK backend when API key is provided', () => {
    initializeBackend('sk-ant-some-key');
    expect(createSdkBackend).toHaveBeenCalled();
    expect(createCliBackend).not.toHaveBeenCalled();
  });

  it('selects CLI backend when API key is empty', () => {
    vi.mocked(createSdkBackend).mockClear();
    vi.mocked(createCliBackend).mockClear();

    initializeBackend('');
    expect(createCliBackend).toHaveBeenCalled();
    expect(createSdkBackend).not.toHaveBeenCalled();
  });
});
