import { defineSuite, SUITE_FINANCIAL_TRACKING } from '@raven/shared';

export default defineSuite({
  name: SUITE_FINANCIAL_TRACKING,
  displayName: 'Financial Tracking',
  version: '0.1.0',
  description: 'Bank transaction sync (Monobank, PrivatBank) → local DB → YNAB, with category sync and spending reports',
  capabilities: ['event-source', 'services'],
  requiresEnv: ['YNAB_ACCESS_TOKEN'],
  services: ['transaction-sync'],
});
