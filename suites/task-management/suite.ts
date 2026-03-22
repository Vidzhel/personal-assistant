import { defineSuite, SUITE_TASK_MANAGEMENT } from '@raven/shared';

export default defineSuite({
  name: SUITE_TASK_MANAGEMENT,
  displayName: 'Task Management',
  version: '0.1.0',
  description: 'Task management via TickTick',
  capabilities: ['mcp-server', 'agent-definition', 'data-provider', 'services'],
  requiresEnv: ['TICKTICK_CLIENT_ID', 'TICKTICK_CLIENT_SECRET', 'TICKTICK_ACCESS_TOKEN'],
  services: ['autonomous-manager', 'ticktick-sync'],
});
