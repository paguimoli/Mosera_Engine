import type { PlayerAccount } from "../accounts/account.types";
import {
  getAccountingTransactionImpact,
  getFreeplayTransactionImpact,
  getOperationalTransactionImpact,
} from "./ledger.helpers";
import type { AccountFinancialSummary, LedgerTransaction } from "./ledger.types";

export function calculateAccountingBalance(
  transactions: LedgerTransaction[],
  accountId: string
) {
  return transactions
    .filter((transaction) => transaction.accountId === accountId)
    .reduce((balance, transaction) => {
      if (transaction.category !== "accounting") return balance;

      return balance + getAccountingTransactionImpact(transaction, transactions);
    }, 0);
}

export function calculateWeeklyFigure(
  transactions: LedgerTransaction[],
  accountId: string
) {
  return transactions
    .filter((transaction) => transaction.accountId === accountId)
    .reduce((figure, transaction) => {
      if (transaction.category !== "operational") return figure;

      return figure + getOperationalTransactionImpact(transaction, transactions);
    }, 0);
}

export function calculateFreeplayBalance(
  transactions: LedgerTransaction[],
  accountId: string
) {
  return transactions
    .filter((transaction) => transaction.accountId === accountId)
    .reduce((balance, transaction) => {
      if (transaction.category !== "freeplay") return balance;

      return balance + getFreeplayTransactionImpact(transaction, transactions);
    }, 0);
}

export function calculatePendingExposure(account?: PlayerAccount) {
  return Number(account?.currentExposure || 0);
}

export function buildAccountFinancialSummary({
  account,
  transactions,
}: {
  account?: PlayerAccount;
  transactions: LedgerTransaction[];
}): AccountFinancialSummary {
  const accountId = account?.id || "";
  const pendingExposure = calculatePendingExposure(account);
  const allocatedCredit = 0;

  return {
    accountId,
    accountingBalance: calculateAccountingBalance(transactions, accountId),
    weeklyFigure: calculateWeeklyFigure(transactions, accountId),
    freeplayBalance: calculateFreeplayBalance(transactions, accountId),
    pendingExposure,
    availableCredit:
      Number(account?.creditLimit || 0) - allocatedCredit - pendingExposure,
  };
}
