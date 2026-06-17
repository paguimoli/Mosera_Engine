export type ReconciliationRunType =
  | "CREDIT"
  | "SETTLEMENT"
  | "ACCOUNTING"
  | "COMMISSION"
  | "FULL";

export type ReconciliationScopeType =
  | "GLOBAL"
  | "ACCOUNT"
  | "PLAYER"
  | "AGENT"
  | "MASTER"
  | "WEEK";

export type ReconciliationRunStatus = "STARTED" | "COMPLETED" | "FAILED";

export type ReconciliationSeverity = "PASS" | "WARNING" | "FAIL";

export type ReconciliationRun = {
  id: string;
  runType: ReconciliationRunType;
  scopeType: ReconciliationScopeType;
  scopeId?: string | null;
  weekStart?: string | null;
  weekEnd?: string | null;
  currency?: string | null;
  status: ReconciliationRunStatus;
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  warningChecks: number;
  correlationId?: string | null;
  createdAt: string;
  completedAt?: string | null;
};

export type ReconciliationFinding = {
  id: string;
  runId: string;
  severity: ReconciliationSeverity;
  checkCode: string;
  entityType: string;
  entityId: string;
  expectedAmount?: number | null;
  actualAmount?: number | null;
  currency?: string | null;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type RunReconciliationInput = {
  runType: ReconciliationRunType;
  scopeType: ReconciliationScopeType;
  scopeId?: string | null;
  weekStart?: string | null;
  weekEnd?: string | null;
  currency?: string | null;
  correlationId?: string | null;
};

export type CreateReconciliationFindingInput = {
  severity: ReconciliationSeverity;
  checkCode: string;
  entityType: string;
  entityId: string;
  expectedAmount?: number | null;
  actualAmount?: number | null;
  currency?: string | null;
  message: string;
  metadata?: Record<string, unknown>;
};

export type ListReconciliationFindingsInput = {
  runId?: string | null;
  severity?: ReconciliationSeverity | null;
  checkCode?: string | null;
  limit?: number;
};
