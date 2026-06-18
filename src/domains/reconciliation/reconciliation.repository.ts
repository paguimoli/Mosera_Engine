import { supabaseServerAdmin } from "@/src/lib/supabase/server-admin-client";
import type {
  CreateReconciliationFindingInput,
  ListReconciliationFindingsInput,
  ReconciliationFinding,
  ReconciliationRun,
  ReconciliationFindingReviewStatus,
  ReconciliationRunReviewStatus,
  ReconciliationRunStatus,
  ReconciliationRunType,
  ReconciliationScopeType,
  ReconciliationSeverity,
  RunReconciliationInput,
} from "./reconciliation.types";

export type CreditReservationSourceRow = {
  id: string;
  player_id: string;
  ticket_id: string;
  currency: string;
  status: string;
  reserved_amount: string | number;
  released_amount: string | number;
  remaining_exposure: string | number;
};

export type CreditSettlementApplicationSourceRow = {
  id: string;
  reservation_id: string;
  player_id: string;
  ticket_id: string;
  settlement_id: string;
  balance_impact: string | number;
  currency: string;
  created_at: string;
};

export type TicketSourceRow = {
  id: string;
  status?: string | null;
  total_amount?: string | number | null;
  currency?: string | null;
  credit_reservation_id?: string | null;
};

export type WeeklyAccountingSnapshotSourceRow = {
  id: string;
  account_id: string;
  account_type: string;
  week_start: string;
  week_end: string;
  currency: string;
  net_result: string | number;
};

export type CommissionRunDetailSourceRow = {
  id: string;
  run_id: string;
  account_id: string;
  snapshot_id: string;
  net_result: string | number;
  commission_percentage_basis_points: number;
  commission_amount: string | number;
};

type ReconciliationRunRow = {
  id: string;
  run_type: ReconciliationRunType;
  scope_type: ReconciliationScopeType;
  scope_id?: string | null;
  week_start?: string | null;
  week_end?: string | null;
  currency?: string | null;
  status: ReconciliationRunStatus;
  total_checks: number;
  passed_checks: number;
  failed_checks: number;
  warning_checks: number;
  review_status?: ReconciliationRunReviewStatus | null;
  reviewed_by_user_id?: string | null;
  reviewed_at?: string | null;
  severity_summary?: Record<string, unknown> | null;
  correlation_id?: string | null;
  created_at: string;
  completed_at?: string | null;
};

type ReconciliationFindingRow = {
  id: string;
  run_id: string;
  severity: ReconciliationSeverity;
  check_code: string;
  entity_type: string;
  entity_id: string;
  expected_amount?: string | number | null;
  actual_amount?: string | number | null;
  currency?: string | null;
  message: string;
  metadata?: Record<string, unknown> | null;
  review_status?: ReconciliationFindingReviewStatus | null;
  assigned_operator_user_id?: string | null;
  reviewed_at?: string | null;
  acknowledged_by_user_id?: string | null;
  acknowledged_at?: string | null;
  resolved_by_user_id?: string | null;
  resolved_at?: string | null;
  resolution_notes?: string | null;
  created_at: string;
};

const RUN_SELECT =
  "id, run_type, scope_type, scope_id, week_start, week_end, currency, status, total_checks, passed_checks, failed_checks, warning_checks, review_status, reviewed_by_user_id, reviewed_at, severity_summary, correlation_id, created_at, completed_at";
const FINDING_SELECT =
  "id, run_id, severity, check_code, entity_type, entity_id, expected_amount, actual_amount, currency, message, metadata, review_status, assigned_operator_user_id, reviewed_at, acknowledged_by_user_id, acknowledged_at, resolved_by_user_id, resolved_at, resolution_notes, created_at";

export class ReconciliationRepositoryError extends Error {
  constructor(message = "Reconciliation persistence operation failed.") {
    super(message);
    this.name = "ReconciliationRepositoryError";
  }
}

function mapRunRow(row: ReconciliationRunRow | null): ReconciliationRun | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    runType: row.run_type,
    scopeType: row.scope_type,
    scopeId: row.scope_id ?? null,
    weekStart: row.week_start ?? null,
    weekEnd: row.week_end ?? null,
    currency: row.currency ?? null,
    status: row.status,
    totalChecks: row.total_checks,
    passedChecks: row.passed_checks,
    failedChecks: row.failed_checks,
    warningChecks: row.warning_checks,
    reviewStatus: row.review_status ?? "PENDING",
    reviewedByUserId: row.reviewed_by_user_id ?? null,
    reviewedAt: row.reviewed_at ?? null,
    severitySummary: row.severity_summary ?? {},
    correlationId: row.correlation_id ?? null,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? null,
  };
}

