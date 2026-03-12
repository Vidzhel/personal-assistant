import { defineSuite } from '@raven/shared';

export default defineSuite({
  name: 'task-management',
  displayName: 'Task Management',
  version: '0.1.0',
  description: 'Task management via TickTick',
  capabilities: ['mcp-server', 'agent-definition', 'data-provider'],
  requiresEnv: ['TICKTICK_CLIENT_ID', 'TICKTICK_CLIENT_SECRET', 'TICKTICK_ACCESS_TOKEN'],
});
