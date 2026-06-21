import {
  fetchShadowDomainRawMetrics,
  ShadowReadinessRepositoryError,
} from "./shadow-readiness.repository";
import { getShadowAnalysisSummary } from "../shadow-analysis/shadow-analysis.service";
import type {
  DomainReadinessMetrics,
  DomainReadinessStatus,
  ExtractionRecommendation,
  ShadowDomainRawMetrics,
  ShadowDomainTableConfig,
  ShadowReadinessSummary,
  ShadowReadinessWindow,
} from "./shadow-readiness.types";

const DEFAULT_READY_RATE = 0.001;
const DEFAULT_BLOCKED_MISMATCH_RATE = 0.01;

function getNumberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);

  return Number.isFinite(value) ? value : fallback;
}

function getThresholds(prefix: "SETTLEMENT" | "LEDGER" | "CREDIT") {
  return {
    readyMismatchRate: getNumberEnv(
      `${prefix}_SHADOW_READY_MISMATCH_RATE`,
      DEFAULT_READY_RATE
    ),
    readyFailureRate: getNumberEnv(
      `${prefix}_SHADOW_READY_FAILURE_RATE`,
      DEFAULT_READY_RATE
    ),
    blockedMismatchRate: getNumberEnv(
      `${prefix}_SHADOW_BLOCKED_MISMATCH_RATE`,
      DEFAULT_BLOCKED_MISMATCH_RATE
    ),
  };
}

function getConfigs(): ShadowDomainTableConfig[] {
  return [
    {
      domain: "settlement",
      label: "Settlement",
      runTable: "settlement_shadow_runs",
      mismatchTable: "settlement_shadow_mismatches",
      failureTable: "settlement_shadow_failures",
      thresholds: getThresholds("SETTLEMENT"),
    },
    {
      domain: "ledger",
      label: "Ledger",
      runTable: "ledger_shadow_runs",
      mismatchTable: "ledger_shadow_mismatches",
      failureTable: "ledger_shadow_failures",
      thresholds: getThresholds("LEDGER"),
    },
    {
      domain: "credit",
      label: "Credit",
      runTable: "credit_shadow_runs",
      mismatchTable: "credit_shadow_mismatches",
      failureTable: "credit_shadow_failures",
      thresholds: getThresholds("CREDIT"),
    },
  ];
}

function rate(part: number, total: number) {
  if (total === 0) return 0;

  return Number((part / total).toFixed(6));
}

function unavailableMetrics(
  config: ShadowDomainTableConfig,
  error: unknown
): DomainReadinessMetrics {
  const message =
    error instanceof Error ? error.message : "Shadow domain metrics unavailable.";

  return {
    domain: config.domain,
    label: config.label,
    totalRuns: 0,
    matches: 0,
    mismatches: 0,
    failures: 0,
    matchRate: 0,
    mismatchRate: 0,
    failureRate: 1,
    criticalMismatchCount: 0,
    readinessStatus: "BLOCKED",
    thresholds: config.thresholds,
    reasons: [
      "Shadow evidence tables are unavailable for this domain.",
      message,
    ],
    unavailable: true,
    error: message,
  };
}

function calculateDomainMetrics(
  config: ShadowDomainTableConfig,
  raw: ShadowDomainRawMetrics
): DomainReadinessMetrics {
  const matches = raw.runs.filter(
    (run) => run.comparison_status === "MATCH"
  ).length;
  const mismatches = raw.runs.filter(
    (run) => run.comparison_status === "MISMATCH"
  ).length;
  const totalEvents = raw.runs.length + raw.failures.length;
  const matchRate = rate(matches, totalEvents);
  const mismatchRate = rate(mismatches, totalEvents);
  const failureRate = rate(raw.failures.length, totalEvents);
  const criticalMismatchCount = raw.mismatches.filter(
    (mismatch) => mismatch.severity === "CRITICAL"
  ).length;
  const reasons: string[] = [];
  let readinessStatus: DomainReadinessStatus = "READY";

  if (
    mismatchRate >= config.thresholds.blockedMismatchRate ||
    criticalMismatchCount > 0
  ) {
    readinessStatus = "BLOCKED";
    if (mismatchRate >= config.thresholds.blockedMismatchRate) {
      reasons.push("Mismatch rate is at or above blocked threshold.");
    }
    if (criticalMismatchCount > 0) {
      reasons.push("Critical mismatches are present.");
    }
  } else if (
    mismatchRate >= config.thresholds.readyMismatchRate ||
    failureRate >= config.thresholds.readyFailureRate
  ) {
    readinessStatus = "WARNING";
    if (mismatchRate >= config.thresholds.readyMismatchRate) {
      reasons.push("Mismatch rate is at or above warning threshold.");
    }
    if (failureRate >= config.thresholds.readyFailureRate) {
      reasons.push("Failure rate is at or above warning threshold.");
    }
  }

  if (reasons.length === 0) {
    reasons.push(`${config.label} shadow metrics are within ready thresholds.`);
  }

  return {
    domain: config.domain,
    label: config.label,
    totalRuns: raw.runs.length,
    matches,
    mismatches,
    failures: raw.failures.length,
    matchRate,
    mismatchRate,
    failureRate,
    criticalMismatchCount,
    readinessStatus,
    thresholds: config.thresholds,
    reasons,
    unavailable: false,
    error: null,
  };
}