function mapFindingRow(
  row: ReconciliationFindingRow | null
): ReconciliationFinding | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    runId: row.run_id,
    severity: row.severity,
    checkCode: row.check_code,
    entityType: row.entity_type,
    entityId: row.entity_id,
    expectedAmount:
      row.expected_amount === null || row.expected_amount === undefined
        ? null
        : Number(row.expected_amount),
    actualAmount:
      row.actual_amount === null || row.actual_amount === undefined
        ? null
        : Number(row.actual_amount),
    currency: row.currency ?? null,
    message: row.message,
    metadata: row.metadata ?? {},
    reviewStatus: row.review_status ?? "OPEN",
    assignedOperatorUserId: row.assigned_operator_user_id ?? null,
    reviewedAt: row.reviewed_at ?? null,
    acknowledgedByUserId: row.acknowledged_by_user_id ?? null,
    acknowledgedAt: row.acknowledged_at ?? null,
    resolvedByUserId: row.resolved_by_user_id ?? null,
    resolvedAt: row.resolved_at ?? null,
    resolutionNotes: row.resolution_notes ?? null,
    createdAt: row.created_at,
  };
}

function isMissingRelationError(error: { code?: string; message?: string }) {
  return (
    error.code === "42P01" ||
    error.code === "42703" ||
    error.message?.includes("does not exist") ||
    error.message?.includes("column")
  );
}

export async function createReconciliationRun(
  input: RunReconciliationInput
): Promise<ReconciliationRun> {
  const { data, error } = await supabaseServerAdmin
    .from("reconciliation_runs")
    .insert({
      run_type: input.runType,
      scope_type: input.scopeType,
      scope_id: input.scopeId ?? null,
      week_start: input.weekStart ?? null,
      week_end: input.weekEnd ?? null,
      currency: input.currency ?? null,
      status: "STARTED",
      correlation_id: input.correlationId ?? null,
    })
    .select(RUN_SELECT)
    .single();

  if (error) {
    throw new ReconciliationRepositoryError(error.message);
  }

  const run = mapRunRow(data as ReconciliationRunRow | null);

  if (!run) {
    throw new ReconciliationRepositoryError();
  }

  return run;
}

export async function completeReconciliationRun({
  runId,
  status,
  findings,
}: {
  runId: string;
  status: ReconciliationRunStatus;
  findings: CreateReconciliationFindingInput[];
}): Promise<ReconciliationRun> {
  const passedChecks = findings.filter(
    (finding) => finding.severity === "PASS"
  ).length;
  const failedChecks = findings.filter(
    (finding) => finding.severity === "FAIL"
  ).length;
  const warningChecks = findings.filter(
    (finding) => finding.severity === "WARNING"
  ).length;

  const { data, error } = await supabaseServerAdmin
    .from("reconciliation_runs")
    .update({
      status,
      total_checks: findings.length,
      passed_checks: passedChecks,
      failed_checks: failedChecks,
      warning_checks: warningChecks,
      review_status:
        failedChecks > 0 || warningChecks > 0 ? "REQUIRES_ATTENTION" : "PENDING",
      severity_summary: {
        pass: passedChecks,
        warning: warningChecks,
        fail: failedChecks,
      },
      completed_at: new Date().toISOString(),
    })
    .eq("id", runId)
    .select(RUN_SELECT)
    .single();

  if (error) {
    throw new ReconciliationRepositoryError(error.message);
  }

  const run = mapRunRow(data as ReconciliationRunRow | null);

  if (!run) {
    throw new ReconciliationRepositoryError();
  }

  return run;
}

export async function createReconciliationFindings(
  runId: string,
  findings: CreateReconciliationFindingInput[]
): Promise<ReconciliationFinding[]> {
  if (findings.length === 0) {
    return [];
  }

  const { data, error } = await supabaseServerAdmin
    .from("reconciliation_run_findings")
    .insert(
      findings.map((finding) => ({
        run_id: runId,
        severity: finding.severity,
        check_code: finding.checkCode,
        entity_type: finding.entityType,
        entity_id: finding.entityId,
        expected_amount: finding.expectedAmount ?? null,
        actual_amount: finding.actualAmount ?? null,
        currency: finding.currency ?? null,
        message: finding.message,
        metadata: finding.metadata ?? {},
      }))
    )
    .select(FINDING_SELECT);

  if (error) {
    throw new ReconciliationRepositoryError(error.message);
  }

  return ((data ?? []) as ReconciliationFindingRow[])
    .map(mapFindingRow)
    .filter((finding): finding is ReconciliationFinding => Boolean(finding));
}

