import { defineSuite, SUITE_PROACTIVE_INTELLIGENCE } from '@raven/shared';

export default defineSuite({
  name: SUITE_PROACTIVE_INTELLIGENCE,
  displayName: 'Proactive Intelligence',
  version: '0.1.0',
  description: 'Background pattern analysis across services with insight generation and delivery',
  capabilities: ['agent-definition', 'event-source', 'services'],
  services: ['data-collector', 'insight-processor', 'cross-domain-detector'],
});
