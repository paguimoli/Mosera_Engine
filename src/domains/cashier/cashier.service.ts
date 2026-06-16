import { createCorrelationId } from "@/src/lib/observability/correlation";
import { logger } from "@/src/lib/observability/logger";
import { findAccountById } from "../accounts/account.repository";
import { postLedgerEntry } from "../ledger/ledger.service";
import type { LedgerTransactionType } from "../ledger/ledger.types";
import { createOutboxEvent } from "../outbox/outbox.service";
import {
  findPersistedWalletByAccountAndType,
  findWalletById,
} from "../wallets/wallet.repository";
import type { Wallet } from "../wallets/wallet.types";
import {
  createCashierTransaction,
  findCashierTransactionById,
  listCashierTransactions as listCashierTransactionRecords,
  listCashierTransactionsForAccount as listCashierTransactionRecordsForAccount,
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

function getCompletionLedgerConfig(transactionType: CashierTransactionType): {
  transactionType: LedgerTransactionType;
  direction: "CREDIT" | "DEBIT";
} {
  if (transactionType === "DEPOSIT") {
    return {
      transactionType: "DEPOSIT",
      direction: "CREDIT",
    };
  }

  return {
    transactionType: "WITHDRAWAL",
    direction: "DEBIT",
  };
}

export async function completeCashierTransaction(
  input: CompleteCashierTransactionInput
): Promise<CashierTransaction> {
  const transaction = await getExistingTransaction(input.transactionId);

  assertStatus(transaction, "APPROVED");

  if (!transaction.walletId) {
    throw new CashierBusinessRuleError("Cashier transaction wallet is required.");
  }

  const wallet = await resolveCashWallet({
    accountId: transaction.accountId,
    walletId: transaction.walletId,
  });

  if (
    transaction.transactionType === "WITHDRAWAL" &&
    transaction.amount > Number(wallet.balance ?? 0)
  ) {
    throw new CashierBusinessRuleError(
      "Withdrawal amount exceeds CASH wallet balance."
    );
  }

  const ledgerConfig = getCompletionLedgerConfig(transaction.transactionType);
  const ledgerEntry = await postLedgerEntry({
    walletId: wallet.id,
    transactionType: ledgerConfig.transactionType,
    direction: ledgerConfig.direction,
    amount: transaction.amount,
    reference: {
      referenceType: "cashier_transaction",
      referenceId: transaction.id,
    },
    idempotencyKey: `cashier:${transaction.id}:completion`,
    metadata: {
      cashierTransactionId: transaction.id,
      cashierTransactionType: transaction.transactionType,
      actorUserId: input.actorUserId ?? null,
    },
  });

  // Production hardening: cashier status update and ledger posting should move
  // into a single Postgres RPC/database transaction before live cashier traffic.
  const completedTransaction = await updateCashierTransactionStatus({
    transactionId: transaction.id,
    status: "COMPLETED",
    ledgerEntryId: ledgerEntry.id,
    metadata: mergeMetadata(transaction.metadata, input.metadata),
    completedAt: new Date().toISOString(),
  });

  const correlationId = createCorrelationId();

  try {
    await createOutboxEvent({
      eventType: "cashier.transaction.completed",
      aggregateType: "cashier_transaction",
      aggregateId: completedTransaction.id,
      correlationId,
      payload: {
        transactionId: completedTransaction.id,
        accountId: completedTransaction.accountId,
        walletId: completedTransaction.walletId,
        transactionType: completedTransaction.transactionType,
        amount: completedTransaction.amount,
        currency: completedTransaction.currencyCode,
        ledgerEntryId: completedTransaction.ledgerEntryId,
      },
    });
  } catch (error) {
    logger.warn({
      message: "Cashier transaction completed without outbox event.",
      correlationId,
      metadata: {
        transactionId: completedTransaction.id,
        error: error instanceof Error ? error.message : "Unknown error",
      },
    });
  }

  return completedTransaction;
}

export async function listCashierTransactions(): Promise<CashierTransaction[]> {
  return listCashierTransactionRecords();
}

export async function listCashierTransactionsForAccount(
  accountId: string
): Promise<CashierTransaction[]> {
  return listCashierTransactionRecordsForAccount(accountId);
}
