import { defineSuite, SUITE_GOOGLE_WORKSPACE } from '@raven/shared';

export default defineSuite({
  name: SUITE_GOOGLE_WORKSPACE,
  displayName: 'Google Workspace',
  version: '0.1.0',
  description: 'Google Workspace integration via gws CLI — Calendar, Gmail, Drive, Meet, Tasks, Docs, People, and workflow helpers',
  capabilities: ['mcp-server', 'agent-definition', 'event-source', 'services'],
  requiresEnv: ['GWS_PRIMARY_CREDENTIALS_FILE'],
  services: ['email-watcher'],
});
