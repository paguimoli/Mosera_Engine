import type {
  AuthorityValue,
  ComparisonMode,
  ServiceHealthStatus,
} from "../authority-control/authority-control.types";
import type { AuthorityApprovalRecord } from "../authority-approval/authority-approval.types";
import type { AuthenticatedUser } from "../auth/auth-context.types";
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

export type LedgerRollbackTriggerEvidenceSource =
  | "RAW_EVIDENCE"
  | "PROMOTION_EVIDENCE"
  | "POST_PROMOTION_EVIDENCE";

export type LedgerRollbackTriggerEvidenceSummary = {
  source: LedgerRollbackTriggerEvidenceSource;
  totalRuns: number;
  matches: number;
  mismatches: number;
  failures: number;
  criticalMismatchCount: number;
  mismatchRate: number;
  failureRate: number;
  readiness: DomainReadinessStatus;
  effectiveMismatchCount: number;
  effectiveFailureCount: number;
  excludedMismatchCount: number;
  excludedFailureCount: number;
  reasons: string[];
};

export type LedgerRollbackEvaluationDetails = {
  triggerSource: LedgerRollbackTriggerEvidenceSource;
  rawTriggerActive: boolean;
  promotionTriggerActive: boolean;
  postPromotionTriggerActive: boolean;
  blockers: string[];
  warnings: string[];
  evaluatedAt: string;
};

export type LedgerPostPromotionStatus = {
  domain: "LEDGER";
  authority: AuthorityValue;
  comparisonMode: ComparisonMode;
  promotedAt: string | null;
  serviceHealth: ServiceHealthStatus;
  rollbackReadiness: DomainReadinessStatus;
  rollbackTrigger: LedgerRollbackTriggerEvaluation;
  triggerSource: LedgerRollbackTriggerEvidenceSource;
  rawEvidenceSummary: LedgerRollbackTriggerEvidenceSummary;
  promotionEvidenceSummary: LedgerRollbackTriggerEvidenceSummary;
  postPromotionEvidenceSummary: LedgerRollbackTriggerEvidenceSummary;
  rollbackEvaluationDetails: LedgerRollbackEvaluationDetails;
  latestLedgerShadowComparison: {
    id: string;
    comparisonStatus: string;
    transactionId: string;
    correlationId: string | null;
    createdAt: string;
  } | null;
  postPromotionMismatchCount: number;
  postPromotionFailureCount: number;
  recommendation: string;
  evaluatedAt: string;
};

export type LedgerCertificationStatus =
  | "NOT_READY"
  | "READY_FOR_CERTIFICATION"
  | "CERTIFIED"
  | "REVIEW_REQUIRED";

export type LedgerStabilizationStatus = {
  domain: "LEDGER";
  authority: AuthorityValue;
  comparisonMode: ComparisonMode;
  promotedAt: string | null;
  ledgersProcessed: number;
  ledgerEntriesProcessed: number;
  mismatchCount: number;
  failureCount: number;
  criticalMismatchCount: number;
  serviceHealth: ServiceHealthStatus;
  rollbackReadiness: DomainReadinessStatus;
  rollbackTrigger: LedgerRollbackTriggerEvaluation;
  certificationStatus: LedgerCertificationStatus;
  certificationBlockers: string[];
  certificationWarnings: string[];
  certificationApprovalId: string | null;
  certifiedAt: string | null;
  recommendation: string;
  generatedAt: string;
};

export type LedgerCertificationInput = {
  actor: AuthenticatedUser;
  justification: unknown;
  acknowledgedWarnings: unknown;
  correlationId?: unknown;
};

export type LedgerCertificationResult = {
  approval: AuthorityApprovalRecord;
  idempotent: boolean;
  stabilizationBefore: LedgerStabilizationStatus;
  stabilizationAfter: LedgerStabilizationStatus;
};

export type LedgerRollbackDrill = {
  domain: "LEDGER";
  mode: "SIMULATION";
  authorityBefore: AuthorityValue;
  authorityAfter: AuthorityValue;
  comparisonMode: ComparisonMode;
  rollbackReadiness: DomainReadinessStatus;
  serviceHealth: ServiceHealthStatus;
  validationResults: Array<{
    name: string;
    passed: boolean;
    message: string;
  }>;
  blockers: string[];
  warnings: string[];
  drillPassed: boolean;
  authorityChanged: boolean;
  auditEvent: {
    id: string;
    eventType: string;
    correlationId: string | null;
  };
  simulatedAt: string;
};
