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
  LedgerImmutabilityReport,
  LedgerReferenceAuditIssue,
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
  const triggerDetected = triggerResult.triggers.some((trigger) =>
    /financial_ledger_entries/i.test(trigger)
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

  return {
    status: statusMax([reversalStatus, adjustmentStatus, triggerStatus]),
    ledgerEntryCount,
    updateDetection: {
      status: "READY",
      message:
        "financial_ledger_entries has no updated_at column in the ledger row model; sampled entries expose created_at only.",
      updatedAtColumnPresent: false,
    },
    deleteDetection: {
      status: "WARNING",
      message:
        "Deletes are not detected by row data alone; no mutation was attempted during verification.",
      tombstoneOrAuditTablePresent: false,
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
      triggers: triggerResult.triggers,
      message: triggerDetected
        ? "Ledger table trigger evidence was detected."
        : "Ledger append-only behavior is currently evidenced by schema, reversal links, idempotency, and service convention.",
    },
    warnings: [...new Set(warnings)],
    generatedAt: nowIso(),
  };
}

export async function getOutboxHardeningReport(): Promise<OutboxHardeningReport> {
  const outbox = await getOutboxObservabilitySummary();
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
    ledgerImmutability,
    outboxHealth,
    queueHealth,
    workerHealth,
    operationsMetrics,
  ] = await Promise.all([
    getAuthorityBaselineStatus(),
    getLedgerReferenceAudit(),
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
