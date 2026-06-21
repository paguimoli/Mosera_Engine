import type {
  AuthorityDomain,
  AuthorityValue,
  ComparisonMode,
  RollbackReadinessStatus,
  ServiceHealthStatus,
} from "../authority-control/authority-control.types";
import type { PromotionDecisionState } from "../promotion-decision/promotion-decision.types";

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

export type PromotionSimulationInput = {
  domain: AuthorityDomain;
  correlationId?: string | null;
};

export type RollbackSimulationInput = {
  domain: AuthorityDomain;
  correlationId?: string | null;
};

export type PromotionExecutionInput = {
  domain: AuthorityDomain;
  correlationId?: string | null;
};
