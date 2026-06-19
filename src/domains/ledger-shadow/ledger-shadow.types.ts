export type LedgerShadowComparisonStatus = "MATCH" | "MISMATCH" | "NOT_COMPARED";

export type LedgerShadowMismatchType =
  | "AMOUNT_MISMATCH"
  | "CURRENCY_MISMATCH"
  | "ENTRY_TYPE_MISMATCH"
  | "ACCOUNT_MISMATCH"
  | "IDEMPOTENCY_MISMATCH"
  | "UNKNOWN_MISMATCH";

export type LedgerShadowSeverity = "INFO" | "WARNING" | "CRITICAL";

export type LedgerShadowRun = {
  id: string;
  correlationId?: string | null;
  transactionId: string;
  accountId: string;
  walletId?: string | null;
  entryType: string;
  comparisonStatus: LedgerShadowComparisonStatus;
  shadowEntryType: string;
  monolithEntryType?: string | null;
  shadowAmountMinor: number;
  monolithAmountMinor?: number | null;
  shadowCurrency: string;
  monolithCurrency?: string | null;
  shadowAccountId: string;
  monolithAccountId?: string | null;
  shadowIdempotencyKey?: string | null;
  monolithIdempotencyKey?: string | null;
  shadowServiceVersion?: string | null;
  createdAt: string;
};

export type LedgerShadowMismatch = {
  id: string;
  shadowRunId: string;
  mismatchType: LedgerShadowMismatchType;
  fieldName: string;
  monolithValue?: string | null;
  shadowValue?: string | null;
  severity: LedgerShadowSeverity;
  createdAt: string;
  run?: LedgerShadowRun | null;
};

export type LedgerShadowFailure = {
  id: string;
  correlationId?: string | null;
  transactionId?: string | null;
  failureReason: string;
  failureType: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type LedgerShadowSummary = {
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

export type LedgerShadowListFilters = {
  transactionId?: string | null;
  accountId?: string | null;
  from?: string | null;
  to?: string | null;
  limit?: number;
};
