import { getAuthorityStatus } from "../authority-control/authority-control.service";
import type { AuthorityDomain } from "../authority-control/authority-control.types";
import {
  getSettlementAuthorityReadiness,
} from "../settlement-authority/settlement-authority.service";
import { getShadowAnalysisSummary } from "../shadow-analysis/shadow-analysis.service";
import type { ShadowAnalysisSummary } from "../shadow-analysis/shadow-analysis.types";
import type {
  AuthorityApprovalHistory,
  AuthorityApprovalRecord,
  AuthorityApprovalStatus,
  AuthorityApprovalType,
  AuthorityPromotionCandidateState,
  SettlementDryRunEvaluation,
} from "./authority-approval.types";
import { listAuthorityApprovalRecords } from "./authority-approval.repository";

function latestApproval(
  approvals: AuthorityApprovalRecord[],
  approvalType: AuthorityApprovalType
) {
  return approvals.find((approval) => approval.approvalType === approvalType) ?? null;
}

function getBasePromotionBlockers({
  settlementReadiness,
  promotionSettlementReadiness,
}: {
  settlementReadiness: Awaited<ReturnType<typeof getSettlementAuthorityReadiness>>;
  promotionSettlementReadiness: ShadowAnalysisSummary["domains"]["settlement"]["promotionReadiness"];
}) {
  const blockers = [...settlementReadiness.remainingBlockers];

  if (promotionSettlementReadiness.readinessStatus !== "READY") {
    blockers.push(
      `Promotion settlement readiness is ${promotionSettlementReadiness.readinessStatus}.`
    );
  }

  if (settlementReadiness.authority !== "MONOLITH") {
    blockers.push("Settlement authority is not MONOLITH.");
  }

  if (settlementReadiness.comparisonMode !== "ENABLED") {
    blockers.push("Settlement comparison mode is not enabled.");
  }

  if (settlementReadiness.rollbackReadinessStatus === "BLOCKED") {
    blockers.push("Settlement rollback readiness is blocked.");
  }

  return Array.from(new Set(blockers));
}

function getRecommendedState({
  authority,
  dryRunEnabled,
  hasDryRunApproval,
  hasPromotionApproval,
  hasPromotionBlockers,
  adjustedReady,
}: {
  authority: ReturnType<typeof getAuthorityStatus>["settlement"]["authority"];
  dryRunEnabled: boolean;
  hasDryRunApproval: boolean;
  hasPromotionApproval: boolean;
  hasPromotionBlockers: boolean;
  adjustedReady: boolean;
}): AuthorityPromotionCandidateState {
  if (authority === "SERVICE") return "PROMOTED";
  if (hasPromotionBlockers) return "BLOCKED";
  if (hasPromotionApproval && hasDryRunApproval) return "APPROVED_FOR_PROMOTION";
  if (dryRunEnabled && hasDryRunApproval) return "DRY_RUN_ACTIVE";
  if (hasDryRunApproval) return "APPROVED_FOR_DRY_RUN";
  if (adjustedReady) return "READY_FOR_REVIEW";

  return "BLOCKED";
}

function getApprovalRequirements({
  currentState,
  hasDryRunApproval,
  hasPromotionApproval,
}: {
  currentState: AuthorityPromotionCandidateState;
  hasDryRunApproval: boolean;
  hasPromotionApproval: boolean;
}) {
  const requirements: string[] = [];

  if (!hasDryRunApproval) {
    requirements.push("DRY_RUN_APPROVAL is required before dry-run activation.");
  }

  if (currentState === "APPROVED_FOR_DRY_RUN" || currentState === "DRY_RUN_ACTIVE") {
    requirements.push("Dry-run evidence must be reviewed before promotion approval.");
  }

  if (!hasPromotionApproval) {
    requirements.push("PROMOTION_APPROVAL is required before authority promotion.");
  }

  requirements.push("ROLLBACK_APPROVAL is required before any future rollback action.");

  return requirements;
}

export async function getAuthorityApprovalHistory(
  authorityCandidate?: AuthorityDomain
): Promise<AuthorityApprovalHistory> {
  return {
    approvals: await listAuthorityApprovalRecords({ authorityCandidate }),
    generatedAt: new Date().toISOString(),
  };
}

