# Google Workspace Suite — Update Check Instructions

## Dependencies to Monitor

### Google APIs
- **Gmail API**: https://developers.google.com/gmail/api/release-notes
- **Drive API**: https://developers.google.com/drive/api/release-notes
- **Calendar API**: https://developers.google.com/calendar/api/release-notes
- **Impact**: Scope changes, deprecated methods, quota changes, new features

### googleapis npm Package
- **Check**: `npm outdated googleapis`
- **Changelog**: https://github.com/googleapis/google-api-nodejs-client/releases
- **Impact**: Type changes, authentication flow updates

### OAuth2 Credentials
- **Location**: Google Cloud Console project
- **Check**: Ensure OAuth consent screen is still approved
- **Token refresh**: Verify refresh tokens are being renewed correctly

## What to Verify
- OAuth2 token refresh cycle working
- Drive file watch notifications being received
- Gmail push notifications via Pub/Sub active
- API quotas not being approached (check Cloud Console)
- Service account permissions still valid (if used)