export async function findReconciliationRunById(
  runId: string
): Promise<ReconciliationRun | null> {
  const { data, error } = await supabaseServerAdmin
    .from("reconciliation_runs")
    .select(RUN_SELECT)
    .eq("id", runId)
    .maybeSingle();

  if (error) {
    throw new ReconciliationRepositoryError(error.message);
  }

  return mapRunRow(data as ReconciliationRunRow | null);
}

export async function listReconciliationFindings(
  input: ListReconciliationFindingsInput
): Promise<ReconciliationFinding[]> {
  let query = supabaseServerAdmin
    .from("reconciliation_run_findings")
    .select(FINDING_SELECT)
    .order("created_at", { ascending: false })
    .limit(input.limit ?? 100);

  if (input.runId) query = query.eq("run_id", input.runId);
  if (input.severity) query = query.eq("severity", input.severity);
  if (input.checkCode) query = query.eq("check_code", input.checkCode);

  const { data, error } = await query;

  if (error) {
    throw new ReconciliationRepositoryError(error.message);
  }

  return ((data ?? []) as ReconciliationFindingRow[])
    .map(mapFindingRow)
    .filter((finding): finding is ReconciliationFinding => Boolean(finding));
}

export async function listRecentReconciliationRuns(
  limit = 20
): Promise<ReconciliationRun[]> {
  const { data, error } = await supabaseServerAdmin
    .from("reconciliation_runs")
    .select(RUN_SELECT)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new ReconciliationRepositoryError(error.message);
  }

  return ((data ?? []) as ReconciliationRunRow[])
    .map(mapRunRow)
    .filter((run): run is ReconciliationRun => Boolean(run));
}

export async function listOpenReconciliationFindings(
  limit = 100
): Promise<ReconciliationFinding[]> {
  const { data, error } = await supabaseServerAdmin
    .from("reconciliation_run_findings")
    .select(FINDING_SELECT)
    .in("severity", ["WARNING", "FAIL"])
    .neq("review_status", "RESOLVED")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new ReconciliationRepositoryError(error.message);
  }

  return ((data ?? []) as ReconciliationFindingRow[])
    .map(mapFindingRow)
    .filter((finding): finding is ReconciliationFinding => Boolean(finding));
}

export async function findReconciliationFindingById(
  findingId: string
): Promise<ReconciliationFinding | null> {
  const { data, error } = await supabaseServerAdmin
    .from("reconciliation_run_findings")
    .select(FINDING_SELECT)
    .eq("id", findingId)
    .maybeSingle();

  if (error) {
    throw new ReconciliationRepositoryError(error.message);
  }

  return mapFindingRow(data as ReconciliationFindingRow | null);
}

export async function acknowledgeReconciliationFindingRecord({
  findingId,
  actorUserId,
  assignedOperatorUserId,
  notes,
}: {
  findingId: string;
  actorUserId: string;
  assignedOperatorUserId?: string | null;
  notes?: string | null;
}): Promise<ReconciliationFinding> {
  const acknowledgedAt = new Date().toISOString();
  const { data, error } = await supabaseServerAdmin
    .from("reconciliation_run_findings")
    .update({
      review_status: "ACKNOWLEDGED",
      assigned_operator_user_id: assignedOperatorUserId ?? actorUserId,
      reviewed_at: acknowledgedAt,
      acknowledged_by_user_id: actorUserId,
      acknowledged_at: acknowledgedAt,
      resolution_notes: notes ?? null,
    })
    .eq("id", findingId)
    .neq("review_status", "RESOLVED")
    .select(FINDING_SELECT)
    .maybeSingle();

  if (error) {
    throw new ReconciliationRepositoryError(error.message);
  }

  const finding = mapFindingRow(data as ReconciliationFindingRow | null);

  if (!finding) {
    throw new ReconciliationRepositoryError("Reconciliation finding not found.");
  }

  return finding;
}

