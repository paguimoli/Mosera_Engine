import type { AuthorityDomain } from "../authority-control/authority-control.types";
import type { AuthenticatedUser } from "../auth/auth-context.types";
import { createOutboxEvent } from "../outbox/outbox.service";
import { getPromotionDecision } from "../promotion-decision/promotion-decision.service";
import type {
  AuthorityApprovalHistory,
  AuthorityApprovalRecord,
  AuthorityApprovalStatus,
  AuthorityApprovalType,
  AuthorityPromotionCandidateState,
  SettlementDryRunEvaluation,
} from "./authority-approval.types";
import {
  createAuthorityApprovalRecord,
  findAuthorityApprovalRecordByCorrelationId,
  listAuthorityApprovalRecords,
} from "./authority-approval.repository";

export class AuthorityApprovalValidationError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "AuthorityApprovalValidationError";
    this.status = status;
  }
}

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

function normalizeJustification(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAcknowledgedWarnings(value: unknown) {
  if (!Array.isArray(value)) return [];

  return value
    .filter((warning): warning is string => typeof warning === "string")
    .map((warning) => warning.trim())
    .filter(Boolean);
}

function normalizeCorrelationId(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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

export async function approveAuthorityDryRun({
  actor,
  domain,
  justification,
  acknowledgedWarnings,
  correlationId,
}: {
  actor: AuthenticatedUser;
  domain: unknown;
  justification: unknown;
  acknowledgedWarnings: unknown;
  correlationId?: unknown;
}): Promise<{
  approval: AuthorityApprovalRecord;
  idempotent: boolean;
  promotionDecisionBefore: Awaited<ReturnType<typeof getPromotionDecision>>;
  promotionDecisionAfter: Awaited<ReturnType<typeof getPromotionDecision>>;
}> {
  if (domain !== "SETTLEMENT" && domain !== "LEDGER" && domain !== "CREDIT") {
    throw new AuthorityApprovalValidationError(
      "Only SETTLEMENT, LEDGER, and CREDIT dry-run approval are supported."
    );
  }

  const authorityCandidate = domain;
  const label =
    authorityCandidate === "CREDIT"
      ? "Credit"
      : authorityCandidate === "LEDGER"
        ? "Ledger"
        : "Settlement";
  const normalizedCorrelationId = normalizeCorrelationId(correlationId);
  if (normalizedCorrelationId) {
    const existingApproval = await findAuthorityApprovalRecordByCorrelationId({
      authorityCandidate,
      approvalType: "DRY_RUN_APPROVAL",
      correlationId: normalizedCorrelationId,
    });

    if (existingApproval) {
      const promotionDecision = await getPromotionDecision({ domain: authorityCandidate });

      return {
        approval: existingApproval,
        idempotent: true,
        promotionDecisionBefore: promotionDecision,
        promotionDecisionAfter: promotionDecision,
      };
    }
  }

  const normalizedJustification = normalizeJustification(justification);
  if (!normalizedJustification) {
    throw new AuthorityApprovalValidationError("Justification is required.");
  }

  const normalizedAcknowledgedWarnings =
    normalizeAcknowledgedWarnings(acknowledgedWarnings);
  const promotionDecisionBefore = await getPromotionDecision({ domain: authorityCandidate });

  if (promotionDecisionBefore.decision !== "READY_FOR_DRY_RUN_APPROVAL") {
    throw new AuthorityApprovalValidationError(
      `${label} is not ready for dry-run approval.`,
      409
    );
  }

  if (promotionDecisionBefore.rollbackReadiness !== "READY") {
    throw new AuthorityApprovalValidationError(
      `${label} rollback readiness must be READY before dry-run approval.`,
      409
    );
  }

  if (promotionDecisionBefore.comparisonMode !== "ENABLED") {
    throw new AuthorityApprovalValidationError(
      `${label} comparison mode must be ENABLED before dry-run approval.`,
      409
    );
  }

  if (promotionDecisionBefore.currentAuthority !== "MONOLITH") {
    throw new AuthorityApprovalValidationError(
      `${label} authority must remain MONOLITH before dry-run approval.`,
      409
    );
  }

  const missingAcknowledgements = promotionDecisionBefore.warnings.filter(
    (warning) => !normalizedAcknowledgedWarnings.includes(warning)
  );

  if (missingAcknowledgements.length > 0) {
    throw new AuthorityApprovalValidationError(
      "All dry-run approval warnings must be acknowledged before approval."
    );
  }

  const approval = await createAuthorityApprovalRecord({
    authorityCandidate,
    approvalType: "DRY_RUN_APPROVAL",
    approverUserId: actor.id,
    approverUsername: actor.username,
    justification: normalizedJustification,
    metadata: {
      acknowledgedWarnings: normalizedAcknowledgedWarnings,
      approvalCapturedAt: new Date().toISOString(),
      correlationId: normalizedCorrelationId,
      promotionDecisionBefore: promotionDecisionBefore.decision,
    },
  });

  await createOutboxEvent({
    eventType:
      authorityCandidate === "CREDIT"
        ? "authority.credit.dry_run.approved"
        : authorityCandidate === "LEDGER"
          ? "authority.ledger.dry_run.approved"
          : "authority.dry_run.approved",
    aggregateType: "authority_candidate",
    aggregateId: authorityCandidate,
    correlationId: normalizedCorrelationId,
    payload: {
      domain: authorityCandidate,
      actorUserId: actor.id,
      approvalId: approval.id,
      correlationId: normalizedCorrelationId,
      createdAt: approval.createdAt,
    },
  });

  const promotionDecisionAfter = await getPromotionDecision({ domain: authorityCandidate });

  return {
    approval,
    idempotent: false,
    promotionDecisionBefore,
    promotionDecisionAfter,
  };
}

export async function approveAuthorityPromotion({
  actor,
  domain,
  justification,
  acknowledgedWarnings,
  correlationId,
}: {
  actor: AuthenticatedUser;
  domain: unknown;
  justification: unknown;
  acknowledgedWarnings: unknown;
  correlationId?: unknown;
}): Promise<{
  approval: AuthorityApprovalRecord;
  idempotent: boolean;
  promotionDecisionBefore: Awaited<ReturnType<typeof getPromotionDecision>>;
  promotionDecisionAfter: Awaited<ReturnType<typeof getPromotionDecision>>;
}> {
  if (domain !== "SETTLEMENT" && domain !== "LEDGER" && domain !== "CREDIT") {
    throw new AuthorityApprovalValidationError(
      "Only SETTLEMENT, LEDGER, and CREDIT promotion approval are supported."
    );
  }

  const authorityCandidate = domain;
  const label =
    authorityCandidate === "CREDIT"
      ? "Credit"
      : authorityCandidate === "LEDGER"
        ? "Ledger"
        : "Settlement";
  const normalizedCorrelationId = normalizeCorrelationId(correlationId);
  if (normalizedCorrelationId) {
    const existingApproval = await findAuthorityApprovalRecordByCorrelationId({
      authorityCandidate,
      approvalType: "PROMOTION_APPROVAL",
      correlationId: normalizedCorrelationId,
    });

    if (existingApproval) {
      const promotionDecision = await getPromotionDecision({ domain: authorityCandidate });

      return {
        approval: existingApproval,
        idempotent: true,
        promotionDecisionBefore: promotionDecision,
        promotionDecisionAfter: promotionDecision,
      };
    }
  }

  const normalizedJustification = normalizeJustification(justification);
  if (!normalizedJustification) {
    throw new AuthorityApprovalValidationError("Justification is required.");
  }

  const normalizedAcknowledgedWarnings =
    normalizeAcknowledgedWarnings(acknowledgedWarnings);
  const promotionDecisionBefore = await getPromotionDecision({ domain: authorityCandidate });

  if (promotionDecisionBefore.decision !== "READY_FOR_PROMOTION_APPROVAL") {
    throw new AuthorityApprovalValidationError(
      `${label} is not ready for promotion approval.`,
      409
    );
  }

  if (!promotionDecisionBefore.approvalState.dryRunApproval) {
    throw new AuthorityApprovalValidationError(
      "DRY_RUN_APPROVAL is required before promotion approval.",
      409
    );
  }

  if (promotionDecisionBefore.rollbackReadiness !== "READY") {
    throw new AuthorityApprovalValidationError(
      "Rollback readiness must be READY before promotion approval.",
      409
    );
  }

  if (promotionDecisionBefore.comparisonMode !== "ENABLED") {
    throw new AuthorityApprovalValidationError(
      `${label} comparison mode must be ENABLED before promotion approval.`,
      409
    );
  }

  if (promotionDecisionBefore.currentAuthority !== "MONOLITH") {
    throw new AuthorityApprovalValidationError(
      `${label} authority must remain MONOLITH before promotion approval.`,
      409
    );
  }

  const missingAcknowledgements = promotionDecisionBefore.warnings.filter(
    (warning) => !normalizedAcknowledgedWarnings.includes(warning)
  );
  if (missingAcknowledgements.length > 0) {
    throw new AuthorityApprovalValidationError(
      "All promotion decision warnings must be acknowledged before promotion approval."
    );
  }

  const approval = await createAuthorityApprovalRecord({
    authorityCandidate,
    approvalType: "PROMOTION_APPROVAL",
    approverUserId: actor.id,
    approverUsername: actor.username,
    justification: normalizedJustification,
    metadata: {
      acknowledgedWarnings: normalizedAcknowledgedWarnings,
      approvalCapturedAt: new Date().toISOString(),
      correlationId: normalizedCorrelationId,
      dryRunApprovalId: promotionDecisionBefore.approvalState.dryRunApproval.id,
      promotionDecisionBefore: promotionDecisionBefore.decision,
    },
  });

  await createOutboxEvent({
    eventType:
      authorityCandidate === "CREDIT"
        ? "authority.credit.promotion.approved"
        : authorityCandidate === "LEDGER"
          ? "authority.ledger.promotion.approved"
          : "authority.promotion.approved",
    aggregateType: "authority_candidate",
    aggregateId: authorityCandidate,
    correlationId: normalizedCorrelationId,
    payload: {
      domain: authorityCandidate,
      actorUserId: actor.id,
      approvalId: approval.id,
      correlationId: normalizedCorrelationId,
      createdAt: approval.createdAt,
    },
  });

  const promotionDecisionAfter = await getPromotionDecision({ domain: authorityCandidate });

  return {
    approval,
    idempotent: false,
    promotionDecisionBefore,
    promotionDecisionAfter,
  };
}

export const approveSettlementPromotion = approveAuthorityPromotion;

export async function getAuthorityApprovalStatus(
  authorityCandidate: AuthorityDomain = "SETTLEMENT"
): Promise<AuthorityApprovalStatus> {
  const [history, promotionDecision] = await Promise.all([
    getAuthorityApprovalHistory(authorityCandidate),
    getPromotionDecision({ domain: authorityCandidate }),
  ]);
  const approvals = history.approvals;
  const dryRunApproval = latestApproval(approvals, "DRY_RUN_APPROVAL");
  const promotionApproval = latestApproval(approvals, "PROMOTION_APPROVAL");
  const rollbackApproval = latestApproval(approvals, "ROLLBACK_APPROVAL");
  const hasDryRunApproval = Boolean(dryRunApproval);
  const hasPromotionApproval = Boolean(promotionApproval);

  return {
    authorityCandidate,
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
