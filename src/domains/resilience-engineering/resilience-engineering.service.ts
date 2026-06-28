import { getAuthorityBaselineStatus } from "../authority-baseline/authority-baseline.service";
import { validateRollbackReadiness } from "../authority-control/authority-control.service";
import { getQueueHealthSummary } from "../operations/queue-health.service";
import {
  getOperationsMetricsSummary,
  getOutboxObservabilitySummary,
  getWorkerObservabilitySummary,
} from "../operations/worker-observability.service";
import { pingRedis } from "@/src/lib/redis/redis.client";
import { supabaseServerAdmin } from "@/src/lib/supabase/server-admin-client";
import type {
  FailureRecoveryBaseline,
  ResilienceDuplicatePrevention,
  ResilienceScenario,
  ResilienceScenarioStatus,
  ResilienceStatus,
  RetryIdempotencyStatus,
  ServiceRecoverySummary,
} from "./resilience-engineering.types";

type Row = Record<string, unknown>;

function nowIso() {
  return new Date().toISOString();
}

function maxStatus(statuses: ResilienceScenarioStatus[]): ResilienceScenarioStatus {
  if (statuses.includes("BLOCKED")) return "BLOCKED";
  if (statuses.includes("WARNING")) return "WARNING";

  return "READY";
}

async function countRows(table: string) {
  const { count, error } = await supabaseServerAdmin
    .from(table)
    .select("id", { count: "exact", head: true });

  if (error) return { count: 0, error: error.message };

  return { count: count ?? 0, error: null };
}

async function sampleRows(table: string, select: string, limit = 1000) {
  const { data, error } = await supabaseServerAdmin
    .from(table)
    .select(select)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) return [] as Row[];

  return (data ?? []) as unknown as Row[];
}

function duplicateCount(rows: Row[], key: string) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const row of rows) {
    const value = row[key];
    if (typeof value !== "string" || value.length === 0) continue;
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }

  return duplicates.size;
}

function duplicateCompositeCount(rows: Row[], keys: string[]) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const row of rows) {
    const values = keys.map((key) => row[key]);
    if (values.some((value) => value === null || value === undefined)) continue;
    const composite = values.map(String).join(":");
    if (seen.has(composite)) duplicates.add(composite);
    seen.add(composite);
  }

  return duplicates.size;
}

async function getDuplicatePrevention(): Promise<ResilienceDuplicatePrevention> {
  const [tickets, settlements, ledgerEntries, reservations] = await Promise.all([
    sampleRows("tickets", "id, external_ticket_id, created_at"),
    sampleRows("credit_settlement_applications", "id, reservation_id, ticket_id, settlement_id, created_at"),
    sampleRows("financial_ledger_entries", "id, reference_type, reference_id, created_at"),
    sampleRows("credit_reservations", "id, player_id, ticket_id, created_at"),
  ]);

  return {
    duplicateTickets: duplicateCount(tickets, "external_ticket_id"),
    duplicateSettlements: duplicateCompositeCount(settlements, [
      "reservation_id",
      "ticket_id",
      "settlement_id",
    ]),
    duplicateLedgerReferences: duplicateCount(ledgerEntries, "id"),
    duplicateCreditReservations: duplicateCompositeCount(reservations, [
      "player_id",
      "ticket_id",
    ]),
    sampledTickets: tickets.length,
    sampledSettlements: settlements.length,
    sampledLedgerEntries: ledgerEntries.length,
    sampledCreditReservations: reservations.length,
  };
}

async function getCorrelationIdEvidenceCount() {
  const { count, error } = await supabaseServerAdmin
    .from("outbox_events")
    .select("id", { count: "exact", head: true })
    .not("correlation_id", "is", null);

  if (error) return 0;

  return count ?? 0;
}

