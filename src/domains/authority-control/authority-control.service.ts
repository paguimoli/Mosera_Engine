import {
  readAuthorityConfigurations,
  readAuthorityDomainConfiguration,
} from "./authority-control.repository";
import type {
  AuthorityConfigurationSummary,
  AuthorityDomainConfiguration,
  ComparisonMode,
  DomainRollbackReadiness,
  RollbackReadinessStatus,
  RollbackReadinessSummary,
  ServiceHealthStatus,
} from "./authority-control.types";

const SERVICE_HEALTH_TIMEOUT_MS = 2_000;

function nowIso() {
  return new Date().toISOString();
}

function trimTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SERVICE_HEALTH_TIMEOUT_MS);

  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function checkServiceHealth(
  config: AuthorityDomainConfiguration
): Promise<ServiceHealthStatus> {
  try {
    const response = await fetchWithTimeout(
      `${trimTrailingSlash(config.serviceUrl)}/health`
    );

    return {
      available: response.ok,
      statusCode: response.status,
      error: response.ok ? null : `Health endpoint returned ${response.status}.`,
      checkedAt: nowIso(),
    };
  } catch (error) {
    return {
      available: false,
      statusCode: null,
      error: error instanceof Error ? error.message : "Unknown health error.",
      checkedAt: nowIso(),
    };
  }
}

function getOverallStatus(
  statuses: RollbackReadinessStatus[]
): RollbackReadinessStatus {
  if (statuses.includes("BLOCKED")) return "BLOCKED";
  if (statuses.includes("WARNING")) return "WARNING";

  return "READY";
}

function getDomainRollbackStatus({
  config,
  serviceHealth,
}: {
  config: AuthorityDomainConfiguration;
  serviceHealth: ServiceHealthStatus;
}): DomainRollbackReadiness {
  const reasons: string[] = [];
  const monolithPathAvailable = true;
  let rollbackStatus: RollbackReadinessStatus = "READY";

  if (!monolithPathAvailable) {
    rollbackStatus = "BLOCKED";
    reasons.push("Monolith execution path is unavailable.");
  }

  if (config.authority === "SERVICE" && !serviceHealth.available) {
    rollbackStatus = "BLOCKED";
    reasons.push("Configured authoritative service is unavailable.");
  } else if (!serviceHealth.available) {
    rollbackStatus = getOverallStatus([rollbackStatus, "WARNING"]);
    reasons.push("Shadow service health is unavailable.");
  }

  if (config.comparisonMode === "DISABLED") {
    rollbackStatus = getOverallStatus([rollbackStatus, "WARNING"]);
    reasons.push("Comparison mode is disabled.");
  }

  if (reasons.length === 0) {
    reasons.push("Authority and rollback controls are within ready thresholds.");
  }

  return {
    ...config,
    monolithPathAvailable,
    serviceHealth,
    rollbackStatus,
    reasons,
  };
}

export function resolveSettlementAuthority() {
  return readAuthorityDomainConfiguration("SETTLEMENT").authority;
}

export function resolveLedgerAuthority() {
  return readAuthorityDomainConfiguration("LEDGER").authority;
}

export function resolveCreditAuthority() {
  return readAuthorityDomainConfiguration("CREDIT").authority;
}

export function resolveSettlementComparisonMode(): ComparisonMode {
  return readAuthorityDomainConfiguration("SETTLEMENT").comparisonMode;
}

export function resolveLedgerComparisonMode(): ComparisonMode {
  return readAuthorityDomainConfiguration("LEDGER").comparisonMode;
}

export function resolveCreditComparisonMode(): ComparisonMode {
  return readAuthorityDomainConfiguration("CREDIT").comparisonMode;
}

export function getAuthorityStatus(): AuthorityConfigurationSummary {
  return {
    ...readAuthorityConfigurations(),
    evaluatedAt: nowIso(),
  };
}

export async function validateRollbackReadiness(): Promise<RollbackReadinessSummary> {
  const configs = readAuthorityConfigurations();
  const [settlementHealth, ledgerHealth, creditHealth] = await Promise.all([
    checkServiceHealth(configs.settlement),
    checkServiceHealth(configs.ledger),
    checkServiceHealth(configs.credit),
  ]);
  const settlement = getDomainRollbackStatus({
    config: configs.settlement,
    serviceHealth: settlementHealth,
  });
  const ledger = getDomainRollbackStatus({
    config: configs.ledger,
    serviceHealth: ledgerHealth,
  });
  const credit = getDomainRollbackStatus({
    config: configs.credit,
    serviceHealth: creditHealth,
  });

  return {
    settlement,
    ledger,
    credit,
    overallStatus: getOverallStatus([
      settlement.rollbackStatus,
      ledger.rollbackStatus,
      credit.rollbackStatus,
    ]),
    evaluatedAt: nowIso(),
  };
}