export async function resolveReconciliationFindingRecord({
  findingId,
  actorUserId,
  notes,
}: {
  findingId: string;
  actorUserId: string;
  notes: string;
}): Promise<ReconciliationFinding> {
  const resolvedAt = new Date().toISOString();
  const { data, error } = await supabaseServerAdmin
    .from("reconciliation_run_findings")
    .update({
      review_status: "RESOLVED",
      reviewed_at: resolvedAt,
      resolved_by_user_id: actorUserId,
      resolved_at: resolvedAt,
      resolution_notes: notes,
    })
    .eq("id", findingId)
    .select(FINDING_SELECT)
    .maybeSingle();

  if (error) {
    throw new ReconciliationRepositoryError(error.message);
  }

  const finding = mapFindingRow(data as ReconciliationFindingRow | null);

  if (!finding) {
    throw new ReconciliationRepositoryError("Reconciliation finding not found.");
  }

  return finding;
}

export async function reviewReconciliationRunRecord({
  runId,
  actorUserId,
  reviewStatus,
}: {
  runId: string;
  actorUserId: string;
  reviewStatus: ReconciliationRunReviewStatus;
}): Promise<ReconciliationRun> {
  const reviewedAt = new Date().toISOString();
  const { data, error } = await supabaseServerAdmin
    .from("reconciliation_runs")
    .update({
      review_status: reviewStatus,
      reviewed_by_user_id: actorUserId,
      reviewed_at: reviewedAt,
    })
    .eq("id", runId)
    .select(RUN_SELECT)
    .maybeSingle();

  if (error) {
    throw new ReconciliationRepositoryError(error.message);
  }

  const run = mapRunRow(data as ReconciliationRunRow | null);

  if (!run) {
    throw new ReconciliationRepositoryError("Reconciliation run not found.");
  }

  return run;
}

export async function recordReconciliationOutboxEvent({
  eventType,
  aggregateId,
  payload,
  correlationId,
}: {
  eventType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  correlationId?: string | null;
}) {
  const { error } = await supabaseServerAdmin.from("outbox_events").insert({
    event_type: eventType,
    aggregate_type: "reconciliation_run",
    aggregate_id: aggregateId,
    payload,
    status: "PENDING",
    correlation_id: correlationId ?? null,
  });

  if (error) {
    throw new ReconciliationRepositoryError(error.message);
  }
}

export async function listCreditReservations(): Promise<
  CreditReservationSourceRow[]
> {
  const { data, error } = await supabaseServerAdmin
    .from("credit_reservations")
    .select(
      "id, player_id, ticket_id, currency, status, reserved_amount, released_amount, remaining_exposure"
    );

  if (error) {
    throw new ReconciliationRepositoryError(error.message);
  }

  return (data ?? []) as CreditReservationSourceRow[];
}

export async function listCreditSettlementApplications(): Promise<
  CreditSettlementApplicationSourceRow[]
> {
  const { data, error } = await supabaseServerAdmin
    .from("credit_settlement_applications")
    .select(
      "id, reservation_id, player_id, ticket_id, settlement_id, balance_impact, currency, created_at"
    );

  if (error) {
    throw new ReconciliationRepositoryError(error.message);
  }

  return (data ?? []) as CreditSettlementApplicationSourceRow[];
}

export async function listTicketsSafely(): Promise<{
  rows: TicketSourceRow[];
  unavailableReason?: string;
}> {
  const { data, error } = await supabaseServerAdmin
    .from("tickets")
    .select("id, status, total_amount, currency, credit_reservation_id");

  if (error) {
    if (isMissingRelationError(error)) {
      return { rows: [], unavailableReason: error.message };
    }

    throw new ReconciliationRepositoryError(error.message);
  }

  return { rows: (data ?? []) as TicketSourceRow[] };
}

export async function listWeeklyAccountingSnapshots(): Promise<
  WeeklyAccountingSnapshotSourceRow[]
> {
  const { data, error } = await supabaseServerAdmin
    .from("weekly_accounting_snapshots")
    .select("id, account_id, account_type, week_start, week_end, currency, net_result");

  if (error) {
    throw new ReconciliationRepositoryError(error.message);
  }

  return (data ?? []) as WeeklyAccountingSnapshotSourceRow[];
}

export async function listCommissionRunDetails(): Promise<
  CommissionRunDetailSourceRow[]
> {
  const { data, error } = await supabaseServerAdmin
    .from("commission_run_details")
    .select(
      "id, run_id, account_id, snapshot_id, net_result, commission_percentage_basis_points, commission_amount"
    );

  if (error) {
    throw new ReconciliationRepositoryError(error.message);
  }

  return (data ?? []) as CommissionRunDetailSourceRow[];
}
