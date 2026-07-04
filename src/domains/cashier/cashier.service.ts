import { findAccountById } from "../accounts/account.repository";
import {
  findPersistedWalletByAccountAndType,
  findWalletById,
} from "../wallets/wallet.repository";
import type { Wallet } from "../wallets/wallet.types";
import {
  createCashierTransaction,
  completeCashierTransactionAtomically,
  findCashierTransactionById,
  listCashierTransactions as listCashierTransactionRecords,
  listCashierTransactionsForAccount as listCashierTransactionRecordsForAccount,
  CashierRepositoryError,
  updateCashierTransactionStatus,
} from "./cashier.repository";
import type {
  ApproveCashierTransactionInput,
  CancelCashierTransactionInput,
  CashierTransaction,
  CashierTransactionType,
  CompleteCashierTransactionInput,
  CreateCashierTransactionInput,
  RejectCashierTransactionInput,
} from "./cashier.types";
import {
  normalizeCreateCashierTransactionInput,
  validateCreateCashierTransactionInput,
} from "./cashier.validation";

export class CashierValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(errors.join(" "));
    this.name = "CashierValidationError";
    this.errors = errors;
  }
}

export class CashierBusinessRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CashierBusinessRuleError";
  }
}

function mergeMetadata(
  existing: Record<string, unknown>,
  next?: Record<string, unknown>
) {
  return next ? { ...existing, ...next } : existing;
}

async function resolveCashWallet({
  accountId,
  walletId,
}: {
  accountId: string;
  walletId?: string | null;
}): Promise<Wallet> {
  const wallet = walletId
    ? await findWalletById(walletId)
    : await findPersistedWalletByAccountAndType(accountId, "CASH");

  if (!wallet) {
    throw new CashierBusinessRuleError("Active CASH wallet not found.");
  }

  if (wallet.accountId !== accountId) {
    throw new CashierBusinessRuleError("Wallet does not belong to account.");
  }

  if (wallet.status !== "ACTIVE") {
    throw new CashierBusinessRuleError("Cashier wallet must be active.");
  }

  if (wallet.walletType !== "CASH") {
    throw new CashierBusinessRuleError(
      "Cashier transactions only support CASH wallets."
    );
  }

  if (wallet.balanceAuthority !== "INTERNAL") {
    throw new CashierBusinessRuleError(
      "Cashier transactions require INTERNAL balance authority."
    );
  }

  return wallet;
}

async function prepareCashierRequest(
  input: CreateCashierTransactionInput,
  expectedType: CashierTransactionType
) {
  const validation = validateCreateCashierTransactionInput(input);

  if (!validation.valid) {
    throw new CashierValidationError(validation.errors);
  }

  const normalized = normalizeCreateCashierTransactionInput(input);

  if (normalized.transactionType !== expectedType) {
    throw new CashierBusinessRuleError("Invalid cashier transaction type.");
  }

  const account = await findAccountById(normalized.accountId);

  if (!account) {
    throw new CashierBusinessRuleError("Account not found.");
  }

  if (account.status !== "ACTIVE") {
    throw new CashierBusinessRuleError("Account must be active.");
  }

  if ((account.balanceAuthority ?? "INTERNAL") !== "INTERNAL") {
    throw new CashierBusinessRuleError(
      "Cashier transactions require INTERNAL account balance authority."
    );
  }

  const wallet = await resolveCashWallet({
    accountId: account.id,
    walletId: normalized.walletId,
  });

  if (normalized.currencyCode !== (wallet.currencyCode ?? wallet.currency)) {
    throw new CashierBusinessRuleError(
      "Cashier transaction currency must match the CASH wallet."
    );
  }

  return {
    normalized,
    wallet,
  };
}

export async function requestDeposit(
  input: CreateCashierTransactionInput
): Promise<CashierTransaction> {
  const { normalized, wallet } = await prepareCashierRequest(input, "DEPOSIT");

  return createCashierTransaction({
    ...normalized,
    walletId: wallet.id,
  });
}

