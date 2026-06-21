import {
  getAuthorityStatus,
  validateRollbackReadiness,
} from "../authority-control/authority-control.service";
import { getSettlementShadowMismatches, getSettlementShadowSummary } from "../settlement-shadow/settlement-shadow-reporting.service";
import { logger } from "@/src/lib/observability/logger";
import type {
  SettlementAuthorityAuditEventType,
  SettlementAuthorityCandidateStatus,
  SettlementAuthorityDryRunMode,
  SettlementAuthorityMetrics,
  SettlementAuthorityReadiness,
  SettlementAuthorityRuntimeRoute,
  SettlementRollbackTriggerEvaluation,
} from "./settlement-authority.types";

function getNumberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);

  return Number.isFinite(value) ? value : fallback;
}

function getDryRunMode(): SettlementAuthorityDryRunMode {
  return process.env.SETTLEMENT_AUTHORITY_DRY_RUN_MODE === "ENABLED"
    ? "ENABLED"
    : "DISABLED";
}

function rate(part: number, total: number) {
  if (total === 0) return 0;

  return Number((part / total).toFixed(6));
}

function maxStatus(
  statuses: SettlementAuthorityCandidateStatus[]
): SettlementAuthorityCandidateStatus {
  if (statuses.includes("BLOCKED")) return "BLOCKED";
  if (statuses.includes("WARNING")) return "WARNING";

  return "READY";
}

function getThresholds() {
  return {
    mismatchAlertThreshold: getNumberEnv(
      "SETTLEMENT_MISMATCH_ALERT_THRESHOLD",
      0.001
    ),
    rollbackFailureThreshold: getNumberEnv(
      "SETTLEMENT_ROLLBACK_FAILURE_THRESHOLD",
      0.001
    ),
  };
}

