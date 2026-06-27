import { validateRollbackReadiness } from "../authority-control/authority-control.service";
import type { AuthorityDomain } from "../authority-control/authority-control.types";
import type {
  AuthorityApprovalRecord,
  AuthorityApprovalType,
} from "../authority-approval/authority-approval.types";
import { getCreditAuthorityReadiness } from "../credit-authority/credit-authority.service";
import { getLedgerAuthorityReadiness } from "../ledger-authority/ledger-authority.service";
import { getSettlementAuthorityReadiness } from "../settlement-authority/settlement-authority.service";
import {
  getShadowAnalysisSummary,
  listShadowAnalysisFailures,
  listShadowAnalysisMismatches,
} from "../shadow-analysis/shadow-analysis.service";
import type {
  ClassifiedShadowEvidence,
} from "../shadow-analysis/shadow-analysis.types";
import type {
  PromotionDecision,
  PromotionDecisionState,
  PromotionEvidenceReadiness,
} from "./promotion-decision.types";
import { listPromotionApprovalRecords } from "./promotion-decision.repository";

function latestApproval(
  approvals: AuthorityApprovalRecord[],
  approvalType: AuthorityApprovalType
) {
  return (
    approvals.find(
      (approval) =>
        approval.approvalType === approvalType &&
        approval.metadata?.remediationWorkflow !== "LEDGER_REFERENCE_REMEDIATION"
    ) ?? null
  );
}

function toEvidenceReadiness(input: {
  readinessStatus: "READY" | "WARNING" | "BLOCKED";
  mismatchRate: number;
  failureRate: number;
  criticalMismatchCount: number;
}): PromotionEvidenceReadiness {
  return {
    readiness: input.readinessStatus,
    mismatchRate: input.mismatchRate,
    failureRate: input.failureRate,
    criticalMismatchCount: input.criticalMismatchCount,
  };
}

function lifecycleParticipatesInPromotion(evidence: ClassifiedShadowEvidence) {
  return (
    evidence.lifecycleStatus === "ACTIVE" ||
    evidence.lifecycleStatus === "REVIEW_REQUIRED"
  );
}

function isUnexplainedFailure(evidence: ClassifiedShadowEvidence) {
  return (
    evidence.evidenceClass === "UNEXPLAINED_FAILURE" ||
    evidence.evidenceClass === "INSUFFICIENT_CONTEXT"
  );
}

function isCriticalUnexplainedMismatch(evidence: ClassifiedShadowEvidence) {
  return (
    evidence.severity === "CRITICAL" &&
    evidence.evidenceClass !== "QA_INTENTIONAL_MISMATCH" &&
    evidence.evidenceClass !== "EXPECTED_TEST_VARIATION"
  );
}

function getRecommendation(decision: PromotionDecisionState) {
  if (decision === "READY_FOR_DRY_RUN_APPROVAL") {
    return "Record DRY_RUN_APPROVAL before dry-run activation.";
  }
  if (decision === "READY_FOR_PROMOTION_APPROVAL") {
    return "Review dry-run evidence and record PROMOTION_APPROVAL before controlled promotion.";
  }
  if (decision === "READY_FOR_CONTROLLED_PROMOTION") {
    return "Operator may plan a controlled promotion in a future phase; no automatic promotion is allowed.";
  }
  if (decision === "ROLLBACK_RECOMMENDED") {
    return "Rollback is recommended because service authority is active and rollback conditions are present.";
  }
  if (decision === "PROMOTED") {
    return "Service authority is already promoted; continue monitoring rollback readiness.";
  }
  if (decision === "READY_FOR_REVIEW") {
    return "Promotion evidence is ready for operator review.";
  }

  return "Resolve blocking reasons before promotion approval.";
}

function getDecisionState({
  currentAuthority,
  rollbackWouldTrigger,
  blockingReasons,
  hasDryRunApproval,
  hasPromotionApproval,
}: {
  currentAuthority: "MONOLITH" | "SERVICE";
  rollbackWouldTrigger: boolean;
  blockingReasons: string[];
  hasDryRunApproval: boolean;
  hasPromotionApproval: boolean;
}): PromotionDecisionState {
  if (currentAuthority === "SERVICE") {
    return rollbackWouldTrigger ? "ROLLBACK_RECOMMENDED" : "PROMOTED";
  }

  if (blockingReasons.length > 0) return "BLOCKED";
  if (!hasDryRunApproval) return "READY_FOR_DRY_RUN_APPROVAL";
  if (!hasPromotionApproval) return "READY_FOR_PROMOTION_APPROVAL";

  return "READY_FOR_CONTROLLED_PROMOTION";
}

export function parsePromotionDecisionDomain(
  value: string | null
): AuthorityDomain {
  if (value?.toUpperCase() === "LEDGER") return "LEDGER";
  if (value?.toUpperCase() === "CREDIT") return "CREDIT";

  return "SETTLEMENT";
}

