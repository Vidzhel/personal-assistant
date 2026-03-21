# Monobank Setup

## Prerequisites

- Monobank app installed on your phone

## Get Personal API Token

1. Visit https://api.monobank.ua/ in your browser
2. Scan the QR code with the Monobank app
3. Copy the personal API token displayed

## Verify Token

```bash
curl -s -H "X-Token: $MONOBANK_TOKEN" https://api.monobank.ua/personal/client-info | python3 -m json.tool
```

The response contains an `accounts` array. Each account has:
- `id` — the account identifier (default card is `"0"`)
- `iban` — full IBAN
- `currencyCode` — ISO 4217 (980 = UAH)
- `balance` — current balance in kopecks

## Configure

1. Add token to `.env`:
   ```
   MONOBANK_TOKEN=<your_token>
   ```

2. Add account entry to `config/integrations.json`:
   ```json
   {
     "accounts": [
       {
         "bank": "monobank",
         "displayName": "Monobank Black",
         "bankAccountId": "0",
         "ynabAccountId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
         "currency": "UAH",
         "enabled": true
       }
     ]
   }
   ```

   - `bankAccountId`: Use `"0"` for your default (Black) card, or the `id` from client-info for other accounts
   - `ynabAccountId`: The YNAB account UUID to receive transactions (see YNAB_SETUP.md)

## Multiple Accounts

If you have multiple Monobank accounts (e.g., Black + White cards), add separate entries with different `bankAccountId` values from the client-info response.

## Troubleshooting

- **Token expired**: Tokens are long-lived but can expire. Re-scan the QR at https://api.monobank.ua/
- **Rate limit (HTTP 429)**: Monobank allows 1 request per 60 seconds per endpoint. The sync service handles this automatically with staggered polling.
- **Empty transactions**: First sync fetches the last 30 days. If your account is new, there may be no transactions yet.
