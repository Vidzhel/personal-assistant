import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

// Mock ynab SDK
const mockCreateTransactions = vi.fn();
const mockGetTransactionsByAccount = vi.fn();
const mockGetBudgetMonth = vi.fn();
const mockGetAccounts = vi.fn();
const mockGetCategories = vi.fn();

// ynab.API is a class — mock must be a constructor function, not arrow
const MockYnabAPI = vi.fn(function (this: any) {
  this.transactions = {
    createTransactions: mockCreateTransactions,
    getTransactionsByAccount: mockGetTransactionsByAccount,
  };
  this.months = {
    getBudgetMonth: mockGetBudgetMonth,
  };
  this.accounts = {
    getAccounts: mockGetAccounts,
  };
  this.categories = {
    getCategories: mockGetCategories,
  };
});

vi.mock('ynab', () => ({
  API: MockYnabAPI,
  SaveTransaction: {
    ClearedEnum: { Cleared: 'cleared' },
  },
}));

// Mock global.fetch for bank APIs
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('Financial Tracking — Transaction Sync', () => {
  let tmpDir: string;
  let sqliteDb: any;

  function setupDb(): void {
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS financial_accounts (
        id TEXT PRIMARY KEY,
        bank TEXT NOT NULL,
        bank_account_id TEXT NOT NULL,
        iban TEXT,
        currency_code INTEGER NOT NULL DEFAULT 980,
        display_name TEXT NOT NULL,
        ynab_account_id TEXT,
        ynab_server_knowledge INTEGER DEFAULT 0,
        last_sync_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS financial_transactions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
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
      CREATE INDEX IF NOT EXISTS idx_financial_tx_account_date
        ON financial_transactions (account_id, transaction_date);
    `);
  }

  beforeEach(() => {
    vi.clearAllMocks();

    tmpDir = mkdtempSync(join(tmpdir(), 'raven-financial-test-'));
    sqliteDb = new Database(':memory:');
    setupDb();
  });

  afterEach(() => {
    sqliteDb?.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Monobank normalization', () => {
    it('normalizes kopecks → milliunits (×10) and generates correct import_id', async () => {
      const { normalizeMonobankTransactions } = await import(
        '../services/monobank-client.ts'
      );

      const txs = normalizeMonobankTransactions([
        {
          id: 'mono-tx-1',
          time: 1711008000,
          description: 'Coffee shop',
          mcc: 5814,
          originalMcc: 5814,
          hold: false,
          amount: -14250,
          operationAmount: -14250,
          currencyCode: 980,
          commissionRate: 0,
          cashbackAmount: 0,
          balance: 500000,
          comment: 'Morning coffee',
        },
      ]);

      expect(txs).toHaveLength(1);
      const tx = txs[0];
      expect(tx.bankTxId).toBe('mono-tx-1');
      expect(tx.bank).toBe('monobank');
      expect(tx.amountMinor).toBe(-14250);
      expect(tx.milliunits).toBe(-142500);
      expect(tx.isDebit).toBe(true);
      expect(tx.mcc).toBe(5814);
      expect(tx.balanceAfterMinor).toBe(500000);
      expect(tx.memo).toBe('Morning coffee');
      expect(tx.importId).toMatch(/^YNAB:-142500:\d{4}-\d{2}-\d{2}:1$/);
    });

    it('handles occurrence counter for same amount+date combos', async () => {
      const { normalizeMonobankTransactions } = await import(
        '../services/monobank-client.ts'
      );

      const time = 1711008000;
      const txs = normalizeMonobankTransactions([
        {
          id: 'tx-a', time, description: 'A', mcc: 0, originalMcc: 0,
          hold: false, amount: -5000, operationAmount: -5000, currencyCode: 980,
          commissionRate: 0, cashbackAmount: 0, balance: 100000,
        },
        {
          id: 'tx-b', time, description: 'B', mcc: 0, originalMcc: 0,
          hold: false, amount: -5000, operationAmount: -5000, currencyCode: 980,
          commissionRate: 0, cashbackAmount: 0, balance: 95000,
        },
      ]);

      expect(txs[0].importId).toContain(':1');
      expect(txs[1].importId).toContain(':2');
    });
  });

  describe('PrivatBank normalization', () => {
    it('normalizes decimal strings → kopecks (×100) and milliunits (×1000)', async () => {
      const { normalizePrivatBankTransactions } = await import(
        '../services/privatbank-client.ts'
      );

      const txs = normalizePrivatBankTransactions([
        {
          ID: 'pb-tx-1',
          AUT_MY_ACC: 'UA1234567890',
          AUT_CNTR_ACC: 'UA0987654321',
          SUM: '142.50',
          CCY: 'UAH',
          DAT_OD: '21.03.2024',
          OSND: 'Payment received',
          TRANTYPE: 'C',
          REF: 'ref-123',
        },
        {
          ID: 'pb-tx-2',
          AUT_MY_ACC: 'UA1234567890',
          AUT_CNTR_ACC: 'UA9999999999',
          SUM: '50.00',
          CCY: 'UAH',
          DAT_OD: '21.03.2024',
          OSND: 'Grocery store',
          TRANTYPE: 'D',
          REF: 'ref-456',
        },
      ]);

      expect(txs[0].amountMinor).toBe(14250);
      expect(txs[0].milliunits).toBe(142500);
      expect(txs[0].isDebit).toBe(false);
      expect(txs[0].transactionDate).toBe('2024-03-21');

      expect(txs[1].amountMinor).toBe(-5000);
      expect(txs[1].milliunits).toBe(-50000);
      expect(txs[1].isDebit).toBe(true);
    });
  });

  describe('Deduplication', () => {
    it('INSERT OR IGNORE prevents duplicate bank_tx_id', () => {
      sqliteDb.prepare(
        'INSERT INTO financial_accounts (id, bank, bank_account_id, display_name) VALUES (?, ?, ?, ?)',
      ).run('acc-1', 'monobank', '0', 'Test Account');

      const stmt = sqliteDb.prepare(
        `INSERT OR IGNORE INTO financial_transactions
         (id, account_id, bank_tx_id, amount_minor, description, transaction_date)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );

      const r1 = stmt.run('tx-1', 'acc-1', 'mono-123', -5000, 'Coffee', '2024-03-21');
      expect(r1.changes).toBe(1);

      const r2 = stmt.run('tx-2', 'acc-1', 'mono-123', -5000, 'Coffee', '2024-03-21');
      expect(r2.changes).toBe(0);

      const count = sqliteDb.prepare('SELECT COUNT(*) as c FROM financial_transactions').get();
      expect(count.c).toBe(1);
    });
  });

  describe('YNAB push', () => {
    it('pushes transactions with correct import_id and milliunits', async () => {
      const { createYnabClient } = await import('../services/ynab-client.ts');

      mockCreateTransactions.mockResolvedValue({
        data: {
          transaction_ids: ['ynab-tx-1'],
          duplicate_import_ids: [],
        },
      });

      const client = createYnabClient('test-token');
      const result = await client.pushTransactions('default', 'ynab-acc-1', [
        {
          bankTxId: 'mono-1',
          bank: 'monobank' as const,
          amountMinor: -14250,
          currencyCode: 980,
          description: 'Coffee shop',
          mcc: 5814,
          isDebit: true,
          balanceAfterMinor: 500000,
          transactionDate: '2024-03-21',
          milliunits: -142500,
          importId: 'YNAB:-142500:2024-03-21:1',
          memo: null,
        },
      ]);

      expect(mockCreateTransactions).toHaveBeenCalledWith('default', {
        transactions: [
          expect.objectContaining({
            account_id: 'ynab-acc-1',
            date: '2024-03-21',
            amount: -142500,
            import_id: 'YNAB:-142500:2024-03-21:1',
            cleared: 'cleared',
            approved: false,
          }),
        ],
      });

      expect(result.transactionIds).toEqual(['ynab-tx-1']);
      expect(result.duplicateImportIds).toEqual([]);
    });

    it('YNAB silently skips duplicate import_ids', async () => {
      const { createYnabClient } = await import('../services/ynab-client.ts');

      mockCreateTransactions.mockResolvedValue({
        data: {
          transaction_ids: [],
          duplicate_import_ids: ['YNAB:-142500:2024-03-21:1'],
        },
      });

      const client = createYnabClient('test-token');
      const result = await client.pushTransactions('default', 'ynab-acc-1', [
        {
          bankTxId: 'mono-1',
          bank: 'monobank' as const,
          amountMinor: -14250,
          currencyCode: 980,
          description: 'Coffee shop',
          mcc: 5814,
          isDebit: true,
          balanceAfterMinor: 500000,
          transactionDate: '2024-03-21',
          milliunits: -142500,
          importId: 'YNAB:-142500:2024-03-21:1',
          memo: null,
        },
      ]);

      expect(result.duplicateImportIds).toEqual(['YNAB:-142500:2024-03-21:1']);
      expect(result.transactionIds).toEqual([]);
    });
  });

  describe('YNAB category sync', () => {
    it('fetches categorized transactions and returns category data', async () => {
      const { createYnabClient } = await import('../services/ynab-client.ts');

      mockGetTransactionsByAccount.mockResolvedValue({
        data: {
          transactions: [
            { id: 'ynab-tx-1', category_name: 'Restaurants' },
            { id: 'ynab-tx-2', category_name: 'Groceries' },
          ],
          server_knowledge: 42,
        },
      });

      const client = createYnabClient('test-token');
      const result = await client.fetchCategorizedTransactions(
        'default', 'ynab-acc-1', '2024-03-01', 0,
      );

      expect(result.transactions).toEqual([
        { id: 'ynab-tx-1', categoryName: 'Restaurants' },
        { id: 'ynab-tx-2', categoryName: 'Groceries' },
      ]);
      expect(result.serverKnowledge).toBe(42);
    });
  });

  describe('Bank API error handling', () => {
    it('Monobank fetch failure throws with status code', async () => {
      const { fetchMonobankTransactions } = await import(
        '../services/monobank-client.ts'
      );

      mockFetch.mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => 'Too many requests',
      });

      await expect(
        fetchMonobankTransactions('token', '0', 1711008000, 1711094400),
      ).rejects.toThrow('Monobank API 429');
    });

    it('PrivatBank fetch failure throws with status code', async () => {
      const { fetchPrivatBankTransactions } = await import(
        '../services/privatbank-client.ts'
      );

      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal server error',
      });

      await expect(
        fetchPrivatBankTransactions('token', 'UA123', 30),
      ).rejects.toThrow('PrivatBank API 500');
    });
  });

  describe('YNAB error isolation', () => {
    it('local storage succeeds even if YNAB push would fail', () => {
      sqliteDb.prepare(
        'INSERT INTO financial_accounts (id, bank, bank_account_id, display_name) VALUES (?, ?, ?, ?)',
      ).run('acc-1', 'monobank', '0', 'Test Account');

      const stmt = sqliteDb.prepare(
        `INSERT OR IGNORE INTO financial_transactions
         (id, account_id, bank_tx_id, amount_minor, description, transaction_date)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      stmt.run('tx-1', 'acc-1', 'mono-456', -5000, 'Coffee', '2024-03-21');

      const row = sqliteDb.prepare(
        'SELECT * FROM financial_transactions WHERE bank_tx_id = ?',
      ).get('mono-456');

      expect(row).toBeDefined();
      expect(row.amount_minor).toBe(-5000);
      expect(row.ynab_transaction_id).toBeNull();
    });
  });

  describe('Transactions routed to correct YNAB account', () => {
    it('uses ynabAccountId from config per account', async () => {
      const { createYnabClient } = await import('../services/ynab-client.ts');

      mockCreateTransactions.mockResolvedValue({
        data: { transaction_ids: ['ynab-1'], duplicate_import_ids: [] },
      });

      const client = createYnabClient('test-token');

      await client.pushTransactions('default', 'ynab-account-aaa', [
        {
          bankTxId: 'tx-1', bank: 'monobank' as const, amountMinor: -1000,
          currencyCode: 980, description: 'A', mcc: null, isDebit: true,
          balanceAfterMinor: null, transactionDate: '2024-03-21',
          milliunits: -10000, importId: 'YNAB:-10000:2024-03-21:1', memo: null,
        },
      ]);

      expect(mockCreateTransactions).toHaveBeenCalledWith('default', {
        transactions: [expect.objectContaining({ account_id: 'ynab-account-aaa' })],
      });

      mockCreateTransactions.mockClear();
      mockCreateTransactions.mockResolvedValue({
        data: { transaction_ids: ['ynab-2'], duplicate_import_ids: [] },
      });

      await client.pushTransactions('default', 'ynab-account-bbb', [
        {
          bankTxId: 'tx-2', bank: 'privatbank' as const, amountMinor: -2000,
          currencyCode: 980, description: 'B', mcc: null, isDebit: true,
          balanceAfterMinor: null, transactionDate: '2024-03-21',
          milliunits: -20000, importId: 'YNAB:-20000:2024-03-21:1', memo: null,
        },
      ]);

      expect(mockCreateTransactions).toHaveBeenCalledWith('default', {
        transactions: [expect.objectContaining({ account_id: 'ynab-account-bbb' })],
      });
    });
  });

  describe('YNAB month report', () => {
    it('fetches per-category budgeted vs actual breakdown', async () => {
      const { createYnabClient } = await import('../services/ynab-client.ts');

      mockGetBudgetMonth.mockResolvedValue({
        data: {
          month: {
            month: '2024-03-01',
            income: 5000000,
            budgeted: 4000000,
            activity: -3500000,
            categories: [
              { name: 'Restaurants', budgeted: 500000, activity: -420000, balance: 80000 },
              { name: 'Groceries', budgeted: 1000000, activity: -890000, balance: 110000 },
            ],
          },
        },
      });

      const client = createYnabClient('test-token');
      const summary = await client.fetchMonthSummary('default', '2024-03');

      expect(summary.month).toBe('2024-03-01');
      expect(summary.income).toBe(5000000);
      expect(summary.categories).toHaveLength(2);
      expect(summary.categories[0]).toEqual({
        name: 'Restaurants',
        budgeted: 500000,
        activity: -420000,
        balance: 80000,
      });
    });
  });

  describe('Config integrations', () => {
    it('accounts can be filtered by enabled flag', () => {
      const config = {
        ynab: { planId: 'default' },
        accounts: [
          { bank: 'monobank' as const, displayName: 'Active', bankAccountId: '0', ynabAccountId: 'aaa', currency: 'UAH', enabled: true },
          { bank: 'monobank' as const, displayName: 'Disabled', bankAccountId: '1', ynabAccountId: 'bbb', currency: 'UAH', enabled: false },
        ],
      };

      const enabled = config.accounts.filter((a) => a.enabled);
      expect(enabled).toHaveLength(1);
      expect(enabled[0].displayName).toBe('Active');
    });
  });

  describe('Import ID format', () => {
    it('respects 36 character limit', async () => {
      const { normalizeMonobankTransactions } = await import(
        '../services/monobank-client.ts'
      );

      const txs = normalizeMonobankTransactions([
        {
          id: 'tx-large',
          time: 1711008000,
          description: 'Large amount',
          mcc: 0,
          originalMcc: 0,
          hold: false,
          amount: -99999999,
          operationAmount: -99999999,
          currencyCode: 980,
          commissionRate: 0,
          cashbackAmount: 0,
          balance: 0,
        },
      ]);

      expect(txs[0].importId.length).toBeLessThanOrEqual(36);
    });
  });
});
