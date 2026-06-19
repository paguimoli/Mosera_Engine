import type { PlayerAccount } from "../accounts/account.types";
import {
  getAccountingTransactionImpact,
  getFreeplayTransactionImpact,
  getOperationalTransactionImpact,
} from "./ledger.helpers";
import {
  findLedgerEntryById,
  insertLedgerEntry,
  LedgerRepositoryError,
  listLedgerEntriesForAccount as listPersistedLedgerEntriesForAccount,
  listLedgerEntriesForWallet as listPersistedLedgerEntriesForWallet,
} from "./ledger.repository";
import type {
  AccountFinancialSummary,
  CreateLedgerEntryInput,
  LedgerDirection,
  LedgerEntry,
  LedgerTransaction,
} from "./ledger.types";
import { runLedgerShadowComparison } from "./ledger-shadow-client";
import { validateCreateLedgerEntryInput } from "./ledger.validation";

export class LedgerValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(errors.join(" "));
    this.name = "LedgerValidationError";
    this.errors = errors;
  }
}

export class LedgerBusinessRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerBusinessRuleError";
  }
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

function getOppositeDirection(direction: LedgerDirection): LedgerDirection {
  return direction === "CREDIT" ? "DEBIT" : "CREDIT";
}

function isFinancialPostingBusinessRuleError(error: LedgerRepositoryError) {
  return [
    "Ledger amount must be positive.",
    "Ledger direction is invalid.",
    "Wallet not found.",
    "Wallet is not active.",
  ].some((message) => error.message.includes(message));
}

export async function postLedgerEntry(
  input: CreateLedgerEntryInput
): Promise<LedgerEntry> {
  const validation = validateCreateLedgerEntryInput(input);

  if (!validation.valid) {
    throw new LedgerValidationError(validation.errors);
  }

  try {
    const ledgerEntry = await insertLedgerEntry({ input });

    await runLedgerShadowComparison({ input, ledgerEntry });

    return ledgerEntry;
  } catch (error) {
    if (
      error instanceof LedgerRepositoryError &&
      isFinancialPostingBusinessRuleError(error)
    ) {
      throw new LedgerBusinessRuleError(error.message);
    }

    throw error;
  }
}

export async function reverseLedgerEntry({
  ledgerEntryId,
  reason,
  actorUserId,
}: {
  ledgerEntryId: string;
  reason: string;
  actorUserId?: string | null;
}): Promise<LedgerEntry> {
  const originalEntry = await findLedgerEntryById(ledgerEntryId);

  if (!originalEntry) {
    throw new LedgerBusinessRuleError("Ledger entry not found.");
  }

  return postLedgerEntry({
    walletId: originalEntry.walletId,
    transactionType: "REVERSAL",
    direction: getOppositeDirection(originalEntry.direction),
    amount: originalEntry.amount,
    reference: {
      referenceType: "ledger_entry",
      referenceId: originalEntry.id,
    },
    reversalOfLedgerEntryId: originalEntry.id,
    metadata: {
      reason,
      actorUserId: actorUserId ?? null,
      reversedTransactionType: originalEntry.transactionType,
    },
  });
}

export async function getLedgerTransaction(
  ledgerEntryId: string
): Promise<LedgerEntry | null> {
  if (!ledgerEntryId) {
    throw new LedgerValidationError(["Ledger entry id is required."]);
  }

  return findLedgerEntryById(ledgerEntryId);
}

export async function listLedgerEntriesForWallet(
  walletId: string
): Promise<LedgerEntry[]> {
  return listPersistedLedgerEntriesForWallet(walletId);
}

export async function listLedgerEntriesForAccount(
  accountId: string
): Promise<LedgerEntry[]> {
  return listPersistedLedgerEntriesForAccount(accountId);
}
