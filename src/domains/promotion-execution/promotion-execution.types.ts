import type {
  AuthorityDomain,
  AuthorityValue,
  ComparisonMode,
  RollbackReadinessStatus,
  ServiceHealthStatus,
} from "../authority-control/authority-control.types";
import type { PromotionDecisionState } from "../promotion-decision/promotion-decision.types";
import type { DomainReadinessStatus } from "../shadow-readiness/shadow-readiness.types";

export type PromotionExecutionValidationResult = {
  name: string;
  passed: boolean;
  message: string;
};

export type PromotionExecutionAuditEvent = {
  id: string;
  eventType: string;
  correlationId: string | null;
};

export type SettlementPromotionSimulation = {
  domain: "SETTLEMENT";
  currentAuthority: AuthorityValue;
  proposedAuthority: "SERVICE";
  comparisonMode: ComparisonMode;
  promotionDecision: PromotionDecisionState;
  rollbackReadiness: RollbackReadinessStatus;
  serviceHealth: ServiceHealthStatus;
  validationResults: PromotionExecutionValidationResult[];
  blockers: string[];
  warnings: string[];
  promotionAllowed: boolean;
  auditEvent: PromotionExecutionAuditEvent;
  simulatedAt: string;
};

export type SettlementRollbackSimulation = {
  domain: "SETTLEMENT";
  authorityState: AuthorityValue;
  comparisonMode: ComparisonMode;
  rollbackReadiness: RollbackReadinessStatus;
  serviceHealth: ServiceHealthStatus;
  monolithPathAvailable: boolean;
  validationResults: PromotionExecutionValidationResult[];
  blockers: string[];
  warnings: string[];
  rollbackAllowed: boolean;
  auditEvent: PromotionExecutionAuditEvent;
  simulatedAt: string;
};

export type SettlementRollbackDrill = {
  domain: "SETTLEMENT";
  mode: "SIMULATION";
  authorityBefore: AuthorityValue;
  authorityAfter: AuthorityValue;
  comparisonMode: ComparisonMode;
  rollbackReadiness: RollbackReadinessStatus;
  serviceHealth: ServiceHealthStatus;
  validationResults: PromotionExecutionValidationResult[];
  blockers: string[];
  warnings: string[];
  drillPassed: boolean;
  authorityChanged: boolean;
  auditEvent: PromotionExecutionAuditEvent;
  simulatedAt: string;
};

export type SettlementAuthorityPromotion = {
  domain: "SETTLEMENT";
  previousAuthority: AuthorityValue;
  newAuthority: "SERVICE";
  comparisonMode: "ENABLED";
  rollbackReadiness: RollbackReadinessStatus;
  promotionApprovalId: string | null;
  promotedAt: string;
  correlationId: string | null;
  idempotent: boolean;
  auditEvent: PromotionExecutionAuditEvent | null;
};

export type SettlementPromotionStatus = {
  domain: "SETTLEMENT";
  authority: AuthorityValue;
  comparisonMode: ComparisonMode;
  promotedAt: string | null;
  rollbackReady: boolean;
  rollbackReadiness: RollbackReadinessStatus;
  promotionApprovalId: string | null;
  evaluatedAt: string;
};

export type RollbackTriggerEvidenceSource =
  | "RAW_EVIDENCE"
  | "PROMOTION_EVIDENCE"
  | "POST_PROMOTION_EVIDENCE";

export type RollbackTriggerEvidenceSummary = {
  source: RollbackTriggerEvidenceSource;
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

export type RollbackEvaluationDetails = {
  triggerSource: RollbackTriggerEvidenceSource;
  rawTriggerActive: boolean;
  promotionTriggerActive: boolean;
  postPromotionTriggerActive: boolean;
  blockers: string[];
  warnings: string[];
  evaluatedAt: string;
};

export type SettlementPostPromotionStatus = {
  domain: "SETTLEMENT";
  authority: AuthorityValue;
  comparisonMode: ComparisonMode;
  promotedAt: string | null;
  serviceHealth: ServiceHealthStatus;
  rollbackReadiness: RollbackReadinessStatus;
  rollbackTrigger: {
    shouldTriggerRollback: boolean;
    status: DomainReadinessStatus;
    reasons: string[];
  };
  triggerSource: RollbackTriggerEvidenceSource;
  rawEvidenceSummary: RollbackTriggerEvidenceSummary;
  promotionEvidenceSummary: RollbackTriggerEvidenceSummary;
  postPromotionEvidenceSummary: RollbackTriggerEvidenceSummary;
  rollbackEvaluationDetails: RollbackEvaluationDetails;
  latestSettlementShadowComparison: {
    id: string;
    comparisonStatus: string;
    ticketId: string;
    correlationId: string | null;
    createdAt: string;
  } | null;
  postPromotionMismatchCount: number;
  postPromotionFailureCount: number;
  recommendation: string;
  evaluatedAt: string;
};

export type PromotionSimulationInput = {
  domain: AuthorityDomain;
  correlationId?: string | null;
};

export type RollbackSimulationInput = {
  domain: AuthorityDomain;
  correlationId?: string | null;
};

export type RollbackDrillInput = {
  domain: AuthorityDomain;
  mode: "SIMULATION";
  correlationId?: string | null;
};

export type PromotionExecutionInput = {
  domain: AuthorityDomain;
  correlationId?: string | null;
};
