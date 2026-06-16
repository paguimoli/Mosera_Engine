import { supabaseServerAdmin } from "@/src/lib/supabase/server-admin-client";
import type {
  CreateLedgerEntryInput,
  LedgerDirection,
  LedgerEntry,
  LedgerTransaction,
  LedgerTransactionType,
} from "./ledger.types";

type LedgerEntryRow = {
  id: string;
  wallet_id: string;
  account_id: string;
  transaction_type: LedgerTransactionType;
  direction: LedgerDirection;
  amount: string | number;
  balance_after: string | number;
  currency_code: string;
  reference_type?: string | null;
  reference_id?: string | null;
  idempotency_key?: string | null;
  reversal_of_ledger_entry_id?: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

const LEDGER_ENTRY_SELECT =
  "id, wallet_id, account_id, transaction_type, direction, amount, balance_after, currency_code, reference_type, reference_id, idempotency_key, reversal_of_ledger_entry_id, metadata, created_at";
const FINANCIAL_LEDGER_ENTRIES_TABLE = "financial_ledger_entries";

export class LedgerRepositoryError extends Error {
  constructor(message = "Ledger persistence operation failed.") {
    super(message);
    this.name = "LedgerRepositoryError";
  }
}

function mapLedgerEntryRow(row: LedgerEntryRow | null): LedgerEntry | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    walletId: row.wallet_id,
    accountId: row.account_id,
    transactionType: row.transaction_type,
    direction: row.direction,
    amount: Number(row.amount),
    balanceAfter: Number(row.balance_after),
    currencyCode: row.currency_code,
    referenceType: row.reference_type ?? null,
    referenceId: row.reference_id ?? null,
    idempotencyKey: row.idempotency_key ?? null,
    reversalOfLedgerEntryId: row.reversal_of_ledger_entry_id ?? null,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}

export async function insertLedgerEntry({
  input,
}: {
  input: CreateLedgerEntryInput;
}): Promise<LedgerEntry> {
  const { data, error } = await supabaseServerAdmin
    .rpc("post_financial_ledger_entry", {
      p_wallet_id: input.walletId,
      p_transaction_type: input.transactionType,
      p_direction: input.direction,
      p_amount: input.amount,
      p_reference_type: input.reference?.referenceType ?? null,
      p_reference_id: input.reference?.referenceId ?? null,
      p_idempotency_key: input.idempotencyKey ?? null,
      p_metadata: input.metadata ?? {},
      p_reversal_of_ledger_entry_id: input.reversalOfLedgerEntryId ?? null,
    })
    .single();

  if (error) {
    throw new LedgerRepositoryError(error.message);
  }

  const ledgerEntry = mapLedgerEntryRow(data as LedgerEntryRow | null);

  if (!ledgerEntry) {
    throw new LedgerRepositoryError();
  }

  return ledgerEntry;
}

export async function findLedgerEntryById(
  ledgerEntryId: string
): Promise<LedgerEntry | null> {
  const { data, error } = await supabaseServerAdmin
    .from(FINANCIAL_LEDGER_ENTRIES_TABLE)
    .select(LEDGER_ENTRY_SELECT)
    .eq("id", ledgerEntryId)
    .maybeSingle();

  if (error) {
    throw new LedgerRepositoryError();
  }

  return mapLedgerEntryRow(data as LedgerEntryRow | null);
}

export async function findLedgerEntryByIdempotencyKey(
  idempotencyKey: string
): Promise<LedgerEntry | null> {
  const { data, error } = await supabaseServerAdmin
    .from(FINANCIAL_LEDGER_ENTRIES_TABLE)
    .select(LEDGER_ENTRY_SELECT)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  if (error) {
    throw new LedgerRepositoryError();
  }

  return mapLedgerEntryRow(data as LedgerEntryRow | null);
}

export async function listLedgerEntriesForWallet(
  walletId: string
): Promise<LedgerEntry[]> {
  const { data, error } = await supabaseServerAdmin
    .from(FINANCIAL_LEDGER_ENTRIES_TABLE)
    .select(LEDGER_ENTRY_SELECT)
    .eq("wallet_id", walletId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new LedgerRepositoryError();
  }

  return ((data ?? []) as LedgerEntryRow[])
    .map(mapLedgerEntryRow)
    .filter((ledgerEntry): ledgerEntry is LedgerEntry => Boolean(ledgerEntry));
}

export async function listLedgerEntriesForAccount(
  accountId: string
): Promise<LedgerEntry[]> {
  const { data, error } = await supabaseServerAdmin
    .from(FINANCIAL_LEDGER_ENTRIES_TABLE)
    .select(LEDGER_ENTRY_SELECT)
    .eq("account_id", accountId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new LedgerRepositoryError();
  }

  return ((data ?? []) as LedgerEntryRow[])
    .map(mapLedgerEntryRow)
    .filter((ledgerEntry): ledgerEntry is LedgerEntry => Boolean(ledgerEntry));
}

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

export function saveLedgerTransactions(
  transactions: LedgerTransaction[],
  newTransactions: LedgerTransaction[]
) {
  return [...transactions, ...newTransactions];
}
