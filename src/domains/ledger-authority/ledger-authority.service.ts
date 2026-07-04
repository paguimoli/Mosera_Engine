import {
  getAuthorityStatus,
  validateRollbackReadiness,
} from "../authority-control/authority-control.service";
import { setRuntimeAuthorityDomainConfiguration } from "../authority-control/authority-control.repository";
import type { AuthenticatedUser } from "../auth/auth-context.types";
import { createOutboxEvent, listRecentOutboxEvents } from "../outbox/outbox.service";
import {
  createAuthorityApprovalRecord,
  findAuthorityApprovalRecordByCorrelationId,
} from "../authority-approval/authority-approval.repository";
import { getSettlementStabilizationStatus } from "../settlement-stabilization/settlement-stabilization.service";
import { getPromotionDecision } from "../promotion-decision/promotion-decision.service";
import {
  getShadowAnalysisSummary,
  listShadowAnalysisFailures,
  listShadowAnalysisMismatches,
} from "../shadow-analysis/shadow-analysis.service";
import type { ClassifiedShadowEvidence } from "../shadow-analysis/shadow-analysis.types";
import {
  checkFinancialAuthorityServiceReadiness,
  evaluateFinancialAuthorityGuardrail,
  readFinancialAuthorityCapabilityEvidenceFromEnv,
} from "../financial-authority/financial-authority-guardrails";
import {
  getLatestLedgerShadowRun,
  getLedgerShadowFailures,
  getLedgerShadowMismatches,
  getLedgerShadowRuns,
  getLedgerShadowSummary,
} from "../ledger-shadow/ledger-shadow-reporting.service";
import type {
  AuthorityApprovalRecord,
  AuthorityApprovalType,
} from "../authority-approval/authority-approval.types";
import { listLedgerAuthorityApprovalRecords } from "./ledger-authority.repository";
import type {
  LedgerAuthorityCandidateStatus,
  LedgerAuthorityDryRunMode,
  LedgerAuthorityMetrics,
  LedgerAuthorityPromotion,
  LedgerAuthorityReadiness,
  LedgerCertificationInput,
  LedgerCertificationResult,
  LedgerAuthorityRuntimeRoute,
  LedgerDryRunEvaluation,
  LedgerPostPromotionStatus,
  LedgerPromotionStatus,
  LedgerRollbackDrill,
  LedgerRollbackEvaluationDetails,
  LedgerRollbackTriggerEvidenceSource,
  LedgerRollbackTriggerEvidenceSummary,
  LedgerRollbackTriggerEvaluation,
  LedgerSimulationResult,
  LedgerStabilizationStatus,
} from "./ledger-authority.types";

function nowIso() {
  return new Date().toISOString();
}

function getNumberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);

  return Number.isFinite(value) ? value : fallback;
}

function getDryRunMode(): LedgerAuthorityDryRunMode {
  return process.env.LEDGER_AUTHORITY_DRY_RUN_MODE === "ENABLED"
    ? "ENABLED"
    : "DISABLED";
}

function rate(part: number, total: number) {
  if (total === 0) return 0;

  return Number((part / total).toFixed(6));
}

function maxStatus(
  statuses: LedgerAuthorityCandidateStatus[]
): LedgerAuthorityCandidateStatus {
  if (statuses.includes("BLOCKED")) return "BLOCKED";
  if (statuses.includes("WARNING")) return "WARNING";

  return "READY";
}

function getThresholds() {
  return {
    mismatchAlertThreshold: getNumberEnv("LEDGER_MISMATCH_ALERT_THRESHOLD", 0.001),
    rollbackFailureThreshold: getNumberEnv(
      "LEDGER_ROLLBACK_FAILURE_THRESHOLD",
      0.001
    ),
  };
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
    .filter((warning): warning is string => typeof warning === "string")
    .map((warning) => warning.trim())
    .filter(Boolean);
}

function getPromotionMetadata() {
  return {
    promotedAt: process.env.LEDGER_PROMOTED_AT || null,
    promotionApprovalId: process.env.LEDGER_PROMOTION_APPROVAL_ID || null,
  };
}

async function getLatestPromotionEventMetadata() {
  const events = await listRecentOutboxEvents({ limit: 10000 });
  const promotionEvent = events.find(
    (event) =>
      event.eventType === "authority.ledger.promoted" &&
      event.aggregateType === "authority_candidate" &&
      event.aggregateId === "LEDGER"
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

export class LedgerAuthorityValidationError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "LedgerAuthorityValidationError";
    this.status = status;
  }
}

export async function resolveLedgerAuthorityRoute(): Promise<LedgerAuthorityRuntimeRoute> {
  const authority = getAuthorityStatus().ledger;
  const dryRunMode = getDryRunMode();
  const reasons: string[] = [];

  reasons.push(
    authority.authority === "MONOLITH"
      ? "Monolith ledger remains authoritative."
      : "Ledger Service is configured as authoritative."
  );

  if (authority.comparisonMode === "ENABLED") {
    reasons.push(
      authority.authority === "SERVICE"
        ? "Monolith ledger remains available for comparison."
        : "Ledger Service remains available for comparison."
    );
  } else {
    reasons.push("Ledger comparison mode is disabled.");
  }

  if (dryRunMode === "ENABLED") {
    reasons.push("Ledger authority dry-run mode is enabled.");
  }

  return {
    authoritativePath: authority.authority,
    comparisonMode: authority.comparisonMode,
    comparisonPath:
      authority.comparisonMode === "ENABLED"
        ? authority.authority === "SERVICE"
          ? "MONOLITH"
          : "LEDGER_SERVICE"
        : null,
    dryRunMode,
    productionCutoverActive: authority.authority === "SERVICE",
    reasons,
  };
}

