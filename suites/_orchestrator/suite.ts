import { defineSuite, SUITE_ORCHESTRATOR } from '@raven/shared';

export default defineSuite({
  name: SUITE_ORCHESTRATOR,
  displayName: 'Orchestrator',
  version: '0.1.0',
  description: 'Top-level routing and domain coordination agents',
  capabilities: ['agent-definition'],
});
