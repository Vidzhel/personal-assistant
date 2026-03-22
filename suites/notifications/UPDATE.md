# Notifications Suite — Update Check Instructions

## Dependencies to Monitor

### grammy (Telegram Bot Framework)
- **Current**: Check `package.json` for version
- **Changelog**: https://github.com/grammyjs/grammY/releases
- **Breaking changes**: Major versions may change middleware API or context types
- **Check**: `npm outdated grammy`

### Telegram Bot API
- **Docs**: https://core.telegram.org/bots/api#recent-changes
- **Impact**: New methods, deprecated parameters, message format changes
- **Check frequency**: Monthly — Telegram updates API frequently

## What to Verify
- Bot token validity (tokens don't expire but can be revoked)
- Webhook vs polling configuration still appropriate
- Inline keyboard callback data format (64-byte limit)
- Topic/forum thread API stability (relatively new feature)
