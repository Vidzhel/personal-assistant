import { defineSuite, SUITE_ORCHESTRATOR } from '@raven/shared';

export default defineSuite({
  name: SUITE_ORCHESTRATOR,
  displayName: 'Orchestrator',
  version: '0.2.0',
  description: 'Top-level routing, domain coordination, and config management agents',
  capabilities: ['agent-definition', 'services'],
  services: ['maintenance-runner'],
});
