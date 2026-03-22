# Email Suite — Update Check Instructions

## Dependencies to Monitor

### Gmail API (via Google Workspace MCP)
- **Docs**: https://developers.google.com/gmail/api/release-notes
- **Impact**: Scope changes, deprecated endpoints, quota adjustments
- **Check**: Review Google Cloud Console for deprecation notices

### IMAP Protocol
- **Standard**: RFC 9051 (IMAP4rev2)
- **Impact**: IMAP IDLE connection handling, authentication method changes
- **Note**: Gmail may restrict "less secure app" access — ensure OAuth2 is used

### node-imap / imapflow
- **Check**: `npm outdated` for IMAP client library
- **Changelog**: Check GitHub releases for connection handling changes

## What to Verify
- OAuth2 token refresh working correctly
- IMAP IDLE connections reconnecting after drops
- Gmail API quota not being exceeded
- Email parsing handles new MIME types correctly