export async function requestWithdrawal(
  input: CreateCashierTransactionInput
): Promise<CashierTransaction> {
  const { normalized, wallet } = await prepareCashierRequest(
    input,
    "WITHDRAWAL"
  );

  if (normalized.amount > Number(wallet.balance ?? 0)) {
    throw new CashierBusinessRuleError(
      "Withdrawal amount exceeds CASH wallet balance."
    );
  }

  return createCashierTransaction({
    ...normalized,
    walletId: wallet.id,
  });
}

async function getExistingTransaction(
  transactionId: string
): Promise<CashierTransaction> {
  const transaction = await findCashierTransactionById(transactionId);

  if (!transaction) {
    throw new CashierBusinessRuleError("Cashier transaction not found.");
  }

  return transaction;
}

function assertStatus(
  transaction: CashierTransaction,
  expectedStatus: CashierTransaction["status"]
) {
  if (transaction.status !== expectedStatus) {
    throw new CashierBusinessRuleError(
      `Cashier transaction must be ${expectedStatus}.`
    );
  }
}

export async function approveCashierTransaction(
  input: ApproveCashierTransactionInput
): Promise<CashierTransaction> {
  const transaction = await getExistingTransaction(input.transactionId);

  assertStatus(transaction, "PENDING");

  return updateCashierTransactionStatus({
    transactionId: transaction.id,
    status: "APPROVED",
    approvedByUserId: input.approvedByUserId ?? null,
    reason: input.reason ?? transaction.reason ?? null,
    metadata: mergeMetadata(transaction.metadata, input.metadata),
    approvedAt: new Date().toISOString(),
  });
}

export async function rejectCashierTransaction(
  input: RejectCashierTransactionInput
): Promise<CashierTransaction> {
  const reason = input.reason.trim();

  if (!reason) {
    throw new CashierBusinessRuleError("Rejection reason is required.");
  }

  const transaction = await getExistingTransaction(input.transactionId);

  assertStatus(transaction, "PENDING");

  return updateCashierTransactionStatus({
    transactionId: transaction.id,
    status: "REJECTED",
    rejectedByUserId: input.rejectedByUserId ?? null,
    reason,
    metadata: mergeMetadata(transaction.metadata, input.metadata),
    rejectedAt: new Date().toISOString(),
  });
}

export async function cancelCashierTransaction(
  input: CancelCashierTransactionInput
): Promise<CashierTransaction> {
  const transaction = await getExistingTransaction(input.transactionId);

  assertStatus(transaction, "PENDING");

  return updateCashierTransactionStatus({
    transactionId: transaction.id,
    status: "CANCELLED",
    cancelledByUserId: input.cancelledByUserId ?? null,
    reason: input.reason?.trim() || transaction.reason || null,
    metadata: mergeMetadata(transaction.metadata, input.metadata),
    cancelledAt: new Date().toISOString(),
  });
}

function isCashierCompletionBusinessRuleMessage(message: string) {
  return [
    "Cashier transaction not found.",
    "Cashier transaction must be APPROVED.",
    "Cashier transaction wallet is required.",
    "Cashier transaction wallet not found.",
    "Cashier transaction wallet must be active.",
    "Cashier transaction wallet must use INTERNAL balance authority.",
    "Cashier transaction wallet must be CASH.",
    "Cashier transaction wallet account mismatch.",
    "Withdrawal amount exceeds CASH wallet balance.",
    "Ledger amount must be positive.",
    "Ledger transaction type is invalid.",
    "Ledger direction is invalid.",
    "Wallet not found.",
    "Wallet is not active.",
  ].some((expected) => message.includes(expected));
}

export async function completeCashierTransaction(
  input: CompleteCashierTransactionInput
): Promise<CashierTransaction> {
  try {
    return await completeCashierTransactionAtomically({
      transactionId: input.transactionId,
      actorUserId: input.actorUserId ?? null,
      metadata: input.metadata ?? {},
    });
  } catch (error) {
    if (
      error instanceof CashierRepositoryError &&
      isCashierCompletionBusinessRuleMessage(error.message)
    ) {
      throw new CashierBusinessRuleError(error.message);
    }

    throw error;
  }
}

export async function listCashierTransactions(): Promise<CashierTransaction[]> {
  return listCashierTransactionRecords();
}

export async function listCashierTransactionsForAccount(
  accountId: string
): Promise<CashierTransaction[]> {
  return listCashierTransactionRecordsForAccount(accountId);
}