export async function getRetryIdempotencyStatus(): Promise<RetryIdempotencyStatus> {
  const [duplicatePrevention, outbox, correlationIdEvidenceCount] =
    await Promise.all([
      getDuplicatePrevention(),
      getOutboxObservabilitySummary(),
      getCorrelationIdEvidenceCount(),
    ]);
  const warnings: string[] = [];

  if (duplicatePrevention.duplicateTickets > 0) {
    warnings.push("Duplicate external ticket identifiers were observed in sampled evidence.");
  }
  if (duplicatePrevention.duplicateSettlements > 0) {
    warnings.push("Duplicate settlement application relationships were observed in sampled evidence.");
  }
  if (duplicatePrevention.duplicateLedgerReferences > 0) {
    warnings.push("Duplicate ledger reference relationships were observed in sampled evidence.");
  }
  if (duplicatePrevention.duplicateCreditReservations > 0) {
    warnings.push("Duplicate credit reservation relationships were observed in sampled evidence.");
  }

  const status = warnings.length > 0 ? "WARNING" : "READY";

  return {
    status,
    generatedAt: nowIso(),
    correlationIdEvidenceCount,
    retryEvidenceCount: outbox.retryCount ?? 0,
    duplicatePrevention,
    warnings,
    recommendation:
      status === "READY"
        ? "Retry and idempotency evidence is safe for baseline purposes."
        : "Review duplicate-prevention warnings before destructive recovery drills.",
  };
}

async function getRedisHealth() {
  const checkedAt = nowIso();

  try {
    await pingRedis();

    return {
      available: true,
      status: "READY" as const,
      checkedAt,
      error: null,
    };
  } catch (error) {
    return {
      available: false,
      status: "WARNING" as const,
      checkedAt,
      error: error instanceof Error ? error.message : "Unknown Redis health error.",
    };
  }
}

export async function getServiceRecoverySummary(): Promise<ServiceRecoverySummary> {
  const [rollback, queueHealth, redisHealth, workers, outbox] = await Promise.all([
    validateRollbackReadiness(),
    getQueueHealthSummary(),
    getRedisHealth(),
    getWorkerObservabilitySummary(),
    getOutboxObservabilitySummary(),
  ]);
  const warnings: string[] = [];

  for (const [name, domain] of [
    ["Settlement", rollback.settlement],
    ["Ledger", rollback.ledger],
    ["Credit", rollback.credit],
  ] as const) {
    if (!domain.serviceHealth.available) {
      warnings.push(`${name} service health is unavailable.`);
    }
    if (domain.rollbackStatus !== "READY") {
      warnings.push(`${name} rollback readiness is ${domain.rollbackStatus}.`);
    }
  }

  if (!redisHealth.available) warnings.push("Redis health is unavailable.");
  if (queueHealth.rabbitmq.every((queue) => !queue.available)) {
    warnings.push("RabbitMQ queue metrics are unavailable.");
  }
  if (workers.heartbeats.length === 0) {
    warnings.push("No worker heartbeat evidence is visible.");
  }
  if (outbox.failedCount > 0 || outbox.deadLetterCount > 0) {
    warnings.push("Outbox failed or dead-letter events are present.");
  }

  return {
    status: warnings.length > 0 ? "WARNING" : "READY",
    generatedAt: nowIso(),
    settlement: rollback.settlement,
    ledger: rollback.ledger,
    credit: rollback.credit,
    rabbitmq: queueHealth.rabbitmq,
    redisHealth,
    workers,
    outbox,
    warnings,
  };
}

function scenario({
  name,
  status,
  checks,
  evidence,
}: {
  name: string;
  status: ResilienceScenarioStatus;
  checks: string[];
  evidence: Record<string, unknown>;
}): ResilienceScenario {
  return {
    name,
    status,
    simulatedOnly: true,
    destructiveTest: false,
    checks,
    evidence,
  };
}