export async function getPromotionDecision({
  domain = "SETTLEMENT",
}: {
  domain?: AuthorityDomain;
} = {}): Promise<PromotionDecision> {
  const isLedger = domain === "LEDGER";
  const isCredit = domain === "CREDIT";
  const [
    authorityReadiness,
    rollbackReadiness,
    shadowAnalysis,
    approvals,
    mismatches,
    failures,
  ] = await Promise.all([
    isCredit
      ? getCreditAuthorityReadiness()
      : isLedger
        ? getLedgerAuthorityReadiness()
        : getSettlementAuthorityReadiness(),
    validateRollbackReadiness(),
    getShadowAnalysisSummary("all"),
    listPromotionApprovalRecords(domain),
    listShadowAnalysisMismatches("all"),
    listShadowAnalysisFailures("all"),
  ]);
  const dryRunApproval = latestApproval(approvals, "DRY_RUN_APPROVAL");
  const promotionApproval = latestApproval(approvals, "PROMOTION_APPROVAL");
  const rollbackApproval = latestApproval(approvals, "ROLLBACK_APPROVAL");
  const domainEvidence = isCredit
    ? shadowAnalysis.domains.credit
    : isLedger
    ? shadowAnalysis.domains.ledger
    : shadowAnalysis.domains.settlement;
  const promotionMismatches = mismatches.filter(
    (evidence) =>
      evidence.domain === domain &&
      lifecycleParticipatesInPromotion(evidence)
  );
  const promotionFailures = failures.filter(
    (evidence) =>
      evidence.domain === domain &&
      lifecycleParticipatesInPromotion(evidence)
  );
  const criticalUnexplainedMismatches = promotionMismatches.filter(
    isCriticalUnexplainedMismatch
  );
  const unexplainedFailures = promotionFailures.filter(isUnexplainedFailure);
  const blockingReasons: string[] = [];
  const warnings: string[] = [];
  const domainRollback = isCredit
    ? rollbackReadiness.credit
    : isLedger
      ? rollbackReadiness.ledger
      : rollbackReadiness.settlement;
  const serviceHealth = domainRollback.serviceHealth;
  const label = isCredit ? "Credit" : isLedger ? "Ledger" : "Settlement";

  if (domainEvidence.promotionReadiness.readinessStatus !== "READY") {
    blockingReasons.push(
      `Promotion evidence is ${domainEvidence.promotionReadiness.readinessStatus}.`
    );
  }
  if (domainRollback.rollbackStatus === "BLOCKED") {
    blockingReasons.push("Rollback readiness is BLOCKED.");
  }
  if (!serviceHealth.available) {
    blockingReasons.push(`${label} Service health is unavailable.`);
  }
  if (criticalUnexplainedMismatches.length > 0) {
    blockingReasons.push(
      `Critical unexplained ${label.toLowerCase()} mismatches are present.`
    );
  }
  if (unexplainedFailures.length > 0) {
    blockingReasons.push(
      `Unexplained ${label.toLowerCase()} shadow failures are present.`
    );
  }
  if (authorityReadiness.comparisonMode !== "ENABLED") {
    blockingReasons.push(`${label} comparison mode is not ENABLED.`);
  }

  if (authorityReadiness.authority !== "MONOLITH") {
    warnings.push(`${label} authority is not MONOLITH.`);
  }
  if (domainEvidence.rawReadiness.readinessStatus !== "READY") {
    warnings.push("Raw evidence is not READY and must remain visible for review.");
  }
  if (!dryRunApproval) {
    warnings.push("DRY_RUN_APPROVAL is missing.");
  }
  if (!promotionApproval) {
    warnings.push("PROMOTION_APPROVAL is missing.");
  }

  const rollbackWouldTrigger =
    authorityReadiness.authority === "SERVICE" && blockingReasons.length > 0;
  const decision = getDecisionState({
    currentAuthority: authorityReadiness.authority,
    rollbackWouldTrigger,
    blockingReasons,
    hasDryRunApproval: Boolean(dryRunApproval),
    hasPromotionApproval: Boolean(promotionApproval),
  });

  return {
    domain,
    decision,
    currentAuthority: authorityReadiness.authority,
    comparisonMode: authorityReadiness.comparisonMode,
    dryRunMode: authorityReadiness.dryRunMode,
    rawReadiness: toEvidenceReadiness(domainEvidence.rawReadiness),
    adjustedReadiness: toEvidenceReadiness(domainEvidence.adjustedReadiness),
    promotionReadiness: toEvidenceReadiness(domainEvidence.promotionReadiness),
    rollbackReadiness: domainRollback.rollbackStatus,
    approvalState: {
      dryRunApproval,
      promotionApproval,
      rollbackApproval,
      approvalHistoryCount: approvals.length,
    },
    blockingReasons: Array.from(new Set(blockingReasons)),
    warnings: Array.from(new Set(warnings)),
    recommendation: getRecommendation(decision),
    evaluatedAt: new Date().toISOString(),
  };
}
