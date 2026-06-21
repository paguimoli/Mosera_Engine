import {
  listShadowFailures as listCreditShadowFailures,
  listShadowMismatches as listCreditShadowMismatches,
  listShadowRuns as listCreditShadowRuns,
} from "../credit-shadow/credit-shadow.repository";
import type {
  CreditShadowFailure,
  CreditShadowMismatch,
  CreditShadowRun,
} from "../credit-shadow/credit-shadow.types";
import {
  listShadowFailures as listLedgerShadowFailures,
  listShadowMismatches as listLedgerShadowMismatches,
  listShadowRuns as listLedgerShadowRuns,
} from "../ledger-shadow/ledger-shadow.repository";
import type {
  LedgerShadowFailure,
  LedgerShadowMismatch,
  LedgerShadowRun,
} from "../ledger-shadow/ledger-shadow.types";
import {
  listShadowFailures as listSettlementShadowFailures,
  listShadowMismatches as listSettlementShadowMismatches,
  listShadowRuns as listSettlementShadowRuns,
} from "../settlement-shadow/settlement-shadow.repository";
import type {
  SettlementShadowFailure,
  SettlementShadowMismatch,
  SettlementShadowRun,
} from "../settlement-shadow/settlement-shadow.types";
import type { DomainReadinessStatus } from "../shadow-readiness/shadow-readiness.types";
import {
  getEffectiveLifecycleStatusMap,
  getLifecycleKey,
} from "../shadow-evidence-lifecycle/shadow-evidence-lifecycle.repository";
import type {
  ShadowEvidenceLifecycleKey,
  ShadowEvidenceLifecycleStatus,
} from "../shadow-evidence-lifecycle/shadow-evidence-lifecycle.types";
import type {
  ClassifiedShadowEvidence,
  ShadowAnalysisDomain,
  ShadowAnalysisReadinessMetrics,
  ShadowAnalysisSummary,
  ShadowAnalysisWindow,
  ShadowCauseCounts,
  ShadowEvidenceClass,
  ShadowEvidenceConfidence,
  ShadowEvidenceSeverity,
} from "./shadow-analysis.types";

type ShadowRun = SettlementShadowRun | LedgerShadowRun | CreditShadowRun;
type ShadowMismatch =
  | SettlementShadowMismatch
  | LedgerShadowMismatch
  | CreditShadowMismatch;
type ShadowFailure =
  | SettlementShadowFailure
  | LedgerShadowFailure
  | CreditShadowFailure;

type DomainEvidence = {
  domain: ShadowAnalysisDomain;
  runs: ShadowRun[];
  mismatches: ClassifiedShadowEvidence[];
  failures: ClassifiedShadowEvidence[];
};

const DEFAULT_READY_RATE = 0.001;
const DEFAULT_BLOCKED_MISMATCH_RATE = 0.01;

const EVIDENCE_CLASSES: ShadowEvidenceClass[] = [
  "QA_INTENTIONAL_MISMATCH",
  "QA_INTENTIONAL_FAILURE",
  "EXPECTED_TEST_VARIATION",
  "UNEXPLAINED_MISMATCH",
  "UNEXPLAINED_FAILURE",
  "PARITY_DEFECT",
  "DATA_QUALITY_ISSUE",
  "INSUFFICIENT_CONTEXT",
];

function emptyCauseCounts(): ShadowCauseCounts {
  return EVIDENCE_CLASSES.reduce((counts, evidenceClass) => {
    counts[evidenceClass] = 0;

    return counts;
  }, {} as ShadowCauseCounts);
}

function addCause(counts: ShadowCauseCounts, evidenceClass: ShadowEvidenceClass) {
  counts[evidenceClass] += 1;
}

function getNumberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);

  return Number.isFinite(value) ? value : fallback;
}