export async function getFailureRecoveryBaseline(): Promise<FailureRecoveryBaseline> {
  const [
    authorityBaseline,
    operationsMetrics,
    retryIdempotency,
    serviceRecovery,
    ticketCount,
    settlementCount,
    ledgerCount,
    reservationCount,
  ] = await Promise.all([
    getAuthorityBaselineStatus(),
    getOperationsMetricsSummary(),
    getRetryIdempotencyStatus(),
    getServiceRecoverySummary(),
    countRows("tickets"),
    countRows("credit_settlement_applications"),
    countRows("financial_ledger_entries"),
    countRows("credit_reservations"),
  ]);
  const scenarios: ResilienceScenario[] = [
    scenario({
      name: "SETTLEMENT_SERVICE_RECOVERY_READINESS",
      status:
        authorityBaseline.settlement.authority === "SERVICE" &&
        authorityBaseline.settlement.rollbackReadiness === "READY" &&
        authorityBaseline.settlement.serviceHealth.available
          ? "READY"
          : "BLOCKED",
      checks: [
        "service health visible",
        "authority remains SERVICE",
        "rollback remains READY",
        "no settlement mutation performed",
      ],
      evidence: {
        serviceHealth: authorityBaseline.settlement.serviceHealth,
        authority: authorityBaseline.settlement.authority,
        rollbackReadiness: authorityBaseline.settlement.rollbackReadiness,
        settlementCount,
        ticketCount,
      },
    }),
    scenario({
      name: "LEDGER_SERVICE_RECOVERY_READINESS",
      status:
        authorityBaseline.ledger.authority === "SERVICE" &&
        authorityBaseline.ledger.rollbackReadiness === "READY" &&
        authorityBaseline.ledger.serviceHealth.available
          ? "READY"
          : "BLOCKED",
      checks: [
        "service health visible",
        "authority remains SERVICE",
        "rollback remains READY",
        "no ledger mutation performed",
      ],
      evidence: {
        serviceHealth: authorityBaseline.ledger.serviceHealth,
        authority: authorityBaseline.ledger.authority,
        rollbackReadiness: authorityBaseline.ledger.rollbackReadiness,
        ledgerCount,
      },
    }),
    scenario({
      name: "CREDIT_SERVICE_RECOVERY_READINESS",
      status:
        authorityBaseline.credit.authority === "SERVICE" &&
        authorityBaseline.credit.rollbackReadiness === "READY" &&
        authorityBaseline.credit.serviceHealth.available
          ? "READY"
          : "BLOCKED",
      checks: [
        "service health visible",
        "authority remains SERVICE",
        "rollback remains READY",
        "no credit mutation performed",
      ],
      evidence: {
        serviceHealth: authorityBaseline.credit.serviceHealth,
        authority: authorityBaseline.credit.authority,
        rollbackReadiness: authorityBaseline.credit.rollbackReadiness,
        reservationCount,
      },
    }),
    scenario({
      name: "RABBITMQ_CONNECTIVITY",
      status: serviceRecovery.rabbitmq.some((queue) => queue.available)
        ? "READY"
        : "WARNING",
      checks: [
        "RabbitMQ health visible",
        "queues visible",
        "consumers visible when management metrics are available",
        "event contracts unchanged",
      ],
      evidence: {
        queueCount: serviceRecovery.rabbitmq.length,
        availableQueueCount: serviceRecovery.rabbitmq.filter((queue) => queue.available)
          .length,
        consumerCount: serviceRecovery.rabbitmq.reduce(
          (sum, queue) => sum + (queue.consumerCount ?? 0),
          0
        ),
      },
    }),
    scenario({
      name: "REDIS_CONNECTIVITY",
      status: serviceRecovery.redisHealth.status,
      checks: [
        "Redis health visible",
        "degraded state can be reported",
        "no Redis-dependent financial mutation performed",
      ],
      evidence: serviceRecovery.redisHealth,
    }),
    scenario({
      name: "OUTBOX_DISPATCHER_RECOVERY",
      status:
        serviceRecovery.outbox.failedCount > 0 ||
        serviceRecovery.outbox.deadLetterCount > 0
          ? "WARNING"
          : "READY",
      checks: [
        "dispatcher heartbeat visible through worker evidence",
        "pending count visible",
        "published count visible",
        "retry candidates visible",
        "no duplicate publish evidence reported",
      ],
      evidence: {
        pendingCount: serviceRecovery.outbox.pendingCount,
        failedCount: serviceRecovery.outbox.failedCount,
        deadLetterCount: serviceRecovery.outbox.deadLetterCount,
        publishedCount: serviceRecovery.outbox.publishedCount,
        retryCount: serviceRecovery.outbox.retryCount,
        dispatcherObserved: serviceRecovery.workers.workerDetails.some((worker) =>
          worker.workerName.includes("outbox")
        ),
      },
    }),
    scenario({
      name: "WORKER_LIFECYCLE",
      status: serviceRecovery.workers.heartbeats.length > 0 ? "READY" : "WARNING",
      checks: [
        "active workers visible",
        "stale workers separated from active workers",
        "worker heartbeat freshness reported",
        "historical stale evidence is advisory",
      ],
      evidence: {
        heartbeatCount: serviceRecovery.workers.heartbeats.length,
        freshHeartbeatCount: serviceRecovery.workers.freshHeartbeats.length,
        staleWorkerCount: serviceRecovery.workers.staleWorkers.length,
        activeWorkerObserved: serviceRecovery.workers.activeWorkerObserved,
      },
    }),
    scenario({
      name: "RETRY_IDEMPOTENCY_EVIDENCE",
      status: retryIdempotency.status,
      checks: [
        "correlation id evidence visible",
        "retry evidence visible when available",
        "duplicate prevention evidence visible",
        "no duplicate ticket, settlement, ledger, or credit records in sampled evidence",
      ],
      evidence: retryIdempotency,
    }),
  ];
  const blockers: string[] = [];
  const warnings = [
    ...authorityBaseline.warnings,
    ...serviceRecovery.warnings,
    ...retryIdempotency.warnings,
  ];

  for (const scenarioItem of scenarios) {
    if (scenarioItem.status === "BLOCKED") blockers.push(`${scenarioItem.name} is blocked.`);
    if (scenarioItem.status === "WARNING") warnings.push(`${scenarioItem.name} has advisory warnings.`);
  }

  const status =
    blockers.length > 0 ? "BLOCKED" : maxStatus(scenarios.map((item) => item.status));

  return {
    status,
    generatedAt: nowIso(),
    measurementOnly: true,
    destructiveTestsPerformed: false,
    scenarios,
    authorityBaseline,
    operationsMetrics,
    retryIdempotency,
    serviceRecovery,
    blockers,
    warnings: [...new Set(warnings)],
    recommendation:
      status === "BLOCKED"
        ? "Resolve blocked resilience checks before destructive recovery drills."
        : "Resilience baseline is ready; Phase 21.1 may introduce controlled recovery drills.",
  };
}

