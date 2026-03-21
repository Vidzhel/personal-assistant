import { createLogger } from '@raven/shared';
import type { NormalizedTransaction } from './monobank-client.ts';

const log = createLogger('privatbank-client');

const BASE_URL = 'https://acp.privatbank.ua/api/proxy';

export interface PrivatBankTransaction {
  ID: string;
  AUT_MY_ACC: string;
  AUT_CNTR_ACC: string;
  SUM: string;
  CCY: string;
  DAT_OD: string;
  OSND: string;
  TRANTYPE: 'D' | 'C';
  REF: string;
}

interface PrivatBankResponse {
  StatementsResponse?: {
    statements?: PrivatBankTransaction[];
  };
}

export async function fetchPrivatBankTransactions(
  token: string,
  iban: string,
  periodDays: number,
): Promise<PrivatBankTransaction[]> {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - periodDays);

  const formatDate = (d: Date): string =>
    `${d.getDate().toString().padStart(2, '0')}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getFullYear()}`;

  const url = `${BASE_URL}/transactions?acc=${iban}&startDate=${formatDate(startDate)}&endDate=${formatDate(endDate)}`;

  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json;charset=utf-8',
      token,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`PrivatBank API ${response.status}: ${text}`);
  }

  const data = (await response.json()) as PrivatBankResponse;
  return data.StatementsResponse?.statements ?? [];
}

function buildImportId(milliunits: number, isoDate: string, occurrence: number): string {
  const id = `YNAB:${milliunits}:${isoDate}:${occurrence}`;
  return id.slice(0, 36);
}

export function normalizePrivatBankTransaction(
  tx: PrivatBankTransaction,
  occurrenceMap: Map<string, number>,
): NormalizedTransaction {
  // DAT_OD format: DD.MM.YYYY
  const [day, month, year] = tx.DAT_OD.split('.');
  const isoDate = `${year}-${month}-${day}`;

  const sumFloat = parseFloat(tx.SUM);
  const isDebit = tx.TRANTYPE === 'D';
  const signedAmount = isDebit ? -Math.abs(sumFloat) : Math.abs(sumFloat);

  // Local storage: kopecks (integer)
  const amountMinor = Math.round(signedAmount * 100);

  // YNAB: milliunits
  const milliunits = Math.round(signedAmount * 1000);

  const occKey = `${milliunits}:${isoDate}`;
  const occ = (occurrenceMap.get(occKey) ?? 0) + 1;
  occurrenceMap.set(occKey, occ);

  // UAH = 980 (ISO 4217)
  const currencyCode = tx.CCY === 'UAH' ? 980 : 0;

  return {
    bankTxId: tx.ID,
    bank: 'privatbank',
    amountMinor,
    currencyCode,
    description: tx.OSND,
    mcc: null,
    isDebit,
    balanceAfterMinor: null,
    transactionDate: isoDate,
    milliunits,
    importId: buildImportId(milliunits, isoDate, occ),
    memo: null,
  };
}

export function normalizePrivatBankTransactions(
  txs: PrivatBankTransaction[],
): NormalizedTransaction[] {
  const occurrenceMap = new Map<string, number>();
  return txs.map((tx) => normalizePrivatBankTransaction(tx, occurrenceMap));
}

log.debug('PrivatBank client module loaded');
