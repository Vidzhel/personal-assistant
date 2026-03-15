import { defineSuite, SUITE_DAILY_BRIEFING } from '@raven/shared';

export default defineSuite({
  name: SUITE_DAILY_BRIEFING,
  displayName: 'Daily Briefing',
  version: '0.1.0',
  description: 'Daily morning briefing with tasks, emails, and suggestions',
  capabilities: ['agent-definition'],
  services: ['briefing-formatter'],
});
