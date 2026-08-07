import { createLogger } from '@raven/shared';

const log = createLogger('monobank-client');

const BASE_URL = 'https://api.monobank.ua';
const SECONDS_TO_MS = 1000; // Unix timestamp (seconds) → milliseconds
const ISO_DATE_LENGTH = 10; // Length of a YYYY-MM-DD date string
const KOPECKS_TO_MILLIUNITS = 10; // 1 kopeck (currency minor unit) = 10 YNAB milliunits
const YNAB_IMPORT_ID_MAX_LENGTH = 36; // YNAB import_id field max length

export interface MonobankTransaction {
  id: string;
  time: number;
  description: string;
  mcc: number;
  originalMcc: number;
  hold: boolean;
  amount: number;
  operationAmount: number;
  currencyCode: number;
  commissionRate: number;
  cashbackAmount: number;
  balance: number;
  comment?: string;
}

export interface NormalizedTransaction {
  bankTxId: string;
  bank: 'monobank' | 'privatbank';
  amountMinor: number;
  currencyCode: number;
  description: string;
  mcc: number | null;
  isDebit: boolean;
  balanceAfterMinor: number | null;
  transactionDate: string;
  milliunits: number;
  importId: string;
  memo: string | null;
}

export interface MonobankStatementRange {
  accountId: string;
  from: number;
  to: number;
}

export async function fetchMonobankTransactions(
  token: string,
  range: MonobankStatementRange,
): Promise<MonobankTransaction[]> {
  const { accountId, from, to } = range;
  const url = `${BASE_URL}/personal/statement/${accountId}/${from}/${to}`;
  const response = await fetch(url, {
    headers: { 'X-Token': token },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Monobank API ${response.status}: ${text}`);
  }

  return (await response.json()) as MonobankTransaction[];
}

function buildImportId(milliunits: number, isoDate: string, occurrence: number): string {
  const id = `YNAB:${milliunits}:${isoDate}:${occurrence}`;
  return id.slice(0, YNAB_IMPORT_ID_MAX_LENGTH);
}

export function normalizeMonobankTransaction(
  tx: MonobankTransaction,
  occurrenceMap: Map<string, number>,
): NormalizedTransaction {
  const isoDate = new Date(tx.time * SECONDS_TO_MS).toISOString().slice(0, ISO_DATE_LENGTH);
  const milliunits = tx.amount * KOPECKS_TO_MILLIUNITS; // kopecks → milliunits

  const occKey = `${milliunits}:${isoDate}`;
  const occ = (occurrenceMap.get(occKey) ?? 0) + 1;
  occurrenceMap.set(occKey, occ);

  return {
    bankTxId: tx.id,
    bank: 'monobank',
    amountMinor: tx.amount,
    currencyCode: tx.currencyCode,
    description: tx.description,
    mcc: tx.mcc ?? null,
    isDebit: tx.amount < 0,
    balanceAfterMinor: tx.balance,
    transactionDate: isoDate,
    milliunits,
    importId: buildImportId(milliunits, isoDate, occ),
    memo: tx.comment ?? null,
  };
}

export function normalizeMonobankTransactions(txs: MonobankTransaction[]): NormalizedTransaction[] {
  const occurrenceMap = new Map<string, number>();
  return txs.map((tx) => normalizeMonobankTransaction(tx, occurrenceMap));
}

log.debug('Monobank client module loaded');
