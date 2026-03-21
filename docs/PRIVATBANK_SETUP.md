# PrivatBank Setup

## Prerequisites

- Privat24 Business account (AutoClient API access)

## Activate AutoClient API

1. Log in to Privat24 Business
2. Navigate to: **Accounting & Reports → Integration (AutoClient) → Activate**
3. Select **API** mode
4. Fill in required fields and save
5. Click **Install** and copy the generated token

## Find Your IBAN

1. Open Privat24
2. Go to your account details
3. Copy the IBAN (starts with `UA`, 29 characters)

Note: "Власний рахунок" is a separate bank (BVR). A PrivatBank current account (поточний рахунок) is identified by its IBAN.

## Verify Token

```bash
curl -s -H "token: $PRIVATBANK_TOKEN" -H "Content-Type: application/json;charset=utf-8" \
  "https://acp.privatbank.ua/api/proxy/transactions?acc=UA123...&startDate=01-03-2026&endDate=21-03-2026" \
  | python3 -m json.tool
```

## Configure

1. Add token to `.env`:
   ```
   PRIVATBANK_TOKEN=<your_token>
   ```

2. Add account entry to `config/integrations.json`:
   ```json
   {
     "accounts": [
       {
         "bank": "privatbank",
         "displayName": "PrivatBank Current Account",
         "iban": "UA123456789012345678901234567",
         "ynabAccountId": "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz",
         "currency": "UAH",
         "enabled": true
       }
     ]
   }
   ```

## Troubleshooting

- **Token activation issues**: Ensure AutoClient API is set to "API" mode, not "File" mode
- **IBAN format**: Must start with `UA` followed by 27 digits
- **API response codes**: Check Privat24 Business portal for error code documentation
- **Date format**: PrivatBank uses `DD-MM-YYYY` format (handled automatically by the sync service)
