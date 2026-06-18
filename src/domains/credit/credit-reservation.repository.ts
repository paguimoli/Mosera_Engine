import { supabaseServerAdmin } from "@/src/lib/supabase/server-admin-client";
import type {
  ApplyCreditSettlementInput,
  CancelCreditReservationInput,
  CreditReservation,
  CreditReservationStatus,
  CreditSettlementApplicationResult,
  CreditSummary,
  ReleaseCreditExposureInput,
  ReserveCreditExposureInput,
} from "./credit-reservation.types";

// Domain-internal persistence adapter. Routes, workers, and other domains should
// depend on credit-reservation.service or credit.entrypoints instead.
type CreditReservationRow = {
  id: string;
  player_id: string;
  ticket_id: string;
  amount: string | number;
  currency: string;
  status: CreditReservationStatus;
  reserved_amount: string | number;
  released_amount: string | number;
  settled_amount: string | number;
  remaining_exposure: string | number;
  idempotency_key: string;
  correlation_id?: string | null;
  created_at: string;
  updated_at?: string | null;
  released_at?: string | null;
  settled_at?: string | null;
  cancelled_at?: string | null;
  metadata?: Record<string, unknown> | null;
};

type CreditSettlementApplicationRow = {
  applicationId?: unknown;
  reservationId?: unknown;
  playerId?: unknown;
  ticketId?: unknown;
  settlementId?: unknown;
  releaseAmount?: unknown;
  balanceImpact?: unknown;
  balanceBefore?: unknown;
  balanceAfter?: unknown;
  currency?: unknown;
  operationType?: unknown;
  status?: unknown;
  releasedAmount?: unknown;
  settledAmount?: unknown;
  remainingExposure?: unknown;
  idempotencyKey?: unknown;
  correlationId?: unknown;
  createdAt?: unknown;
};

const CREDIT_RESERVATION_SELECT =
  "id, player_id, ticket_id, amount, currency, status, reserved_amount, released_amount, settled_amount, remaining_exposure, idempotency_key, correlation_id, created_at, updated_at, released_at, settled_at, cancelled_at, metadata";

export class CreditReservationRepositoryError extends Error {
  constructor(message = "Credit reservation persistence operation failed.") {
    super(message);
    this.name = "CreditReservationRepositoryError";
  }
}

function mapCreditReservationRow(
  row: CreditReservationRow | null
): CreditReservation | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    playerId: row.player_id,
    ticketId: row.ticket_id,
    amount: Number(row.amount),
    currency: row.currency,
    status: row.status,
    reservedAmount: Number(row.reserved_amount),
    releasedAmount: Number(row.released_amount),
    settledAmount: Number(row.settled_amount),
    remainingExposure: Number(row.remaining_exposure),
    idempotencyKey: row.idempotency_key,
    correlationId: row.correlation_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? null,
    releasedAt: row.released_at ?? null,
    settledAt: row.settled_at ?? null,
    cancelledAt: row.cancelled_at ?? null,
    metadata: row.metadata ?? {},
  };
}

function assertCreditReservation(
  row: CreditReservationRow | null
): CreditReservation {
  const reservation = mapCreditReservationRow(row);

  if (!reservation) {
    throw new CreditReservationRepositoryError();
  }

  return reservation;
}

function assertCreditSettlementApplication(
  row: CreditSettlementApplicationRow | null
): CreditSettlementApplicationResult {
  if (!row || typeof row !== "object") {
    throw new CreditReservationRepositoryError();
  }

  return {
    applicationId: String(row.applicationId ?? ""),
    reservationId: String(row.reservationId ?? ""),
    playerId: String(row.playerId ?? ""),
    ticketId: String(row.ticketId ?? ""),
    settlementId: String(row.settlementId ?? ""),
    releaseAmount: Number(row.releaseAmount ?? 0),
    balanceImpact: Number(row.balanceImpact ?? 0),
    balanceBefore: Number(row.balanceBefore ?? 0),
    balanceAfter: Number(row.balanceAfter ?? 0),
    currency: String(row.currency ?? ""),
    operationType:
      row.operationType === "FULL_SETTLEMENT"
        ? "FULL_SETTLEMENT"
        : "PARTIAL_SETTLEMENT",
    status: String(row.status ?? "FAILED") as CreditReservationStatus,
    releasedAmount: Number(row.releasedAmount ?? 0),
    settledAmount: Number(row.settledAmount ?? 0),
    remainingExposure: Number(row.remainingExposure ?? 0),
    idempotencyKey: String(row.idempotencyKey ?? ""),
    correlationId:
      typeof row.correlationId === "string" ? row.correlationId : null,
    createdAt: String(row.createdAt ?? ""),
  };
}