function getThresholds(domain: ShadowAnalysisDomain) {
  return {
    readyMismatchRate: getNumberEnv(
      `${domain}_SHADOW_READY_MISMATCH_RATE`,
      DEFAULT_READY_RATE
    ),
    readyFailureRate: getNumberEnv(
      `${domain}_SHADOW_READY_FAILURE_RATE`,
      DEFAULT_READY_RATE
    ),
    blockedMismatchRate: getNumberEnv(
      `${domain}_SHADOW_BLOCKED_MISMATCH_RATE`,
      DEFAULT_BLOCKED_MISMATCH_RATE
    ),
  };
}

function rate(part: number, total: number) {
  if (total === 0) return 0;

  return Number((part / total).toFixed(6));
}

function statusFromDomains(
  statuses: DomainReadinessStatus[]
): DomainReadinessStatus {
  if (statuses.includes("BLOCKED")) return "BLOCKED";
  if (statuses.includes("WARNING")) return "WARNING";

  return "READY";
}

function getWindowStart(window: ShadowAnalysisWindow): string | null {
  if (window === "all") return null;

  const durationMs =
    window === "24h"
      ? 24 * 60 * 60 * 1000
      : window === "7d"
        ? 7 * 24 * 60 * 60 * 1000
        : 30 * 24 * 60 * 60 * 1000;

  return new Date(Date.now() - durationMs).toISOString();
}

function inWindow(createdAt: string, windowStart: string | null) {
  if (!windowStart) return true;

  return new Date(createdAt).getTime() >= new Date(windowStart).getTime();
}