async function getDomainMetrics(
  config: ShadowDomainTableConfig,
  window: ShadowReadinessWindow
): Promise<DomainReadinessMetrics> {
  try {
    const raw = await fetchShadowDomainRawMetrics({ config, window });

    return calculateDomainMetrics(config, raw);
  } catch (error) {
    if (error instanceof ShadowReadinessRepositoryError) {
      return unavailableMetrics(config, error);
    }

    return unavailableMetrics(config, error);
  }
}

function getPlatformStatus(
  statuses: DomainReadinessStatus[]
): DomainReadinessStatus {
  if (statuses.includes("BLOCKED")) return "BLOCKED";
  if (statuses.includes("WARNING")) return "WARNING";

  return "READY";
}

function hasBlockedFailureRate(domain: DomainReadinessMetrics) {
  return domain.failureRate >= domain.thresholds.readyFailureRate;
}

function getRecommendations(domains: DomainReadinessMetrics[]) {
  const recommendations: ExtractionRecommendation[] = [];

  if (domains.some((domain) => domain.unavailable)) {
    recommendations.push("SHADOW_DATA_UNAVAILABLE");
  }
  if (domains.some((domain) => domain.criticalMismatchCount > 0)) {
    recommendations.push("BLOCKED_BY_CRITICAL_MISMATCHES");
  }
  if (domains.some(hasBlockedFailureRate)) {
    recommendations.push("BLOCKED_BY_FAILURE_RATE");
  }

  const readyDomains = domains.filter(
    (domain) => domain.readinessStatus === "READY" && !domain.unavailable
  );

  for (const domain of readyDomains) {
    if (domain.domain === "settlement") recommendations.push("SETTLEMENT_READY");
    if (domain.domain === "ledger") recommendations.push("LEDGER_READY");
    if (domain.domain === "credit") recommendations.push("CREDIT_READY");
  }

  if (readyDomains.length === domains.length) {
    recommendations.push("ALL_READY");
  }

  if (recommendations.length === 0 || !recommendations.includes("ALL_READY")) {
    recommendations.push("CONTINUE_SHADOWING");
  }

  return Array.from(new Set(recommendations));
}

function getPrimaryRecommendation(
  recommendations: ExtractionRecommendation[]
): ExtractionRecommendation {
  if (recommendations.includes("SHADOW_DATA_UNAVAILABLE")) {
    return "SHADOW_DATA_UNAVAILABLE";
  }
  if (recommendations.includes("BLOCKED_BY_CRITICAL_MISMATCHES")) {
    return "BLOCKED_BY_CRITICAL_MISMATCHES";
  }
  if (recommendations.includes("BLOCKED_BY_FAILURE_RATE")) {
    return "BLOCKED_BY_FAILURE_RATE";
  }
  if (recommendations.includes("ALL_READY")) return "ALL_READY";

  return "CONTINUE_SHADOWING";
}

export function parseShadowReadinessWindow(
  value: string | null
): ShadowReadinessWindow {
  if (value === "24h" || value === "7d" || value === "30d" || value === "all") {
    return value;
  }

  return "7d";
}

export async function getShadowReadinessSummary(
  window: ShadowReadinessWindow = "7d"
): Promise<ShadowReadinessSummary> {
  const configs = getConfigs();
  const [settlement, ledger, credit] = await Promise.all(
    configs.map((config) => getDomainMetrics(config, window))
  );
  const platformStatus = getPlatformStatus([
    settlement.readinessStatus,
    ledger.readinessStatus,
    credit.readinessStatus,
  ]);
  const recommendations = getRecommendations([settlement, ledger, credit]);
  const evidenceAnalysis = await getShadowAnalysisSummary(window);

  return {
    window,
    domains: {
      settlement,
      ledger,
      credit,
    },
    platform: {
      settlementStatus: settlement.readinessStatus,
      ledgerStatus: ledger.readinessStatus,
      creditStatus: credit.readinessStatus,
      platformStatus,
      evaluatedAt: new Date().toISOString(),
    },
    evidenceReadiness: {
      rawReadiness: evidenceAnalysis.platform.raw,
      adjustedReadiness: evidenceAnalysis.platform.adjusted,
      promotionReadiness: evidenceAnalysis.platform.promotion,
    },
    recommendations,
    extractionRecommendation: getPrimaryRecommendation(recommendations),
  };
}
