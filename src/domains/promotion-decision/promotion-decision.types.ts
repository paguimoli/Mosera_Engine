import type {
  AuthorityDomain,
  AuthorityValue,
  ComparisonMode,
} from "../authority-control/authority-control.types";
import type { AuthorityApprovalRecord } from "../authority-approval/authority-approval.types";
import type { SettlementAuthorityDryRunMode } from "../settlement-authority/settlement-authority.types";
import type { DomainReadinessStatus } from "../shadow-readiness/shadow-readiness.types";

export type PromotionDecisionDomain = AuthorityDomain;

export type PromotionDecisionState =
  | "BLOCKED"
  | "READY_FOR_REVIEW"
  | "READY_FOR_DRY_RUN_APPROVAL"
  | "READY_FOR_PROMOTION_APPROVAL"
  | "READY_FOR_CONTROLLED_PROMOTION"
  | "PROMOTED"
  | "ROLLBACK_RECOMMENDED";

export type PromotionEvidenceReadiness = {
  readiness: DomainReadinessStatus;
  mismatchRate: number;
  failureRate: number;
  criticalMismatchCount: number;
};

export type PromotionApprovalState = {
  dryRunApproval: AuthorityApprovalRecord | null;
  promotionApproval: AuthorityApprovalRecord | null;
  rollbackApproval: AuthorityApprovalRecord | null;
  approvalHistoryCount: number;
};

export type PromotionDecision = {
  domain: PromotionDecisionDomain;
  decision: PromotionDecisionState;
  currentAuthority: AuthorityValue;
  comparisonMode: ComparisonMode;
  dryRunMode: SettlementAuthorityDryRunMode;
  rawReadiness: PromotionEvidenceReadiness;
  adjustedReadiness: PromotionEvidenceReadiness;
  promotionReadiness: PromotionEvidenceReadiness;
  rollbackReadiness: DomainReadinessStatus;
  approvalState: PromotionApprovalState;
  blockingReasons: string[];
  warnings: string[];
  recommendation: string;
  evaluatedAt: string;
};
