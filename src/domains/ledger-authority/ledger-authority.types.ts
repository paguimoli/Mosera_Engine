import type {
  AuthorityValue,
  ComparisonMode,
  ServiceHealthStatus,
} from "../authority-control/authority-control.types";
import type { DomainReadinessStatus } from "../shadow-readiness/shadow-readiness.types";

export type LedgerAuthorityCandidateStatus = "READY" | "WARNING" | "BLOCKED";

export type LedgerAuthorityDryRunMode = "ENABLED" | "DISABLED";

export type LedgerAuthorityRuntimeRoute = {
  authoritativePath: AuthorityValue;
  comparisonMode: ComparisonMode;
  comparisonPath: "MONOLITH" | "LEDGER_SERVICE" | null;
  dryRunMode: LedgerAuthorityDryRunMode;
  productionCutoverActive: boolean;
  reasons: string[];
};

export type LedgerAuthorityMetrics = {
  totalRuns: number;
  matches: number;
  mismatches: number;
  failures: number;
  mismatchRate: number;
  failureRate: number;
  criticalMismatchPresent: boolean;
  shadowReadinessStatus: LedgerAuthorityCandidateStatus;
};

export type LedgerAuthorityThresholds = {
  mismatchAlertThreshold: number;
  rollbackFailureThreshold: number;
};

export type LedgerRollbackTriggerEvaluation = {
  shouldTriggerRollback: boolean;
  status: LedgerAuthorityCandidateStatus;
  reasons: string[];
};

export type LedgerAuthorityReadiness = {
  status: LedgerAuthorityCandidateStatus;
  authority: AuthorityValue;
  comparisonMode: ComparisonMode;
  dryRunMode: LedgerAuthorityDryRunMode;
  runtimeRoute: LedgerAuthorityRuntimeRoute;
  metrics: LedgerAuthorityMetrics | null;
  thresholds: LedgerAuthorityThresholds;
  rollbackReadinessStatus: LedgerAuthorityCandidateStatus;
  rollbackTrigger: LedgerRollbackTriggerEvaluation;
  readinessReasons: string[];
  remainingBlockers: string[];
  evaluatedAt: string;
};

export type LedgerDryRunEvaluation = {
  authorityCandidate: "LEDGER";
  currentState: string;
  ifServiceBecameAuthoritativeNow: {
    wouldRollbackTrigger: boolean;
    wouldThresholdsBeExceeded: boolean;
    wouldPromotionBeAllowed: boolean;
  };
  rawEvidence: {
    readiness: DomainReadinessStatus;
    mismatchRate: number;
    failureRate: number;
  };
  adjustedEvidence: {
    readiness: DomainReadinessStatus;
    mismatchRate: number;
    failureRate: number;
  };
  promotionEvidence: {
    readiness: DomainReadinessStatus;
    mismatchRate: number;
    failureRate: number;
  };
  rollbackReadiness: DomainReadinessStatus;
  promotionBlockers: string[];
  approvalRequirements: string[];
  evaluatedAt: string;
};

export type LedgerSimulationResult = {
  domain: "LEDGER";
  currentAuthority?: AuthorityValue;
  proposedAuthority?: "SERVICE";
  simulatedAuthority?: AuthorityValue;
  authorityState?: AuthorityValue;
  comparisonMode: ComparisonMode;
  promotionDecision?: string;
  rollbackReadiness: DomainReadinessStatus;
  rollbackReady: boolean;
  serviceHealth: ServiceHealthStatus;
  validationResults: Array<{
    name: string;
    passed: boolean;
    message: string;
  }>;
  blockers: string[];
  warnings: string[];
  promotionAllowed?: boolean;
  rollbackAllowed?: boolean;
  auditEvent: {
    id: string;
    eventType: string;
    correlationId: string | null;
  };
  simulatedAt: string;
};

export type LedgerAuthorityPromotion = {
  domain: "LEDGER";
  previousAuthority: AuthorityValue;
  newAuthority: "SERVICE";
  comparisonMode: "ENABLED";
  rollbackReadiness: DomainReadinessStatus;
  promotionApprovalId: string | null;
  promotedAt: string;
  correlationId: string | null;
  idempotent: boolean;
  auditEvent: {
    id: string;
    eventType: string;
    correlationId: string | null;
  } | null;
};

export type LedgerPromotionStatus = {
  domain: "LEDGER";
  authority: AuthorityValue;
  comparisonMode: ComparisonMode;
  promotedAt: string | null;
  rollbackReady: boolean;
  rollbackReadiness: DomainReadinessStatus;
  promotionApprovalId: string | null;
  evaluatedAt: string;
};
