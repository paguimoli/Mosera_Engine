import {
  getAuthorityStatus,
  validateRollbackReadiness,
} from "../authority-control/authority-control.service";
import { setRuntimeAuthorityDomainConfiguration } from "../authority-control/authority-control.repository";
import type { AuthorityDomain } from "../authority-control/authority-control.types";
import type { AuthenticatedUser } from "../auth/auth-context.types";
import { createOutboxEvent, listRecentOutboxEvents } from "../outbox/outbox.service";
import { getPromotionDecision } from "../promotion-decision/promotion-decision.service";
import {
  getShadowAnalysisSummary,
  listShadowAnalysisFailures,
  listShadowAnalysisMismatches,
} from "../shadow-analysis/shadow-analysis.service";
import type { ClassifiedShadowEvidence } from "../shadow-analysis/shadow-analysis.types";
import {
  getLatestSettlementShadowRun,
  getSettlementShadowFailures,
  getSettlementShadowMismatches,
  getSettlementShadowRuns,
} from "../settlement-shadow/settlement-shadow-reporting.service";
import {
  assertSupportedPromotionExecutionDomain,
} from "./promotion-execution.repository";
import type {
  PromotionExecutionInput,
  PromotionExecutionValidationResult,
  RollbackEvaluationDetails,
  RollbackDrillInput,
  RollbackTriggerEvidenceSource,
  RollbackTriggerEvidenceSummary,
  PromotionSimulationInput,
  RollbackSimulationInput,
  SettlementAuthorityPromotion,
  SettlementPostPromotionStatus,
  SettlementPromotionStatus,
  SettlementPromotionSimulation,
  SettlementRollbackDrill,
  SettlementRollbackSimulation,
} from "./promotion-execution.types";

export class PromotionExecutionValidationError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "PromotionExecutionValidationError";
    this.status = status;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeCorrelationId(value: string | null | undefined) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parsePromotionExecutionDomain(
  value: unknown
): AuthorityDomain {
  if (value === "SETTLEMENT") return "SETTLEMENT";
  if (value === "LEDGER") return "LEDGER";
  if (value === "CREDIT") return "CREDIT";

  throw new PromotionExecutionValidationError("A supported domain is required.");
}

function validationResult(
  name: string,
  passed: boolean,
  message: string
): PromotionExecutionValidationResult {
  return { name, passed, message };
}

function collectBlockers(results: PromotionExecutionValidationResult[]) {
  return results
    .filter((result) => !result.passed)
    .map((result) => result.message);
}

function getPromotionMetadata() {
  return {
    promotedAt: process.env.SETTLEMENT_PROMOTED_AT || null,
    promotionApprovalId: process.env.SETTLEMENT_PROMOTION_APPROVAL_ID || null,
  };
}

