# Financial Tracking Suite — Update Check Instructions

## Dependencies to Monitor

### Monobank API
- **Docs**: https://api.monobank.ua/docs/
- **Impact**: Endpoint changes, rate limits, webhook format changes
- **Check**: Review Monobank API changelog for breaking changes
- **Token**: Personal token — verify still valid

### PrivatBank API
- **Docs**: https://api.privatbank.ua/
- **Impact**: Merchant API changes, authentication updates
- **Check**: Test with a simple balance/transaction fetch

### YNAB API (You Need A Budget)
- **Docs**: https://api.ynab.com/
- **Check**: `npm outdated ynab` if using official SDK
- **Impact**: Budget/transaction endpoint changes, OAuth scope updates

## What to Verify
- Bank webhook delivery working (if configured)
- Transaction categorization rules still matching
- Currency conversion rates updating
- YNAB push not failing silently (check error logs)
