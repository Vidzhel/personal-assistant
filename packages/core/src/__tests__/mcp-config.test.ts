import { afterEach, describe, expect, it } from 'vitest';
import {
  environmentReferences,
  getMcpConfigurationStatus,
  materializeMcpServerConfig,
  mcpEnvironmentReferences,
} from '../capability-library/mcp-config.ts';

afterEach(() => {
  delete process.env['TEST_MCP_TOKEN'];
});

describe('MCP configuration', () => {
  const httpConfig = {
    type: 'http' as const,
    url: 'https://mcp.example.com',
    headers: {
      Authorization: 'Bearer ${TEST_MCP_TOKEN}',
      'X-Client': 'raven',
    },
  };

  it('extracts and deduplicates complete environment references', () => {
    expect(environmentReferences('${ONE}/Bearer ${TWO}/${ONE}')).toEqual(['ONE', 'TWO', 'ONE']);
    expect(mcpEnvironmentReferences(httpConfig)).toEqual(['TEST_MCP_TOKEN']);
  });

  it('reports missing configuration without returning environment values', () => {
    expect(getMcpConfigurationStatus(httpConfig, {})).toEqual({
      configured: false,
      missingEnvironment: ['TEST_MCP_TOKEN'],
    });
  });

  it('materializes the HTTP SDK shape at dispatch', () => {
    process.env['TEST_MCP_TOKEN'] = 'fake-secret';
    expect(materializeMcpServerConfig(httpConfig)).toEqual({
      type: 'http',
      url: 'https://mcp.example.com',
      headers: { Authorization: 'Bearer fake-secret', 'X-Client': 'raven' },
      alwaysLoad: true,
    });
  });

  it('rejects missing and control-bearing environment values without exposing them', () => {
    expect(() => materializeMcpServerConfig(httpConfig, {})).toThrow('TEST_MCP_TOKEN');
    const unsafe = 'secret\nInjected: true';
    expect(() => materializeMcpServerConfig(httpConfig, { TEST_MCP_TOKEN: unsafe })).toThrow(
      'Invalid control character',
    );
    try {
      materializeMcpServerConfig(httpConfig, { TEST_MCP_TOKEN: unsafe });
    } catch (error) {
      expect(String(error)).not.toContain(unsafe);
    }
  });

  it('preserves legacy stdio missing-variable behavior only at dispatch', () => {
    const template = {
      command: 'mcp-fixture',
      args: [],
      env: { API_TOKEN: '${TEST_MCP_TOKEN}' },
    };
    expect(materializeMcpServerConfig(template, {})).toEqual({
      type: 'stdio',
      command: 'mcp-fixture',
      args: [],
      env: { API_TOKEN: '' },
      alwaysLoad: true,
    });
    expect(template.env.API_TOKEN).toBe('${TEST_MCP_TOKEN}');
  });
});
