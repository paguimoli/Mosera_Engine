import type { LedgerTransaction } from "../ledger/ledger.types";
import {
  getAccountingTransactionImpact,
  getFreeplayTransactionImpact,
  getOperationalTransactionImpact,
} from "../ledger/ledger.helpers";
import type {
  Wallet,
  WalletBalanceSummary,
  WalletType,
} from "./wallet.types";

function isWalletTransaction(
  transaction: LedgerTransaction,
  walletType: WalletType
) {
  return transaction.walletType === walletType;
}

function getWalletTransactionImpact(
  transaction: LedgerTransaction,
  transactions: LedgerTransaction[]
) {
  if (transaction.category === "accounting") {
    return getAccountingTransactionImpact(transaction, transactions);
  }

  if (transaction.category === "operational") {
    return getOperationalTransactionImpact(transaction, transactions);
  }

  if (transaction.category === "freeplay") {
    return getFreeplayTransactionImpact(transaction, transactions);
  }

  return 0;
}

export function calculateCashBalance(
  transactions: LedgerTransaction[],
  accountId: string
) {
  return transactions
    .filter(
      (transaction) =>
        transaction.accountId === accountId &&
        isWalletTransaction(transaction, "cash")
    )
    .reduce(
      (balance, transaction) =>
        balance + getWalletTransactionImpact(transaction, transactions),
      0
    );
}

export function calculateCreditBalance(
  transactions: LedgerTransaction[],
  accountId: string
) {
  return transactions
    .filter(
      (transaction) =>
        transaction.accountId === accountId &&
        isWalletTransaction(transaction, "credit")
    )
    .reduce(
      (balance, transaction) =>
        balance + getWalletTransactionImpact(transaction, transactions),
      0
    );
}

export function calculateFreeplayBalance(
  transactions: LedgerTransaction[],
  accountId: string
) {
  return transactions
    .filter(
      (transaction) =>
        transaction.accountId === accountId &&
        isWalletTransaction(transaction, "freeplay")
    )
    .reduce(
      (balance, transaction) =>
        transaction.category === "freeplay"
          ? balance + getWalletTransactionImpact(transaction, transactions)
          : balance,
      0
    );
}

export function getWalletForAccount({
  wallets,
  accountId,
  walletType,
}: {
  wallets: Wallet[];
  accountId: string;
  walletType: WalletType;
}) {
  return wallets.find(
    (wallet) =>
      wallet.accountId === accountId && wallet.walletType === walletType
  );
}

export function isWalletActive(wallet?: Wallet | null) {
  return Boolean(
    wallet && (wallet.status === "ACTIVE" || wallet.status === "active")
  );
}

export function calculateWalletBalanceSummary({
  accountId,
  wallets,
  transactions,
}: {
  accountId: string;
  wallets: Wallet[];
  transactions: LedgerTransaction[];
}): WalletBalanceSummary {
  const creditWallet = getWalletForAccount({
    wallets,
    accountId,
    walletType: "credit",
  });
  const creditBalance = calculateCreditBalance(transactions, accountId);

  return {
    accountId,
    cashBalance: calculateCashBalance(transactions, accountId),
    creditBalance,
    freeplayBalance: calculateFreeplayBalance(transactions, accountId),
    availableCredit: Number(creditWallet?.creditLimit || 0) + creditBalance,
  };
}
