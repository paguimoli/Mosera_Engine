import { supabaseServerAdmin } from "@/src/lib/supabase/server-admin-client";
import type {
  LedgerShadowFailure,
  LedgerShadowListFilters,
  LedgerShadowMismatch,
  LedgerShadowRun,
} from "./ledger-shadow.types";

type ShadowRunRow = {
  id: string;
  correlation_id?: string | null;
  transaction_id: string;
  account_id: string;
  wallet_id?: string | null;
  entry_type: string;
  comparison_status: "MATCH" | "MISMATCH" | "NOT_COMPARED";
  shadow_entry_type: string;
  monolith_entry_type?: string | null;
  shadow_amount_minor: string | number;
  monolith_amount_minor?: string | number | null;
  shadow_currency: string;
  monolith_currency?: string | null;
  shadow_account_id: string;
  monolith_account_id?: string | null;
  shadow_idempotency_key?: string | null;
  monolith_idempotency_key?: string | null;
  shadow_service_version?: string | null;
  created_at: string;
};

type ShadowMismatchRow = {
  id: string;
  shadow_run_id: string;
  mismatch_type:
    | "AMOUNT_MISMATCH"
    | "CURRENCY_MISMATCH"
    | "ENTRY_TYPE_MISMATCH"
    | "ACCOUNT_MISMATCH"
    | "IDEMPOTENCY_MISMATCH"
    | "UNKNOWN_MISMATCH";
  field_name: string;
  monolith_value?: string | null;
  shadow_value?: string | null;
  severity: "INFO" | "WARNING" | "CRITICAL";
  created_at: string;
  ledger_shadow_runs?: ShadowRunRow | null;
};

type ShadowFailureRow = {
  id: string;
  correlation_id?: string | null;
  transaction_id?: string | null;
  failure_reason: string;
  failure_type: string;
  metadata?: Record<string, unknown> | null;
  created_at: string;
};

const RUN_SELECT =
  "id, correlation_id, transaction_id, account_id, wallet_id, entry_type, comparison_status, shadow_entry_type, monolith_entry_type, shadow_amount_minor, monolith_amount_minor, shadow_currency, monolith_currency, shadow_account_id, monolith_account_id, shadow_idempotency_key, monolith_idempotency_key, shadow_service_version, created_at";
const MISMATCH_SELECT = `id, shadow_run_id, mismatch_type, field_name, monolith_value, shadow_value, severity, created_at, ledger_shadow_runs(${RUN_SELECT})`;
const FAILURE_SELECT =
  "id, correlation_id, transaction_id, failure_reason, failure_type, metadata, created_at";

export class LedgerShadowRepositoryError extends Error {
  constructor(message = "Ledger shadow reporting persistence operation failed.") {
    super(message);
    this.name = "LedgerShadowRepositoryError";
  }
}

function toNullableNumber(value: string | number | null | undefined) {
  if (value === null || value === undefined) return null;

  return Number(value);
}

function mapRun(row: ShadowRunRow | null): LedgerShadowRun | null {
  if (!row) return null;

  return {
    id: row.id,
    correlationId: row.correlation_id ?? null,
    transactionId: row.transaction_id,
    accountId: row.account_id,
    walletId: row.wallet_id ?? null,
    entryType: row.entry_type,
    comparisonStatus: row.comparison_status,
    shadowEntryType: row.shadow_entry_type,
    monolithEntryType: row.monolith_entry_type ?? null,
    shadowAmountMinor: Number(row.shadow_amount_minor),
    monolithAmountMinor: toNullableNumber(row.monolith_amount_minor),
    shadowCurrency: row.shadow_currency,
    monolithCurrency: row.monolith_currency ?? null,
    shadowAccountId: row.shadow_account_id,
    monolithAccountId: row.monolith_account_id ?? null,
    shadowIdempotencyKey: row.shadow_idempotency_key ?? null,
    monolithIdempotencyKey: row.monolith_idempotency_key ?? null,
    shadowServiceVersion: row.shadow_service_version ?? null,
    createdAt: row.created_at,
  };
}

function mapMismatch(row: ShadowMismatchRow): LedgerShadowMismatch {
  return {
    id: row.id,
    shadowRunId: row.shadow_run_id,
    mismatchType: row.mismatch_type,
    fieldName: row.field_name,
    monolithValue: row.monolith_value ?? null,
    shadowValue: row.shadow_value ?? null,
    severity: row.severity,
    createdAt: row.created_at,
    run: mapRun(row.ledger_shadow_runs ?? null),
  };
}

function mapFailure(row: ShadowFailureRow): LedgerShadowFailure {
  return {
    id: row.id,
    correlationId: row.correlation_id ?? null,
    transactionId: row.transaction_id ?? null,
    failureReason: row.failure_reason,
    failureType: row.failure_type,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}

function applyDateFilters<T>(query: T, filters: LedgerShadowListFilters): T {
  let nextQuery = query as {
    gte(column: string, value: string): typeof nextQuery;
    lte(column: string, value: string): typeof nextQuery;
  };

  if (filters.from) nextQuery = nextQuery.gte("created_at", filters.from);
  if (filters.to) nextQuery = nextQuery.lte("created_at", filters.to);

  return nextQuery as T;
}

export async function listShadowRuns(): Promise<LedgerShadowRun[]> {
  const { data, error } = await supabaseServerAdmin
    .from("ledger_shadow_runs")
    .select(RUN_SELECT)
    .order("created_at", { ascending: false });

  if (error) throw new LedgerShadowRepositoryError(error.message);

  return ((data ?? []) as ShadowRunRow[])
    .map(mapRun)
    .filter((run): run is LedgerShadowRun => Boolean(run));
}

export async function listShadowMismatches(
  filters: LedgerShadowListFilters = {}
): Promise<LedgerShadowMismatch[]> {
  let query = supabaseServerAdmin
    .from("ledger_shadow_mismatches")
    .select(MISMATCH_SELECT)
    .order("created_at", { ascending: false })
    .limit(filters.limit ?? 100);

  query = applyDateFilters(query, filters);

  if (filters.transactionId) {
    query = query.eq("ledger_shadow_runs.transaction_id", filters.transactionId);
  }
  if (filters.accountId) {
    query = query.eq("ledger_shadow_runs.account_id", filters.accountId);
  }

  const { data, error } = await query;

  if (error) throw new LedgerShadowRepositoryError(error.message);

  return ((data ?? []) as unknown as ShadowMismatchRow[]).map(mapMismatch);
}

export async function listShadowFailures(
  filters: LedgerShadowListFilters = {}
): Promise<LedgerShadowFailure[]> {
  let query = supabaseServerAdmin
    .from("ledger_shadow_failures")
    .select(FAILURE_SELECT)
    .order("created_at", { ascending: false })
    .limit(filters.limit ?? 100);

  query = applyDateFilters(query, filters);

  if (filters.transactionId) {
    query = query.eq("transaction_id", filters.transactionId);
  }

  const { data, error } = await query;

  if (error) throw new LedgerShadowRepositoryError(error.message);

  return ((data ?? []) as ShadowFailureRow[]).map(mapFailure);
}
