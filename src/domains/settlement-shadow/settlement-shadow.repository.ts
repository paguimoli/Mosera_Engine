import { supabaseServerAdmin } from "@/src/lib/supabase/server-admin-client";
import type {
  SettlementShadowFailure,
  SettlementShadowListFilters,
  SettlementShadowMismatch,
  SettlementShadowRun,
} from "./settlement-shadow.types";

type ShadowRunRow = {
  id: string;
  correlation_id?: string | null;
  settlement_run_id?: string | null;
  ticket_id: string;
  game_id?: string | null;
  drawing_id?: string | null;
  comparison_status: "MATCH" | "MISMATCH" | "NOT_COMPARED";
  shadow_outcome: string;
  monolith_outcome?: string | null;
  shadow_gross_payout: string | number;
  monolith_gross_payout?: string | number | null;
  shadow_net_amount: string | number;
  monolith_net_amount?: string | number | null;
  currency: string;
  shadow_service_version?: string | null;
  created_at: string;
};

type ShadowMismatchRow = {
  id: string;
  shadow_run_id: string;
  mismatch_type:
    | "OUTCOME_MISMATCH"
    | "PAYOUT_MISMATCH"
    | "NET_AMOUNT_MISMATCH"
    | "STAKE_MISMATCH"
    | "CURRENCY_MISMATCH"
    | "UNKNOWN_MISMATCH";
  field_name: string;
  monolith_value?: string | null;
  shadow_value?: string | null;
  severity: "INFO" | "WARNING" | "CRITICAL";
  created_at: string;
  settlement_shadow_runs?: ShadowRunRow | null;
};

type ShadowFailureRow = {
  id: string;
  correlation_id?: string | null;
  ticket_id?: string | null;
  failure_reason: string;
  failure_type: string;
  metadata?: Record<string, unknown> | null;
  created_at: string;
};

const RUN_SELECT =
  "id, correlation_id, settlement_run_id, ticket_id, game_id, drawing_id, comparison_status, shadow_outcome, monolith_outcome, shadow_gross_payout, monolith_gross_payout, shadow_net_amount, monolith_net_amount, currency, shadow_service_version, created_at";
const MISMATCH_SELECT = `id, shadow_run_id, mismatch_type, field_name, monolith_value, shadow_value, severity, created_at, settlement_shadow_runs(${RUN_SELECT})`;
const FAILURE_SELECT =
  "id, correlation_id, ticket_id, failure_reason, failure_type, metadata, created_at";

export class SettlementShadowRepositoryError extends Error {
  constructor(message = "Settlement shadow reporting persistence operation failed.") {
    super(message);
    this.name = "SettlementShadowRepositoryError";
  }
}

function mapRun(row: ShadowRunRow | null): SettlementShadowRun | null {
  if (!row) return null;

  return {
    id: row.id,
    correlationId: row.correlation_id ?? null,
    settlementRunId: row.settlement_run_id ?? null,
    ticketId: row.ticket_id,
    gameId: row.game_id ?? null,
    drawingId: row.drawing_id ?? null,
    comparisonStatus: row.comparison_status,
    shadowOutcome: row.shadow_outcome,
    monolithOutcome: row.monolith_outcome ?? null,
    shadowGrossPayout: Number(row.shadow_gross_payout),
    monolithGrossPayout:
      row.monolith_gross_payout === null || row.monolith_gross_payout === undefined
        ? null
        : Number(row.monolith_gross_payout),
    shadowNetAmount: Number(row.shadow_net_amount),
    monolithNetAmount:
      row.monolith_net_amount === null || row.monolith_net_amount === undefined
        ? null
        : Number(row.monolith_net_amount),
    currency: row.currency,
    shadowServiceVersion: row.shadow_service_version ?? null,
    createdAt: row.created_at,
  };
}

function mapMismatch(row: ShadowMismatchRow): SettlementShadowMismatch {
  return {
    id: row.id,
    shadowRunId: row.shadow_run_id,
    mismatchType: row.mismatch_type,
    fieldName: row.field_name,
    monolithValue: row.monolith_value ?? null,
    shadowValue: row.shadow_value ?? null,
    severity: row.severity,
    createdAt: row.created_at,
    run: mapRun(row.settlement_shadow_runs ?? null),
  };
}

function mapFailure(row: ShadowFailureRow): SettlementShadowFailure {
  return {
    id: row.id,
    correlationId: row.correlation_id ?? null,
    ticketId: row.ticket_id ?? null,
    failureReason: row.failure_reason,
    failureType: row.failure_type,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}

function applyDateFilters<T>(
  query: T,
  filters: SettlementShadowListFilters
): T {
  let nextQuery = query as {
    gte(column: string, value: string): typeof nextQuery;
    lte(column: string, value: string): typeof nextQuery;
  };

  if (filters.from) nextQuery = nextQuery.gte("created_at", filters.from);
  if (filters.to) nextQuery = nextQuery.lte("created_at", filters.to);

  return nextQuery as T;
}

export async function listShadowRuns(): Promise<SettlementShadowRun[]> {
  const { data, error } = await supabaseServerAdmin
    .from("settlement_shadow_runs")
    .select(RUN_SELECT)
    .order("created_at", { ascending: false });

  if (error) throw new SettlementShadowRepositoryError(error.message);

  return ((data ?? []) as ShadowRunRow[])
    .map(mapRun)
    .filter((run): run is SettlementShadowRun => Boolean(run));
}

export async function listShadowMismatches(
  filters: SettlementShadowListFilters = {}
): Promise<SettlementShadowMismatch[]> {
  let query = supabaseServerAdmin
    .from("settlement_shadow_mismatches")
    .select(MISMATCH_SELECT)
    .order("created_at", { ascending: false })
    .limit(filters.limit ?? 100);

  query = applyDateFilters(query, filters);

  if (filters.ticketId) {
    query = query.eq("settlement_shadow_runs.ticket_id", filters.ticketId);
  }
  if (filters.gameId) {
    query = query.eq("settlement_shadow_runs.game_id", filters.gameId);
  }

  const { data, error } = await query;

  if (error) throw new SettlementShadowRepositoryError(error.message);

  return ((data ?? []) as unknown as ShadowMismatchRow[]).map(mapMismatch);
}

export async function listShadowFailures(
  filters: SettlementShadowListFilters = {}
): Promise<SettlementShadowFailure[]> {
  let query = supabaseServerAdmin
    .from("settlement_shadow_failures")
    .select(FAILURE_SELECT)
    .order("created_at", { ascending: false })
    .limit(filters.limit ?? 100);

  query = applyDateFilters(query, filters);

  if (filters.ticketId) {
    query = query.eq("ticket_id", filters.ticketId);
  }

  const { data, error } = await query;

  if (error) throw new SettlementShadowRepositoryError(error.message);

  return ((data ?? []) as ShadowFailureRow[]).map(mapFailure);
}