export async function getResilienceStatus(): Promise<ResilienceStatus> {
  const [baseline, rollback, queueHealth, redisHealth, workers] = await Promise.all([
    getAuthorityBaselineStatus(),
    validateRollbackReadiness(),
    getQueueHealthSummary(),
    getRedisHealth(),
    getWorkerObservabilitySummary(),
  ]);
  const blockers: string[] = [];
  const warnings = [...baseline.warnings];
  const domains = [
    ["Settlement", baseline.settlement],
    ["Ledger", baseline.ledger],
    ["Credit", baseline.credit],
  ] as const;

  for (const [name, domain] of domains) {
    if (domain.authority !== "SERVICE") blockers.push(`${name} authority must remain SERVICE.`);
    if (domain.certificationStatus !== "CERTIFIED") {
      blockers.push(`${name} certification must remain CERTIFIED.`);
    }
    if (domain.comparisonMode !== "ENABLED") {
      blockers.push(`${name} comparison mode must remain ENABLED.`);
    }
    if (domain.rollbackReadiness !== "READY") {
      blockers.push(`${name} rollback readiness must remain READY.`);
    }
  }

  if (!redisHealth.available) warnings.push("Redis health is unavailable.");
  if (queueHealth.rabbitmq.every((queue) => !queue.available)) {
    warnings.push("RabbitMQ queue metrics are unavailable.");
  }
  if (workers.heartbeats.length === 0) warnings.push("Worker heartbeat evidence is unavailable.");

  const status =
    blockers.length > 0
      ? "BLOCKED"
      : warnings.length > 0
        ? "WARNING"
        : "READY";

  return {
    status,
    generatedAt: nowIso(),
    measurementOnly: true,
    destructiveTestsPerformed: false,
    authority: {
      settlement: baseline.settlement.authority,
      ledger: baseline.ledger.authority,
      credit: baseline.credit.authority,
    },
    certification: {
      settlement: baseline.settlement.certificationStatus,
      ledger: baseline.ledger.certificationStatus,
      credit: baseline.credit.certificationStatus,
    },
    comparison: {
      settlement: baseline.settlement.comparisonMode,
      ledger: baseline.ledger.comparisonMode,
      credit: baseline.credit.comparisonMode,
    },
    rollback: {
      settlement: baseline.settlement.rollbackReadiness,
      ledger: baseline.ledger.rollbackReadiness,
      credit: baseline.credit.rollbackReadiness,
      overall: rollback.overallStatus,
    },
    serviceHealth: {
      settlement: baseline.settlement.serviceHealth.available,
      ledger: baseline.ledger.serviceHealth.available,
      credit: baseline.credit.serviceHealth.available,
    },
    rabbitmqVisible: queueHealth.rabbitmq.some((queue) => queue.available),
    redisVisible: redisHealth.available,
    workersVisible: workers.heartbeats.length > 0,
    dispatcherVisible: workers.workerDetails.some((worker) =>
      worker.workerName.includes("outbox")
    ),
    blockers,
    warnings: [...new Set(warnings)],
    recommendation:
      blockers.length > 0
        ? "Resolve resilience blockers before continuing."
        : "Resilience status is suitable for non-destructive baseline validation.",
  };
}
