import type { AuthorityValue, ComparisonMode } from "../authority-control/authority-control.types";

export type SettlementAuthorityCandidateStatus = "READY" | "WARNING" | "BLOCKED";

export type SettlementAuthorityDryRunMode = "ENABLED" | "DISABLED";

export type SettlementAuthorityRuntimeRoute = {
  authoritativePath: AuthorityValue;
  comparisonMode: ComparisonMode;
  comparisonPath: "MONOLITH" | "SETTLEMENT_SERVICE" | null;
  dryRunMode: SettlementAuthorityDryRunMode;
  productionCutoverActive: boolean;
  reasons: string[];
};

export type SettlementAuthorityAuditEventType =
  | "SETTLEMENT_AUTHORITY_READINESS_EVALUATED"
  | "SETTLEMENT_AUTHORITY_ROUTE_RESOLVED"
  | "SETTLEMENT_AUTHORITY_ROLLBACK_TRIGGER_EVALUATED";

export type SettlementAuthorityMetrics = {
  totalRuns: number;
  matches: number;
  mismatches: number;
  failures: number;
  mismatchRate: number;
  failureRate: number;
  criticalMismatchPresent: boolean;
  shadowReadinessStatus: SettlementAuthorityCandidateStatus;
};

export type SettlementAuthorityThresholds = {
  mismatchAlertThreshold: number;
  rollbackFailureThreshold: number;
};

export type SettlementRollbackTriggerEvaluation = {
  shouldTriggerRollback: boolean;
  status: SettlementAuthorityCandidateStatus;
  reasons: string[];
};

export type SettlementAuthorityReadiness = {
  status: SettlementAuthorityCandidateStatus;
  authority: AuthorityValue;
  comparisonMode: ComparisonMode;
  dryRunMode: SettlementAuthorityDryRunMode;
  runtimeRoute: SettlementAuthorityRuntimeRoute;
  metrics: SettlementAuthorityMetrics | null;
  thresholds: SettlementAuthorityThresholds;
  rollbackReadinessStatus: SettlementAuthorityCandidateStatus;
  rollbackTrigger: SettlementRollbackTriggerEvaluation;
  readinessReasons: string[];
  remainingBlockers: string[];
  evaluatedAt: string;
};
