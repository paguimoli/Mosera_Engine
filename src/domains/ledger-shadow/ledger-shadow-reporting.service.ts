import {
  listShadowFailures,
  listShadowMismatches,
  listShadowRuns,
} from "./ledger-shadow.repository";
import type {
  LedgerShadowListFilters,
  LedgerShadowSummary,
} from "./ledger-shadow.types";

function getNumberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);

  return Number.isFinite(value) ? value : fallback;
}

function percentage(part: number, total: number) {
  if (total === 0) return 0;

  return Number(((part / total) * 100).toFixed(4));
}

export async function getLedgerShadowSummary(): Promise<LedgerShadowSummary> {
  const [runs, failures, mismatches] = await Promise.all([
    listShadowRuns(),
    listShadowFailures({ limit: 10000 }),
    listShadowMismatches({ limit: 10000 }),
  ]);
  const matches = runs.filter((run) => run.comparisonStatus === "MATCH").length;
  const mismatchRuns = runs.filter(
    (run) => run.comparisonStatus === "MISMATCH"
  ).length;
  const totalEvents = runs.length + failures.length;
  const mismatchRate = totalEvents === 0 ? 0 : mismatchRuns / totalEvents;
  const failureRate = totalEvents === 0 ? 0 : failures.length / totalEvents;
  const readyMismatchRate = getNumberEnv(
    "LEDGER_SHADOW_READY_MISMATCH_RATE",
    0.001
  );
  const readyFailureRate = getNumberEnv(
    "LEDGER_SHADOW_READY_FAILURE_RATE",
    0.001
  );
  const blockedMismatchRate = getNumberEnv(
    "LEDGER_SHADOW_BLOCKED_MISMATCH_RATE",
    0.01
  );
  const hasCriticalMismatch = mismatches.some(
    (mismatch) => mismatch.severity === "CRITICAL"
  );
  const reasons: string[] = [];
  let status: LedgerShadowSummary["readiness"]["status"] = "READY";

  if (mismatchRate >= blockedMismatchRate || hasCriticalMismatch) {
    status = "BLOCKED";
    if (mismatchRate >= blockedMismatchRate) {
      reasons.push("Mismatch rate is at or above blocked threshold.");
    }
    if (hasCriticalMismatch) {
      reasons.push("Critical mismatches are present.");
    }
  } else if (mismatchRate >= readyMismatchRate || failureRate >= readyFailureRate) {
    status = "WARNING";
    if (mismatchRate >= readyMismatchRate) {
      reasons.push("Mismatch rate is at or above warning threshold.");
    }
    if (failureRate >= readyFailureRate) {
      reasons.push("Failure rate is at or above warning threshold.");
    }
  }

  if (reasons.length === 0) {
    reasons.push("Shadow ledger metrics are within ready thresholds.");
  }

  return {
    totalRuns: runs.length,
    matches,
    mismatches: mismatchRuns,
    failures: failures.length,
    matchPercentage: percentage(matches, totalEvents),
    mismatchPercentage: percentage(mismatchRuns, totalEvents),
    failurePercentage: percentage(failures.length, totalEvents),
    readiness: {
      status,
      reasons,
      thresholds: {
        readyMismatchRate,
        readyFailureRate,
        blockedMismatchRate,
      },
    },
    generatedAt: new Date().toISOString(),
  };
}

export async function getLedgerShadowMismatches(
  filters: LedgerShadowListFilters
) {
  return listShadowMismatches(filters);
}

export async function getLedgerShadowFailures(filters: LedgerShadowListFilters) {
  return listShadowFailures(filters);
}
