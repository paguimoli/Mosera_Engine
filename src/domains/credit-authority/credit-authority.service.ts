import {
  getAuthorityStatus,
  validateRollbackReadiness,
} from "../authority-control/authority-control.service";
import { setRuntimeAuthorityDomainConfiguration } from "../authority-control/authority-control.repository";
import {
  createAuthorityApprovalRecord,
  findAuthorityApprovalRecordByCorrelationId,
} from "../authority-approval/authority-approval.repository";
import type {
  AuthorityApprovalRecord,
  AuthorityApprovalType,
} from "../authority-approval/authority-approval.types";
import type { AuthenticatedUser } from "../auth/auth-context.types";
import { getLedgerStabilizationStatus } from "../ledger-authority/ledger-authority.service";
import {
  checkFinancialAuthorityServiceReadiness,
  evaluateFinancialAuthorityGuardrail,
  readFinancialAuthorityCapabilityEvidenceFromEnv,
} from "../financial-authority/financial-authority-guardrails";
import { createOutboxEvent, listRecentOutboxEvents } from "../outbox/outbox.service";
import { getPromotionDecision } from "../promotion-decision/promotion-decision.service";
import { getSettlementStabilizationStatus } from "../settlement-stabilization/settlement-stabilization.service";
import {
  getShadowAnalysisSummary,
  listShadowAnalysisFailures,
  listShadowAnalysisMismatches,
} from "../shadow-analysis/shadow-analysis.service";
import type { ClassifiedShadowEvidence } from "../shadow-analysis/shadow-analysis.types";
import {
  getCreditShadowMismatches,
  getCreditShadowRuns,
  getCreditShadowSummary,
  getCreditShadowFailures,
} from "../credit-shadow/credit-shadow-reporting.service";
import { listCreditAuthorityApprovalRecords } from "./credit-authority.repository";
import type {
  CreditAuthorityCandidateStatus,
  CreditAuthorityDryRunMode,
  CreditAuthorityMetrics,
  CreditAuthorityReadiness,
  CreditAuthorityRuntimeRoute,
  CreditAuthorityPromotion,
  CreditCertificationInput,
  CreditCertificationResult,
  CreditCertificationStatus,
  CreditDryRunEvaluation,
  CreditPostPromotionStatus,
  CreditPromotionStatus,
  CreditRollbackDrill,
  CreditRollbackEvaluationDetails,
  CreditStabilizationStatus,
  CreditRollbackTriggerEvidenceSource,
  CreditRollbackTriggerEvidenceSummary,
  CreditRollbackTriggerEvaluation,
  CreditSimulationResult,
} from "./credit-authority.types";

export class CreditAuthorityValidationError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "CreditAuthorityValidationError";
    this.status = status;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function getNumberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);

  return Number.isFinite(value) ? value : fallback;
}

function getDryRunMode(): CreditAuthorityDryRunMode {
  return process.env.CREDIT_AUTHORITY_DRY_RUN_MODE === "ENABLED"
    ? "ENABLED"
    : "DISABLED";
}

function rate(part: number, total: number) {
  if (total === 0) return 0;

  return Number((part / total).toFixed(6));
}

function maxStatus(
  statuses: CreditAuthorityCandidateStatus[]
): CreditAuthorityCandidateStatus {
  if (statuses.includes("BLOCKED")) return "BLOCKED";
  if (statuses.includes("WARNING")) return "WARNING";

  return "READY";
}

function getThresholds() {
  return {
    mismatchAlertThreshold: getNumberEnv("CREDIT_MISMATCH_ALERT_THRESHOLD", 0.001),
    rollbackFailureThreshold: getNumberEnv(
      "CREDIT_ROLLBACK_FAILURE_THRESHOLD",
      0.001
    ),
  };
}

function validationResult(name: string, passed: boolean, message: string) {
  return { name, passed, message };
}

function collectBlockers(
  results: Array<{ name: string; passed: boolean; message: string }>
) {
  return results.filter((result) => !result.passed).map((result) => result.message);
}