export async function reserveCreditExposure(
  input: ReserveCreditExposureInput
): Promise<CreditReservation> {
  const { data, error } = await supabaseServerAdmin.rpc(
    "reserve_credit_exposure",
    {
      p_player_id: input.playerId,
      p_ticket_id: input.ticketId,
      p_amount: input.amount,
      p_currency: input.currency,
      p_idempotency_key: input.idempotencyKey,
      p_correlation_id: input.correlationId ?? null,
      p_metadata: input.metadata ?? {},
    }
  );

  if (error) {
    throw new CreditReservationRepositoryError(error.message);
  }

  return assertCreditReservation(data as CreditReservationRow | null);
}

export async function releaseCreditExposure(
  input: ReleaseCreditExposureInput
): Promise<CreditReservation> {
  const { data, error } = await supabaseServerAdmin.rpc(
    "release_credit_exposure",
    {
      p_reservation_id: input.reservationId,
      p_ticket_id: input.ticketId,
      p_release_amount: input.releaseAmount,
      p_idempotency_key: input.idempotencyKey,
      p_correlation_id: input.correlationId ?? null,
      p_reason: input.reason ?? null,
      p_metadata: input.metadata ?? {},
    }
  );

  if (error) {
    throw new CreditReservationRepositoryError(error.message);
  }

  return assertCreditReservation(data as CreditReservationRow | null);
}

export async function cancelCreditReservation(
  input: CancelCreditReservationInput
): Promise<CreditReservation> {
  const { data, error } = await supabaseServerAdmin.rpc(
    "cancel_credit_reservation",
    {
      p_reservation_id: input.reservationId,
      p_correlation_id: input.correlationId ?? null,
      p_reason: input.reason ?? null,
    }
  );

  if (error) {
    throw new CreditReservationRepositoryError(error.message);
  }

  return assertCreditReservation(data as CreditReservationRow | null);
}

export async function applyCreditSettlement(
  input: ApplyCreditSettlementInput
): Promise<CreditSettlementApplicationResult> {
  const { data, error } = await supabaseServerAdmin.rpc(
    "apply_credit_settlement",
    {
      p_reservation_id: input.reservationId,
      p_ticket_id: input.ticketId,
      p_settlement_id: input.settlementId,
      p_release_amount: input.releaseAmount,
      p_balance_impact: input.balanceImpact,
      p_currency: input.currency,
      p_idempotency_key: input.idempotencyKey,
      p_correlation_id: input.correlationId ?? null,
      p_metadata: input.metadata ?? {},
    }
  );

  if (error) {
    throw new CreditReservationRepositoryError(error.message);
  }

  return assertCreditSettlementApplication(
    data as CreditSettlementApplicationRow | null
  );
}

export async function getPlayerCreditSummary(
  playerId: string
): Promise<CreditSummary> {
  const { data, error } = await supabaseServerAdmin.rpc(
    "get_player_credit_summary",
    {
      p_player_id: playerId,
    }
  );

  if (error) {
    throw new CreditReservationRepositoryError(error.message);
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new CreditReservationRepositoryError();
  }

  const summary = data as Record<string, unknown>;

  return {
    playerId: String(summary.playerId ?? ""),
    walletId: String(summary.walletId ?? ""),
    creditLimit: Number(summary.creditLimit ?? 0),
    balance: Number(summary.balance ?? 0),
    pendingExposure: Number(summary.pendingExposure ?? 0),
    availableCredit: Number(summary.availableCredit ?? 0),
    currency: String(summary.currency ?? ""),
  };
}

export async function findCreditReservationById(
  reservationId: string
): Promise<CreditReservation | null> {
  const { data, error } = await supabaseServerAdmin
    .from("credit_reservations")
    .select(CREDIT_RESERVATION_SELECT)
    .eq("id", reservationId)
    .maybeSingle();

  if (error) {
    throw new CreditReservationRepositoryError(error.message);
  }

  return mapCreditReservationRow(data as CreditReservationRow | null);
}
