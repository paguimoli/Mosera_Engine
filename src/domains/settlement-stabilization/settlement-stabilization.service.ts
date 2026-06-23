import { getSettlementPostPromotionStatus } from "../promotion-execution/promotion-execution.service";
import type {
  SettlementCertificationStatus,
  SettlementStabilizationMetrics,
  SettlementStabilizationStatus,
  SettlementStabilizationSummary,
  SettlementStabilizationWindow,
} from "./settlement-stabilization.types";
import { getSettlementStabilizationEvidence } from "./settlement-stabilization.repository";

export class SettlementStabilizationValidationError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "SettlementStabilizationValidationError";
    this.status = status;
  }
}

const WINDOW_HOURS: Record<Exclude<SettlementStabilizationWindow, "all">, number> = {
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
};

export function parseSettlementStabilizationWindow(
  value: string | null | undefined
): SettlementStabilizationWindow {
  if (!value) return "7d";
  if (value === "24h" || value === "7d" || value === "30d" || value === "all") {
    return value;
  }

  throw new SettlementStabilizationValidationError(
    "Unsupported stabilization window."
  );
}

function maxIso(left: string | null, right: string | null) {
  if (!left) return right;
  if (!right) return left;

  return new Date(left).getTime() >= new Date(right).getTime() ? left : right;
}

function getWindowStart(
  window: SettlementStabilizationWindow,
  generatedAt: string
) {
  if (window === "all") return null;

  const hours = WINDOW_HOURS[window];
  return new Date(new Date(generatedAt).getTime() - hours * 60 * 60 * 1000)
    .toISOString();
}

function getDaysSincePromotion(promotedAt: string | null, generatedAt: string) {
  if (!promotedAt) return null;

  const elapsedMs =
    new Date(generatedAt).getTime() - new Date(promotedAt).getTime();

  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 0;

  return Number((elapsedMs / (24 * 60 * 60 * 1000)).toFixed(4));
}

function getMetrics({
  runs,
  mismatches,
  failures,
  from,
  to,
}: Awaited<ReturnType<typeof getSettlementStabilizationEvidence>> & {
  from: string | null;
  to: string;
}): SettlementStabilizationMetrics {
  const mismatchRunIds = new Set(mismatches.map((mismatch) => mismatch.shadowRunId));

  return {
    settlementsProcessed: runs.length,
    mismatchCount: mismatchRunIds.size,
    failureCount: failures.length,
    criticalMismatchCount: mismatches.filter(
      (mismatch) => mismatch.severity === "CRITICAL"
    ).length,
    evidenceFrom: from,
    evidenceTo: to,
  };
}

function getStabilizationStatus({
  authority,
  serviceHealthy,
  rollbackReady,
  rollbackTriggerActive,
  criticalMismatchCount,
  warningCount,
}: {
  authority: string;
  serviceHealthy: boolean;
  rollbackReady: boolean;
  rollbackTriggerActive: boolean;
  criticalMismatchCount: number;
  warningCount: number;
}): SettlementStabilizationStatus {
  if (rollbackTriggerActive || criticalMismatchCount > 0) {
    return "ROLLBACK_RECOMMENDED";
  }
  if (authority !== "SERVICE" || !serviceHealthy || !rollbackReady) {
    return "REVIEW_REQUIRED";
  }
  if (warningCount > 0) {
    return "REVIEW_REQUIRED";
  }

  return "STABLE";
}

function getRecommendation(status: SettlementStabilizationStatus) {
  if (status === "ROLLBACK_RECOMMENDED") {
    return "ROLLBACK_RECOMMENDED: Execute the rollback runbook after operator confirmation.";
  }
  if (status === "REVIEW_REQUIRED") {
    return "REVIEW_REQUIRED: Investigate warnings before exiting the stabilization window.";
  }
  if (status === "STABLE") {
    return "STABLE: Continue monitoring until the stabilization window exit criteria are satisfied.";
  }

  return "STABILIZING: Continue collecting post-promotion evidence.";
}

