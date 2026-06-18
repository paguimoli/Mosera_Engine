export type CreditReservationStatus =
  | "RESERVED"
  | "PARTIALLY_RELEASED"
  | "RELEASED"
  | "SETTLED"
  | "CANCELLED"
  | "FAILED";

export type CreditReservation = {
  id: string;
  playerId: string;
  ticketId: string;
  amount: number;
  currency: string;
  status: CreditReservationStatus;
  reservedAmount: number;
  releasedAmount: number;
  settledAmount: number;
  remainingExposure: number;
  idempotencyKey: string;
  correlationId?: string | null;
  createdAt: string;
  updatedAt?: string | null;
  releasedAt?: string | null;
  settledAt?: string | null;
  cancelledAt?: string | null;
  metadata: Record<string, unknown>;
};

export type CreditSummary = {
  playerId: string;
  walletId: string;
  creditLimit: number;
  balance: number;
  pendingExposure: number;
  availableCredit: number;
  currency: string;
};

export type ReserveCreditExposureInput = {
  playerId: string;
  ticketId: string;
  amount: number;
  currency: string;
  idempotencyKey: string;
  correlationId?: string | null;
  metadata?: Record<string, unknown>;
};

export type ReleaseCreditExposureInput = {
  reservationId: string;
  ticketId: string;
  releaseAmount: number;
  idempotencyKey: string;
  correlationId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
};

export type CancelCreditReservationInput = {
  reservationId: string;
  correlationId?: string | null;
  reason?: string | null;
};

export type ApplyCreditSettlementInput = {
  reservationId: string;
  ticketId: string;
  settlementId: string;
  releaseAmount: number;
  balanceImpact: number;
  currency: string;
  idempotencyKey: string;
  correlationId?: string | null;
  metadata?: Record<string, unknown>;
};

export type CreditSettlementApplicationResult = {
  applicationId: string;
  reservationId: string;
  playerId: string;
  ticketId: string;
  settlementId: string;
  releaseAmount: number;
  balanceImpact: number;
  balanceBefore: number;
  balanceAfter: number;
  currency: string;
  operationType: "PARTIAL_SETTLEMENT" | "FULL_SETTLEMENT";
  status: CreditReservationStatus;
  releasedAmount: number;
  settledAmount: number;
  remainingExposure: number;
  idempotencyKey: string;
  correlationId?: string | null;
  createdAt: string;
};