async function getMetrics(): Promise<LedgerAuthorityMetrics> {
  const [summary, mismatches] = await Promise.all([
    getLedgerShadowSummary(),
    getLedgerShadowMismatches({ limit: 10000 }),
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
  metrics: LedgerAuthorityMetrics | null;
  rollbackReadinessStatus: LedgerAuthorityCandidateStatus;
  authority: ReturnType<typeof getAuthorityStatus>["ledger"];
}): LedgerRollbackTriggerEvaluation {
  const thresholds = getThresholds();
  const reasons: string[] = [];

  if (!metrics) {
    return {
      shouldTriggerRollback: false,
      status: "WARNING",
      reasons: ["Ledger shadow metrics are unavailable."],
    };
  }

  if (metrics.criticalMismatchPresent) {
    reasons.push("Critical ledger shadow mismatches are present.");
  }
  if (metrics.mismatchRate >= thresholds.mismatchAlertThreshold) {
    reasons.push("Ledger mismatch rate is at or above alert threshold.");
  }
  if (metrics.failureRate >= thresholds.rollbackFailureThreshold) {
    reasons.push("Ledger shadow failure rate is at or above rollback threshold.");
  }
  if (rollbackReadinessStatus === "BLOCKED") {
    reasons.push("Ledger rollback readiness is blocked.");
  }

  const shouldTriggerRollback =
    authority.authority === "SERVICE" && reasons.length > 0;

  if (!shouldTriggerRollback && reasons.length === 0) {
    reasons.push("No automatic ledger rollback trigger is active.");
  }

  return {
    shouldTriggerRollback,
    status: shouldTriggerRollback ? "BLOCKED" : reasons.length > 0 ? "WARNING" : "READY",
    reasons,
  };
}

export async function getLedgerAuthorityReadiness(): Promise<LedgerAuthorityReadiness> {
  const authorityStatus = getAuthorityStatus();
  const ledgerAuthority = authorityStatus.ledger;
  const route = await resolveLedgerAuthorityRoute();
  const rollbackReadiness = await validateRollbackReadiness();
  const rollbackReadinessStatus = rollbackReadiness.ledger.rollbackStatus;
  const capabilityEvidence = readFinancialAuthorityCapabilityEvidenceFromEnv("LEDGER");
  const readinessHealthy = await checkFinancialAuthorityServiceReadiness(
    ledgerAuthority.serviceUrl
  );
  const productionGuardrail = evaluateFinancialAuthorityGuardrail({
    config: ledgerAuthority,
    serviceReachable: rollbackReadiness.ledger.serviceHealth.available,
    readinessHealthy,
    ...capabilityEvidence,
  });
  const thresholds = getThresholds();
  const readinessReasons: string[] = [];
  const remainingBlockers: string[] = [];
  let metrics: LedgerAuthorityMetrics | null = null;

  try {
    metrics = await getMetrics();
  } catch (error) {
    remainingBlockers.push(
      error instanceof Error ? error.message : "Ledger shadow metrics are unavailable."
    );
  }

  if (productionGuardrail.productionStatus === "MONOLITH_ALLOWED") {
    readinessReasons.push("Ledger authority remains MONOLITH.");
  } else if (productionGuardrail.productionReady) {
    readinessReasons.push("Ledger Service production mutation capability guardrail passed.");
  } else {
    remainingBlockers.push(...productionGuardrail.blockers);
  }

  if (ledgerAuthority.comparisonMode !== "ENABLED") {
    remainingBlockers.push("Ledger comparison mode is disabled.");
  } else {
    readinessReasons.push("Ledger comparison mode is enabled.");
  }

  if (rollbackReadinessStatus === "BLOCKED") {
    remainingBlockers.push("Ledger rollback readiness is blocked.");
  } else {
    readinessReasons.push(`Ledger rollback readiness is ${rollbackReadinessStatus}.`);
  }

  if (metrics) {
    if (metrics.criticalMismatchPresent) {
      remainingBlockers.push("Critical ledger mismatches are present.");
    }
    if (metrics.mismatchRate >= thresholds.mismatchAlertThreshold) {
      remainingBlockers.push("Ledger mismatch threshold is exceeded.");
    }
    readinessReasons.push(`Ledger shadow readiness is ${metrics.shadowReadinessStatus}.`);
  }

  readinessReasons.push(
    route.dryRunMode === "ENABLED"
      ? "Ledger authority dry-run mode is enabled."
      : "Ledger authority dry-run mode is disabled."
  );

  const rollbackTrigger = evaluateRollbackTrigger({
    metrics,
    rollbackReadinessStatus,
    authority: ledgerAuthority,
  });
  const status = maxStatus([
    remainingBlockers.length > 0 ? "BLOCKED" : "READY",
    rollbackTrigger.status,
    metrics?.shadowReadinessStatus ?? "WARNING",
  ]);

  return {
    status,
    authority: ledgerAuthority.authority,
    comparisonMode: ledgerAuthority.comparisonMode,
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
    requirements.push("DRY_RUN_APPROVAL is required before ledger dry-run activation.");
  }
  if (!hasPromotionApproval) {
    requirements.push("PROMOTION_APPROVAL is required before ledger authority promotion.");
  }
  requirements.push("ROLLBACK_APPROVAL is required before any future ledger rollback action.");

  return requirements;
}

export async function getLedgerDryRunEvaluation(): Promise<LedgerDryRunEvaluation> {
  const [promotionDecision, approvals] = await Promise.all([
    getPromotionDecision({ domain: "LEDGER" }),
    listLedgerAuthorityApprovalRecords(),
  ]);
  const wouldThresholdsBeExceeded =
    promotionDecision.promotionReadiness.readiness !== "READY";
  const wouldRollbackTrigger =
    promotionDecision.decision === "ROLLBACK_RECOMMENDED" ||
    promotionDecision.blockingReasons.length > 0;

  return {
    authorityCandidate: "LEDGER",
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
    rollbackReadiness: promotionDecision.rollbackReadiness,
    promotionBlockers: promotionDecision.blockingReasons,
    approvalRequirements: approvalRequirements({
      hasDryRunApproval: Boolean(latestApproval(approvals, "DRY_RUN_APPROVAL")),
      hasPromotionApproval: Boolean(latestApproval(approvals, "PROMOTION_APPROVAL")),
    }),
    evaluatedAt: nowIso(),
  };
}

function ledgerRollbackReadiness(summary: Awaited<ReturnType<typeof validateRollbackReadiness>>) {
  return summary.ledger;
}

export async function simulateLedgerPromotion({
  actorUserId,
  correlationId,
}: {
  actorUserId?: string | null;
  correlationId?: unknown;
} = {}): Promise<LedgerSimulationResult> {
  const normalizedCorrelationId = normalizeCorrelationId(correlationId);
  const [promotionDecision, rollbackReadiness] = await Promise.all([
    getPromotionDecision({ domain: "LEDGER" }),
    validateRollbackReadiness(),
  ]);
  const ledgerRollback = ledgerRollbackReadiness(rollbackReadiness);
  const validationResults = [
    validationResult(
      "PROMOTION_DECISION_READY",
      promotionDecision.decision === "READY_FOR_CONTROLLED_PROMOTION",
      "Ledger promotion decision must be READY_FOR_CONTROLLED_PROMOTION."
    ),
    validationResult(
      "DRY_RUN_APPROVAL_EXISTS",
      Boolean(promotionDecision.approvalState.dryRunApproval),
      "Ledger DRY_RUN_APPROVAL must exist."
    ),
    validationResult(
      "PROMOTION_APPROVAL_EXISTS",
      Boolean(promotionDecision.approvalState.promotionApproval),
      "Ledger PROMOTION_APPROVAL must exist."
    ),
    validationResult(
      "ROLLBACK_READY",
      promotionDecision.rollbackReadiness === "READY" &&
        ledgerRollback.rollbackStatus === "READY",
      "Ledger rollback readiness must be READY."
    ),
    validationResult(
      "AUTHORITY_MONOLITH",
      promotionDecision.currentAuthority === "MONOLITH",
      "Ledger authority must remain MONOLITH before controlled promotion."
    ),
    validationResult(
      "COMPARISON_ENABLED",
      promotionDecision.comparisonMode === "ENABLED",
      "Ledger comparison mode must be ENABLED."
    ),
    validationResult(
      "SERVICE_HEALTHY",
      ledgerRollback.serviceHealth.available,
      "Ledger Service health must be available."
    ),
  ];
  const blockers = collectBlockers(validationResults);
  const warnings = [...promotionDecision.warnings];
  const simulatedAt = nowIso();
  const auditEvent = await createOutboxEvent({
    eventType: "authority.ledger.promotion.simulated",
    aggregateType: "authority_candidate",
    aggregateId: "LEDGER",
    correlationId: normalizedCorrelationId,
    payload: {
      domain: "LEDGER",
      actorUserId: actorUserId ?? null,
      currentAuthority: promotionDecision.currentAuthority,
      proposedAuthority: "SERVICE",
      simulatedAuthority: "SERVICE",
      comparisonMode: promotionDecision.comparisonMode,
      decision: promotionDecision.decision,
      rollbackReadiness: promotionDecision.rollbackReadiness,
      rollbackReady:
        promotionDecision.rollbackReadiness === "READY" &&
        ledgerRollback.rollbackStatus === "READY",
      promotionAllowed: blockers.length === 0,
      blockers,
      warnings,
      timestamp: simulatedAt,
      simulatedAt,
    },
  });

  return {
    domain: "LEDGER",
    currentAuthority: promotionDecision.currentAuthority,
    proposedAuthority: "SERVICE",
    simulatedAuthority: "SERVICE",
    comparisonMode: promotionDecision.comparisonMode,
    promotionDecision: promotionDecision.decision,
    rollbackReadiness: promotionDecision.rollbackReadiness,
    rollbackReady:
      promotionDecision.rollbackReadiness === "READY" &&
      ledgerRollback.rollbackStatus === "READY",
    serviceHealth: ledgerRollback.serviceHealth,
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

export async function simulateLedgerRollback({
  actorUserId,
  correlationId,
}: {
  actorUserId?: string | null;
  correlationId?: unknown;
} = {}): Promise<LedgerSimulationResult> {
  const normalizedCorrelationId = normalizeCorrelationId(correlationId);
  const [rollbackReadiness, promotionDecision] = await Promise.all([
    validateRollbackReadiness(),
    getPromotionDecision({ domain: "LEDGER" }),
  ]);
  const ledgerRollback = ledgerRollbackReadiness(rollbackReadiness);
  const validationResults = [
    validationResult(
      "MONOLITH_PATH_AVAILABLE",
      ledgerRollback.monolithPathAvailable,
      "Ledger monolith path must be available."
    ),
    validationResult(
      "COMPARISON_MODE_AVAILABLE",
      ledgerRollback.comparisonMode === "ENABLED",
      "Ledger comparison mode must be ENABLED."
    ),
    validationResult(
      "AUTHORITY_CONTROLS_AVAILABLE",
      ledgerRollback.authority === "MONOLITH" || ledgerRollback.authority === "SERVICE",
      "Ledger authority controls must be available."
    ),
    validationResult(
      "ROLLBACK_READY",
      ledgerRollback.rollbackStatus === "READY",
      "Ledger rollback readiness must be READY."
    ),
  ];
  const blockers = collectBlockers(validationResults);
  const warnings = ledgerRollback.reasons.filter(
    (reason) => reason !== "Authority and rollback controls are within ready thresholds."
  );
  const simulatedAt = nowIso();
  const auditEvent = await createOutboxEvent({
    eventType: "authority.ledger.rollback.simulated",
    aggregateType: "authority_candidate",
    aggregateId: "LEDGER",
    correlationId: normalizedCorrelationId,
    payload: {
      domain: "LEDGER",
      actorUserId: actorUserId ?? null,
      authorityState: ledgerRollback.authority,
      comparisonMode: ledgerRollback.comparisonMode,
      decision: promotionDecision.decision,
      rollbackReadiness: ledgerRollback.rollbackStatus,
      rollbackReady: ledgerRollback.rollbackStatus === "READY",
      rollbackAllowed: blockers.length === 0,
      blockers,
      warnings,
      timestamp: simulatedAt,
      simulatedAt,
    },
  });

  return {
    domain: "LEDGER",
    authorityState: ledgerRollback.authority,
    simulatedAuthority: "MONOLITH",
    comparisonMode: ledgerRollback.comparisonMode,
    rollbackReadiness: ledgerRollback.rollbackStatus,
    rollbackReady: ledgerRollback.rollbackStatus === "READY",
    serviceHealth: ledgerRollback.serviceHealth,
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

export async function promoteLedgerAuthority({
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
}): Promise<LedgerAuthorityPromotion> {
  if (domain !== "LEDGER") {
    throw new LedgerAuthorityValidationError("Only LEDGER promotion is supported.");
  }

  if (mode !== "EXECUTE") {
    throw new LedgerAuthorityValidationError("Promotion mode must be EXECUTE.");
  }

  const normalizedJustification = normalizeJustification(justification);
  if (!normalizedJustification) {
    throw new LedgerAuthorityValidationError("Justification is required.");
  }

  const normalizedCorrelationId = normalizeCorrelationId(correlationId);
  const authorityStatusBefore = getAuthorityStatus().ledger;
  const promotionDecisionBefore = await getPromotionDecision({ domain: "LEDGER" });
  const promotionApproval = promotionDecisionBefore.approvalState.promotionApproval;

  if (authorityStatusBefore.authority === "SERVICE") {
    const rollbackReadiness = await validateRollbackReadiness();
    const metadata = getPromotionMetadata();

    return {
      domain: "LEDGER",
      previousAuthority: "SERVICE",
      newAuthority: "SERVICE",
      comparisonMode: "ENABLED",
      rollbackReadiness: rollbackReadiness.ledger.rollbackStatus,
      promotionApprovalId:
        metadata.promotionApprovalId ?? promotionApproval?.id ?? null,
      promotedAt: metadata.promotedAt ?? nowIso(),
      correlationId: normalizedCorrelationId,
      idempotent: true,
      auditEvent: null,
    };
  }

  const simulation = await simulateLedgerPromotion({
    actorUserId: actor.id,
    correlationId: normalizedCorrelationId,
  });

  if (!simulation.promotionAllowed) {
    throw new LedgerAuthorityValidationError(
      "Ledger authority promotion preconditions are not satisfied.",
      409
    );
  }

  if (!promotionApproval) {
    throw new LedgerAuthorityValidationError(
      "PROMOTION_APPROVAL is required before controlled promotion.",
      409
    );
  }

  const promotedAt = nowIso();
  setRuntimeAuthorityDomainConfiguration({
    domain: "LEDGER",
    authority: "SERVICE",
    comparisonMode: "ENABLED",
  });
  process.env.LEDGER_PROMOTED_AT = promotedAt;
  process.env.LEDGER_PROMOTION_APPROVAL_ID = promotionApproval.id;

  const auditEvent = await createOutboxEvent({
    eventType: "authority.ledger.promoted",
    aggregateType: "authority_candidate",
    aggregateId: "LEDGER",
    correlationId: normalizedCorrelationId,
    payload: {
      domain: "LEDGER",
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
    domain: "LEDGER",
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

export async function getLedgerPromotionStatus(): Promise<LedgerPromotionStatus> {
  const [authorityStatus, rollbackReadiness, promotionDecision, eventMetadata] =
    await Promise.all([
      Promise.resolve(getAuthorityStatus()),
      validateRollbackReadiness(),
      getPromotionDecision({ domain: "LEDGER" }),
      getLatestPromotionEventMetadata(),
    ]);
  const ledgerAuthority = authorityStatus.ledger;
  const ledgerRollback = rollbackReadiness.ledger;
  const metadata = getPromotionMetadata();

  return {
    domain: "LEDGER",
    authority: ledgerAuthority.authority,
    comparisonMode: ledgerAuthority.comparisonMode,
    promotedAt:
      ledgerAuthority.authority === "SERVICE"
        ? metadata.promotedAt ??
          eventMetadata.promotedAt ??
          promotionDecision.approvalState.promotionApproval?.createdAt ??
          null
        : null,
    rollbackReady: ledgerRollback.rollbackStatus === "READY",
    rollbackReadiness: ledgerRollback.rollbackStatus,
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
  rollbackTrigger: LedgerPostPromotionStatus["rollbackTrigger"];
  serviceAvailable: boolean;
}) {
  if (authority !== "SERVICE") {
    return "BLOCKED: Ledger is not currently service-authoritative.";
  }
  if (comparisonMode !== "ENABLED") {
    return "BLOCKED: Ledger comparison mode must be re-enabled.";
  }
  if (!serviceAvailable) {
    return "ROLLBACK_RECOMMENDED: Ledger Service health is unavailable.";
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

  return "CONTINUE_MONITORING: Ledger Service remains authoritative with aligned rollback evidence ready.";
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
  LedgerRollbackTriggerEvidenceSummary,
  "mismatchRate" | "failureRate" | "readiness"
>): LedgerRollbackTriggerEvidenceSummary {
  const totalEvents = totalRuns + failures;
  const mismatchRate = rate(mismatches, totalEvents);
  const failureRate = rate(failures, totalEvents);
  let readiness: LedgerRollbackTriggerEvidenceSummary["readiness"] = "READY";

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

function rawEvidenceHasTrigger(summary: LedgerRollbackTriggerEvidenceSummary) {
  return summary.readiness !== "READY";
}

function effectiveEvidenceHasTrigger(summary: LedgerRollbackTriggerEvidenceSummary) {
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
  rawEvidence: LedgerRollbackTriggerEvidenceSummary;
  promotionEvidence: LedgerRollbackTriggerEvidenceSummary;
  postPromotionEvidence: LedgerRollbackTriggerEvidenceSummary;
}): {
  rollbackTrigger: LedgerPostPromotionStatus["rollbackTrigger"];
  triggerSource: LedgerRollbackTriggerEvidenceSource;
  details: LedgerRollbackEvaluationDetails;
} {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const rawTriggerActive = rawEvidenceHasTrigger(rawEvidence);
  const promotionTriggerActive = effectiveEvidenceHasTrigger(promotionEvidence);
  const postPromotionTriggerActive = effectiveEvidenceHasTrigger(postPromotionEvidence);
  const triggerSource: LedgerRollbackTriggerEvidenceSource =
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
  const status: LedgerRollbackTriggerEvidenceSummary["readiness"] =
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

export async function getLedgerPostPromotionStatus(): Promise<LedgerPostPromotionStatus> {
  const [promotionStatus, rollbackReadiness, shadowAnalysis] =
    await Promise.all([
      getLedgerPromotionStatus(),
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
    getLatestLedgerShadowRun(),
    getLedgerShadowRuns(sinceFilter),
    getLedgerShadowMismatches(sinceFilter),
    getLedgerShadowFailures(sinceFilter),
    listShadowAnalysisMismatches("all"),
    listShadowAnalysisFailures("all"),
  ]);
  const ledgerRollback = rollbackReadiness.ledger;
  const ledgerEvidence = shadowAnalysis.domains.ledger;
  const rawEvidenceSummary = summarizeReadiness({
    source: "RAW_EVIDENCE",
    totalRuns: ledgerEvidence.rawReadiness.totalRuns,
    matches: ledgerEvidence.rawReadiness.matches,
    mismatches: ledgerEvidence.rawReadiness.mismatches,
    failures: ledgerEvidence.rawReadiness.failures,
    criticalMismatchCount: ledgerEvidence.rawReadiness.criticalMismatchCount,
    effectiveMismatchCount: ledgerEvidence.rawReadiness.mismatches,
    effectiveFailureCount: ledgerEvidence.rawReadiness.failures,
    excludedMismatchCount:
      ledgerEvidence.rawReadiness.mismatches -
      ledgerEvidence.promotionReadiness.mismatches,
    excludedFailureCount:
      ledgerEvidence.rawReadiness.failures -
      ledgerEvidence.promotionReadiness.failures,
    reasons: ledgerEvidence.rawReadiness.reasons,
  });
  const promotionEvidenceSummary = summarizeReadiness({
    source: "PROMOTION_EVIDENCE",
    totalRuns: ledgerEvidence.promotionReadiness.totalRuns,
    matches: ledgerEvidence.promotionReadiness.matches,
    mismatches: ledgerEvidence.promotionReadiness.mismatches,
    failures: ledgerEvidence.promotionReadiness.failures,
    criticalMismatchCount: ledgerEvidence.promotionReadiness.criticalMismatchCount,
    effectiveMismatchCount: ledgerEvidence.promotionReadiness.mismatches,
    effectiveFailureCount: ledgerEvidence.promotionReadiness.failures,
    excludedMismatchCount:
      ledgerEvidence.rawReadiness.mismatches -
      ledgerEvidence.promotionReadiness.mismatches,
    excludedFailureCount:
      ledgerEvidence.rawReadiness.failures -
      ledgerEvidence.promotionReadiness.failures,
    reasons: ledgerEvidence.promotionReadiness.reasons,
  });
  const postPromotionClassifiedMismatches = classifiedMismatches.filter(
    (mismatch) =>
      mismatch.domain === "LEDGER" && isOnOrAfter(mismatch.createdAt, promotedAt)
  );
  const postPromotionClassifiedFailures = classifiedFailures.filter(
    (failure) =>
      failure.domain === "LEDGER" && isOnOrAfter(failure.createdAt, promotedAt)
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
    serviceAvailable: ledgerRollback.serviceHealth.available,
  });

  return {
    domain: "LEDGER",
    authority: promotionStatus.authority,
    comparisonMode: promotionStatus.comparisonMode,
    promotedAt,
    serviceHealth: ledgerRollback.serviceHealth,
    rollbackReadiness: ledgerRollback.rollbackStatus,
    rollbackTrigger: alignedEvaluation.rollbackTrigger,
    triggerSource: alignedEvaluation.triggerSource,
    rawEvidenceSummary,
    promotionEvidenceSummary,
    postPromotionEvidenceSummary,
    rollbackEvaluationDetails: alignedEvaluation.details,
    latestLedgerShadowComparison: latestShadowRun
      ? {
          id: latestShadowRun.id,
          comparisonStatus: latestShadowRun.comparisonStatus,
          transactionId: latestShadowRun.transactionId,
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

function getLedgerCertificationState({
  authority,
  comparisonMode,
  rollbackReadiness,
  serviceHealthy,
  ledgerEntriesProcessed,
  mismatchCount,
  failureCount,
  criticalMismatchCount,
  existingCertification,
}: {
  authority: string;
  comparisonMode: string;
  rollbackReadiness: string;
  serviceHealthy: boolean;
  ledgerEntriesProcessed: number;
  mismatchCount: number;
  failureCount: number;
  criticalMismatchCount: number;
  existingCertification: AuthorityApprovalRecord | null;
}): {
  certificationStatus: LedgerStabilizationStatus["certificationStatus"];
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
    certificationBlockers.push("Ledger authority must be SERVICE.");
  }
  if (comparisonMode !== "ENABLED") {
    certificationBlockers.push("Ledger comparison mode must be ENABLED.");
  }
  if (rollbackReadiness !== "READY") {
    certificationBlockers.push("Rollback readiness must be READY.");
  }
  if (!serviceHealthy) {
    certificationBlockers.push("Ledger Service health must be healthy.");
  }
  if (ledgerEntriesProcessed <= 0) {
    certificationBlockers.push(
      "At least one post-promotion ledger entry must be processed."
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
    "Operator certification is still required before marking Ledger as CERTIFIED."
  );

  return {
    certificationStatus: "READY_FOR_CERTIFICATION",
    certificationBlockers,
    certificationWarnings,
  };
}

function getLedgerCertificationRecommendation({
  certificationStatus,
  rollbackTrigger,
}: {
  certificationStatus: LedgerStabilizationStatus["certificationStatus"];
  rollbackTrigger: LedgerRollbackTriggerEvaluation;
}) {
  if (rollbackTrigger.shouldTriggerRollback) {
    return "ROLLBACK_RECOMMENDED: Execute the rollback runbook after operator confirmation.";
  }
  if (certificationStatus === "CERTIFIED") {
    return "CERTIFIED: Continue post-promotion monitoring and preserve certification evidence.";
  }
  if (certificationStatus === "READY_FOR_CERTIFICATION") {
    return "READY_FOR_CERTIFICATION: Operator review may proceed; do not mark Ledger CERTIFIED without explicit approval.";
  }
  if (certificationStatus === "REVIEW_REQUIRED") {
    return "REVIEW_REQUIRED: Investigate post-promotion Ledger evidence before certification.";
  }

  return "NOT_READY: Continue collecting clean post-promotion Ledger activity.";
}

export async function getLedgerStabilizationStatus(): Promise<LedgerStabilizationStatus> {
  const [postPromotionStatus, approvals] = await Promise.all([
    getLedgerPostPromotionStatus(),
    listLedgerAuthorityApprovalRecords(),
  ]);
  const certificationApproval = latestApproval(approvals, "LEDGER_CERTIFICATION");
  const ledgerEntriesProcessed =
    postPromotionStatus.postPromotionEvidenceSummary.totalRuns;
  const certification = getLedgerCertificationState({
    authority: postPromotionStatus.authority,
    comparisonMode: postPromotionStatus.comparisonMode,
    rollbackReadiness: postPromotionStatus.rollbackReadiness,
    serviceHealthy: postPromotionStatus.serviceHealth.available,
    ledgerEntriesProcessed,
    mismatchCount: postPromotionStatus.postPromotionMismatchCount,
    failureCount: postPromotionStatus.postPromotionFailureCount,
    criticalMismatchCount:
      postPromotionStatus.postPromotionEvidenceSummary.criticalMismatchCount,
    existingCertification: certificationApproval,
  });

  return {
    domain: "LEDGER",
    authority: postPromotionStatus.authority,
    comparisonMode: postPromotionStatus.comparisonMode,
    promotedAt: postPromotionStatus.promotedAt,
    ledgersProcessed: ledgerEntriesProcessed,
    ledgerEntriesProcessed,
    mismatchCount: postPromotionStatus.postPromotionMismatchCount,
    failureCount: postPromotionStatus.postPromotionFailureCount,
    criticalMismatchCount:
      postPromotionStatus.postPromotionEvidenceSummary.criticalMismatchCount,
    serviceHealth: postPromotionStatus.serviceHealth,
    rollbackReadiness: postPromotionStatus.rollbackReadiness,
    rollbackTrigger: postPromotionStatus.rollbackTrigger,
    certificationStatus: certification.certificationStatus,
    certificationBlockers: certification.certificationBlockers,
    certificationWarnings: certification.certificationWarnings,
    certificationApprovalId: certificationApproval?.id ?? null,
    certifiedAt: certificationApproval?.createdAt ?? null,
    recommendation: getLedgerCertificationRecommendation({
      certificationStatus: certification.certificationStatus,
      rollbackTrigger: postPromotionStatus.rollbackTrigger,
    }),
    generatedAt: nowIso(),
  };
}

export async function certifyLedgerAuthority({
  actor,
  justification,
  acknowledgedWarnings,
  correlationId,
}: LedgerCertificationInput): Promise<LedgerCertificationResult> {
  const normalizedCorrelationId = normalizeCorrelationId(correlationId);

  if (normalizedCorrelationId) {
    const existingApproval = await findAuthorityApprovalRecordByCorrelationId({
      authorityCandidate: "LEDGER",
      approvalType: "LEDGER_CERTIFICATION",
      correlationId: normalizedCorrelationId,
    });

    if (existingApproval) {
      const stabilization = await getLedgerStabilizationStatus();

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
    throw new LedgerAuthorityValidationError("Justification is required.");
  }

  const normalizedAcknowledgedWarnings =
    normalizeAcknowledgedWarnings(acknowledgedWarnings);
  const [stabilizationBefore, settlementStatus, authorityStatus] =
    await Promise.all([
      getLedgerStabilizationStatus(),
      getSettlementStabilizationStatus({ window: "7d" }),
      Promise.resolve(getAuthorityStatus()),
    ]);
  const missingWarnings = stabilizationBefore.certificationWarnings.filter(
    (warning) => !normalizedAcknowledgedWarnings.includes(warning)
  );

  if (missingWarnings.length > 0) {
    throw new LedgerAuthorityValidationError(
      "Certification warnings must be acknowledged before certification."
    );
  }
  if (stabilizationBefore.certificationStatus !== "READY_FOR_CERTIFICATION") {
    throw new LedgerAuthorityValidationError(
      "Ledger is not ready for certification.",
      409
    );
  }
  if (stabilizationBefore.authority !== "SERVICE") {
    throw new LedgerAuthorityValidationError(
      "Ledger authority must be SERVICE before certification.",
      409
    );
  }
  if (stabilizationBefore.comparisonMode !== "ENABLED") {
    throw new LedgerAuthorityValidationError(
      "Ledger comparison mode must be ENABLED before certification.",
      409
    );
  }
  if (stabilizationBefore.rollbackReadiness !== "READY") {
    throw new LedgerAuthorityValidationError(
      "Rollback readiness must be READY before certification.",
      409
    );
  }
  if (!stabilizationBefore.serviceHealth.available) {
    throw new LedgerAuthorityValidationError(
      "Ledger Service health must be healthy before certification.",
      409
    );
  }
  if (
    stabilizationBefore.failureCount !== 0 ||
    stabilizationBefore.criticalMismatchCount !== 0
  ) {
    throw new LedgerAuthorityValidationError(
      "Post-promotion failures and critical mismatches must be zero before certification.",
      409
    );
  }
  if (settlementStatus.authority !== "SERVICE") {
    throw new LedgerAuthorityValidationError(
      "Settlement authority must remain SERVICE before Ledger certification.",
      409
    );
  }
  if (settlementStatus.certificationStatus !== "CERTIFIED") {
    throw new LedgerAuthorityValidationError(
      "Settlement must remain CERTIFIED before Ledger certification.",
      409
    );
  }
  if (authorityStatus.credit.authority !== "MONOLITH") {
    throw new LedgerAuthorityValidationError(
      "Credit authority must remain MONOLITH before Ledger certification.",
      409
    );
  }

  const approval = await createAuthorityApprovalRecord({
    authorityCandidate: "LEDGER",
    approvalType: "LEDGER_CERTIFICATION",
    approverUserId: actor.id,
    approverUsername: actor.username,
    justification: normalizedJustification,
    metadata: {
      acknowledgedWarnings: normalizedAcknowledgedWarnings,
      certificationCapturedAt: new Date().toISOString(),
      correlationId: normalizedCorrelationId,
      certificationStatusBefore: stabilizationBefore.certificationStatus,
      ledgerEntriesProcessed: stabilizationBefore.ledgerEntriesProcessed,
      mismatchCount: stabilizationBefore.mismatchCount,
      failureCount: stabilizationBefore.failureCount,
      criticalMismatchCount: stabilizationBefore.criticalMismatchCount,
      settlementCertificationStatus: settlementStatus.certificationStatus,
      creditAuthority: authorityStatus.credit.authority,
    },
  });

  await createOutboxEvent({
    eventType: "authority.ledger.certified",
    aggregateType: "authority_candidate",
    aggregateId: "LEDGER",
    correlationId: normalizedCorrelationId,
    payload: {
      approvalId: approval.id,
      actorUserId: actor.id,
      correlationId: normalizedCorrelationId,
      certifiedAt: approval.createdAt,
    },
  });

  const stabilizationAfter = await getLedgerStabilizationStatus();

  return {
    approval,
    idempotent: false,
    stabilizationBefore,
    stabilizationAfter,
  };
}

export async function simulateLedgerRollbackDrill({
  mode,
  correlationId,
}: {
  mode: unknown;
  correlationId?: unknown;
}): Promise<LedgerRollbackDrill> {
  if (mode !== "SIMULATION") {
    throw new LedgerAuthorityValidationError(
      "Ledger rollback drill only supports SIMULATION mode."
    );
  }

  const normalizedCorrelationId = normalizeCorrelationId(correlationId);
  const authorityBefore = getAuthorityStatus().ledger;
  const rollbackReadiness = await validateRollbackReadiness();
  const ledgerRollback = rollbackReadiness.ledger;
  const validationResults = [
    validationResult(
      "AUTHORITY_SERVICE",
      authorityBefore.authority === "SERVICE",
      "Ledger authority must be SERVICE before rollback drill."
    ),
    validationResult(
      "MONOLITH_PATH_AVAILABLE",
      ledgerRollback.monolithPathAvailable,
      "Ledger monolith path must be available."
    ),
    validationResult(
      "SERVICE_PATH_AVAILABLE",
      ledgerRollback.serviceHealth.available,
      "Ledger Service path must be available."
    ),
    validationResult(
      "AUTHORITY_CONTROLS_AVAILABLE",
      authorityBefore.authority === "MONOLITH" ||
        authorityBefore.authority === "SERVICE",
      "Ledger authority controls must be available."
    ),
    validationResult(
      "COMPARISON_ENABLED",
      authorityBefore.comparisonMode === "ENABLED",
      "Ledger comparison mode must be ENABLED."
    ),
    validationResult(
      "ROLLBACK_READY",
      ledgerRollback.rollbackStatus === "READY",
      "Ledger rollback readiness must be READY."
    ),
  ];
  const blockers = collectBlockers(validationResults);
  const warnings = ledgerRollback.reasons.filter(
    (reason) => reason !== "Authority and rollback controls are within ready thresholds."
  );
  const simulatedAt = nowIso();
  const auditEvent = await createOutboxEvent({
    eventType: "authority.ledger.rollback.drill.simulated",
    aggregateType: "authority_candidate",
    aggregateId: "LEDGER",
    correlationId: normalizedCorrelationId,
    payload: {
      domain: "LEDGER",
      mode: "SIMULATION",
      authorityState: authorityBefore.authority,
      comparisonMode: authorityBefore.comparisonMode,
      rollbackReadiness: ledgerRollback.rollbackStatus,
      drillPassed: blockers.length === 0,
      blockers,
      warnings,
      simulatedAt,
    },
  });
  const authorityAfter = getAuthorityStatus().ledger;

  return {
    domain: "LEDGER",
    mode: "SIMULATION",
    authorityBefore: authorityBefore.authority,
    authorityAfter: authorityAfter.authority,
    comparisonMode: authorityAfter.comparisonMode,
    rollbackReadiness: ledgerRollback.rollbackStatus,
    serviceHealth: ledgerRollback.serviceHealth,
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
