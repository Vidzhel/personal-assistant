# Telegram Setup

## Prerequisites

1. **Telegram Bot** created via [@BotFather](https://t.me/BotFather)
2. **Telegram group** (supergroup recommended for topic/thread support)

## Create Bot

1. Open [@BotFather](https://t.me/BotFather) in Telegram
2. Send `/newbot`, follow the prompts
3. Copy the bot token

## Add Bot to Group

1. Open your Telegram group
2. Tap the group name/header → **Add Members**
3. Search for the bot by its `@username` and add it
4. Send a message in the group

## Get Group Chat ID

With the bot **stopped** (not polling), call the Telegram API:

```bash
curl -s "https://api.telegram.org/bot<BOT_TOKEN>/getUpdates" | python3 -m json.tool
```

Look for `chat.id` in the response. Supergroup IDs are **negative** (e.g., `-1003859760220`).

## Group Privacy (Optional)

To let the bot see all messages (not just `/commands`):

1. Open [@BotFather](https://t.me/BotFather)
2. `/mybots` → select your bot
3. **Bot Settings → Group Privacy → Turn OFF**

## Forum / Topics Support

If the group has topics enabled (`is_forum: true`), the bot may need to specify a `message_thread_id` when sending messages to target a specific topic thread.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from BotFather |
| `TELEGRAM_CHAT_ID` | Yes | Group chat ID (negative for supergroups) |

Set in `.env`:
```bash
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHAT_ID=-100xxxxxxxxxx
```
