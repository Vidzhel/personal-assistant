import { defineSuite, SUITE_EMAIL } from '@raven/shared';

export default defineSuite({
  name: SUITE_EMAIL,
  displayName: 'Email',
  version: '0.1.0',
  description: 'Email monitoring and management via Gmail',
  capabilities: ['mcp-server', 'agent-definition', 'event-source', 'data-provider', 'services'],
  requiresEnv: ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'],
  services: ['imap-watcher', 'reply-composer'],
});
