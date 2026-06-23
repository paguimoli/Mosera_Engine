import type {
  RollbackReadinessStatus,
  ServiceHealthStatus,
} from "../authority-control/authority-control.types";
import type {
  RollbackTriggerEvidenceSummary,
  SettlementPostPromotionStatus,
} from "../promotion-execution/promotion-execution.types";

export type SettlementStabilizationWindow = "24h" | "7d" | "30d" | "all";

export type SettlementStabilizationStatus =
  | "STABILIZING"
  | "STABLE"
  | "REVIEW_REQUIRED"
  | "ROLLBACK_RECOMMENDED";

export type SettlementStabilizationMetrics = {
  settlementsProcessed: number;
  mismatchCount: number;
  failureCount: number;
  criticalMismatchCount: number;
  evidenceFrom: string | null;
  evidenceTo: string;
};

export type SettlementStabilizationSummary = {
  window: SettlementStabilizationWindow;
  authority: string;
  comparisonMode: string;
  promotedAt: string | null;
  daysSincePromotion: number | null;
  settlementsProcessed: number;
  mismatchCount: number;
  failureCount: number;
  criticalMismatchCount: number;
  serviceHealth: ServiceHealthStatus;
  rollbackReadiness: RollbackReadinessStatus;
  rollbackTrigger: SettlementPostPromotionStatus["rollbackTrigger"];
  stabilizationStatus: SettlementStabilizationStatus;
  recommendation: string;
  generatedAt: string;
  evidence: {
    effectiveWindow: {
      from: string | null;
      to: string;
    };
    promotionEvidenceSummary: RollbackTriggerEvidenceSummary;
    postPromotionEvidenceSummary: RollbackTriggerEvidenceSummary;
  };
};