export async function getAuthorityApprovalStatus(): Promise<AuthorityApprovalStatus> {
  const [history, settlementReadiness, shadowAnalysis] = await Promise.all([
    getAuthorityApprovalHistory("SETTLEMENT"),
    getSettlementAuthorityReadiness(),
    getShadowAnalysisSummary("all"),
  ]);
  const approvals = history.approvals;
  const dryRunApproval = latestApproval(approvals, "DRY_RUN_APPROVAL");
  const promotionApproval = latestApproval(approvals, "PROMOTION_APPROVAL");
  const rollbackApproval = latestApproval(approvals, "ROLLBACK_APPROVAL");
  const promotionSettlementReadiness =
    shadowAnalysis.domains.settlement.promotionReadiness;
  const promotionBlockers = getBasePromotionBlockers({
    settlementReadiness,
    promotionSettlementReadiness,
  });
  const hasDryRunApproval = Boolean(dryRunApproval);
  const hasPromotionApproval = Boolean(promotionApproval);
  const currentState = getRecommendedState({
    authority: settlementReadiness.authority,
    dryRunEnabled: settlementReadiness.dryRunMode === "ENABLED",
    hasDryRunApproval,
    hasPromotionApproval,
    hasPromotionBlockers: false,
    adjustedReady: promotionSettlementReadiness.readinessStatus === "READY",
  });
  const recommendedState = getRecommendedState({
    authority: settlementReadiness.authority,
    dryRunEnabled: settlementReadiness.dryRunMode === "ENABLED",
    hasDryRunApproval,
    hasPromotionApproval,
    hasPromotionBlockers: promotionBlockers.length > 0,
    adjustedReady: promotionSettlementReadiness.readinessStatus === "READY",
  });

  return {
    authorityCandidate: "SETTLEMENT",
    currentState,
    recommendedState,
    approvalRequirements: getApprovalRequirements({
      currentState,
      hasDryRunApproval,
      hasPromotionApproval,
    }),
    promotionBlockers,
    rollbackReadiness: settlementReadiness.rollbackReadinessStatus,
    latestApprovals: {
      dryRunApproval,
      promotionApproval,
      rollbackApproval,
    },
    evaluatedAt: new Date().toISOString(),
  };
}

export async function getSettlementDryRunEvaluation(): Promise<SettlementDryRunEvaluation> {
  const [approvalStatus, settlementReadiness, shadowAnalysis] = await Promise.all([
    getAuthorityApprovalStatus(),
    getSettlementAuthorityReadiness(),
    getShadowAnalysisSummary("all"),
  ]);
  const rawEvidence = shadowAnalysis.domains.settlement.rawReadiness;
  const adjustedEvidence = shadowAnalysis.domains.settlement.adjustedReadiness;
  const promotionEvidence = shadowAnalysis.domains.settlement.promotionReadiness;
  const wouldThresholdsBeExceeded =
    rawEvidence.mismatchRate >= settlementReadiness.thresholds.mismatchAlertThreshold ||
    rawEvidence.failureRate >= settlementReadiness.thresholds.rollbackFailureThreshold ||
    rawEvidence.criticalMismatchCount > 0;
  const wouldRollbackTrigger =
    settlementReadiness.rollbackReadinessStatus === "BLOCKED" ||
    wouldThresholdsBeExceeded;
  const wouldPromotionBeAllowed =
    approvalStatus.currentState === "APPROVED_FOR_PROMOTION" &&
    !wouldRollbackTrigger &&
    promotionEvidence.readinessStatus === "READY";

  return {
    authorityCandidate: "SETTLEMENT",
    currentState: approvalStatus.currentState,
    ifServiceBecameAuthoritativeNow: {
      wouldRollbackTrigger,
      wouldThresholdsBeExceeded,
      wouldPromotionBeAllowed,
    },
    rawEvidence: {
      readiness: rawEvidence.readinessStatus,
      mismatchRate: rawEvidence.mismatchRate,
      failureRate: rawEvidence.failureRate,
    },
    adjustedEvidence: {
      readiness: adjustedEvidence.readinessStatus,
      mismatchRate: adjustedEvidence.mismatchRate,
      failureRate: adjustedEvidence.failureRate,
    },
    promotionEvidence: {
      readiness: promotionEvidence.readinessStatus,
      mismatchRate: promotionEvidence.mismatchRate,
      failureRate: promotionEvidence.failureRate,
    },
    rollbackReadiness: settlementReadiness.rollbackReadinessStatus,
    promotionBlockers: approvalStatus.promotionBlockers,
    approvalRequirements: approvalStatus.approvalRequirements,
    evaluatedAt: new Date().toISOString(),
  };
}
