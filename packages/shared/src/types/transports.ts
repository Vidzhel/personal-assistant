export interface TelegramReplyAddress {
  transport: 'telegram';
  chatId: string;
  /** Telegram forum topic. Omitted for private bot chat. */
  topicId?: number;
  /** Owner message that admitted this turn. */
  messageId: number;
  /** Telegram message being replied to, when it selected an older Raven session. */
  replyToMessageId?: number;
}

export type ChatTransportOrigin = TelegramReplyAddress;

export type NotificationDestination =
  { kind: 'project'; projectId: string } | { kind: 'global'; topic: 'general' | 'system' };