export function recordSettlementAuthorityAudit({
  eventType,
  correlationId,
  metadata,
}: {
  eventType: SettlementAuthorityAuditEventType;
  correlationId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  logger.info({
    message: "Settlement authority control event recorded.",
    correlationId,
    metadata: {
      eventType,
      ...metadata,
    },
  });
}

export async function resolveSettlementAuthorityRoute(): Promise<SettlementAuthorityRuntimeRoute> {
  const authority = getAuthorityStatus().settlement;
  const dryRunMode = getDryRunMode();
  const reasons: string[] = [];

  if (authority.authority === "MONOLITH") {
    reasons.push("Monolith remains authoritative.");
  } else {
    reasons.push("Settlement Service is authoritative.");
  }

  if (authority.comparisonMode === "ENABLED") {
    reasons.push(
      authority.authority === "SERVICE"
        ? "Monolith settlement engine remains available for comparison."
        : "Settlement Service remains available for comparison."
    );
  } else {
    reasons.push("Comparison mode is disabled.");
  }

  if (dryRunMode === "ENABLED") {
    reasons.push("Dry-run mode is enabled for authority decision evaluation.");
  }

  const route: SettlementAuthorityRuntimeRoute = {
    authoritativePath: authority.authority,
    comparisonMode: authority.comparisonMode,
    comparisonPath:
      authority.comparisonMode === "ENABLED"
        ? authority.authority === "SERVICE"
          ? "MONOLITH"
          : "SETTLEMENT_SERVICE"
        : null,
    dryRunMode,
    productionCutoverActive: authority.authority === "SERVICE",
    reasons,
  };

  recordSettlementAuthorityAudit({
    eventType: "SETTLEMENT_AUTHORITY_ROUTE_RESOLVED",
    metadata: route,
  });

  return route;
}

async function getMetrics(): Promise<SettlementAuthorityMetrics> {
  const [summary, mismatches] = await Promise.all([
    getSettlementShadowSummary(),
    getSettlementShadowMismatches({ limit: 10000 }),
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
  metrics: SettlementAuthorityMetrics | null;
  rollbackReadinessStatus: SettlementAuthorityCandidateStatus;
  authority: ReturnType<typeof getAuthorityStatus>["settlement"];
}): SettlementRollbackTriggerEvaluation {
  const thresholds = getThresholds();
  const reasons: string[] = [];

  if (!metrics) {
    return {
      shouldTriggerRollback: false,
      status: "WARNING",
      reasons: ["Settlement shadow metrics are unavailable."],
    };
  }

  if (metrics.criticalMismatchPresent) {
    reasons.push("Critical settlement shadow mismatches are present.");
  }

  if (metrics.mismatchRate >= thresholds.mismatchAlertThreshold) {
    reasons.push("Settlement mismatch rate is at or above alert threshold.");
  }

  if (metrics.failureRate >= thresholds.rollbackFailureThreshold) {
    reasons.push("Settlement shadow failure rate is at or above rollback threshold.");
  }

  if (rollbackReadinessStatus === "BLOCKED") {
    reasons.push("Rollback readiness is blocked.");
  }

  const shouldTriggerRollback =
    authority.authority === "SERVICE" && reasons.length > 0;

  if (!shouldTriggerRollback && reasons.length === 0) {
    reasons.push("No automatic rollback trigger is active.");
  }

  const status: SettlementAuthorityCandidateStatus = shouldTriggerRollback
    ? "BLOCKED"
    : reasons.length > 0
      ? "WARNING"
      : "READY";

  const evaluation = {
    shouldTriggerRollback,
    status,
    reasons,
  };

  recordSettlementAuthorityAudit({
    eventType: "SETTLEMENT_AUTHORITY_ROLLBACK_TRIGGER_EVALUATED",
    metadata: evaluation,
  });

  return evaluation;
}

export async function getSettlementAuthorityReadiness(): Promise<SettlementAuthorityReadiness> {
  const authorityStatus = getAuthorityStatus();
  const settlementAuthority = authorityStatus.settlement;
  const route = await resolveSettlementAuthorityRoute();
  const rollbackReadiness = await validateRollbackReadiness();
  const rollbackReadinessStatus = rollbackReadiness.settlement.rollbackStatus;
  const thresholds = getThresholds();
  const readinessReasons: string[] = [];
  const remainingBlockers: string[] = [];
  let metrics: SettlementAuthorityMetrics | null = null;

  try {
    metrics = await getMetrics();
  } catch (error) {
    remainingBlockers.push(
      error instanceof Error
        ? error.message
        : "Settlement shadow metrics are unavailable."
    );
  }

  if (settlementAuthority.authority !== "MONOLITH") {
    remainingBlockers.push("Settlement authority is not MONOLITH.");
  } else {
    readinessReasons.push("Settlement authority remains MONOLITH.");
  }

  if (settlementAuthority.comparisonMode !== "ENABLED") {
    remainingBlockers.push("Settlement comparison mode is disabled.");
  } else {
    readinessReasons.push("Settlement comparison mode is enabled.");
  }

  if (rollbackReadinessStatus === "BLOCKED") {
    remainingBlockers.push("Settlement rollback readiness is blocked.");
  } else {
    readinessReasons.push(
      `Settlement rollback readiness is ${rollbackReadinessStatus}.`
    );
  }

  if (metrics) {
    if (metrics.criticalMismatchPresent) {
      remainingBlockers.push("Critical settlement mismatches are present.");
    }

    if (metrics.mismatchRate >= thresholds.mismatchAlertThreshold) {
      remainingBlockers.push("Settlement mismatch threshold is exceeded.");
    }

    if (metrics.shadowReadinessStatus === "READY") {
      readinessReasons.push("Settlement shadow readiness is READY.");
    } else {
      readinessReasons.push(
        `Settlement shadow readiness is ${metrics.shadowReadinessStatus}.`
      );
    }
  }

  if (route.dryRunMode !== "ENABLED") {
    readinessReasons.push("Settlement authority dry-run mode is disabled.");
  } else {
    readinessReasons.push("Settlement authority dry-run mode is enabled.");
  }

  const rollbackTrigger = evaluateRollbackTrigger({
    metrics,
    rollbackReadinessStatus,
    authority: settlementAuthority,
  });
  const status = maxStatus([
    remainingBlockers.length > 0 ? "BLOCKED" : "READY",
    rollbackTrigger.status,
    metrics?.shadowReadinessStatus ?? "WARNING",
  ]);
  const readiness: SettlementAuthorityReadiness = {
    status,
    authority: settlementAuthority.authority,
    comparisonMode: settlementAuthority.comparisonMode,
    dryRunMode: route.dryRunMode,
    runtimeRoute: route,
    metrics,
    thresholds,
    rollbackReadinessStatus,
    rollbackTrigger,
    readinessReasons,
    remainingBlockers,
    evaluatedAt: new Date().toISOString(),
  };

  recordSettlementAuthorityAudit({
    eventType: "SETTLEMENT_AUTHORITY_READINESS_EVALUATED",
    metadata: readiness,
  });

  return readiness;
}
