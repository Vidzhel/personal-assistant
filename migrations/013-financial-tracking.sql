-- Financial account tracking
CREATE TABLE IF NOT EXISTS financial_accounts (
  id TEXT PRIMARY KEY,
  bank TEXT NOT NULL CHECK (bank IN ('monobank', 'privatbank')),
  bank_account_id TEXT NOT NULL,
  iban TEXT,
  currency_code INTEGER NOT NULL DEFAULT 980,
  display_name TEXT NOT NULL,
  ynab_account_id TEXT,
  ynab_server_knowledge INTEGER DEFAULT 0,
  last_sync_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Financial transaction tracking
CREATE TABLE IF NOT EXISTS financial_transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES financial_accounts(id),
  bank_tx_id TEXT NOT NULL UNIQUE,
  amount_minor INTEGER NOT NULL,
  currency_code INTEGER NOT NULL DEFAULT 980,
  description TEXT NOT NULL DEFAULT '',
  mcc INTEGER,
  ynab_category TEXT,
  ynab_transaction_id TEXT,
  is_debit INTEGER NOT NULL DEFAULT 1,
  balance_after_minor INTEGER,
  transaction_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indices
CREATE INDEX IF NOT EXISTS idx_financial_tx_account_date
  ON financial_transactions (account_id, transaction_date);