function normalizeCorrelationId(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeJustification(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAcknowledgedWarnings(value: unknown) {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getPromotionMetadata() {
  return {
    promotedAt: process.env.CREDIT_PROMOTED_AT || null,
    promotionApprovalId: process.env.CREDIT_PROMOTION_APPROVAL_ID || null,
  };
}

async function getLatestPromotionEventMetadata() {
  const events = await listRecentOutboxEvents({ limit: 10000 });
  const promotionEvent = events.find(
    (event) =>
      event.eventType === "authority.credit.promoted" &&
      event.aggregateType === "authority_candidate" &&
      event.aggregateId === "CREDIT"
  );
  const payload = promotionEvent?.payload ?? {};

  return {
    promotedAt:
      typeof payload.promotedAt === "string"
        ? payload.promotedAt
        : promotionEvent?.createdAt ?? null,
    promotionApprovalId:
      typeof payload.promotionApprovalId === "string"
        ? payload.promotionApprovalId
        : null,
  };
}

export async function resolveCreditAuthorityRoute(): Promise<CreditAuthorityRuntimeRoute> {
  const authority = getAuthorityStatus().credit;
  const dryRunMode = getDryRunMode();
  const reasons: string[] = [];

  reasons.push(
    authority.authority === "MONOLITH"
      ? "Monolith credit wallet remains authoritative."
      : "Credit Wallet Service is configured as authoritative."
  );

  if (authority.comparisonMode === "ENABLED") {
    reasons.push(
      authority.authority === "SERVICE"
        ? "Monolith credit wallet remains available for comparison."
        : "Credit Wallet Service remains available for comparison."
    );
  } else {
    reasons.push("Credit comparison mode is disabled.");
  }

  if (dryRunMode === "ENABLED") {
    reasons.push("Credit authority dry-run mode is enabled.");
  }

  return {
    authoritativePath: authority.authority,
    comparisonMode: authority.comparisonMode,
    comparisonPath:
      authority.comparisonMode === "ENABLED"
        ? authority.authority === "SERVICE"
          ? "MONOLITH"
          : "CREDIT_SERVICE"
        : null,
    dryRunMode,
    productionCutoverActive: authority.authority === "SERVICE",
    reasons,
  };
}

async function getMetrics(): Promise<CreditAuthorityMetrics> {
  const [summary, mismatches] = await Promise.all([
    getCreditShadowSummary(),
    getCreditShadowMismatches({ limit: 10000 }),
  ]);
  const totalEvents = summary.totalRuns + summary.failures;

  return {
    totalRuns: summary.totalRuns,
    matches: summary.matches,
    mismatches: summary.mismatches,
    failures: summary.failures,
    mismatchRate: rate(summary.mismatches, totalEvents),
    failureRate: rate(summary.failures, totalEvents),
    criticalMismatchPresent: mismatches.some(
      (mismatch) => mismatch.severity === "CRITICAL"
    ),
    shadowReadinessStatus: summary.readiness.status,
  };
}

function evaluateRollbackTrigger({
  metrics,
  rollbackReadinessStatus,
  authority,
}: {
  metrics: CreditAuthorityMetrics | null;
  rollbackReadinessStatus: CreditAuthorityCandidateStatus;
  authority: ReturnType<typeof getAuthorityStatus>["credit"];
}): CreditRollbackTriggerEvaluation {
  const thresholds = getThresholds();
  const reasons: string[] = [];

  if (!metrics) {
    return {
      shouldTriggerRollback: false,
      status: "WARNING",
      reasons: ["Credit shadow metrics are unavailable."],
    };
  }

  if (metrics.criticalMismatchPresent) {
    reasons.push("Critical credit shadow mismatches are present.");
  }
  if (metrics.mismatchRate >= thresholds.mismatchAlertThreshold) {
    reasons.push("Credit mismatch rate is at or above alert threshold.");
  }
  if (metrics.failureRate >= thresholds.rollbackFailureThreshold) {
    reasons.push("Credit shadow failure rate is at or above rollback threshold.");
  }
  if (rollbackReadinessStatus === "BLOCKED") {
    reasons.push("Credit rollback readiness is blocked.");
  }

  const shouldTriggerRollback =
    authority.authority === "SERVICE" && reasons.length > 0;

  if (!shouldTriggerRollback && reasons.length === 0) {
    reasons.push("No automatic credit rollback trigger is active.");
  }

  return {
    shouldTriggerRollback,
    status: shouldTriggerRollback ? "BLOCKED" : reasons.length > 0 ? "WARNING" : "READY",
    reasons,
  };
}

export async function getCreditAuthorityReadiness(): Promise<CreditAuthorityReadiness> {
  const authorityStatus = getAuthorityStatus();
  const creditAuthority = authorityStatus.credit;
  const route = await resolveCreditAuthorityRoute();
  const rollbackReadiness = await validateRollbackReadiness();
  const rollbackReadinessStatus = rollbackReadiness.credit.rollbackStatus;
  const capabilityEvidence = readFinancialAuthorityCapabilityEvidenceFromEnv("CREDIT");
  const readinessHealthy = await checkFinancialAuthorityServiceReadiness(
    creditAuthority.serviceUrl
  );
  const productionGuardrail = evaluateFinancialAuthorityGuardrail({
    config: creditAuthority,
    serviceReachable: rollbackReadiness.credit.serviceHealth.available,
    readinessHealthy,
    ...capabilityEvidence,
  });
  const thresholds = getThresholds();
  const readinessReasons: string[] = [];
  const remainingBlockers: string[] = [];
  let metrics: CreditAuthorityMetrics | null = null;

  try {
    metrics = await getMetrics();
  } catch (error) {
    remainingBlockers.push(
      error instanceof Error ? error.message : "Credit shadow metrics are unavailable."
    );
  }

  if (productionGuardrail.productionStatus === "MONOLITH_ALLOWED") {
    readinessReasons.push("Credit authority remains MONOLITH.");
  } else if (productionGuardrail.productionReady) {
    readinessReasons.push("Credit Wallet Service production mutation capability guardrail passed.");
  } else {
    remainingBlockers.push(...productionGuardrail.blockers);
  }

  if (creditAuthority.comparisonMode !== "ENABLED") {
    remainingBlockers.push("Credit comparison mode is disabled.");
  } else {
    readinessReasons.push("Credit comparison mode is enabled.");
  }

  if (rollbackReadinessStatus === "BLOCKED") {
    remainingBlockers.push("Credit rollback readiness is blocked.");
  } else {
    readinessReasons.push(`Credit rollback readiness is ${rollbackReadinessStatus}.`);
  }

  if (metrics) {
    if (metrics.criticalMismatchPresent) {
      remainingBlockers.push("Critical credit mismatches are present.");
    }
    if (metrics.mismatchRate >= thresholds.mismatchAlertThreshold) {
      remainingBlockers.push("Credit mismatch threshold is exceeded.");
    }
    readinessReasons.push(`Credit shadow readiness is ${metrics.shadowReadinessStatus}.`);
  }

  readinessReasons.push(
    route.dryRunMode === "ENABLED"
      ? "Credit authority dry-run mode is enabled."
      : "Credit authority dry-run mode is disabled."
  );

  const rollbackTrigger = evaluateRollbackTrigger({
    metrics,
    rollbackReadinessStatus,
    authority: creditAuthority,
  });
  const status = maxStatus([
    remainingBlockers.length > 0 ? "BLOCKED" : "READY",
    rollbackTrigger.status,
    metrics?.shadowReadinessStatus ?? "WARNING",
  ]);

  return {
    status,
    authority: creditAuthority.authority,
    comparisonMode: creditAuthority.comparisonMode,
    dryRunMode: route.dryRunMode,
    runtimeRoute: route,
    productionGuardrail,
    metrics,
    thresholds,
    rollbackReadinessStatus,
    rollbackTrigger,
    readinessReasons,
    remainingBlockers,
    evaluatedAt: nowIso(),
  };
}

function approvalRequirements({
  hasDryRunApproval,
  hasPromotionApproval,
}: {
  hasDryRunApproval: boolean;
  hasPromotionApproval: boolean;
}) {
  const requirements: string[] = [];

  if (!hasDryRunApproval) {
    requirements.push("DRY_RUN_APPROVAL is required before credit dry-run activation.");
  }
  if (!hasPromotionApproval) {
    requirements.push("PROMOTION_APPROVAL is required before credit authority promotion.");
  }
  requirements.push("ROLLBACK_APPROVAL is required before any future credit rollback action.");

  return requirements;
}

function latestApproval(
  approvals: Awaited<ReturnType<typeof listCreditAuthorityApprovalRecords>>,
  approvalType: AuthorityApprovalType
) {
  return approvals.find((approval) => approval.approvalType === approvalType) ?? null;
}

function lifecycleParticipatesInRollback(evidence: ClassifiedShadowEvidence) {
  return (
    evidence.lifecycleStatus === "ACTIVE" ||
    evidence.lifecycleStatus === "REVIEW_REQUIRED"
  );
}

function getPostPromotionEvidenceSummary(
  domainEvidence: Awaited<ReturnType<typeof getShadowAnalysisSummary>>["domains"]["credit"]
) {
  return {
    totalRuns: 0,
    matches: 0,
    mismatches: 0,
    failures: 0,
    criticalMismatchCount: 0,
    readiness: domainEvidence.promotionReadiness.readinessStatus,
  };
}

export async function getCreditDryRunEvaluation(): Promise<CreditDryRunEvaluation> {
  const [promotionDecision, approvals, shadowAnalysis] = await Promise.all([
    getPromotionDecision({ domain: "CREDIT" }),
    listCreditAuthorityApprovalRecords(),
    getShadowAnalysisSummary("all"),
  ]);
  const wouldThresholdsBeExceeded =
    promotionDecision.promotionReadiness.readiness !== "READY";
  const wouldRollbackTrigger =
    promotionDecision.decision === "ROLLBACK_RECOMMENDED" ||
    promotionDecision.blockingReasons.length > 0;

  return {
    authorityCandidate: "CREDIT",
    currentState: promotionDecision.decision,
    ifServiceBecameAuthoritativeNow: {
      wouldRollbackTrigger,
      wouldThresholdsBeExceeded,
      wouldPromotionBeAllowed:
        promotionDecision.decision === "READY_FOR_CONTROLLED_PROMOTION" &&
        !wouldRollbackTrigger &&
        !wouldThresholdsBeExceeded,
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
    postPromotionEvidence: getPostPromotionEvidenceSummary(
      shadowAnalysis.domains.credit
    ),
    rollbackReadiness: promotionDecision.rollbackReadiness,
    promotionBlockers: promotionDecision.blockingReasons,
    approvalRequirements: approvalRequirements({
      hasDryRunApproval: Boolean(latestApproval(approvals, "DRY_RUN_APPROVAL")),
      hasPromotionApproval: Boolean(latestApproval(approvals, "PROMOTION_APPROVAL")),
    }),
    evaluatedAt: nowIso(),
  };
}

function creditRollbackReadiness(summary: Awaited<ReturnType<typeof validateRollbackReadiness>>) {
  return summary.credit;
}

export async function simulateCreditPromotion({
  actorUserId,
  correlationId,
}: {
  actorUserId?: string | null;
  correlationId?: unknown;
} = {}): Promise<CreditSimulationResult> {
  const normalizedCorrelationId = normalizeCorrelationId(correlationId);
  const [promotionDecision, rollbackReadiness] = await Promise.all([
    getPromotionDecision({ domain: "CREDIT" }),
    validateRollbackReadiness(),
  ]);
  const creditRollback = creditRollbackReadiness(rollbackReadiness);
  const validationResults = [
    validationResult(
      "PROMOTION_DECISION_READY",
      promotionDecision.decision === "READY_FOR_CONTROLLED_PROMOTION",
      "Credit promotion decision must be READY_FOR_CONTROLLED_PROMOTION."
    ),
    validationResult(
      "DRY_RUN_APPROVAL_EXISTS",
      Boolean(promotionDecision.approvalState.dryRunApproval),
      "Credit DRY_RUN_APPROVAL must exist."
    ),
    validationResult(
      "PROMOTION_APPROVAL_EXISTS",
      Boolean(promotionDecision.approvalState.promotionApproval),
      "Credit PROMOTION_APPROVAL must exist."
    ),
    validationResult(
      "ROLLBACK_READY",
      promotionDecision.rollbackReadiness === "READY" &&
        creditRollback.rollbackStatus === "READY",
      "Credit rollback readiness must be READY."
    ),
    validationResult(
      "AUTHORITY_MONOLITH",
      promotionDecision.currentAuthority === "MONOLITH",
      "Credit authority must remain MONOLITH before controlled promotion."
    ),
    validationResult(
      "COMPARISON_ENABLED",
      promotionDecision.comparisonMode === "ENABLED",
      "Credit comparison mode must be ENABLED."
    ),
    validationResult(
      "SERVICE_HEALTHY",
      creditRollback.serviceHealth.available,
      "Credit Wallet Service health must be available."
    ),
  ];
  const blockers = collectBlockers(validationResults);
  const warnings = [...promotionDecision.warnings];
  const simulatedAt = nowIso();
  const auditEvent = await createOutboxEvent({
    eventType: "authority.credit.promotion.simulated",
    aggregateType: "authority_candidate",
    aggregateId: "CREDIT",
    correlationId: normalizedCorrelationId,
    payload: {
      domain: "CREDIT",
      actorUserId: actorUserId ?? null,
      currentAuthority: promotionDecision.currentAuthority,
      proposedAuthority: "SERVICE",
      simulatedAuthority: "SERVICE",
      comparisonMode: promotionDecision.comparisonMode,
      decision: promotionDecision.decision,
      rollbackReadiness: promotionDecision.rollbackReadiness,
      rollbackReady:
        promotionDecision.rollbackReadiness === "READY" &&
        creditRollback.rollbackStatus === "READY",
      promotionAllowed: blockers.length === 0,
      blockers,
      warnings,
      timestamp: simulatedAt,
      simulatedAt,
    },
  });

  return {
    domain: "CREDIT",
    currentAuthority: promotionDecision.currentAuthority,
    proposedAuthority: "SERVICE",
    simulatedAuthority: "SERVICE",
    comparisonMode: promotionDecision.comparisonMode,
    promotionDecision: promotionDecision.decision,
    rollbackReadiness: promotionDecision.rollbackReadiness,
    rollbackReady:
      promotionDecision.rollbackReadiness === "READY" &&
      creditRollback.rollbackStatus === "READY",
    serviceHealth: creditRollback.serviceHealth,
    validationResults,
    blockers,
    warnings,
    promotionAllowed: blockers.length === 0,
    auditEvent: {
      id: auditEvent.id,
      eventType: auditEvent.eventType,
      correlationId: auditEvent.correlationId ?? null,
    },
    simulatedAt,
  };
}

export async function simulateCreditRollback({
  actorUserId,
  correlationId,
}: {
  actorUserId?: string | null;
  correlationId?: unknown;
} = {}): Promise<CreditSimulationResult> {
  const normalizedCorrelationId = normalizeCorrelationId(correlationId);
  const [rollbackReadiness, promotionDecision, mismatches, failures] =
    await Promise.all([
      validateRollbackReadiness(),
      getPromotionDecision({ domain: "CREDIT" }),
      listShadowAnalysisMismatches("all"),
      listShadowAnalysisFailures("all"),
    ]);
  const creditRollback = creditRollbackReadiness(rollbackReadiness);
  const activeCreditEvidence = [...mismatches, ...failures].filter(
    (evidence) =>
      evidence.domain === "CREDIT" && lifecycleParticipatesInRollback(evidence)
  );
  const validationResults = [
    validationResult(
      "MONOLITH_PATH_AVAILABLE",
      creditRollback.monolithPathAvailable,
      "Credit monolith path must be available."
    ),
    validationResult(
      "COMPARISON_MODE_AVAILABLE",
      creditRollback.comparisonMode === "ENABLED",
      "Credit comparison mode must be ENABLED."
    ),
    validationResult(
      "AUTHORITY_CONTROLS_AVAILABLE",
      creditRollback.authority === "MONOLITH" || creditRollback.authority === "SERVICE",
      "Credit authority controls must be available."
    ),
    validationResult(
      "ROLLBACK_READY",
      creditRollback.rollbackStatus === "READY",
      "Credit rollback readiness must be READY."
    ),
    validationResult(
      "NO_ACTIVE_PROMOTION_EVIDENCE_BLOCKERS",
      activeCreditEvidence.length === 0,
      "Credit lifecycle-effective rollback evidence must be clear."
    ),
  ];
  const blockers = collectBlockers(validationResults);
  const warnings = creditRollback.reasons.filter(
    (reason) => reason !== "Authority and rollback controls are within ready thresholds."
  );
  const simulatedAt = nowIso();
  const auditEvent = await createOutboxEvent({
    eventType: "authority.credit.rollback.simulated",
    aggregateType: "authority_candidate",
    aggregateId: "CREDIT",
    correlationId: normalizedCorrelationId,
    payload: {
      domain: "CREDIT",
      actorUserId: actorUserId ?? null,
      authorityState: creditRollback.authority,
      comparisonMode: creditRollback.comparisonMode,
      decision: promotionDecision.decision,
      rollbackReadiness: creditRollback.rollbackStatus,
      rollbackReady: creditRollback.rollbackStatus === "READY",
      rollbackAllowed: blockers.length === 0,
      blockers,
      warnings,
      timestamp: simulatedAt,
      simulatedAt,
    },
  });

  return {
    domain: "CREDIT",
    authorityState: creditRollback.authority,
    simulatedAuthority: "MONOLITH",
    comparisonMode: creditRollback.comparisonMode,
    rollbackReadiness: creditRollback.rollbackStatus,
    rollbackReady: creditRollback.rollbackStatus === "READY",
    serviceHealth: creditRollback.serviceHealth,
    validationResults,
    blockers,
    warnings,
    rollbackAllowed: blockers.length === 0,
    auditEvent: {
      id: auditEvent.id,
      eventType: auditEvent.eventType,
      correlationId: auditEvent.correlationId ?? null,
    },
    simulatedAt,
  };
}

export async function promoteCreditAuthority({
  actor,
  domain,
  mode,
  justification,
  correlationId,
}: {
  actor: AuthenticatedUser;
  domain: unknown;
  mode: unknown;
  justification: unknown;
  correlationId?: unknown;
}): Promise<CreditAuthorityPromotion> {
  if (domain !== "CREDIT") {
    throw new CreditAuthorityValidationError("Only CREDIT promotion is supported.");
  }

  if (mode !== "EXECUTE") {
    throw new CreditAuthorityValidationError("Promotion mode must be EXECUTE.");
  }

  const normalizedJustification = normalizeJustification(justification);
  if (!normalizedJustification) {
    throw new CreditAuthorityValidationError("Justification is required.");
  }

  const normalizedCorrelationId = normalizeCorrelationId(correlationId);
  const authorityStatusBefore = getAuthorityStatus().credit;
  const promotionDecisionBefore = await getPromotionDecision({ domain: "CREDIT" });
  const promotionApproval = promotionDecisionBefore.approvalState.promotionApproval;

  if (authorityStatusBefore.authority === "SERVICE") {
    const rollbackReadiness = await validateRollbackReadiness();
    const metadata = getPromotionMetadata();

    return {
      domain: "CREDIT",
      previousAuthority: "SERVICE",
      newAuthority: "SERVICE",
      comparisonMode: "ENABLED",
      rollbackReadiness: rollbackReadiness.credit.rollbackStatus,
      promotionApprovalId:
        metadata.promotionApprovalId ?? promotionApproval?.id ?? null,
      promotedAt: metadata.promotedAt ?? nowIso(),
      correlationId: normalizedCorrelationId,
      idempotent: true,
      auditEvent: null,
    };
  }

  const simulation = await simulateCreditPromotion({
    actorUserId: actor.id,
    correlationId: normalizedCorrelationId,
  });

  if (!simulation.promotionAllowed) {
    throw new CreditAuthorityValidationError(
      "Credit authority promotion preconditions are not satisfied.",
      409
    );
  }

  if (!promotionApproval) {
    throw new CreditAuthorityValidationError(
      "PROMOTION_APPROVAL is required before controlled promotion.",
      409
    );
  }

  const promotedAt = nowIso();
  setRuntimeAuthorityDomainConfiguration({
    domain: "CREDIT",
    authority: "SERVICE",
    comparisonMode: "ENABLED",
  });
  process.env.CREDIT_PROMOTED_AT = promotedAt;
  process.env.CREDIT_PROMOTION_APPROVAL_ID = promotionApproval.id;

  const auditEvent = await createOutboxEvent({
    eventType: "authority.credit.promoted",
    aggregateType: "authority_candidate",
    aggregateId: "CREDIT",
    correlationId: normalizedCorrelationId,
    payload: {
      domain: "CREDIT",
      previousAuthority: authorityStatusBefore.authority,
      newAuthority: "SERVICE",
      actorUserId: actor.id,
      promotionApprovalId: promotionApproval.id,
      justification: normalizedJustification,
      correlationId: normalizedCorrelationId,
      promotedAt,
    },
  });

  return {
    domain: "CREDIT",
    previousAuthority: authorityStatusBefore.authority,
    newAuthority: "SERVICE",
    comparisonMode: "ENABLED",
    rollbackReadiness: simulation.rollbackReadiness,
    promotionApprovalId: promotionApproval.id,
    promotedAt,
    correlationId: normalizedCorrelationId,
    idempotent: false,
    auditEvent: {
      id: auditEvent.id,
      eventType: auditEvent.eventType,
      correlationId: auditEvent.correlationId ?? null,
    },
  };
}

export async function getCreditPromotionStatus(): Promise<CreditPromotionStatus> {
  const [authorityStatus, rollbackReadiness, promotionDecision, eventMetadata] =
    await Promise.all([
      Promise.resolve(getAuthorityStatus()),
      validateRollbackReadiness(),
      getPromotionDecision({ domain: "CREDIT" }),
      getLatestPromotionEventMetadata(),
    ]);
  const creditAuthority = authorityStatus.credit;
  const creditRollback = rollbackReadiness.credit;
  const metadata = getPromotionMetadata();

  return {
    domain: "CREDIT",
    authority: creditAuthority.authority,
    comparisonMode: creditAuthority.comparisonMode,
    promotedAt:
      creditAuthority.authority === "SERVICE"
        ? metadata.promotedAt ??
          eventMetadata.promotedAt ??
          promotionDecision.approvalState.promotionApproval?.createdAt ??
          null
        : null,
    rollbackReady: creditRollback.rollbackStatus === "READY",
    rollbackReadiness: creditRollback.rollbackStatus,
    promotionApprovalId:
      metadata.promotionApprovalId ??
      eventMetadata.promotionApprovalId ??
      promotionDecision.approvalState.promotionApproval?.id ??
      null,
    evaluatedAt: nowIso(),
  };
}

function getPostPromotionRecommendation({
  authority,
  comparisonMode,
  rollbackReady,
  rollbackTrigger,
  serviceAvailable,
  postPromotionActivityCount,
}: {
  authority: string;
  comparisonMode: string;
  rollbackReady: boolean;
  rollbackTrigger: CreditPostPromotionStatus["rollbackTrigger"];
  serviceAvailable: boolean;
  postPromotionActivityCount: number;
}) {
  if (authority !== "SERVICE") {
    return "BLOCKED: Credit Wallet is not currently service-authoritative.";
  }
  if (comparisonMode !== "ENABLED") {
    return "BLOCKED: Credit comparison mode must be re-enabled.";
  }
  if (!serviceAvailable) {
    return "ROLLBACK_RECOMMENDED: Credit Wallet Service health is unavailable.";
  }
  if (!rollbackReady) {
    return "REVIEW_REQUIRED: Rollback readiness is not READY.";
  }
  if (rollbackTrigger.shouldTriggerRollback) {
    return "ROLLBACK_RECOMMENDED: Aligned rollback trigger conditions are active.";
  }
  if (postPromotionActivityCount === 0) {
    return "REVIEW_REQUIRED: Post-promotion Credit activity has not been observed yet.";
  }
  if (rollbackTrigger.status === "WARNING") {
    return "REVIEW_REQUIRED: Aligned rollback evidence needs operator review.";
  }

  return "CONTINUE_MONITORING: Credit Wallet Service remains authoritative with aligned rollback evidence ready.";
}

function summarizeReadiness({
  source,
  totalRuns,
  matches,
  mismatches,
  failures,
  criticalMismatchCount,
  effectiveMismatchCount,
  effectiveFailureCount,
  excludedMismatchCount,
  excludedFailureCount,
  reasons,
}: Omit<
  CreditRollbackTriggerEvidenceSummary,
  "mismatchRate" | "failureRate" | "readiness"
>): CreditRollbackTriggerEvidenceSummary {
  const totalEvents = totalRuns + failures;
  const mismatchRate = rate(mismatches, totalEvents);
  const failureRate = rate(failures, totalEvents);
  let readiness: CreditRollbackTriggerEvidenceSummary["readiness"] = "READY";

  if (criticalMismatchCount > 0 || mismatches > 0 || failures > 0) {
    readiness = criticalMismatchCount > 0 ? "BLOCKED" : "WARNING";
  }

  return {
    source,
    totalRuns,
    matches,
    mismatches,
    failures,
    criticalMismatchCount,
    mismatchRate,
    failureRate,
    readiness,
    effectiveMismatchCount,
    effectiveFailureCount,
    excludedMismatchCount,
    excludedFailureCount,
    reasons: reasons.length > 0 ? reasons : [`${source} is within ready thresholds.`],
  };
}

function rawEvidenceHasTrigger(summary: CreditRollbackTriggerEvidenceSummary) {
  return summary.readiness !== "READY";
}

function effectiveEvidenceHasTrigger(summary: CreditRollbackTriggerEvidenceSummary) {
  return summary.readiness === "BLOCKED";
}

function isOnOrAfter(value: string, floor: string | null) {
  if (!floor) return true;

  return new Date(value).getTime() >= new Date(floor).getTime();
}

function uniqueShadowRunCount(evidence: ClassifiedShadowEvidence[]) {
  return new Set(
    evidence
      .map((item) => item.shadowRunId)
      .filter((shadowRunId): shadowRunId is string => Boolean(shadowRunId))
  ).size;
}

function getAlignedRollbackEvaluation({
  authority,
  rollbackReady,
  rawEvidence,
  promotionEvidence,
  postPromotionEvidence,
}: {
  authority: string;
  rollbackReady: boolean;
  rawEvidence: CreditRollbackTriggerEvidenceSummary;
  promotionEvidence: CreditRollbackTriggerEvidenceSummary;
  postPromotionEvidence: CreditRollbackTriggerEvidenceSummary;
}): {
  rollbackTrigger: CreditPostPromotionStatus["rollbackTrigger"];
  triggerSource: CreditRollbackTriggerEvidenceSource;
  details: CreditRollbackEvaluationDetails;
} {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const rawTriggerActive = rawEvidenceHasTrigger(rawEvidence);
  const promotionTriggerActive = effectiveEvidenceHasTrigger(promotionEvidence);
  const postPromotionTriggerActive = effectiveEvidenceHasTrigger(postPromotionEvidence);
  const triggerSource: CreditRollbackTriggerEvidenceSource =
    authority === "SERVICE" ? "POST_PROMOTION_EVIDENCE" : "PROMOTION_EVIDENCE";

  if (!rollbackReady) {
    blockers.push("Rollback readiness is not READY.");
  }
  if (postPromotionTriggerActive) {
    blockers.push("Post-promotion evidence has blocking mismatches or failures.");
  }
  if (promotionTriggerActive) {
    blockers.push("Promotion lifecycle evidence has blocking mismatches or failures.");
  }
  if (rawTriggerActive && !promotionTriggerActive && !postPromotionTriggerActive) {
    warnings.push(
      "Raw historical evidence is not READY but is excluded from aligned rollback trigger evaluation."
    );
  }
  if (postPromotionEvidence.readiness === "WARNING") {
    warnings.push("Post-promotion evidence has warning-level mismatches or failures.");
  }

  const shouldTriggerRollback = authority === "SERVICE" && blockers.length > 0;
  const status: CreditRollbackTriggerEvaluation["status"] =
    shouldTriggerRollback ? "BLOCKED" : warnings.length > 0 ? "WARNING" : "READY";
  const reasons =
    blockers.length > 0 || warnings.length > 0
      ? [...blockers, ...warnings]
      : ["Aligned rollback evidence is within ready thresholds."];

  return {
    triggerSource,
    rollbackTrigger: {
      shouldTriggerRollback,
      status,
      reasons,
    },
    details: {
      triggerSource,
      rawTriggerActive,
      promotionTriggerActive,
      postPromotionTriggerActive,
      blockers,
      warnings,
      evaluatedAt: nowIso(),
    },
  };
}

export async function getCreditPostPromotionStatus(): Promise<CreditPostPromotionStatus> {
  const [promotionStatus, rollbackReadiness, shadowAnalysis] =
    await Promise.all([
      getCreditPromotionStatus(),
      validateRollbackReadiness(),
      getShadowAnalysisSummary("all"),
    ]);
  const promotedAt = promotionStatus.promotedAt;
  const sinceFilter = promotedAt ? { from: promotedAt, limit: 10000 } : { limit: 10000 };
  const [
    runs,
    mismatches,
    failures,
    classifiedMismatches,
    classifiedFailures,
  ] = await Promise.all([
    getCreditShadowRuns(sinceFilter),
    getCreditShadowMismatches(sinceFilter),
    getCreditShadowFailures(sinceFilter),
    listShadowAnalysisMismatches("all"),
    listShadowAnalysisFailures("all"),
  ]);
  const creditRollback = creditRollbackReadiness(rollbackReadiness);
  const creditEvidence = shadowAnalysis.domains.credit;
  const rawEvidenceSummary = summarizeReadiness({
    source: "RAW_EVIDENCE",
    totalRuns: creditEvidence.rawReadiness.totalRuns,
    matches: creditEvidence.rawReadiness.matches,
    mismatches: creditEvidence.rawReadiness.mismatches,
    failures: creditEvidence.rawReadiness.failures,
    criticalMismatchCount: creditEvidence.rawReadiness.criticalMismatchCount,
    effectiveMismatchCount: creditEvidence.rawReadiness.mismatches,
    effectiveFailureCount: creditEvidence.rawReadiness.failures,
    excludedMismatchCount:
      creditEvidence.rawReadiness.mismatches -
      creditEvidence.promotionReadiness.mismatches,
    excludedFailureCount:
      creditEvidence.rawReadiness.failures -
      creditEvidence.promotionReadiness.failures,
    reasons: creditEvidence.rawReadiness.reasons,
  });
  const promotionEvidenceSummary = summarizeReadiness({
    source: "PROMOTION_EVIDENCE",
    totalRuns: creditEvidence.promotionReadiness.totalRuns,
    matches: creditEvidence.promotionReadiness.matches,
    mismatches: creditEvidence.promotionReadiness.mismatches,
    failures: creditEvidence.promotionReadiness.failures,
    criticalMismatchCount: creditEvidence.promotionReadiness.criticalMismatchCount,
    effectiveMismatchCount: creditEvidence.promotionReadiness.mismatches,
    effectiveFailureCount: creditEvidence.promotionReadiness.failures,
    excludedMismatchCount:
      creditEvidence.rawReadiness.mismatches -
      creditEvidence.promotionReadiness.mismatches,
    excludedFailureCount:
      creditEvidence.rawReadiness.failures -
      creditEvidence.promotionReadiness.failures,
    reasons: creditEvidence.promotionReadiness.reasons,
  });
  const postPromotionClassifiedMismatches = classifiedMismatches.filter(
    (mismatch) =>
      mismatch.domain === "CREDIT" && isOnOrAfter(mismatch.createdAt, promotedAt)
  );
  const postPromotionClassifiedFailures = classifiedFailures.filter(
    (failure) =>
      failure.domain === "CREDIT" && isOnOrAfter(failure.createdAt, promotedAt)
  );
  const postPromotionEffectiveMismatches =
    postPromotionClassifiedMismatches.filter(lifecycleParticipatesInRollback);
  const postPromotionEffectiveFailures =
    postPromotionClassifiedFailures.filter(lifecycleParticipatesInRollback);
  const postPromotionEffectiveMismatchCount = uniqueShadowRunCount(
    postPromotionEffectiveMismatches
  );
  const postPromotionEffectiveFailureCount =
    postPromotionEffectiveFailures.length;
  const postPromotionMatches = runs.filter(
    (run) => run.comparisonStatus === "MATCH"
  ).length;
  const postPromotionCriticalMismatchCount = postPromotionEffectiveMismatches.filter(
    (mismatch) => mismatch.severity === "CRITICAL"
  ).length;
  const postPromotionEvidenceSummary = summarizeReadiness({
    source: "POST_PROMOTION_EVIDENCE",
    totalRuns: runs.length,
    matches: postPromotionMatches,
    mismatches: postPromotionEffectiveMismatchCount,
    failures: postPromotionEffectiveFailureCount,
    criticalMismatchCount: postPromotionCriticalMismatchCount,
    effectiveMismatchCount: postPromotionEffectiveMismatchCount,
    effectiveFailureCount: postPromotionEffectiveFailureCount,
    excludedMismatchCount: Math.max(
      0,
      mismatches.length - postPromotionEffectiveMismatches.length
    ),
    excludedFailureCount: Math.max(
      0,
      failures.length - postPromotionEffectiveFailureCount
    ),
    reasons:
      postPromotionEffectiveMismatchCount === 0 &&
      postPromotionEffectiveFailureCount === 0
        ? ["Post-promotion evidence is within ready thresholds."]
        : ["Post-promotion lifecycle-effective evidence contains mismatches or failures."],
  });
  const alignedEvaluation = getAlignedRollbackEvaluation({
    authority: promotionStatus.authority,
    rollbackReady: promotionStatus.rollbackReady,
    rawEvidence: rawEvidenceSummary,
    promotionEvidence: promotionEvidenceSummary,
    postPromotionEvidence: postPromotionEvidenceSummary,
  });
  const creditWalletsProcessed = new Set(
    runs.map((run) => run.walletId).filter((walletId): walletId is string => Boolean(walletId))
  ).size;
  const reservationsProcessed = new Set(
    runs
      .map((run) => run.reservationId)
      .filter((reservationId): reservationId is string => Boolean(reservationId))
  ).size;
  const exposureUpdatesProcessed = runs.filter(
    (run) =>
      run.shadowRemainingExposure !== null ||
      run.monolithRemainingExposure !== null ||
      run.operationType === "RESERVE" ||
      run.operationType === "RELEASE"
  ).length;
  const recommendation = getPostPromotionRecommendation({
    authority: promotionStatus.authority,
    comparisonMode: promotionStatus.comparisonMode,
    rollbackReady: promotionStatus.rollbackReady,
    rollbackTrigger: alignedEvaluation.rollbackTrigger,
    serviceAvailable: creditRollback.serviceHealth.available,
    postPromotionActivityCount: runs.length,
  });
  const latestRun = runs[0] ?? null;

  return {
    domain: "CREDIT",
    authority: promotionStatus.authority,
    comparisonMode: promotionStatus.comparisonMode,
    promotedAt,
    serviceHealth: creditRollback.serviceHealth,
    rollbackReady: promotionStatus.rollbackReady,
    rollbackReadiness: creditRollback.rollbackStatus,
    rollbackTrigger: alignedEvaluation.rollbackTrigger,
    triggerSource: alignedEvaluation.triggerSource,
    rawEvidenceSummary,
    promotionEvidenceSummary,
    postPromotionEvidenceSummary,
    rollbackEvaluationDetails: alignedEvaluation.details,
    latestCreditShadowComparison: latestRun
      ? {
          id: latestRun.id,
          comparisonStatus: latestRun.comparisonStatus,
          operationType: latestRun.operationType,
          walletId: latestRun.walletId ?? null,
          reservationId: latestRun.reservationId ?? null,
          correlationId: latestRun.correlationId ?? null,
          createdAt: latestRun.createdAt,
        }
      : null,
    creditWalletsProcessed,
    reservationsProcessed,
    exposureUpdatesProcessed,
    mismatchCount: postPromotionEffectiveMismatchCount,
    failureCount: postPromotionEffectiveFailureCount,
    criticalMismatchCount: postPromotionCriticalMismatchCount,
    recommendation,
    evaluatedAt: nowIso(),
  };
}

export async function simulateCreditRollbackDrill({
  actor,
  mode,
  correlationId,
}: {
  actor: AuthenticatedUser;
  mode: unknown;
  correlationId?: unknown;
}): Promise<CreditRollbackDrill> {
  if (mode !== "SIMULATION") {
    throw new CreditAuthorityValidationError(
      "Credit rollback drill only supports SIMULATION mode."
    );
  }

  const normalizedCorrelationId = normalizeCorrelationId(correlationId);
  const authorityBefore = getAuthorityStatus().credit;
  const rollbackReadiness = await validateRollbackReadiness();
  const creditRollback = creditRollbackReadiness(rollbackReadiness);
  const validationResults = [
    validationResult(
      "AUTHORITY_SERVICE",
      authorityBefore.authority === "SERVICE",
      "Credit authority must be SERVICE before rollback drill."
    ),
    validationResult(
      "MONOLITH_PATH_AVAILABLE",
      creditRollback.monolithPathAvailable,
      "Credit monolith path must be available."
    ),
    validationResult(
      "SERVICE_PATH_AVAILABLE",
      creditRollback.serviceHealth.available,
      "Credit Wallet Service path must be available."
    ),
    validationResult(
      "AUTHORITY_CONTROLS_AVAILABLE",
      authorityBefore.authority === "MONOLITH" ||
        authorityBefore.authority === "SERVICE",
      "Credit authority controls must be available."
    ),
    validationResult(
      "COMPARISON_ENABLED",
      authorityBefore.comparisonMode === "ENABLED",
      "Credit comparison mode must be ENABLED."
    ),
    validationResult(
      "ROLLBACK_READY",
      creditRollback.rollbackStatus === "READY",
      "Credit rollback readiness must be READY."
    ),
  ];
  const blockers = collectBlockers(validationResults);
  const warnings = creditRollback.reasons.filter(
    (reason) => reason !== "Authority and rollback controls are within ready thresholds."
  );
  const simulatedAt = nowIso();
  const auditEvent = await createOutboxEvent({
    eventType: "authority.credit.rollback.drill.simulated",
    aggregateType: "authority_candidate",
    aggregateId: "CREDIT",
    correlationId: normalizedCorrelationId,
    payload: {
      domain: "CREDIT",
      mode: "SIMULATION",
      actorUserId: actor.id,
      authorityState: authorityBefore.authority,
      comparisonMode: authorityBefore.comparisonMode,
      rollbackReadiness: creditRollback.rollbackStatus,
      drillPassed: blockers.length === 0,
      blockers,
      warnings,
      createdAt: simulatedAt,
      simulatedAt,
    },
  });
  const authorityAfter = getAuthorityStatus().credit;

  return {
    domain: "CREDIT",
    mode: "SIMULATION",
    authorityBefore: authorityBefore.authority,
    authorityAfter: authorityAfter.authority,
    comparisonMode: authorityAfter.comparisonMode,
    rollbackReadiness: creditRollback.rollbackStatus,
    serviceHealth: creditRollback.serviceHealth,
    validationResults,
    blockers,
    warnings,
    drillPassed: blockers.length === 0,
    authorityChanged: authorityBefore.authority !== authorityAfter.authority,
    auditEvent: {
      id: auditEvent.id,
      eventType: auditEvent.eventType,
      correlationId: auditEvent.correlationId ?? null,
    },
    simulatedAt,
  };
}

function getCreditCertificationState({
  authority,
  comparisonMode,
  rollbackReadiness,
  serviceHealthy,
  creditWalletsProcessed,
  mismatchCount,
  failureCount,
  criticalMismatchCount,
  existingCertification,
}: {
  authority: string;
  comparisonMode: string;
  rollbackReadiness: string;
  serviceHealthy: boolean;
  creditWalletsProcessed: number;
  mismatchCount: number;
  failureCount: number;
  criticalMismatchCount: number;
  existingCertification?: AuthorityApprovalRecord | null;
}): {
  certificationStatus: CreditCertificationStatus;
  certificationBlockers: string[];
  certificationWarnings: string[];
} {
  const certificationBlockers: string[] = [];
  const certificationWarnings: string[] = [];

  if (existingCertification) {
    return {
      certificationStatus: "CERTIFIED",
      certificationBlockers,
      certificationWarnings,
    };
  }

  if (authority !== "SERVICE") {
    certificationBlockers.push("Credit authority must be SERVICE.");
  }
  if (comparisonMode !== "ENABLED") {
    certificationBlockers.push("Credit comparison mode must be ENABLED.");
  }
  if (rollbackReadiness !== "READY") {
    certificationBlockers.push("Rollback readiness must be READY.");
  }
  if (!serviceHealthy) {
    certificationBlockers.push("Credit Wallet Service health must be healthy.");
  }
  if (creditWalletsProcessed <= 0) {
    certificationBlockers.push(
      "At least one post-promotion Credit wallet activity must be processed."
    );
  }
  if (mismatchCount > 0) {
    certificationBlockers.push("Post-promotion mismatch count must be zero.");
  }
  if (failureCount > 0) {
    certificationBlockers.push("Post-promotion failure count must be zero.");
  }
  if (criticalMismatchCount > 0) {
    certificationBlockers.push(
      "Post-promotion critical mismatch count must be zero."
    );
  }

  if (certificationBlockers.length > 0) {
    return {
      certificationStatus:
        mismatchCount > 0 || failureCount > 0 || criticalMismatchCount > 0
          ? "REVIEW_REQUIRED"
          : "NOT_READY",
      certificationBlockers,
      certificationWarnings,
    };
  }

  certificationWarnings.push(
    "Operator certification is still required before marking Credit as CERTIFIED."
  );

  return {
    certificationStatus: "READY_FOR_CERTIFICATION",
    certificationBlockers,
    certificationWarnings,
  };
}

function getCreditCertificationRecommendation({
  certificationStatus,
  rollbackTrigger,
}: {
  certificationStatus: CreditCertificationStatus;
  rollbackTrigger: CreditRollbackTriggerEvaluation;
}) {
  if (rollbackTrigger.shouldTriggerRollback) {
    return "ROLLBACK_RECOMMENDED";
  }
  if (certificationStatus === "CERTIFIED") {
    return "CERTIFIED";
  }
  if (certificationStatus === "READY_FOR_CERTIFICATION") {
    return "READY_FOR_CERTIFICATION";
  }
  if (certificationStatus === "REVIEW_REQUIRED") {
    return "REVIEW_REQUIRED";
  }

  return "NOT_READY";
}

export async function getCreditStabilizationStatus(): Promise<CreditStabilizationStatus> {
  const [postPromotionStatus, approvals] = await Promise.all([
    getCreditPostPromotionStatus(),
    listCreditAuthorityApprovalRecords(),
  ]);
  const certificationApproval = latestApproval(approvals, "CREDIT_CERTIFICATION");
  const certification = getCreditCertificationState({
    authority: postPromotionStatus.authority,
    comparisonMode: postPromotionStatus.comparisonMode,
    rollbackReadiness: postPromotionStatus.rollbackReadiness,
    serviceHealthy: postPromotionStatus.serviceHealth.available,
    creditWalletsProcessed: postPromotionStatus.creditWalletsProcessed,
    mismatchCount: postPromotionStatus.mismatchCount,
    failureCount: postPromotionStatus.failureCount,
    criticalMismatchCount: postPromotionStatus.criticalMismatchCount,
    existingCertification: certificationApproval,
  });

  return {
    domain: "CREDIT",
    authority: postPromotionStatus.authority,
    comparisonMode: postPromotionStatus.comparisonMode,
    promotedAt: postPromotionStatus.promotedAt,
    rollbackReady: postPromotionStatus.rollbackReady,
    rollbackReadiness: postPromotionStatus.rollbackReadiness,
    serviceHealth: postPromotionStatus.serviceHealth,
    rollbackTrigger: postPromotionStatus.rollbackTrigger,
    creditWalletsProcessed: postPromotionStatus.creditWalletsProcessed,
    reservationsProcessed: postPromotionStatus.reservationsProcessed,
    exposureUpdatesProcessed: postPromotionStatus.exposureUpdatesProcessed,
    mismatchCount: postPromotionStatus.mismatchCount,
    failureCount: postPromotionStatus.failureCount,
    criticalMismatchCount: postPromotionStatus.criticalMismatchCount,
    certificationStatus: certification.certificationStatus,
    certificationBlockers: certification.certificationBlockers,
    certificationWarnings: certification.certificationWarnings,
    certificationApprovalId: certificationApproval?.id ?? null,
    certifiedAt: certificationApproval?.createdAt ?? null,
    recommendation: getCreditCertificationRecommendation({
      certificationStatus: certification.certificationStatus,
      rollbackTrigger: postPromotionStatus.rollbackTrigger,
    }),
    generatedAt: nowIso(),
  };
}

export async function certifyCreditAuthority({
  actor,
  justification,
  acknowledgedWarnings,
  correlationId,
}: CreditCertificationInput): Promise<CreditCertificationResult> {
  const normalizedCorrelationId = normalizeCorrelationId(correlationId);

  if (normalizedCorrelationId) {
    const existingApproval = await findAuthorityApprovalRecordByCorrelationId({
      authorityCandidate: "CREDIT",
      approvalType: "CREDIT_CERTIFICATION",
      correlationId: normalizedCorrelationId,
    });

    if (existingApproval) {
      const stabilization = await getCreditStabilizationStatus();

      return {
        approval: existingApproval,
        idempotent: true,
        stabilizationBefore: stabilization,
        stabilizationAfter: stabilization,
      };
    }
  }

  const normalizedJustification = normalizeJustification(justification);
  if (!normalizedJustification) {
    throw new CreditAuthorityValidationError("Justification is required.");
  }

  const normalizedAcknowledgedWarnings =
    normalizeAcknowledgedWarnings(acknowledgedWarnings);
  const [stabilizationBefore, promotionDecision, settlementStatus, ledgerStatus] =
    await Promise.all([
      getCreditStabilizationStatus(),
      getPromotionDecision({ domain: "CREDIT" }),
      getSettlementStabilizationStatus({ window: "7d" }),
      getLedgerStabilizationStatus(),
    ]);
  const missingWarnings = stabilizationBefore.certificationWarnings.filter(
    (warning) => !normalizedAcknowledgedWarnings.includes(warning)
  );

  if (missingWarnings.length > 0) {
    throw new CreditAuthorityValidationError(
      "Certification warnings must be acknowledged before certification."
    );
  }
  if (stabilizationBefore.certificationStatus !== "READY_FOR_CERTIFICATION") {
    throw new CreditAuthorityValidationError(
      "Credit is not ready for certification.",
      409
    );
  }
  if (stabilizationBefore.authority !== "SERVICE") {
    throw new CreditAuthorityValidationError(
      "Credit authority must be SERVICE before certification.",
      409
    );
  }
  if (stabilizationBefore.comparisonMode !== "ENABLED") {
    throw new CreditAuthorityValidationError(
      "Credit comparison mode must be ENABLED before certification.",
      409
    );
  }
  if (stabilizationBefore.rollbackReadiness !== "READY") {
    throw new CreditAuthorityValidationError(
      "Rollback readiness must be READY before certification.",
      409
    );
  }
  if (!stabilizationBefore.serviceHealth.available) {
    throw new CreditAuthorityValidationError(
      "Credit Wallet Service health must be healthy before certification.",
      409
    );
  }
  if (promotionDecision.decision !== "PROMOTED") {
    throw new CreditAuthorityValidationError(
      "Credit promotion state must be PROMOTED before certification.",
      409
    );
  }
  if (stabilizationBefore.creditWalletsProcessed <= 0) {
    throw new CreditAuthorityValidationError(
      "Post-promotion Credit activity must exist before certification.",
      409
    );
  }
  if (
    stabilizationBefore.mismatchCount !== 0 ||
    stabilizationBefore.failureCount !== 0 ||
    stabilizationBefore.criticalMismatchCount !== 0
  ) {
    throw new CreditAuthorityValidationError(
      "Post-promotion mismatches, failures, and critical mismatches must be zero before certification.",
      409
    );
  }
  if (
    settlementStatus.authority !== "SERVICE" ||
    settlementStatus.certificationStatus !== "CERTIFIED"
  ) {
    throw new CreditAuthorityValidationError(
      "Settlement must remain SERVICE and CERTIFIED before Credit certification.",
      409
    );
  }
  if (
    ledgerStatus.authority !== "SERVICE" ||
    ledgerStatus.certificationStatus !== "CERTIFIED"
  ) {
    throw new CreditAuthorityValidationError(
      "Ledger must remain SERVICE and CERTIFIED before Credit certification.",
      409
    );
  }

  const approval = await createAuthorityApprovalRecord({
    authorityCandidate: "CREDIT",
    approvalType: "CREDIT_CERTIFICATION",
    approverUserId: actor.id,
    approverUsername: actor.username,
    justification: normalizedJustification,
    metadata: {
      acknowledgedWarnings: normalizedAcknowledgedWarnings,
      certificationCapturedAt: new Date().toISOString(),
      correlationId: normalizedCorrelationId,
      certificationStatusBefore: stabilizationBefore.certificationStatus,
      creditWalletsProcessed: stabilizationBefore.creditWalletsProcessed,
      reservationsProcessed: stabilizationBefore.reservationsProcessed,
      exposureUpdatesProcessed: stabilizationBefore.exposureUpdatesProcessed,
      mismatchCount: stabilizationBefore.mismatchCount,
      failureCount: stabilizationBefore.failureCount,
      criticalMismatchCount: stabilizationBefore.criticalMismatchCount,
      settlementCertificationStatus: settlementStatus.certificationStatus,
      ledgerCertificationStatus: ledgerStatus.certificationStatus,
      promotionDecision: promotionDecision.decision,
    },
  });

  await createOutboxEvent({
    eventType: "authority.credit.certified",
    aggregateType: "authority_candidate",
    aggregateId: "CREDIT",
    correlationId: normalizedCorrelationId,
    payload: {
      approvalId: approval.id,
      actorUserId: actor.id,
      correlationId: normalizedCorrelationId,
      certifiedAt: approval.createdAt,
    },
  });

  const stabilizationAfter = await getCreditStabilizationStatus();

  return {
    approval,
    idempotent: false,
    stabilizationBefore,
    stabilizationAfter,
  };
}