export function parseShadowAnalysisWindow(
  value: string | null
): ShadowAnalysisWindow {
  if (value === "24h" || value === "7d" || value === "30d" || value === "all") {
    return value;
  }

  return "7d";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringifyForClassification(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.toLowerCase();

  try {
    return JSON.stringify(value).toLowerCase();
  } catch {
    return String(value).toLowerCase();
  }
}

function hasQaMarker(values: unknown[]) {
  return values.some((value) => {
    const normalized = stringifyForClassification(value);

    return (
      normalized.startsWith("qa-") ||
      normalized.includes("qa:") ||
      normalized.includes("-mismatch") ||
      normalized.includes("-failure") ||
      normalized.includes("intentional")
    );
  });
}

function hasDataQualityMarker(values: unknown[]) {
  return values.some((value) => {
    const normalized = stringifyForClassification(value);

    return (
      normalized.includes("missing") ||
      normalized.includes("null") ||
      normalized.includes("undefined") ||
      normalized.includes("invalid") ||
      normalized.includes("not found")
    );
  });
}

function getRunCorrelationId(run: ShadowRun | null | undefined) {
  return run?.correlationId ?? null;
}

function getRunEntityId(domain: ShadowAnalysisDomain, run: ShadowRun | null | undefined) {
  if (!run) return null;
  if (domain === "SETTLEMENT") return (run as SettlementShadowRun).ticketId;
  if (domain === "LEDGER") return (run as LedgerShadowRun).transactionId;

  const creditRun = run as CreditShadowRun;

  return creditRun.reservationId ?? creditRun.ticketId ?? creditRun.accountId;
}

function getFailureEntityId(domain: ShadowAnalysisDomain, failure: ShadowFailure) {
  if (domain === "SETTLEMENT") return (failure as SettlementShadowFailure).ticketId ?? null;
  if (domain === "LEDGER") return (failure as LedgerShadowFailure).transactionId ?? null;

  const creditFailure = failure as CreditShadowFailure;

  return creditFailure.reservationId ?? creditFailure.ticketId ?? null;
}

function getRoute(domain: ShadowAnalysisDomain) {
  if (domain === "SETTLEMENT") return "settlement-shadow";
  if (domain === "LEDGER") return "ledger-shadow";

  return "credit-shadow";
}

function classifyMismatch(
  domain: ShadowAnalysisDomain,
  mismatch: ShadowMismatch
): {
  evidenceClass: ShadowEvidenceClass;
  confidence: ShadowEvidenceConfidence;
  explanation: string;
} {
  const run = mismatch.run ?? null;
  const evidenceValues = [
    run?.correlationId,
    getRunEntityId(domain, run),
    mismatch.mismatchType,
    mismatch.fieldName,
    mismatch.monolithValue,
    mismatch.shadowValue,
  ];

  if (hasQaMarker(evidenceValues)) {
    return {
      evidenceClass: "QA_INTENTIONAL_MISMATCH",
      confidence: "HIGH",
      explanation:
        "Evidence contains QA identifiers or intentional mismatch markers.",
    };
  }

  if (!run) {
    return {
      evidenceClass: "INSUFFICIENT_CONTEXT",
      confidence: "LOW",
      explanation: "Mismatch record is missing its shadow run context.",
    };
  }

  if (hasDataQualityMarker(evidenceValues)) {
    return {
      evidenceClass: "DATA_QUALITY_ISSUE",
      confidence: "MEDIUM",
      explanation:
        "Mismatch contains missing, invalid, or not-found data quality markers.",
    };
  }

  if (mismatch.severity === "CRITICAL") {
    return {
      evidenceClass: "PARITY_DEFECT",
      confidence: "MEDIUM",
      explanation:
        "Critical non-QA mismatch requires parity investigation before transfer.",
    };
  }

  return {
    evidenceClass: "UNEXPLAINED_MISMATCH",
    confidence: "MEDIUM",
    explanation: "Mismatch is not currently attributable to QA or expected input.",
  };
}

function classifyFailure(
  domain: ShadowAnalysisDomain,
  failure: ShadowFailure
): {
  evidenceClass: ShadowEvidenceClass;
  confidence: ShadowEvidenceConfidence;
  explanation: string;
} {
  const metadata = isRecord(failure.metadata) ? failure.metadata : {};
  const evidenceValues = [
    failure.correlationId,
    getFailureEntityId(domain, failure),
    failure.failureReason,
    failure.failureType,
    metadata,
  ];

  if (hasQaMarker(evidenceValues)) {
    return {
      evidenceClass: "QA_INTENTIONAL_FAILURE",
      confidence: "HIGH",
      explanation:
        "Evidence contains QA identifiers or intentional failure markers.",
    };
  }

  if (hasDataQualityMarker(evidenceValues)) {
    return {
      evidenceClass: "DATA_QUALITY_ISSUE",
      confidence: "MEDIUM",
      explanation:
        "Failure contains missing, invalid, or not-found data quality markers.",
    };
  }

  return {
    evidenceClass: "UNEXPLAINED_FAILURE",
    confidence: "MEDIUM",
    explanation: "Failure is not currently attributable to QA or expected input.",
  };
}

function classifyMismatchEvidence(
  domain: ShadowAnalysisDomain,
  mismatch: ShadowMismatch,
  lifecycleStatus: ShadowEvidenceLifecycleStatus
): ClassifiedShadowEvidence {
  const classification = classifyMismatch(domain, mismatch);
  const run = mismatch.run ?? null;

  return {
    id: mismatch.id,
    domain,
    kind: "MISMATCH",
    evidenceClass: classification.evidenceClass,
    confidence: classification.confidence,
    explanation: classification.explanation,
    severity: mismatch.severity as ShadowEvidenceSeverity,
    route: getRoute(domain),
    authorityCandidate: domain,
    correlationId: getRunCorrelationId(run),
    shadowRunId: mismatch.shadowRunId,
    entityId: getRunEntityId(domain, run),
    evidenceType: mismatch.mismatchType,
    lifecycleStatus,
    fieldName: mismatch.fieldName,
    createdAt: mismatch.createdAt,
  };
}

function classifyFailureEvidence(
  domain: ShadowAnalysisDomain,
  failure: ShadowFailure,
  lifecycleStatus: ShadowEvidenceLifecycleStatus
): ClassifiedShadowEvidence {
  const classification = classifyFailure(domain, failure);

  return {
    id: failure.id,
    domain,
    kind: "FAILURE",
    evidenceClass: classification.evidenceClass,
    confidence: classification.confidence,
    explanation: classification.explanation,
    severity: null,
    route: getRoute(domain),
    authorityCandidate: domain,
    correlationId: failure.correlationId ?? null,
    entityId: getFailureEntityId(domain, failure),
    evidenceType: failure.failureType,
    lifecycleStatus,
    failureReason: failure.failureReason,
    createdAt: failure.createdAt,
  };
}

function uniqueMismatchRunCount(mismatches: ClassifiedShadowEvidence[]) {
  const runIds = new Set(
    mismatches
      .map((mismatch) => mismatch.shadowRunId)
      .filter((shadowRunId): shadowRunId is string => Boolean(shadowRunId))
  );

  return runIds.size;
}

function calculateReadiness({
  domain,
  runs,
  mismatches,
  failures,
  mode,
}: {
  domain: ShadowAnalysisDomain;
  runs: ShadowRun[];
  mismatches: ClassifiedShadowEvidence[];
  failures: ClassifiedShadowEvidence[];
  mode: "RAW_READINESS" | "ADJUSTED_READINESS" | "PROMOTION_READINESS";
}): ShadowAnalysisReadinessMetrics {
  const thresholds = getThresholds(domain);
  const includedMismatches = mismatches.filter((mismatch) => {
    if (mode === "RAW_READINESS") return true;
    if (mode === "ADJUSTED_READINESS") {
      return mismatch.evidenceClass !== "QA_INTENTIONAL_MISMATCH";
    }

    return (
      mismatch.lifecycleStatus === "ACTIVE" ||
      mismatch.lifecycleStatus === "REVIEW_REQUIRED"
    );
  });
  const includedFailures = failures.filter((failure) => {
    if (mode === "RAW_READINESS") return true;
    if (mode === "ADJUSTED_READINESS") {
      return failure.evidenceClass !== "QA_INTENTIONAL_FAILURE";
    }

    return (
      failure.lifecycleStatus === "ACTIVE" ||
      failure.lifecycleStatus === "REVIEW_REQUIRED"
    );
  });
  const mismatchRunIds = new Set(
    includedMismatches
      .map((mismatch) => mismatch.shadowRunId)
      .filter((shadowRunId): shadowRunId is string => Boolean(shadowRunId))
  );
  const matches = runs.filter((run) => run.comparisonStatus === "MATCH").length;
  const mismatchesCount = mismatchRunIds.size;
  const failuresCount = includedFailures.length;
  const totalEvents = runs.length + failuresCount;
  const matchRate = rate(matches, totalEvents);
  const mismatchRate = rate(mismatchesCount, totalEvents);
  const failureRate = rate(failuresCount, totalEvents);
  const criticalMismatchCount = includedMismatches.filter(
    (mismatch) => mismatch.severity === "CRITICAL"
  ).length;
  const reasons: string[] = [];
  let readinessStatus: DomainReadinessStatus = "READY";

  if (
    mismatchRate >= thresholds.blockedMismatchRate ||
    criticalMismatchCount > 0
  ) {
    readinessStatus = "BLOCKED";
    if (mismatchRate >= thresholds.blockedMismatchRate) {
      reasons.push("Mismatch rate is at or above blocked threshold.");
    }
    if (criticalMismatchCount > 0) {
      reasons.push("Critical mismatches are present.");
    }
  } else if (
    mismatchRate >= thresholds.readyMismatchRate ||
    failureRate >= thresholds.readyFailureRate
  ) {
    readinessStatus = "WARNING";
    if (mismatchRate >= thresholds.readyMismatchRate) {
      reasons.push("Mismatch rate is at or above warning threshold.");
    }
    if (failureRate >= thresholds.readyFailureRate) {
      reasons.push("Failure rate is at or above warning threshold.");
    }
  }

  if (reasons.length === 0) {
    if (mode === "RAW_READINESS") {
      reasons.push("Raw shadow evidence is within ready thresholds.");
    } else if (mode === "ADJUSTED_READINESS") {
      reasons.push("Adjusted shadow evidence is within ready thresholds.");
    } else {
      reasons.push("Promotion lifecycle evidence is within ready thresholds.");
    }
  }

  return {
    mode,
    totalRuns: runs.length,
    matches,
    mismatches: mismatchesCount,
    failures: failuresCount,
    matchRate,
    mismatchRate,
    failureRate,
    criticalMismatchCount,
    readinessStatus,
    reasons,
  };
}

async function loadDomainEvidence({
  domain,
  windowStart,
  lifecycleMap,
}: {
  domain: ShadowAnalysisDomain;
  windowStart: string | null;
  lifecycleMap: Map<ShadowEvidenceLifecycleKey, { newStatus: ShadowEvidenceLifecycleStatus }>;
}): Promise<DomainEvidence> {
  const getLifecycleStatus = (kind: "MISMATCH" | "FAILURE", evidenceId: string) =>
    lifecycleMap.get(
      getLifecycleKey({
        domain,
        evidenceType: kind,
        evidenceId,
      })
    )?.newStatus ?? "ACTIVE";

  if (domain === "SETTLEMENT") {
    const [runs, mismatches, failures] = await Promise.all([
      listSettlementShadowRuns(),
      listSettlementShadowMismatches({ limit: 10000 }),
      listSettlementShadowFailures({ limit: 10000 }),
    ]);

    return {
      domain,
      runs: runs.filter((run) => inWindow(run.createdAt, windowStart)),
      mismatches: mismatches
        .filter((mismatch) => inWindow(mismatch.createdAt, windowStart))
        .map((mismatch) =>
          classifyMismatchEvidence(
            domain,
            mismatch,
            getLifecycleStatus("MISMATCH", mismatch.id)
          )
        ),
      failures: failures
        .filter((failure) => inWindow(failure.createdAt, windowStart))
        .map((failure) =>
          classifyFailureEvidence(
            domain,
            failure,
            getLifecycleStatus("FAILURE", failure.id)
          )
        ),
    };
  }

  if (domain === "LEDGER") {
    const [runs, mismatches, failures] = await Promise.all([
      listLedgerShadowRuns(),
      listLedgerShadowMismatches({ limit: 10000 }),
      listLedgerShadowFailures({ limit: 10000 }),
    ]);

    return {
      domain,
      runs: runs.filter((run) => inWindow(run.createdAt, windowStart)),
      mismatches: mismatches
        .filter((mismatch) => inWindow(mismatch.createdAt, windowStart))
        .map((mismatch) =>
          classifyMismatchEvidence(
            domain,
            mismatch,
            getLifecycleStatus("MISMATCH", mismatch.id)
          )
        ),
      failures: failures
        .filter((failure) => inWindow(failure.createdAt, windowStart))
        .map((failure) =>
          classifyFailureEvidence(
            domain,
            failure,
            getLifecycleStatus("FAILURE", failure.id)
          )
        ),
    };
  }

  const [runs, mismatches, failures] = await Promise.all([
    listCreditShadowRuns(),
    listCreditShadowMismatches({ limit: 10000 }),
    listCreditShadowFailures({ limit: 10000 }),
  ]);

  return {
    domain,
    runs: runs.filter((run) => inWindow(run.createdAt, windowStart)),
    mismatches: mismatches
      .filter((mismatch) => inWindow(mismatch.createdAt, windowStart))
      .map((mismatch) =>
        classifyMismatchEvidence(
          domain,
          mismatch,
          getLifecycleStatus("MISMATCH", mismatch.id)
        )
      ),
    failures: failures
      .filter((failure) => inWindow(failure.createdAt, windowStart))
      .map((failure) =>
        classifyFailureEvidence(
          domain,
          failure,
          getLifecycleStatus("FAILURE", failure.id)
        )
      ),
  };
}

function summarizeDomain(evidence: DomainEvidence) {
  const classifiedCauses = emptyCauseCounts();

  for (const item of [...evidence.mismatches, ...evidence.failures]) {
    addCause(classifiedCauses, item.evidenceClass);
  }

  const rawReadiness = calculateReadiness({
    domain: evidence.domain,
    runs: evidence.runs,
    mismatches: evidence.mismatches,
    failures: evidence.failures,
    mode: "RAW_READINESS",
  });
  const adjustedReadiness = calculateReadiness({
    domain: evidence.domain,
    runs: evidence.runs,
    mismatches: evidence.mismatches,
    failures: evidence.failures,
    mode: "ADJUSTED_READINESS",
  });
  const promotionReadiness = calculateReadiness({
    domain: evidence.domain,
    runs: evidence.runs,
    mismatches: evidence.mismatches,
    failures: evidence.failures,
    mode: "PROMOTION_READINESS",
  });

  return {
    domain: evidence.domain,
    totalRuns: evidence.runs.length,
    matches: evidence.runs.filter((run) => run.comparisonStatus === "MATCH").length,
    mismatches: uniqueMismatchRunCount(evidence.mismatches),
    failures: evidence.failures.length,
    classifiedCauses,
    rawReadiness,
    adjustedReadiness,
    promotionReadiness,
    affectedRoutes: [getRoute(evidence.domain)],
    authorityCandidate: evidence.domain,
  };
}

function combineCauseCounts(evidence: ClassifiedShadowEvidence[]) {
  const counts = emptyCauseCounts();

  for (const item of evidence) {
    addCause(counts, item.evidenceClass);
  }

  return counts;
}

function getRecommendation(summary: Pick<ShadowAnalysisSummary, "platform">) {
  if (summary.platform.promotion.readiness === "READY") {
    return "Promotion lifecycle evidence is ready; operator approvals and raw evidence review are still required before any authority transfer.";
  }

  if (summary.platform.adjusted.readiness === "READY") {
    return "Adjusted evidence removes QA blockers; continue shadowing until raw evidence is clean enough for transfer review.";
  }

  if (summary.platform.adjusted.readiness === "WARNING") {
    return "Adjusted evidence still requires review before extraction authority planning.";
  }

  return "Adjusted evidence remains blocked; investigate non-QA parity, failure, or data quality causes.";
}

export async function getShadowAnalysisSummary(
  window: ShadowAnalysisWindow = "7d"
): Promise<ShadowAnalysisSummary> {
  const windowStart = getWindowStart(window);
  const lifecycleMap = await getEffectiveLifecycleStatusMap();
  const [settlementEvidence, ledgerEvidence, creditEvidence] = await Promise.all([
    loadDomainEvidence({ domain: "SETTLEMENT", windowStart, lifecycleMap }),
    loadDomainEvidence({ domain: "LEDGER", windowStart, lifecycleMap }),
    loadDomainEvidence({ domain: "CREDIT", windowStart, lifecycleMap }),
  ]);
  const settlement = summarizeDomain(settlementEvidence);
  const ledger = summarizeDomain(ledgerEvidence);
  const credit = summarizeDomain(creditEvidence);
  const allMismatches = [
    ...settlementEvidence.mismatches,
    ...ledgerEvidence.mismatches,
    ...creditEvidence.mismatches,
  ];
  const allFailures = [
    ...settlementEvidence.failures,
    ...ledgerEvidence.failures,
    ...creditEvidence.failures,
  ];
  const rawStatus = statusFromDomains([
    settlement.rawReadiness.readinessStatus,
    ledger.rawReadiness.readinessStatus,
    credit.rawReadiness.readinessStatus,
  ]);
  const adjustedStatus = statusFromDomains([
    settlement.adjustedReadiness.readinessStatus,
    ledger.adjustedReadiness.readinessStatus,
    credit.adjustedReadiness.readinessStatus,
  ]);
  const promotionStatus = statusFromDomains([
    settlement.promotionReadiness.readinessStatus,
    ledger.promotionReadiness.readinessStatus,
    credit.promotionReadiness.readinessStatus,
  ]);
  const rawTotalEvents =
    settlement.rawReadiness.totalRuns +
    ledger.rawReadiness.totalRuns +
    credit.rawReadiness.totalRuns +
    settlement.rawReadiness.failures +
    ledger.rawReadiness.failures +
    credit.rawReadiness.failures;
  const adjustedTotalEvents =
    settlement.adjustedReadiness.totalRuns +
    ledger.adjustedReadiness.totalRuns +
    credit.adjustedReadiness.totalRuns +
    settlement.adjustedReadiness.failures +
    ledger.adjustedReadiness.failures +
    credit.adjustedReadiness.failures;
  const promotionTotalEvents =
    settlement.promotionReadiness.totalRuns +
    ledger.promotionReadiness.totalRuns +
    credit.promotionReadiness.totalRuns +
    settlement.promotionReadiness.failures +
    ledger.promotionReadiness.failures +
    credit.promotionReadiness.failures;
  const summary: ShadowAnalysisSummary = {
    window,
    evaluatedAt: new Date().toISOString(),
    platform: {
      raw: {
        readiness: rawStatus,
        mismatchRate: rate(
          settlement.rawReadiness.mismatches +
            ledger.rawReadiness.mismatches +
            credit.rawReadiness.mismatches,
          rawTotalEvents
        ),
        failureRate: rate(
          settlement.rawReadiness.failures +
            ledger.rawReadiness.failures +
            credit.rawReadiness.failures,
          rawTotalEvents
        ),
      },
      adjusted: {
        readiness: adjustedStatus,
        mismatchRate: rate(
          settlement.adjustedReadiness.mismatches +
            ledger.adjustedReadiness.mismatches +
            credit.adjustedReadiness.mismatches,
          adjustedTotalEvents
        ),
        failureRate: rate(
          settlement.adjustedReadiness.failures +
            ledger.adjustedReadiness.failures +
            credit.adjustedReadiness.failures,
          adjustedTotalEvents
        ),
      },
      promotion: {
        readiness: promotionStatus,
        mismatchRate: rate(
          settlement.promotionReadiness.mismatches +
            ledger.promotionReadiness.mismatches +
            credit.promotionReadiness.mismatches,
          promotionTotalEvents
        ),
        failureRate: rate(
          settlement.promotionReadiness.failures +
            ledger.promotionReadiness.failures +
            credit.promotionReadiness.failures,
          promotionTotalEvents
        ),
      },
    },
    domains: {
      settlement,
      ledger,
      credit,
    },
    rootCause: {
      mismatchCountsByCategory: combineCauseCounts(allMismatches),
      failureCountsByCategory: combineCauseCounts(allFailures),
      affectedDomains: Array.from(
        new Set([...allMismatches, ...allFailures].map((item) => item.domain))
      ),
      affectedRoutes: Array.from(
        new Set([...allMismatches, ...allFailures].map((item) => item.route))
      ),
      affectedAuthorityCandidates: Array.from(
        new Set(
          [...allMismatches, ...allFailures].map(
            (item) => item.authorityCandidate
          )
        )
      ),
    },
    recommendation: "",
  };

  summary.recommendation = getRecommendation(summary);

  return summary;
}

export async function listShadowAnalysisMismatches(
  window: ShadowAnalysisWindow = "7d"
): Promise<ClassifiedShadowEvidence[]> {
  const windowStart = getWindowStart(window);
  const lifecycleMap = await getEffectiveLifecycleStatusMap();
  const domains = await Promise.all([
    loadDomainEvidence({ domain: "SETTLEMENT", windowStart, lifecycleMap }),
    loadDomainEvidence({ domain: "LEDGER", windowStart, lifecycleMap }),
    loadDomainEvidence({ domain: "CREDIT", windowStart, lifecycleMap }),
  ]);

  return domains.flatMap((domain) => domain.mismatches);
}

export async function listShadowAnalysisFailures(
  window: ShadowAnalysisWindow = "7d"
): Promise<ClassifiedShadowEvidence[]> {
  const windowStart = getWindowStart(window);
  const lifecycleMap = await getEffectiveLifecycleStatusMap();
  const domains = await Promise.all([
    loadDomainEvidence({ domain: "SETTLEMENT", windowStart, lifecycleMap }),
    loadDomainEvidence({ domain: "LEDGER", windowStart, lifecycleMap }),
    loadDomainEvidence({ domain: "CREDIT", windowStart, lifecycleMap }),
  ]);

  return domains.flatMap((domain) => domain.failures);
}
