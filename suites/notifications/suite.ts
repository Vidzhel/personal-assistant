import { defineSuite } from '@raven/shared';

export default defineSuite({
  name: 'notifications',
  displayName: 'Notifications',
  version: '0.1.0',
  description: 'Push notifications and quick commands via Telegram',
  capabilities: ['notification-sink', 'event-source'],
  requiresEnv: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'],
  services: ['telegram-bot'],
});
