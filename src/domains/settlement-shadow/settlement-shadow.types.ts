export type SettlementShadowComparisonStatus =
  | "MATCH"
  | "MISMATCH"
  | "NOT_COMPARED";

export type SettlementShadowMismatchType =
  | "OUTCOME_MISMATCH"
  | "PAYOUT_MISMATCH"
  | "NET_AMOUNT_MISMATCH"
  | "STAKE_MISMATCH"
  | "CURRENCY_MISMATCH"
  | "UNKNOWN_MISMATCH";

export type SettlementShadowSeverity = "INFO" | "WARNING" | "CRITICAL";

export type SettlementShadowRun = {
  id: string;
  correlationId?: string | null;
  settlementRunId?: string | null;
  ticketId: string;
  gameId?: string | null;
  drawingId?: string | null;
  comparisonStatus: SettlementShadowComparisonStatus;
  shadowOutcome: string;
  monolithOutcome?: string | null;
  shadowGrossPayout: number;
  monolithGrossPayout?: number | null;
  shadowNetAmount: number;
  monolithNetAmount?: number | null;
  currency: string;
  shadowServiceVersion?: string | null;
  createdAt: string;
};

export type SettlementShadowMismatch = {
  id: string;
  shadowRunId: string;
  mismatchType: SettlementShadowMismatchType;
  fieldName: string;
  monolithValue?: string | null;
  shadowValue?: string | null;
  severity: SettlementShadowSeverity;
  createdAt: string;
  run?: SettlementShadowRun | null;
};

export type SettlementShadowFailure = {
  id: string;
  correlationId?: string | null;
  ticketId?: string | null;
  failureReason: string;
  failureType: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type SettlementShadowSummary = {
  totalRuns: number;
  matches: number;
  mismatches: number;
  failures: number;
  matchPercentage: number;
  mismatchPercentage: number;
  failurePercentage: number;
  readiness: {
    status: "READY" | "WARNING" | "BLOCKED";
    reasons: string[];
    thresholds: {
      readyMismatchRate: number;
      readyFailureRate: number;
      blockedMismatchRate: number;
    };
  };
  generatedAt: string;
};

export type SettlementShadowListFilters = {
  ticketId?: string | null;
  gameId?: string | null;
  from?: string | null;
  to?: string | null;
  limit?: number;
};
