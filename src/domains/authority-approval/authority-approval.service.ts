import type { AuthorityDomain } from "../authority-control/authority-control.types";
import { getPromotionDecision } from "../promotion-decision/promotion-decision.service";
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
  const [history, promotionDecision] = await Promise.all([
    getAuthorityApprovalHistory("SETTLEMENT"),
    getPromotionDecision({ domain: "SETTLEMENT" }),
  ]);
  const approvals = history.approvals;
  const dryRunApproval = latestApproval(approvals, "DRY_RUN_APPROVAL");
  const promotionApproval = latestApproval(approvals, "PROMOTION_APPROVAL");
  const rollbackApproval = latestApproval(approvals, "ROLLBACK_APPROVAL");
  const hasDryRunApproval = Boolean(dryRunApproval);
  const hasPromotionApproval = Boolean(promotionApproval);

  return {
    authorityCandidate: "SETTLEMENT",
    currentState: promotionDecision.decision,
    recommendedState: promotionDecision.decision,
    approvalRequirements: getApprovalRequirements({
      currentState: promotionDecision.decision,
      hasDryRunApproval,
      hasPromotionApproval,
    }),
    promotionBlockers: promotionDecision.blockingReasons,
    rollbackReadiness: promotionDecision.rollbackReadiness,
    latestApprovals: {
      dryRunApproval,
      promotionApproval,
      rollbackApproval,
    },
    evaluatedAt: new Date().toISOString(),
  };
}

export async function getSettlementDryRunEvaluation(): Promise<SettlementDryRunEvaluation> {
  const promotionDecision = await getPromotionDecision({ domain: "SETTLEMENT" });
  const wouldThresholdsBeExceeded =
    promotionDecision.promotionReadiness.readiness !== "READY";
  const wouldRollbackTrigger =
    promotionDecision.decision === "ROLLBACK_RECOMMENDED" ||
    promotionDecision.blockingReasons.length > 0;
  const wouldPromotionBeAllowed =
    promotionDecision.decision === "READY_FOR_CONTROLLED_PROMOTION" &&
    !wouldRollbackTrigger &&
    promotionDecision.promotionReadiness.readiness === "READY";

  return {
    authorityCandidate: "SETTLEMENT",
    currentState: promotionDecision.decision,
    ifServiceBecameAuthoritativeNow: {
      wouldRollbackTrigger,
      wouldThresholdsBeExceeded,
      wouldPromotionBeAllowed,
    },
    rawEvidence: {
      readiness: promotionDecision.rawReadiness.readiness,
      mismatchRate: promotionDecision.rawReadiness.mismatchRate,
      failureRate: promotionDecision.rawReadiness.failureRate,
    },
    adjustedEvidence: {
      readiness: promotionDecision.adjustedReadiness.readiness,
      mismatchRate: promotionDecision.adjustedReadiness.mismatchRate,
      failureRate: promotionDecision.adjustedReadiness.failureRate,
    },
    promotionEvidence: {
      readiness: promotionDecision.promotionReadiness.readiness,
      mismatchRate: promotionDecision.promotionReadiness.mismatchRate,
      failureRate: promotionDecision.promotionReadiness.failureRate,
    },
    rollbackReadiness: promotionDecision.rollbackReadiness,
    promotionBlockers: promotionDecision.blockingReasons,
    approvalRequirements: getApprovalRequirements({
      currentState: promotionDecision.decision,
      hasDryRunApproval: Boolean(promotionDecision.approvalState.dryRunApproval),
      hasPromotionApproval: Boolean(
        promotionDecision.approvalState.promotionApproval
      ),
    }),
    evaluatedAt: new Date().toISOString(),
  };
}
