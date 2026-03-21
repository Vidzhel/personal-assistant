import type { FastifyInstance, FastifyReply } from 'fastify';
import { getDb } from '../../db/database.ts';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const CACHE_TTL_MS = 300_000; // 5 minutes
const HTTP_BAD_REQUEST = 400;
const HTTP_SERVICE_UNAVAILABLE = 503;

interface TransactionRow {
  id: string;
  account_id: string;
  bank_tx_id: string;
  amount_minor: number;
  currency_code: number;
  description: string;
  mcc: number | null;
  ynab_category: string | null;
  ynab_transaction_id: string | null;
  is_debit: number;
  balance_after_minor: number | null;
  transaction_date: string;
  created_at: string;
}

interface AccountRow {
  id: string;
  bank: string;
  bank_account_id: string;
  iban: string | null;
  currency_code: number;
  display_name: string;
  ynab_account_id: string | null;
  last_sync_at: string | null;
  created_at: string;
}

interface TransactionQueryParams {
  account?: string;
  from?: string;
  to?: string;
  category?: string;
  limit?: string;
  offset?: string;
}

interface ReportQueryParams {
  month?: string;
}

interface YnabApi {
  months: {
    getBudgetMonth(
      planId: string,
      month: string,
    ): Promise<{
      data: {
        month: {
          month: string;
          income: number;
          budgeted: number;
          activity: number;
          categories?: Array<{ name: string; budgeted: number; activity: number; balance: number }>;
        };
      };
    }>;
  };
  categories: { getCategories(planId: string): Promise<{ data: { category_groups: unknown[] } }> };
}

let ynabApi: YnabApi | null = null;
let ynabPlanId = 'default';
let reportCache: { month: string; data: unknown; fetchedAt: number } | null = null;
let categoryCache: { data: unknown; fetchedAt: number } | null = null;

function getYnabApi(): YnabApi | null {
  if (ynabApi) return ynabApi;

  const token = process.env.YNAB_ACCESS_TOKEN;
  if (!token) return null;

  // Lazy-import ynab SDK (installed at monorepo root)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ynab = require('ynab') as { API: new (token: string) => YnabApi };
    ynabApi = new ynab.API(token);
    ynabPlanId = process.env.YNAB_PLAN_ID ?? 'default';
    return ynabApi;
  } catch {
    return null;
  }
}

function mapTransactionRow(
  r: TransactionRow & { account_name: string; bank: string },
): Record<string, unknown> {
  return {
    id: r.id,
    accountId: r.account_id,
    accountName: r.account_name,
    bank: r.bank,
    bankTxId: r.bank_tx_id,
    amountMinor: r.amount_minor,
    currencyCode: r.currency_code,
    description: r.description,
    mcc: r.mcc,
    ynabCategory: r.ynab_category,
    isDebit: r.is_debit === 1,
    balanceAfterMinor: r.balance_after_minor,
    transactionDate: r.transaction_date,
    createdAt: r.created_at,
  };
}

function buildTransactionQuery(query: TransactionQueryParams): {
  where: string;
  params: unknown[];
  limit: number;
  offset: number;
} {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.account) {
    conditions.push('t.account_id = ?');
    params.push(query.account);
  }
  if (query.from) {
    conditions.push('t.transaction_date >= ?');
    params.push(query.from);
  }
  if (query.to) {
    conditions.push('t.transaction_date <= ?');
    params.push(query.to);
  }
  if (query.category) {
    conditions.push('t.ynab_category = ?');
    params.push(query.category);
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
    limit: Math.min(Number(query.limit ?? DEFAULT_LIMIT), MAX_LIMIT),
    offset: Number(query.offset ?? 0),
  };
}

function registerTransactionRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: TransactionQueryParams }>('/api/financial/transactions', async (req) => {
    const db = getDb();
    const { where, params, limit, offset } = buildTransactionQuery(req.query);

    const rows = db
      .prepare(
        `SELECT t.*, a.display_name as account_name, a.bank
           FROM financial_transactions t
           JOIN financial_accounts a ON t.account_id = a.id
           ${where}
           ORDER BY t.transaction_date DESC, t.created_at DESC
           LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<
      TransactionRow & { account_name: string; bank: string }
    >;

    const total = db
      .prepare(`SELECT COUNT(*) as count FROM financial_transactions t ${where}`)
      .get(...params) as { count: number };

    return { transactions: rows.map(mapTransactionRow), total: total.count, limit, offset };
  });

  app.get('/api/financial/accounts', async () => {
    const db = getDb();
    const rows = db
      .prepare('SELECT * FROM financial_accounts ORDER BY display_name')
      .all() as AccountRow[];

    return rows.map((r) => ({
      id: r.id,
      bank: r.bank,
      bankAccountId: r.bank_account_id,
      iban: r.iban,
      currencyCode: r.currency_code,
      displayName: r.display_name,
      ynabAccountId: r.ynab_account_id,
      lastSyncAt: r.last_sync_at,
      createdAt: r.created_at,
    }));
  });
}

function registerReportRoute(app: FastifyInstance): void {
  app.get<{ Querystring: ReportQueryParams }>(
    '/api/financial/report',
    async (req, reply: FastifyReply) => {
      const month = req.query.month;
      if (!month || !/^\d{4}-\d{2}$/.test(month)) {
        return reply
          .status(HTTP_BAD_REQUEST)
          .send({ error: 'month query param required (YYYY-MM)' });
      }
      const api = getYnabApi();
      if (!api) {
        return reply
          .status(HTTP_SERVICE_UNAVAILABLE)
          .send({ error: 'YNAB not configured (YNAB_ACCESS_TOKEN not set)' });
      }
      if (
        reportCache &&
        reportCache.month === month &&
        Date.now() - reportCache.fetchedAt < CACHE_TTL_MS
      ) {
        return reportCache.data;
      }
      const response = await api.months.getBudgetMonth(ynabPlanId, month);
      const monthData = response.data.month;
      const data = {
        month: monthData.month,
        income: monthData.income,
        budgeted: monthData.budgeted,
        activity: monthData.activity,
        categories: (monthData.categories ?? []).map((c) => ({
          name: c.name,
          budgeted: c.budgeted,
          activity: c.activity,
          balance: c.balance,
        })),
      };
      reportCache = { month, data, fetchedAt: Date.now() };
      return data;
    },
  );
}

function registerCategoryRoute(app: FastifyInstance): void {
  app.get('/api/financial/categories', async (_req, reply: FastifyReply) => {
    const api = getYnabApi();
    if (!api) {
      return reply
        .status(HTTP_SERVICE_UNAVAILABLE)
        .send({ error: 'YNAB not configured (YNAB_ACCESS_TOKEN not set)' });
    }
    if (categoryCache && Date.now() - categoryCache.fetchedAt < CACHE_TTL_MS) {
      return categoryCache.data;
    }
    const response = await api.categories.getCategories(ynabPlanId);
    const data = response.data.category_groups;
    categoryCache = { data, fetchedAt: Date.now() };
    return data;
  });
}

export function registerFinancialRoutes(app: FastifyInstance): void {
  registerTransactionRoutes(app);
  registerReportRoute(app);
  registerCategoryRoute(app);
}