function getCertificationState({
  authority,
  comparisonMode,
  rollbackReady,
  serviceHealthy,
  settlementsProcessed,
  mismatchCount,
  failureCount,
  criticalMismatchCount,
}: {
  authority: string;
  comparisonMode: string;
  rollbackReady: boolean;
  serviceHealthy: boolean;
  settlementsProcessed: number;
  mismatchCount: number;
  failureCount: number;
  criticalMismatchCount: number;
}): {
  certificationStatus: SettlementCertificationStatus;
  certificationBlockers: string[];
  certificationWarnings: string[];
} {
  const certificationBlockers: string[] = [];
  const certificationWarnings: string[] = [];

  if (authority !== "SERVICE") {
    certificationBlockers.push("Settlement authority must be SERVICE.");
  }
  if (comparisonMode !== "ENABLED") {
    certificationBlockers.push("Settlement comparison mode must be ENABLED.");
  }
  if (!rollbackReady) {
    certificationBlockers.push("Rollback readiness must be READY.");
  }
  if (!serviceHealthy) {
    certificationBlockers.push("Settlement Service health must be healthy.");
  }
  if (settlementsProcessed <= 0) {
    certificationBlockers.push(
      "At least one post-promotion settlement must be processed."
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
    "Operator certification is still required before marking Settlement as CERTIFIED."
  );

  return {
    certificationStatus: "READY_FOR_CERTIFICATION",
    certificationBlockers,
    certificationWarnings,
  };
}

export async function getSettlementStabilizationStatus({
  window = "7d",
}: {
  window?: SettlementStabilizationWindow;
} = {}): Promise<SettlementStabilizationSummary> {
  const generatedAt = new Date().toISOString();
  const postPromotionStatus = await getSettlementPostPromotionStatus();
  const windowStart = getWindowStart(window, generatedAt);
  const evidenceFrom = maxIso(postPromotionStatus.promotedAt, windowStart);
  const evidence = await getSettlementStabilizationEvidence({
    from: evidenceFrom,
    to: generatedAt,
    limit: 10000,
  });
  const metrics = getMetrics({
    ...evidence,
    from: evidenceFrom,
    to: generatedAt,
  });
  const warningCount =
    postPromotionStatus.rollbackTrigger.status === "WARNING" ? 1 : 0;
  const stabilizationStatus = getStabilizationStatus({
    authority: postPromotionStatus.authority,
    serviceHealthy: postPromotionStatus.serviceHealth.available,
    rollbackReady: postPromotionStatus.rollbackReadiness === "READY",
    rollbackTriggerActive:
      postPromotionStatus.rollbackTrigger.shouldTriggerRollback,
    criticalMismatchCount: metrics.criticalMismatchCount,
    warningCount,
  });
  const certification = getCertificationState({
    authority: postPromotionStatus.authority,
    comparisonMode: postPromotionStatus.comparisonMode,
    rollbackReady: postPromotionStatus.rollbackReadiness === "READY",
    serviceHealthy: postPromotionStatus.serviceHealth.available,
    settlementsProcessed: metrics.settlementsProcessed,
    mismatchCount: metrics.mismatchCount,
    failureCount: metrics.failureCount,
    criticalMismatchCount: metrics.criticalMismatchCount,
  });

  return {
    window,
    authority: postPromotionStatus.authority,
    comparisonMode: postPromotionStatus.comparisonMode,
    promotedAt: postPromotionStatus.promotedAt,
    daysSincePromotion: getDaysSincePromotion(
      postPromotionStatus.promotedAt,
      generatedAt
    ),
    settlementsProcessed: metrics.settlementsProcessed,
    mismatchCount: metrics.mismatchCount,
    failureCount: metrics.failureCount,
    criticalMismatchCount: metrics.criticalMismatchCount,
    serviceHealth: postPromotionStatus.serviceHealth,
    rollbackReadiness: postPromotionStatus.rollbackReadiness,
    rollbackTrigger: postPromotionStatus.rollbackTrigger,
    stabilizationStatus,
    certificationStatus: certification.certificationStatus,
    certificationBlockers: certification.certificationBlockers,
    certificationWarnings: certification.certificationWarnings,
    recommendation: getRecommendation(stabilizationStatus),
    generatedAt,
    evidence: {
      effectiveWindow: {
        from: metrics.evidenceFrom,
        to: metrics.evidenceTo,
      },
      promotionEvidenceSummary: postPromotionStatus.promotionEvidenceSummary,
      postPromotionEvidenceSummary:
        postPromotionStatus.postPromotionEvidenceSummary,
    },
  };
}
