import {
  getAuthorityStatus,
  validateRollbackReadiness,
} from "../authority-control/authority-control.service";
import { setRuntimeAuthorityDomainConfiguration } from "../authority-control/authority-control.repository";
import type { AuthenticatedUser } from "../auth/auth-context.types";
import { createOutboxEvent, listRecentOutboxEvents } from "../outbox/outbox.service";
import { getPromotionDecision } from "../promotion-decision/promotion-decision.service";
import {
  getLedgerShadowMismatches,
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
  LedgerAuthorityRuntimeRoute,
  LedgerDryRunEvaluation,
  LedgerPromotionStatus,
  LedgerRollbackTriggerEvaluation,
  LedgerSimulationResult,
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
  return approvals.find((approval) => approval.approvalType === approvalType) ?? null;
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

  if (ledgerAuthority.authority !== "MONOLITH") {
    remainingBlockers.push("Ledger authority is not MONOLITH.");
  } else {
    readinessReasons.push("Ledger authority remains MONOLITH.");
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
