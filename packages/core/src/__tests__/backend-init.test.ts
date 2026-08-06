import { describe, it, expect, vi } from 'vitest';

// Mock the SDK to avoid real imports
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

// Spy on the backend factory
vi.mock('../agent-manager/sdk-backend.ts', () => ({
  createSdkBackend: vi.fn(() => vi.fn()),
}));

import { initializeBackend } from '../agent-manager/agent-session.ts';
import { createSdkBackend } from '../agent-manager/sdk-backend.ts';

describe('Backend initialization', () => {
  it('always creates the SDK backend — there is no CLI backend split', () => {
    vi.mocked(createSdkBackend).mockClear();

    initializeBackend();

    expect(createSdkBackend).toHaveBeenCalled();
  });
});
