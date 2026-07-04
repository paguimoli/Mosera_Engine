import { supabaseServerAdmin } from "@/src/lib/supabase/server-admin-client";
import type {
  CashierTransaction,
  CashierTransactionStatus,
  CashierTransactionType,
  CompleteCashierTransactionInput,
  CreateCashierTransactionInput,
  UpdateCashierTransactionStatusInput,
} from "./cashier.types";
import { normalizeCreateCashierTransactionInput } from "./cashier.validation";

type CashierTransactionRow = {
  id: string;
  account_id: string;
  wallet_id?: string | null;
  transaction_type: CashierTransactionType;
  status: CashierTransactionStatus;
  amount: string | number;
  currency_code: string;
  payment_method?: string | null;
  provider?: string | null;
  provider_reference?: string | null;
  requested_by_user_id?: string | null;
  approved_by_user_id?: string | null;
  rejected_by_user_id?: string | null;
  cancelled_by_user_id?: string | null;
  ledger_entry_id?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
  requested_at: string;
  approved_at?: string | null;
  rejected_at?: string | null;
  cancelled_at?: string | null;
  completed_at?: string | null;
  created_at: string;
  updated_at?: string | null;
};

const CASHIER_TRANSACTION_SELECT =
  "id, account_id, wallet_id, transaction_type, status, amount, currency_code, payment_method, provider, provider_reference, requested_by_user_id, approved_by_user_id, rejected_by_user_id, cancelled_by_user_id, ledger_entry_id, reason, metadata, requested_at, approved_at, rejected_at, cancelled_at, completed_at, created_at, updated_at";

export class CashierRepositoryError extends Error {
  constructor(message = "Cashier persistence operation failed.") {
    super(message);
    this.name = "CashierRepositoryError";
  }
}

function mapCashierTransactionRow(
  row: CashierTransactionRow | null
): CashierTransaction | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    accountId: row.account_id,
    walletId: row.wallet_id ?? null,
    transactionType: row.transaction_type,
    status: row.status,
    amount: Number(row.amount),
    currencyCode: row.currency_code,
    paymentMethod: row.payment_method ?? null,
    provider: row.provider ?? null,
    providerReference: row.provider_reference ?? null,
    requestedByUserId: row.requested_by_user_id ?? null,
    approvedByUserId: row.approved_by_user_id ?? null,
    rejectedByUserId: row.rejected_by_user_id ?? null,
    cancelledByUserId: row.cancelled_by_user_id ?? null,
    ledgerEntryId: row.ledger_entry_id ?? null,
    reason: row.reason ?? null,
    metadata: row.metadata ?? {},
    requestedAt: row.requested_at,
    approvedAt: row.approved_at ?? null,
    rejectedAt: row.rejected_at ?? null,
    cancelledAt: row.cancelled_at ?? null,
    completedAt: row.completed_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? null,
  };
}

export async function createCashierTransaction(
  input: CreateCashierTransactionInput
): Promise<CashierTransaction> {
  const normalized = normalizeCreateCashierTransactionInput(input);
  const { data, error } = await supabaseServerAdmin
    .from("cashier_transactions")
    .insert({
      account_id: normalized.accountId,
      wallet_id: normalized.walletId ?? null,
      transaction_type: normalized.transactionType,
      status: "PENDING",
      amount: normalized.amount,
      currency_code: normalized.currencyCode,
      payment_method: normalized.paymentMethod ?? null,
      provider: normalized.provider ?? null,
      provider_reference: normalized.providerReference ?? null,
      requested_by_user_id: normalized.requestedByUserId ?? null,
      reason: normalized.reason ?? null,
      metadata: normalized.metadata ?? {},
    })
    .select(CASHIER_TRANSACTION_SELECT)
    .single();

  if (error) {
    throw new CashierRepositoryError();
  }

  const transaction = mapCashierTransactionRow(
    data as CashierTransactionRow | null
  );

  if (!transaction) {
    throw new CashierRepositoryError();
  }

  return transaction;
}

