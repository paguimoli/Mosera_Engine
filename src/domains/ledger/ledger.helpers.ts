import type { PlayerAccount } from "../accounts/account.types";
import type {
  AccountFinancialSummary,
  LedgerTransaction,
} from "./ledger.types";

export function getAccountingTransactionImpact(
  transaction: LedgerTransaction,
  transactions: LedgerTransaction[] = []
): number {
  if (transaction.transactionType === "reversal") {
    const parentTransaction = transactions.find(
      (createdTransaction) => createdTransaction.id === transaction.parentTransactionId
    );

    return parentTransaction
      ? -getAccountingTransactionImpact(parentTransaction, transactions)
      : 0;
  }

  if (
    [
      "deposit",
      "zero_balance_credit",
      "transfer_in",
      "manual_adjustment",
    ].includes(transaction.transactionType)
  ) {
    return transaction.amount;
  }

  if (
    ["withdrawal", "zero_balance_debit", "transfer_out"].includes(
      transaction.transactionType
    )
  ) {
    return -transaction.amount;
  }

  return 0;
}

export function getOperationalTransactionImpact(
  transaction: LedgerTransaction,
  transactions: LedgerTransaction[] = []
): number {
  if (transaction.transactionType === "reversal") {
    const parentTransaction = transactions.find(
      (createdTransaction) => createdTransaction.id === transaction.parentTransactionId
    );

    return parentTransaction
      ? -getOperationalTransactionImpact(parentTransaction, transactions)
      : 0;
  }

  if (["win", "loss"].includes(transaction.transactionType)) {
    return transaction.transactionType === "win"
      ? transaction.amount
      : -transaction.amount;
  }

  if (
    [
      "bet_stake",
      "bet_win",
      "freeplay_win",
      "credit_adjustment",
      "settlement_reversal",
    ].includes(transaction.transactionType)
  ) {
    return transaction.amount;
  }

  if (transaction.transactionType === "debit_adjustment") {
    return transaction.amount < 0 ? transaction.amount : -transaction.amount;
  }

  return 0;
}

export function getFreeplayTransactionImpact(
  transaction: LedgerTransaction,
  transactions: LedgerTransaction[] = []
): number {
  if (transaction.transactionType === "reversal") {
    const parentTransaction = transactions.find(
      (createdTransaction) => createdTransaction.id === transaction.parentTransactionId
    );

    return parentTransaction
      ? -getFreeplayTransactionImpact(parentTransaction, transactions)
      : 0;
  }

  if (
    ["freeplay_grant", "freeplay_adjustment", "freeplay_reversal"].includes(
      transaction.transactionType
    )
  ) {
    return transaction.amount;
  }

  if (
    ["freeplay_wager", "freeplay_expiration"].includes(
      transaction.transactionType
    )
  ) {
    return -transaction.amount;
  }

  return 0;
}

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

export function findLedgerTransactionById(
  transactions: LedgerTransaction[],
  transactionId: string
) {
  return transactions.find((transaction) => transaction.id === transactionId);
}

export function saveLedgerTransaction(
  transactions: LedgerTransaction[],
  transaction: LedgerTransaction
) {
  return [...transactions, transaction];
}

export function saveLedgerTransactions(
  transactions: LedgerTransaction[],
  newTransactions: LedgerTransaction[]
) {
  return [...transactions, ...newTransactions];
}