async function getLatestPromotionEventMetadata() {
  const events = await listRecentOutboxEvents({ limit: 10000 });
  const promotionEvent = events.find(
    (event) =>
      event.eventType === "authority.promoted" &&
      event.aggregateType === "authority_candidate" &&
      event.aggregateId === "SETTLEMENT"
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

export async function simulateSettlementPromotion(
  input: PromotionSimulationInput
): Promise<SettlementPromotionSimulation> {
  assertSupportedPromotionExecutionDomain(input.domain);

  const correlationId = normalizeCorrelationId(input.correlationId);
  const [promotionDecision, rollbackReadiness] = await Promise.all([
    getPromotionDecision({ domain: "SETTLEMENT" }),
    validateRollbackReadiness(),
  ]);
  const settlementRollback = rollbackReadiness.settlement;
  const validationResults = [
    validationResult(
      "PROMOTION_DECISION_READY",
      promotionDecision.decision === "READY_FOR_CONTROLLED_PROMOTION",
      "Promotion decision must be READY_FOR_CONTROLLED_PROMOTION."
    ),
    validationResult(
      "DRY_RUN_APPROVAL_EXISTS",
      Boolean(promotionDecision.approvalState.dryRunApproval),
      "DRY_RUN_APPROVAL must exist."
    ),
    validationResult(
      "PROMOTION_APPROVAL_EXISTS",
      Boolean(promotionDecision.approvalState.promotionApproval),
      "PROMOTION_APPROVAL must exist."
    ),
    validationResult(
      "ROLLBACK_READY",
      promotionDecision.rollbackReadiness === "READY" &&
        settlementRollback.rollbackStatus === "READY",
      "Rollback readiness must be READY."
    ),
    validationResult(
      "AUTHORITY_MONOLITH",
      promotionDecision.currentAuthority === "MONOLITH",
      "Settlement authority must remain MONOLITH before controlled promotion."
    ),
    validationResult(
      "COMPARISON_ENABLED",
      promotionDecision.comparisonMode === "ENABLED",
      "Settlement comparison mode must be ENABLED."
    ),
    validationResult(
      "SERVICE_HEALTHY",
      settlementRollback.serviceHealth.available,
      "Settlement Service health must be available."
    ),
  ];
  const blockers = collectBlockers(validationResults);
  const warnings = [...promotionDecision.warnings];
  const simulatedAt = nowIso();
  const auditEvent = await createOutboxEvent({
    eventType: "authority.promotion.simulated",
    aggregateType: "authority_candidate",
    aggregateId: "SETTLEMENT",
    correlationId,
    payload: {
      domain: "SETTLEMENT",
      currentAuthority: promotionDecision.currentAuthority,
      proposedAuthority: "SERVICE",
      comparisonMode: promotionDecision.comparisonMode,
      rollbackReadiness: promotionDecision.rollbackReadiness,
      promotionAllowed: blockers.length === 0,
      blockers,
      warnings,
      simulatedAt,
    },
  });

  return {
    domain: "SETTLEMENT",
    currentAuthority: promotionDecision.currentAuthority,
    proposedAuthority: "SERVICE",
    comparisonMode: promotionDecision.comparisonMode,
    promotionDecision: promotionDecision.decision,
    rollbackReadiness: promotionDecision.rollbackReadiness,
    serviceHealth: settlementRollback.serviceHealth,
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

export async function simulateSettlementRollback(
  input: RollbackSimulationInput
): Promise<SettlementRollbackSimulation> {
  assertSupportedPromotionExecutionDomain(input.domain);

  const correlationId = normalizeCorrelationId(input.correlationId);
  const rollbackReadiness = await validateRollbackReadiness();
  const settlementRollback = rollbackReadiness.settlement;
  const validationResults = [
    validationResult(
      "MONOLITH_PATH_AVAILABLE",
      settlementRollback.monolithPathAvailable,
      "Monolith path must be available."
    ),
    validationResult(
      "COMPARISON_MODE_AVAILABLE",
      settlementRollback.comparisonMode === "ENABLED",
      "Comparison mode must be ENABLED."
    ),
    validationResult(
      "AUTHORITY_CONTROLS_AVAILABLE",
      settlementRollback.authority === "MONOLITH" ||
        settlementRollback.authority === "SERVICE",
      "Authority controls must be available."
    ),
    validationResult(
      "ROLLBACK_READY",
      settlementRollback.rollbackStatus === "READY",
      "Rollback readiness must be READY."
    ),
  ];
  const blockers = collectBlockers(validationResults);
  const warnings = settlementRollback.reasons.filter(
    (reason) => reason !== "Authority and rollback controls are within ready thresholds."
  );
  const simulatedAt = nowIso();
  const auditEvent = await createOutboxEvent({
    eventType: "authority.rollback.simulated",
    aggregateType: "authority_candidate",
    aggregateId: "SETTLEMENT",
    correlationId,
    payload: {
      domain: "SETTLEMENT",
      authorityState: settlementRollback.authority,
      comparisonMode: settlementRollback.comparisonMode,
      rollbackReadiness: settlementRollback.rollbackStatus,
      rollbackAllowed: blockers.length === 0,
      blockers,
      warnings,
      simulatedAt,
    },
  });

  return {
    domain: "SETTLEMENT",
    authorityState: settlementRollback.authority,
    comparisonMode: settlementRollback.comparisonMode,
    rollbackReadiness: settlementRollback.rollbackStatus,
    serviceHealth: settlementRollback.serviceHealth,
    monolithPathAvailable: settlementRollback.monolithPathAvailable,
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

export async function promoteSettlementAuthority({
  actor,
  domain,
  correlationId,
}: PromotionExecutionInput & {
  actor: AuthenticatedUser;
}): Promise<SettlementAuthorityPromotion> {
  assertSupportedPromotionExecutionDomain(domain);

  const normalizedCorrelationId = normalizeCorrelationId(correlationId);
  const authorityStatusBefore = getAuthorityStatus().settlement;
  const promotionDecisionBefore = await getPromotionDecision({ domain: "SETTLEMENT" });
  const promotionApproval =
    promotionDecisionBefore.approvalState.promotionApproval;

  if (authorityStatusBefore.authority === "SERVICE") {
    const rollbackReadiness = await validateRollbackReadiness();
    const metadata = getPromotionMetadata();

    return {
      domain: "SETTLEMENT",
      previousAuthority: "SERVICE",
      newAuthority: "SERVICE",
      comparisonMode: "ENABLED",
      rollbackReadiness: rollbackReadiness.settlement.rollbackStatus,
      promotionApprovalId:
        metadata.promotionApprovalId ?? promotionApproval?.id ?? null,
      promotedAt: metadata.promotedAt ?? nowIso(),
      correlationId: normalizedCorrelationId,
      idempotent: true,
      auditEvent: null,
    };
  }

  const simulation = await simulateSettlementPromotion({
    domain,
    correlationId: normalizedCorrelationId,
  });

  if (!simulation.promotionAllowed) {
    throw new PromotionExecutionValidationError(
      "Settlement authority promotion preconditions are not satisfied.",
      409
    );
  }

  if (!promotionApproval) {
    throw new PromotionExecutionValidationError(
      "PROMOTION_APPROVAL is required before controlled promotion.",
      409
    );
  }

  const promotedAt = nowIso();
  setRuntimeAuthorityDomainConfiguration({
    domain: "SETTLEMENT",
    authority: "SERVICE",
    comparisonMode: "ENABLED",
  });
  process.env.SETTLEMENT_PROMOTED_AT = promotedAt;
  process.env.SETTLEMENT_PROMOTION_APPROVAL_ID = promotionApproval.id;

  const auditEvent = await createOutboxEvent({
    eventType: "authority.promoted",
    aggregateType: "authority_candidate",
    aggregateId: "SETTLEMENT",
    correlationId: normalizedCorrelationId,
    payload: {
      domain: "SETTLEMENT",
      previousAuthority: authorityStatusBefore.authority,
      newAuthority: "SERVICE",
      actorUserId: actor.id,
      promotionApprovalId: promotionApproval.id,
      correlationId: normalizedCorrelationId,
      promotedAt,
    },
  });

  return {
    domain: "SETTLEMENT",
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

export async function getSettlementPromotionStatus(): Promise<SettlementPromotionStatus> {
  const [authorityStatus, rollbackReadiness, promotionDecision, eventMetadata] =
    await Promise.all([
      Promise.resolve(getAuthorityStatus()),
      validateRollbackReadiness(),
      getPromotionDecision({ domain: "SETTLEMENT" }),
      getLatestPromotionEventMetadata(),
    ]);
  const settlementAuthority = authorityStatus.settlement;
  const settlementRollback = rollbackReadiness.settlement;
  const metadata = getPromotionMetadata();

  return {
    domain: "SETTLEMENT",
    authority: settlementAuthority.authority,
    comparisonMode: settlementAuthority.comparisonMode,
    promotedAt:
      settlementAuthority.authority === "SERVICE"
        ? metadata.promotedAt ??
          eventMetadata.promotedAt ??
          promotionDecision.approvalState.promotionApproval?.createdAt ??
          null
        : null,
    rollbackReady: settlementRollback.rollbackStatus === "READY",
    rollbackReadiness: settlementRollback.rollbackStatus,
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
}: {
  authority: string;
  comparisonMode: string;
  rollbackReady: boolean;
  rollbackTrigger: SettlementPostPromotionStatus["rollbackTrigger"];
  serviceAvailable: boolean;
}) {
  if (authority !== "SERVICE") {
    return "BLOCKED: Settlement is not currently service-authoritative.";
  }
  if (comparisonMode !== "ENABLED") {
    return "BLOCKED: Settlement comparison mode must be re-enabled.";
  }
  if (!serviceAvailable) {
    return "ROLLBACK_RECOMMENDED: Settlement Service health is unavailable.";
  }
  if (!rollbackReady) {
    return "REVIEW_REQUIRED: Rollback readiness is not READY.";
  }
  if (rollbackTrigger.shouldTriggerRollback) {
    return "ROLLBACK_RECOMMENDED: Aligned rollback trigger conditions are active.";
  }
  if (rollbackTrigger.status === "WARNING") {
    return "REVIEW_REQUIRED: Aligned rollback evidence needs operator review.";
  }

  return "CONTINUE_MONITORING: Settlement Service remains authoritative with aligned rollback evidence ready.";
}

function rate(part: number, total: number) {
  if (total === 0) return 0;

  return Number((part / total).toFixed(6));
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
  RollbackTriggerEvidenceSummary,
  "mismatchRate" | "failureRate" | "readiness"
>): RollbackTriggerEvidenceSummary {
  const totalEvents = totalRuns + failures;
  const mismatchRate = rate(mismatches, totalEvents);
  const failureRate = rate(failures, totalEvents);
  let readiness: RollbackTriggerEvidenceSummary["readiness"] = "READY";

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

function rawEvidenceHasTrigger(summary: RollbackTriggerEvidenceSummary) {
  return summary.readiness !== "READY";
}

function effectiveEvidenceHasTrigger(summary: RollbackTriggerEvidenceSummary) {
  return summary.readiness === "BLOCKED";
}

function lifecycleParticipatesInRollback(evidence: ClassifiedShadowEvidence) {
  return (
    evidence.lifecycleStatus === "ACTIVE" ||
    evidence.lifecycleStatus === "REVIEW_REQUIRED"
  );
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
  rawEvidence: RollbackTriggerEvidenceSummary;
  promotionEvidence: RollbackTriggerEvidenceSummary;
  postPromotionEvidence: RollbackTriggerEvidenceSummary;
}): {
  rollbackTrigger: SettlementPostPromotionStatus["rollbackTrigger"];
  triggerSource: RollbackTriggerEvidenceSource;
  details: RollbackEvaluationDetails;
} {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const rawTriggerActive = rawEvidenceHasTrigger(rawEvidence);
  const promotionTriggerActive = effectiveEvidenceHasTrigger(promotionEvidence);
  const postPromotionTriggerActive = effectiveEvidenceHasTrigger(postPromotionEvidence);
  const triggerSource: RollbackTriggerEvidenceSource =
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
  const status: RollbackTriggerEvidenceSummary["readiness"] = shouldTriggerRollback
    ? "BLOCKED"
    : warnings.length > 0
      ? "WARNING"
      : "READY";
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

export async function getSettlementPostPromotionStatus(): Promise<SettlementPostPromotionStatus> {
  const [promotionStatus, rollbackReadiness, shadowAnalysis] =
    await Promise.all([
      getSettlementPromotionStatus(),
      validateRollbackReadiness(),
      getShadowAnalysisSummary("all"),
    ]);
  const promotedAt = promotionStatus.promotedAt;
  const sinceFilter = promotedAt ? { from: promotedAt, limit: 10000 } : { limit: 10000 };
  const [
    latestShadowRun,
    runs,
    mismatches,
    failures,
    classifiedMismatches,
    classifiedFailures,
  ] = await Promise.all([
    getLatestSettlementShadowRun(),
    getSettlementShadowRuns(sinceFilter),
    getSettlementShadowMismatches(sinceFilter),
    getSettlementShadowFailures(sinceFilter),
    listShadowAnalysisMismatches("all"),
    listShadowAnalysisFailures("all"),
  ]);
  const settlementRollback = rollbackReadiness.settlement;
  const settlementEvidence = shadowAnalysis.domains.settlement;
  const rawEvidenceSummary = summarizeReadiness({
    source: "RAW_EVIDENCE",
    totalRuns: settlementEvidence.rawReadiness.totalRuns,
    matches: settlementEvidence.rawReadiness.matches,
    mismatches: settlementEvidence.rawReadiness.mismatches,
    failures: settlementEvidence.rawReadiness.failures,
    criticalMismatchCount: settlementEvidence.rawReadiness.criticalMismatchCount,
    effectiveMismatchCount: settlementEvidence.rawReadiness.mismatches,
    effectiveFailureCount: settlementEvidence.rawReadiness.failures,
    excludedMismatchCount:
      settlementEvidence.rawReadiness.mismatches -
      settlementEvidence.promotionReadiness.mismatches,
    excludedFailureCount:
      settlementEvidence.rawReadiness.failures -
      settlementEvidence.promotionReadiness.failures,
    reasons: settlementEvidence.rawReadiness.reasons,
  });
  const promotionEvidenceSummary = summarizeReadiness({
    source: "PROMOTION_EVIDENCE",
    totalRuns: settlementEvidence.promotionReadiness.totalRuns,
    matches: settlementEvidence.promotionReadiness.matches,
    mismatches: settlementEvidence.promotionReadiness.mismatches,
    failures: settlementEvidence.promotionReadiness.failures,
    criticalMismatchCount:
      settlementEvidence.promotionReadiness.criticalMismatchCount,
    effectiveMismatchCount: settlementEvidence.promotionReadiness.mismatches,
    effectiveFailureCount: settlementEvidence.promotionReadiness.failures,
    excludedMismatchCount:
      settlementEvidence.rawReadiness.mismatches -
      settlementEvidence.promotionReadiness.mismatches,
    excludedFailureCount:
      settlementEvidence.rawReadiness.failures -
      settlementEvidence.promotionReadiness.failures,
    reasons: settlementEvidence.promotionReadiness.reasons,
  });
  const postPromotionClassifiedMismatches = classifiedMismatches.filter(
    (mismatch) =>
      mismatch.domain === "SETTLEMENT" &&
      isOnOrAfter(mismatch.createdAt, promotedAt)
  );
  const postPromotionClassifiedFailures = classifiedFailures.filter(
    (failure) =>
      failure.domain === "SETTLEMENT" &&
      isOnOrAfter(failure.createdAt, promotedAt)
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
  const recommendation = getPostPromotionRecommendation({
    authority: promotionStatus.authority,
    comparisonMode: promotionStatus.comparisonMode,
    rollbackReady: promotionStatus.rollbackReady,
    rollbackTrigger: alignedEvaluation.rollbackTrigger,
    serviceAvailable: settlementRollback.serviceHealth.available,
  });

  return {
    domain: "SETTLEMENT",
    authority: promotionStatus.authority,
    comparisonMode: promotionStatus.comparisonMode,
    promotedAt,
    serviceHealth: settlementRollback.serviceHealth,
    rollbackReadiness: settlementRollback.rollbackStatus,
    rollbackTrigger: alignedEvaluation.rollbackTrigger,
    triggerSource: alignedEvaluation.triggerSource,
    rawEvidenceSummary,
    promotionEvidenceSummary,
    postPromotionEvidenceSummary,
    rollbackEvaluationDetails: alignedEvaluation.details,
    latestSettlementShadowComparison: latestShadowRun
      ? {
          id: latestShadowRun.id,
          comparisonStatus: latestShadowRun.comparisonStatus,
          ticketId: latestShadowRun.ticketId,
          correlationId: latestShadowRun.correlationId ?? null,
          createdAt: latestShadowRun.createdAt,
        }
      : null,
    postPromotionMismatchCount: postPromotionEffectiveMismatchCount,
    postPromotionFailureCount: postPromotionEffectiveFailureCount,
    recommendation,
    evaluatedAt: nowIso(),
  };
}

export async function simulateSettlementRollbackDrill(
  input: RollbackDrillInput
): Promise<SettlementRollbackDrill> {
  assertSupportedPromotionExecutionDomain(input.domain);

  if (input.mode !== "SIMULATION") {
    throw new PromotionExecutionValidationError(
      "Rollback drill only supports SIMULATION mode."
    );
  }

  const correlationId = normalizeCorrelationId(input.correlationId);
  const authorityBefore = getAuthorityStatus().settlement;
  const rollbackReadiness = await validateRollbackReadiness();
  const settlementRollback = rollbackReadiness.settlement;
  const validationResults = [
    validationResult(
      "AUTHORITY_SERVICE",
      authorityBefore.authority === "SERVICE",
      "Settlement authority must be SERVICE before rollback drill."
    ),
    validationResult(
      "MONOLITH_PATH_AVAILABLE",
      settlementRollback.monolithPathAvailable,
      "Monolith path must be available."
    ),
    validationResult(
      "SERVICE_PATH_AVAILABLE",
      settlementRollback.serviceHealth.available,
      "Settlement Service path must be available."
    ),
    validationResult(
      "AUTHORITY_CONTROLS_AVAILABLE",
      authorityBefore.authority === "MONOLITH" ||
        authorityBefore.authority === "SERVICE",
      "Authority controls must be available."
    ),
    validationResult(
      "COMPARISON_ENABLED",
      authorityBefore.comparisonMode === "ENABLED",
      "Settlement comparison mode must be ENABLED."
    ),
    validationResult(
      "ROLLBACK_READY",
      settlementRollback.rollbackStatus === "READY",
      "Rollback readiness must be READY."
    ),
  ];
  const blockers = collectBlockers(validationResults);
  const warnings = settlementRollback.reasons.filter(
    (reason) => reason !== "Authority and rollback controls are within ready thresholds."
  );
  const simulatedAt = nowIso();
  const auditEvent = await createOutboxEvent({
    eventType: "authority.rollback.drill.simulated",
    aggregateType: "authority_candidate",
    aggregateId: "SETTLEMENT",
    correlationId,
    payload: {
      domain: "SETTLEMENT",
      mode: "SIMULATION",
      authorityState: authorityBefore.authority,
      comparisonMode: authorityBefore.comparisonMode,
      rollbackReadiness: settlementRollback.rollbackStatus,
      drillPassed: blockers.length === 0,
      blockers,
      warnings,
      simulatedAt,
    },
  });
  const authorityAfter = getAuthorityStatus().settlement;

  return {
    domain: "SETTLEMENT",
    mode: "SIMULATION",
    authorityBefore: authorityBefore.authority,
    authorityAfter: authorityAfter.authority,
    comparisonMode: authorityAfter.comparisonMode,
    rollbackReadiness: settlementRollback.rollbackStatus,
    serviceHealth: settlementRollback.serviceHealth,
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