export async function findCashierTransactionById(
  id: string
): Promise<CashierTransaction | null> {
  const { data, error } = await supabaseServerAdmin
    .from("cashier_transactions")
    .select(CASHIER_TRANSACTION_SELECT)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new CashierRepositoryError();
  }

  return mapCashierTransactionRow(data as CashierTransactionRow | null);
}

export async function listCashierTransactions(): Promise<CashierTransaction[]> {
  const { data, error } = await supabaseServerAdmin
    .from("cashier_transactions")
    .select(CASHIER_TRANSACTION_SELECT)
    .order("requested_at", { ascending: false });

  if (error) {
    throw new CashierRepositoryError();
  }

  return ((data ?? []) as CashierTransactionRow[])
    .map(mapCashierTransactionRow)
    .filter(
      (transaction): transaction is CashierTransaction => Boolean(transaction)
    );
}

export async function listCashierTransactionsForAccount(
  accountId: string
): Promise<CashierTransaction[]> {
  const { data, error } = await supabaseServerAdmin
    .from("cashier_transactions")
    .select(CASHIER_TRANSACTION_SELECT)
    .eq("account_id", accountId)
    .order("requested_at", { ascending: false });

  if (error) {
    throw new CashierRepositoryError();
  }

  return ((data ?? []) as CashierTransactionRow[])
    .map(mapCashierTransactionRow)
    .filter(
      (transaction): transaction is CashierTransaction => Boolean(transaction)
    );
}

export async function updateCashierTransactionStatus(
  input: UpdateCashierTransactionStatusInput
): Promise<CashierTransaction> {
  const updatePayload: Record<
    string,
    string | Record<string, unknown> | null
  > = {
    status: input.status,
  };

  if (input.approvedByUserId !== undefined) {
    updatePayload.approved_by_user_id = input.approvedByUserId ?? null;
  }
  if (input.rejectedByUserId !== undefined) {
    updatePayload.rejected_by_user_id = input.rejectedByUserId ?? null;
  }
  if (input.cancelledByUserId !== undefined) {
    updatePayload.cancelled_by_user_id = input.cancelledByUserId ?? null;
  }
  if (input.ledgerEntryId !== undefined) {
    updatePayload.ledger_entry_id = input.ledgerEntryId ?? null;
  }
  if (input.reason !== undefined) {
    updatePayload.reason = input.reason ?? null;
  }
  if (input.metadata !== undefined) {
    updatePayload.metadata = input.metadata;
  }
  if (input.approvedAt !== undefined) {
    updatePayload.approved_at = input.approvedAt ?? null;
  }
  if (input.rejectedAt !== undefined) {
    updatePayload.rejected_at = input.rejectedAt ?? null;
  }
  if (input.cancelledAt !== undefined) {
    updatePayload.cancelled_at = input.cancelledAt ?? null;
  }
  if (input.completedAt !== undefined) {
    updatePayload.completed_at = input.completedAt ?? null;
  }

  const { data, error } = await supabaseServerAdmin
    .from("cashier_transactions")
    .update(updatePayload)
    .eq("id", input.transactionId)
    .select(CASHIER_TRANSACTION_SELECT)
    .single();

  if (error) {
    throw new CashierRepositoryError();
  }

  const transaction = mapCashierTransactionRow(
    data as CashierTransactionRow | null
  );

  if (!transaction) {
    throw new CashierRepositoryError();
  }

  return transaction;
}

export async function completeCashierTransactionAtomically(
  input: CompleteCashierTransactionInput
): Promise<CashierTransaction> {
  const { data, error } = await supabaseServerAdmin
    .rpc("complete_cashier_transaction_atomically", {
      p_transaction_id: input.transactionId,
      p_actor_user_id: input.actorUserId ?? null,
      p_metadata: input.metadata ?? {},
    })
    .single();

  if (error) {
    throw new CashierRepositoryError(error.message);
  }

  const transaction = mapCashierTransactionRow(
    data as CashierTransactionRow | null
  );

  if (!transaction) {
    throw new CashierRepositoryError();
  }

  return transaction;
}
