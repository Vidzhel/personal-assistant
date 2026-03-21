# YNAB Setup

## Prerequisites

- Active YNAB subscription (https://ynab.com)

## Create Personal Access Token

1. Log in to YNAB web app
2. Go to **Account Settings → Developer Settings**
3. Click **New Token**, confirm your password
4. Copy the generated token immediately (it won't be shown again)

## Find Plan (Budget) ID

You can use `"default"` as the plan ID (maps to your last-used budget), or find the specific UUID:

```bash
curl -s -H "Authorization: Bearer $YNAB_ACCESS_TOKEN" \
  https://api.ynab.com/v1/budgets | python3 -m json.tool
```

Each budget has an `id` field (UUID).

## Find Account IDs

```bash
curl -s -H "Authorization: Bearer $YNAB_ACCESS_TOKEN" \
  https://api.ynab.com/v1/budgets/default/accounts | python3 -m json.tool
```

Note the `id` (UUID) for each account you want to map to a bank account. Create YNAB accounts if needed (e.g., "Monobank Black", "PrivatBank").

## Configure

1. Add token to `.env`:
   ```
   YNAB_ACCESS_TOKEN=<your_token>
   ```

2. Set YNAB plan ID in `config/integrations.json`:
   ```json
   {
     "ynab": {
       "planId": "default"
     }
   }
   ```

3. Map each bank account to a YNAB account by setting `ynabAccountId` in each account entry (see MONOBANK_SETUP.md, PRIVATBANK_SETUP.md).

## Verify

After starting Raven, check logs for successful sync:
```bash
cat data/logs/raven.1.log | python3 -c "import sys,json; [print(json.loads(l).get('msg','')) for l in sys.stdin if l.strip() and 'financial' in json.loads(l).get('msg','').lower()]"
```

## Troubleshooting

- **Token expired**: YNAB tokens don't expire automatically, but can be revoked. Regenerate in Developer Settings if needed.
- **Rate limits**: YNAB allows 200 requests per rolling 1-hour window. With hourly sync, typical usage is 5-10 requests per cycle.
- **Plan ID not found**: Use `"default"` or verify the UUID from the budgets API call above.
- **Account ID mismatch**: Ensure the `ynabAccountId` in `config/integrations.json` matches the account UUID from YNAB exactly.
