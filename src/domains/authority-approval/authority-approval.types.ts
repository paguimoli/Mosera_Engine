import type { AuthorityDomain } from "../authority-control/authority-control.types";
import type { DomainReadinessStatus } from "../shadow-readiness/shadow-readiness.types";

export type AuthorityPromotionCandidateState =
  | "BLOCKED"
  | "READY_FOR_REVIEW"
  | "READY_FOR_DRY_RUN_APPROVAL"
  | "APPROVED_FOR_DRY_RUN"
  | "DRY_RUN_ACTIVE"
  | "READY_FOR_PROMOTION_APPROVAL"
  | "APPROVED_FOR_PROMOTION"
  | "READY_FOR_CONTROLLED_PROMOTION"
  | "ROLLBACK_RECOMMENDED"
  | "PROMOTED";

export type AuthorityApprovalType =
  | "DRY_RUN_APPROVAL"
  | "PROMOTION_APPROVAL"
  | "ROLLBACK_APPROVAL"
  | "SETTLEMENT_CERTIFICATION"
  | "LEDGER_CERTIFICATION";

export type AuthorityApprovalRecord = {
  id: string;
  authorityCandidate: AuthorityDomain;
  approvalType: AuthorityApprovalType;
  approverUserId?: string | null;
  approverUsername?: string | null;
  justification: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type CreateAuthorityApprovalInput = {
  authorityCandidate: AuthorityDomain;
  approvalType: AuthorityApprovalType;
  approverUserId?: string | null;
  approverUsername?: string | null;
  justification: string;
  metadata?: Record<string, unknown>;
};

export type AuthorityApprovalHistory = {
  approvals: AuthorityApprovalRecord[];
  generatedAt: string;
};

export type AuthorityApprovalStatus = {
  authorityCandidate: AuthorityDomain;
  currentState: AuthorityPromotionCandidateState;
  recommendedState: AuthorityPromotionCandidateState;
  approvalRequirements: string[];
  promotionBlockers: string[];
  rollbackReadiness: DomainReadinessStatus;
  latestApprovals: {
    dryRunApproval: AuthorityApprovalRecord | null;
    promotionApproval: AuthorityApprovalRecord | null;
    rollbackApproval: AuthorityApprovalRecord | null;
  };
  evaluatedAt: string;
};

export type SettlementDryRunEvaluation = {
  authorityCandidate: "SETTLEMENT";
  currentState: AuthorityPromotionCandidateState;
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
