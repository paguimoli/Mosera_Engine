import type { LedgerTransaction } from "./ledger.types";

export function listTransactionsByAccountId(
  transactions: LedgerTransaction[],
  accountId: string
) {
  return transactions.filter((transaction) => transaction.accountId === accountId);
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
