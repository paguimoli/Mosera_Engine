import { getAuthorityBaselineStatus } from "../authority-baseline/authority-baseline.service";
import { getQueueHealthSummary } from "../operations/queue-health.service";
import {
  getOperationsMetricsSummary,
  getOutboxObservabilitySummary,
  getWorkerObservabilitySummary,
  getWorkerObservabilityThresholds,
} from "../operations/worker-observability.service";
import { supabaseServerAdmin } from "@/src/lib/supabase/server-admin-client";
import type {
  EvidenceStatus,
  LedgerImmutabilityVerificationReport,
  LedgerImmutabilityReport,
  LedgerReferenceAuditIssue,
  LedgerReferenceRemediationItem,
  LedgerReferenceRemediationReport,
  LedgerReferenceAuditSummary,
  OutboxHardeningReport,
  PlatformEvidenceReport,
  QueueHardeningReport,
  WorkerHardeningReport,
} from "./platform-evidence.types";

type CreditSettlementApplicationEvidenceRow = {
  id: string;
  reservation_id: string;
  player_id: string;
  ticket_id: string;
  settlement_id: string;
  correlation_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

type LedgerEvidenceRow = {
  id: string;
  account_id: string;
  transaction_type: string;
  reference_type: string | null;
  reference_id: string | null;
  idempotency_key: string | null;
  reversal_of_ledger_entry_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

type OutboxEventEvidenceRow = {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  status: string;
  attempt_count: number;
  next_attempt_at: string | null;
  correlation_id: string | null;
  created_at: string;
  published_at: string | null;
};

type TriggerRow = {
  trigger_name?: string | null;
  event_manipulation?: string | null;
  action_timing?: string | null;
};

function nowIso() {
  return new Date().toISOString();
}

function statusMax(statuses: EvidenceStatus[]): EvidenceStatus {
  if (statuses.includes("ACTION_REQUIRED")) return "ACTION_REQUIRED";
  if (statuses.includes("WARNING")) return "WARNING";

  return "READY";
}

function metadataIncludes(row: LedgerEvidenceRow, needle: string | null | undefined) {
  if (!needle) return false;

  return JSON.stringify(row.metadata ?? {}).includes(needle);
}

function stringIncludes(value: string | null | undefined, needle: string | null | undefined) {
  return Boolean(value && needle && value.includes(needle));
}

function stableReportId(prefix: string, values: string[]) {
  const source = values.sort().join("|");
  let hash = 0;

  for (let index = 0; index < source.length; index += 1) {
    hash = (hash * 31 + source.charCodeAt(index)) >>> 0;
  }

  return `${prefix}-${hash.toString(16).padStart(8, "0")}`;
}

function ledgerReferencesApplication(
  ledger: LedgerEvidenceRow,
  application: CreditSettlementApplicationEvidenceRow
) {
  const referenceIds = [
    application.id,
    application.settlement_id,
    application.reservation_id,
    application.ticket_id,
    application.correlation_id,
  ].filter((value): value is string => Boolean(value));

  if (ledger.reference_id && referenceIds.includes(ledger.reference_id)) {
    return "DIRECT" as const;
  }

  if (
    metadataIncludes(ledger, application.id) ||
    metadataIncludes(ledger, application.settlement_id) ||
    metadataIncludes(ledger, application.reservation_id) ||
    metadataIncludes(ledger, application.ticket_id) ||
    metadataIncludes(ledger, application.correlation_id) ||
    stringIncludes(ledger.idempotency_key, application.id) ||
    stringIncludes(ledger.idempotency_key, application.settlement_id) ||
    stringIncludes(ledger.idempotency_key, application.reservation_id) ||
    stringIncludes(ledger.idempotency_key, application.ticket_id)
  ) {
    return "INFERRED" as const;
  }

  return null;
}

async function listCreditSettlementApplicationEvidence() {
  const { data, error } = await supabaseServerAdmin
    .from("credit_settlement_applications")
    .select(
      "id, reservation_id, player_id, ticket_id, settlement_id, correlation_id, metadata, created_at"
    )
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error) throw new Error(error.message);

  return (data ?? []) as CreditSettlementApplicationEvidenceRow[];
}

async function listLedgerEvidence() {
  const { data, error } = await supabaseServerAdmin
    .from("financial_ledger_entries")
    .select(
      "id, account_id, transaction_type, reference_type, reference_id, idempotency_key, reversal_of_ledger_entry_id, metadata, created_at"
    )
    .order("created_at", { ascending: false })
    .limit(5000);

  if (error) throw new Error(error.message);

  return (data ?? []) as LedgerEvidenceRow[];
}

async function countLedgerEntries() {
  const { count, error } = await supabaseServerAdmin
    .from("financial_ledger_entries")
    .select("id", { count: "exact", head: true });

  if (error) throw new Error(error.message);

  return count ?? 0;
}

async function tryListLedgerTriggers() {
  const { data, error } = await supabaseServerAdmin
    .from("information_schema.triggers")
    .select("trigger_name, event_manipulation, action_timing")
    .eq("event_object_schema", "public")
    .eq("event_object_table", "financial_ledger_entries");

  if (error) {
    return {
      unavailable: true,
      triggers: [] as string[],
      error: error.message,
    };
  }

  return {
    unavailable: false,
    triggers: ((data ?? []) as TriggerRow[]).map((trigger) =>
      [
        trigger.trigger_name ?? "unnamed_trigger",
        trigger.action_timing ?? "UNKNOWN_TIMING",
        trigger.event_manipulation ?? "UNKNOWN_EVENT",
      ].join(":")
    ),
    error: null,
  };
}

async function listRecentOutboxEventEvidence() {
  const { data, error } = await supabaseServerAdmin
    .from("outbox_events")
    .select(
      "id, event_type, aggregate_type, aggregate_id, status, attempt_count, next_attempt_at, correlation_id, created_at, published_at"
    )
    .in("status", ["PENDING", "FAILED", "DEAD_LETTER"])
    .order("created_at", { ascending: true })
    .limit(100);

  if (error) throw new Error(error.message);

  return (data ?? []) as OutboxEventEvidenceRow[];
}

export async function getLedgerReferenceAudit(): Promise<LedgerReferenceAuditSummary> {
  const [applications, ledgerEntries] = await Promise.all([
    listCreditSettlementApplicationEvidence(),
    listLedgerEvidence(),
  ]);
  const settlementLedgerEntries = ledgerEntries.filter((entry) =>
    entry.transaction_type.startsWith("SETTLEMENT_")
  );
  const issues: LedgerReferenceAuditIssue[] = [];
  let directReferenceMatches = 0;
  let inferredReferenceMatches = 0;

  for (const application of applications) {
    const matches = ledgerEntries
      .map((entry) => ({
        entry,
        matchType: ledgerReferencesApplication(entry, application),
      }))
      .filter((item) => item.matchType);

    if (matches.length === 0) {
      issues.push({
        kind: "MISSING_LEDGER_POSTING",
        severity: "WARNING",
        settlementApplicationId: application.id,
        settlementId: application.settlement_id,
        reservationId: application.reservation_id,
        ticketId: application.ticket_id,
        correlationId: application.correlation_id,
        message:
          "Credit-backed settlement application has no sampled ledger posting reference.",
      });
      continue;
    }

    if (matches.some((item) => item.matchType === "DIRECT")) {
      directReferenceMatches += 1;
    } else {
      inferredReferenceMatches += 1;
      issues.push({
        kind: "MISSING_SETTLEMENT_REFERENCE",
        severity: "WARNING",
        settlementApplicationId: application.id,
        settlementId: application.settlement_id,
        reservationId: application.reservation_id,
        ticketId: application.ticket_id,
        ledgerEntryId: matches[0]?.entry.id ?? null,
        correlationId: application.correlation_id,
        message:
          "Credit-backed settlement has inferred ledger evidence but no direct reference_id match.",
      });
    }
  }

  for (const entry of settlementLedgerEntries) {
    if (!entry.reference_id && !entry.reversal_of_ledger_entry_id) {
      issues.push({
        kind: "ORPHAN_LEDGER_RECORD",
        severity: "WARNING",
        ledgerEntryId: entry.id,
        correlationId:
          typeof entry.metadata?.correlationId === "string"
            ? entry.metadata.correlationId
            : null,
        message: "Settlement ledger entry is missing a settlement reference.",
      });
    }
  }

  const matchedLedgerPostings = directReferenceMatches + inferredReferenceMatches;
  const missingLedgerPostingCount = issues.filter(
    (issue) => issue.kind === "MISSING_LEDGER_POSTING"
  ).length;
  const orphanLedgerRecordCount = issues.filter(
    (issue) => issue.kind === "ORPHAN_LEDGER_RECORD"
  ).length;
  const orphanSettlementReferenceCount = issues.filter(
    (issue) => issue.kind === "ORPHAN_SETTLEMENT_REFERENCE"
  ).length;
  const status = issues.some((issue) => issue.severity === "ACTION_REQUIRED")
    ? "ACTION_REQUIRED"
    : issues.length > 0
      ? "WARNING"
      : "READY";

  return {
    status,
    sampledCreditBackedSettlements: applications.length,
    matchedLedgerPostings,
    directReferenceMatches,
    inferredReferenceMatches,
    missingLedgerPostingCount,
    orphanLedgerRecordCount,
    orphanSettlementReferenceCount,
    issues: issues.slice(0, 100),
    generatedAt: nowIso(),
  };
}

function confidenceForIssue(issue: LedgerReferenceAuditIssue) {
  if (issue.ledgerEntryId && issue.settlementApplicationId) return "HIGH";
  if (issue.settlementId || issue.reservationId || issue.ticketId) return "MEDIUM";
  if (issue.correlationId) return "LOW";

  return "UNKNOWN";
}

function remediationForIssue(issue: LedgerReferenceAuditIssue) {
  switch (issue.kind) {
    case "MISSING_LEDGER_POSTING":
      return "Review settlement, reservation, ticket, and correlation evidence before preparing a separate operator-approved reference remediation or backfill plan.";
    case "MISSING_SETTLEMENT_REFERENCE":
      return "Review the probable ledger entry and settlement application evidence before creating a separately approved reference-link remediation plan.";
    case "ORPHAN_LEDGER_RECORD":
      return "Review the ledger entry metadata and idempotency evidence before linking it to settlement evidence in a separately approved remediation phase.";
    case "ORPHAN_SETTLEMENT_REFERENCE":
      return "Review the settlement reference and confirm whether the source settlement application remains valid before a remediation phase.";
    default:
      return "Review evidence manually before any remediation phase.";
  }
}

export async function getLedgerReferenceRemediationReport(): Promise<LedgerReferenceRemediationReport> {
  const audit = await getLedgerReferenceAudit();
  const items: LedgerReferenceRemediationItem[] = audit.issues.map((issue) => ({
    issueKind: issue.kind,
    settlementApplicationId: issue.settlementApplicationId ?? null,
    settlementId: issue.settlementId ?? null,
    reservationId: issue.reservationId ?? null,
    ticketId: issue.ticketId ?? null,
    ledgerEntryId: issue.ledgerEntryId ?? null,
    correlationId: issue.correlationId ?? null,
    probableLedgerEntryId: issue.ledgerEntryId ?? null,
    confidence: confidenceForIssue(issue),
    recommendedRemediation: remediationForIssue(issue),
    mutationAllowed: false,
  }));
  const counts = {
    highConfidenceCount: items.filter((item) => item.confidence === "HIGH").length,
    mediumConfidenceCount: items.filter((item) => item.confidence === "MEDIUM")
      .length,
    lowConfidenceCount: items.filter((item) => item.confidence === "LOW").length,
    unknownConfidenceCount: items.filter((item) => item.confidence === "UNKNOWN")
      .length,
  };

  return {
    status: audit.status,
    reportId: stableReportId(
      "ledger-reference-remediation",
      items.map(
        (item) =>
          `${item.issueKind}:${item.settlementApplicationId ?? ""}:${item.ledgerEntryId ?? ""}:${item.correlationId ?? ""}`
      )
    ),
    appendOnly: true,
    persistence: {
      mode: "GENERATED_REPORT",
      persisted: false,
      reason:
        "The remediation report is generated as append-only evidence and intentionally does not mutate production records or create backfill rows.",
    },
    itemCount: items.length,
    ...counts,
    items,
    generatedAt: nowIso(),
  };
}

export async function getLedgerImmutabilityReport(): Promise<LedgerImmutabilityReport> {
  const [ledgerEntryCount, ledgerEntries, triggerResult] = await Promise.all([
    countLedgerEntries(),
    listLedgerEvidence(),
    tryListLedgerTriggers(),
  ]);
  const reversalEntries = ledgerEntries.filter(
    (entry) =>
      entry.transaction_type === "REVERSAL" || Boolean(entry.reversal_of_ledger_entry_id)
  );
  const sampledLedgerIds = new Set(ledgerEntries.map((entry) => entry.id));
  const missingOriginalLedgerEntryIds = reversalEntries
    .filter(
      (entry) =>
        entry.reversal_of_ledger_entry_id &&
        !sampledLedgerIds.has(entry.reversal_of_ledger_entry_id)
    )
    .map((entry) => entry.id);
  const adjustmentEntries = ledgerEntries.filter((entry) =>
    entry.transaction_type.includes("ADJUSTMENT")
  );
  const brokenAdjustmentEntries = adjustmentEntries.filter(
    (entry) => !entry.idempotency_key && !entry.reference_id
  );
  const ledgerTableTriggers = triggerResult.triggers.filter((trigger) =>
    /financial_ledger_entries/i.test(trigger) ||
    /ledger/i.test(trigger)
  );
  const triggerDetected = ledgerTableTriggers.length > 0;
  const updateProtectedByDatabase = ledgerTableTriggers.some((trigger) =>
    /UPDATE/i.test(trigger)
  );
  const deleteProtectedByDatabase = ledgerTableTriggers.some((trigger) =>
    /DELETE/i.test(trigger)
  );
  const warnings: string[] = [];

  if (triggerResult.unavailable) {
    warnings.push(
      "Database trigger catalog is unavailable through the API; append-only behavior is verified from schema shape, reversal references, and service conventions."
    );
  } else if (!triggerDetected) {
    warnings.push(
      "No table-level immutability trigger was detected for financial_ledger_entries."
    );
  }
  if (missingOriginalLedgerEntryIds.length > 0) {
    warnings.push("Some sampled reversal entries reference originals outside the sample.");
  }
  if (brokenAdjustmentEntries.length > 0) {
    warnings.push("Some sampled adjustment entries lack reference or idempotency evidence.");
  }

  const reversalStatus =
    missingOriginalLedgerEntryIds.length === 0 ? "READY" : "WARNING";
  const adjustmentStatus =
    brokenAdjustmentEntries.length === 0 ? "READY" : "WARNING";
  const triggerStatus = triggerDetected ? "READY" : "WARNING";
  const databaseProtected = updateProtectedByDatabase && deleteProtectedByDatabase;
  const enforcementMode = databaseProtected
    ? "DATABASE_ENFORCED"
    : triggerResult.unavailable
      ? "UNKNOWN"
      : "APPLICATION_ENFORCED";
  const appendOnlyStatus = databaseProtected ? "READY" : "WARNING";

  return {
    status: statusMax([
      reversalStatus,
      adjustmentStatus,
      triggerStatus,
      appendOnlyStatus,
    ]),
    ledgerEntryCount,
    enforcementMode,
    appendOnlyEnforcement: {
      status: appendOnlyStatus,
      databaseProtected,
      applicationProtected: true,
      message: databaseProtected
        ? "Ledger immutability has database-level update/delete protection evidence."
        : "Ledger immutability is evidenced by application write surfaces, schema shape, idempotency, and reversal links; database-level update/delete protection was not verified.",
    },
    updateDetection: {
      status: updateProtectedByDatabase ? "READY" : "WARNING",
      message: updateProtectedByDatabase
        ? "Database trigger evidence indicates ledger UPDATE protection."
        : "No database-level UPDATE protection was verified; sampled ledger rows expose created_at only and no updated_at column.",
      updatedAtColumnPresent: false,
      protectedByDatabase: updateProtectedByDatabase,
    },
    deleteDetection: {
      status: deleteProtectedByDatabase ? "READY" : "WARNING",
      message: deleteProtectedByDatabase
        ? "Database trigger evidence indicates ledger DELETE protection."
        : "Deletes are not detected by row data alone; no mutation was attempted during verification.",
      tombstoneOrAuditTablePresent: false,
      protectedByDatabase: deleteProtectedByDatabase,
    },
    reversalIntegrity: {
      status: reversalStatus,
      reversalEntryCount: reversalEntries.length,
      missingOriginalCount: missingOriginalLedgerEntryIds.length,
      missingOriginalLedgerEntryIds: missingOriginalLedgerEntryIds.slice(0, 25),
    },
    adjustmentChains: {
      status: adjustmentStatus,
      adjustmentEntryCount: adjustmentEntries.length,
      brokenChainCount: brokenAdjustmentEntries.length,
      brokenLedgerEntryIds: brokenAdjustmentEntries
        .map((entry) => entry.id)
        .slice(0, 25),
    },
    databaseTriggers: {
      status: triggerStatus,
      detected: triggerDetected,
      unavailable: triggerResult.unavailable,
      triggers: ledgerTableTriggers,
      message: triggerDetected
        ? "Ledger table trigger evidence was detected."
        : "Ledger append-only behavior is currently evidenced by schema, reversal links, idempotency, and service convention.",
    },
    warnings: [...new Set(warnings)],
    generatedAt: nowIso(),
  };
}

export async function getLedgerImmutabilityVerificationReport(): Promise<LedgerImmutabilityVerificationReport> {
  const report = await getLedgerImmutabilityReport();

  return {
    ...report,
    verificationScope: "EVIDENCE_ONLY",
    destructiveProbeAttempted: false,
    destructiveTriggerCreated: false,
    guarantees: {
      updateImpossibleOrProtected:
        report.updateDetection.protectedByDatabase ||
        report.appendOnlyEnforcement.applicationProtected,
      deleteImpossibleOrProtected:
        report.deleteDetection.protectedByDatabase ||
        report.appendOnlyEnforcement.applicationProtected,
      appendOnlyEnforced:
        report.appendOnlyEnforcement.databaseProtected ||
        report.appendOnlyEnforcement.applicationProtected,
      reversalChainIntact: report.reversalIntegrity.status !== "ACTION_REQUIRED",
      adjustmentChainIntact: report.adjustmentChains.status !== "ACTION_REQUIRED",
    },
  };
}

export async function getOutboxHardeningReport(): Promise<OutboxHardeningReport> {
  const [outbox, oldestEvents] = await Promise.all([
    getOutboxObservabilitySummary(),
    listRecentOutboxEventEvidence(),
  ]);
  const warnings: string[] = [];

  if (outbox.deadLetterCount > 0) warnings.push("Dead-letter outbox events exist.");
  if (outbox.failedCount > 0) warnings.push("Failed outbox events exist.");
  if (outbox.stalledPublisher.detected) {
    warnings.push(outbox.stalledPublisher.reason);
  }

  const recommendation =
    outbox.deadLetterCount > 0 || outbox.failedCount > 0
      ? "ACTION_REQUIRED"
      : warnings.length > 0
        ? "WARNING"
        : "READY";

  return {
    ...outbox,
    oldestPendingEvents: oldestEvents.slice(0, 25),
    retryCandidates: oldestEvents
      .filter((event) => event.status === "FAILED" || event.attempt_count > 0)
      .slice(0, 25),
    status: recommendation,
    recommendation,
    warnings,
    generatedAt: nowIso(),
  };
}

export async function getQueueHardeningReport(): Promise<QueueHardeningReport> {
  const queueHealth = await getQueueHealthSummary();
  const warnings: string[] = [];

  for (const queue of queueHealth.rabbitmq) {
    if (!queue.available) {
      warnings.push(
        `${queue.category} queue metrics are unavailable; treating as degraded evidence, not a queue failure.`
      );
      continue;
    }
    if ((queue.deadLetterMessagesReady ?? 0) > 0) {
      warnings.push(`${queue.category} dead-letter queue has ready messages.`);
    }
    if ((queue.messagesReady ?? 0) > 0) {
      warnings.push(`${queue.category} queue has ready messages.`);
    }
  }

  const recommendation = queueHealth.rabbitmq.some(
    (queue) => queue.status === "CRITICAL"
  )
    ? "ACTION_REQUIRED"
    : warnings.length > 0
      ? "WARNING"
      : "READY";

  return {
    ...queueHealth,
    evidenceState: queueHealth.rabbitmq.some((queue) => queue.status === "CRITICAL")
      ? "UNHEALTHY"
      : queueHealth.rabbitmq.some((queue) => !queue.available)
        ? "UNKNOWN"
        : "HEALTHY",
    status: recommendation,
    recommendation,
    warnings,
  };
}

export async function getWorkerHardeningReport(): Promise<WorkerHardeningReport> {
  const worker = await getWorkerObservabilitySummary();
  const thresholds = getWorkerObservabilityThresholds();
  const warnings: string[] = [];

  if (worker.heartbeats.length === 0) {
    warnings.push(
      "Workers appear intentionally offline or have not emitted heartbeat evidence yet."
    );
  }
  if (worker.staleWorkers.length > 0) {
    warnings.push(
      `${worker.staleWorkers.length} worker heartbeat(s) exceed the stale threshold.`
    );
  }
  if (!worker.activeWorkerObserved && worker.heartbeats.length > 0) {
    warnings.push("Worker heartbeat evidence exists but no worker is active.");
  }

  return {
    ...worker,
    evidenceState:
      worker.heartbeats.length === 0 || worker.staleWorkers.length > 0
        ? "UNKNOWN"
        : worker.activeWorkerObserved
          ? "HEALTHY"
          : "IDLE",
    status: warnings.length > 0 ? "WARNING" : "READY",
    recommendation: warnings.length > 0 ? "WARNING" : "READY",
    warnings,
    heartbeatStaleSeconds: thresholds.heartbeatStaleSeconds,
  };
}

export async function getPlatformEvidenceReport(): Promise<PlatformEvidenceReport> {
  const [
    authorityBaseline,
    ledgerReferenceAudit,
    ledgerReferenceRemediation,
    ledgerImmutability,
    outboxHealth,
    queueHealth,
    workerHealth,
    operationsMetrics,
  ] = await Promise.all([
    getAuthorityBaselineStatus(),
    getLedgerReferenceAudit(),
    getLedgerReferenceRemediationReport(),
    getLedgerImmutabilityReport(),
    getOutboxHardeningReport(),
    getQueueHardeningReport(),
    getWorkerHardeningReport(),
    getOperationsMetricsSummary(),
  ]);
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (authorityBaseline.blockers.length > 0) {
    blockers.push(...authorityBaseline.blockers);
  }

  for (const [label, report] of [
    ["ledger reference audit", ledgerReferenceAudit],
    ["ledger reference remediation", ledgerReferenceRemediation],
    ["ledger immutability", ledgerImmutability],
    ["outbox health", outboxHealth],
    ["queue health", queueHealth],
    ["worker health", workerHealth],
  ] as const) {
    if (report.status === "ACTION_REQUIRED") {
      blockers.push(`${label} requires action.`);
    } else if (report.status === "WARNING") {
      warnings.push(`${label} has advisory warnings.`);
    }
  }

  warnings.push(...authorityBaseline.warnings);
  warnings.push(...ledgerImmutability.warnings);
  warnings.push(...outboxHealth.warnings);
  warnings.push(...queueHealth.warnings);
  warnings.push(...workerHealth.warnings);

  return {
    status:
      blockers.length > 0
        ? "ACTION_REQUIRED"
        : warnings.length > 0
          ? "WARNING"
          : "READY",
    authorityBaseline,
    financialInvariants: authorityBaseline.financialInvariants,
    ledgerReferenceAudit,
    ledgerReferenceRemediation,
    ledgerImmutability,
    outboxHealth,
    workerHealth,
    queueHealth,
    operationsMetrics,
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    generatedAt: nowIso(),
  };
}
