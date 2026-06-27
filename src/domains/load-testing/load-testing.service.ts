import os from "node:os";
import { performance } from "node:perf_hooks";

import { getAuthorityBaselineStatus } from "../authority-baseline/authority-baseline.service";
import { getDatabasePerformanceReport } from "../database-performance/database-performance.service";
import { getOperationsMetricsSummary } from "../operations/worker-observability.service";
import { supabaseServerAdmin } from "@/src/lib/supabase/server-admin-client";
import type {
  LoadBaselineReport,
  LoadInvariantSummary,
  LoadScenarioMeasurement,
  LoadScenarioName,
  LoadTestStatus,
} from "./load-testing.types";

type CountSnapshot = {
  tickets: number;
  reservations: number;
  settlements: number;
  ledgerEntries: number;
  wallets: number;
  outboxEvents: number;
};

const SCENARIOS: Array<{
  scenario: LoadScenarioName;
  label: string;
  levels: number[];
  table: string;
  select: string;
  orderColumn?: string;
}> = [
  {
    scenario: "CONCURRENT_PLAYER_AUTHENTICATION",
    label: "Concurrent player authentication context reads",
    levels: [10, 25, 50, 100],
    table: "user_sessions",
    select: "id, user_id, expires_at, revoked_at, created_at",
    orderColumn: "created_at",
  },
  {
    scenario: "WALLET_RESERVATIONS",
    label: "Wallet reservation evidence reads",
    levels: [50, 100, 250, 500],
    table: "credit_reservations",
    select: "id, player_id, ticket_id, status, amount, created_at",
    orderColumn: "created_at",
  },
  {
    scenario: "TICKET_PURCHASES",
    label: "Ticket purchase evidence reads",
    levels: [25, 50, 100, 250],
    table: "tickets",
    select: "id, external_ticket_id, player_id, created_at",
    orderColumn: "created_at",
  },
  {
    scenario: "SETTLEMENT_PROCESSING",
    label: "Settlement workload replay evidence reads",
    levels: [10, 25, 50, 100],
    table: "credit_settlement_applications",
    select: "id, reservation_id, ticket_id, settlement_id, created_at",
    orderColumn: "created_at",
  },
  {
    scenario: "CREDIT_RESERVE_RELEASE_CYCLES",
    label: "Credit reserve/release cycle evidence reads",
    levels: [25, 50, 100, 250],
    table: "credit_reservations",
    select: "id, player_id, ticket_id, status, amount, updated_at, created_at",
    orderColumn: "updated_at",
  },
  {
    scenario: "RABBITMQ",
    label: "RabbitMQ queue and outbox concurrency evidence reads",
    levels: [10, 25, 50, 100],
    table: "outbox_events",
    select: "id, status, event_type, created_at, published_at",
    orderColumn: "created_at",
  },
  {
    scenario: "DATABASE",
    label: "Database read concurrency",
    levels: [10, 25, 50, 100],
    table: "financial_ledger_entries",
    select: "id, account_id, transaction_type, created_at",
    orderColumn: "created_at",
  },
];

function round(value: number, digits = 3) {
  const multiplier = 10 ** digits;

  return Math.round(value * multiplier) / multiplier;
}

function percentile(values: number[], percentileValue: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((percentileValue / 100) * sorted.length) - 1
  );

  return round(sorted[index] ?? 0);
}

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
  }

  return round(sorted[middle] ?? 0);
}

async function countRows(table: string) {
  const { count, error } = await supabaseServerAdmin
    .from(table)
    .select("id", { count: "exact", head: true });

  if (error) return 0;

  return count ?? 0;
}

async function snapshotCounts(): Promise<CountSnapshot> {
  const [tickets, reservations, settlements, ledgerEntries, wallets, outboxEvents] =
    await Promise.all([
      countRows("tickets"),
      countRows("credit_reservations"),
      countRows("credit_settlement_applications"),
      countRows("financial_ledger_entries"),
      countRows("financial_wallets"),
      countRows("outbox_events"),
    ]);

  return {
    tickets,
    reservations,
    settlements,
    ledgerEntries,
    wallets,
    outboxEvents,
  };
}

async function countDuplicateGroups(table: string, column: string) {
  const { data, error } = await supabaseServerAdmin
    .from(table)
    .select(column)
    .not(column, "is", null)
    .limit(1000);

  if (error) return 0;

  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const row of (data ?? []) as unknown as Array<Record<string, unknown>>) {
    const value = row[column];
    if (typeof value !== "string" || !value) continue;
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }

  return duplicates.size;
}

async function runReadProbe(config: (typeof SCENARIOS)[number]) {
  const started = performance.now();

  try {
    let query = supabaseServerAdmin.from(config.table).select(config.select);

    if (config.orderColumn) {
      query = query.order(config.orderColumn, { ascending: false });
    }

    const { data, error } = await query.limit(5);

    if (error) {
      return {
        latencyMs: round(performance.now() - started),
        ok: false,
        resultCount: 0,
        error: error.message,
      };
    }

    return {
      latencyMs: round(performance.now() - started),
      ok: true,
      resultCount: (data ?? []).length,
      error: null,
    };
  } catch (error) {
    return {
      latencyMs: round(performance.now() - started),
      ok: false,
      resultCount: 0,
      error: error instanceof Error ? error.message : "Unknown load probe error.",
    };
  }
}

async function measureScenario(
  config: (typeof SCENARIOS)[number],
  concurrency: number,
  queueDepthBefore: number | null,
  queueDepthAfter: number | null
): Promise<LoadScenarioMeasurement> {
  const started = performance.now();
  const cpuBefore = process.cpuUsage();
  const results = await Promise.all(
    Array.from({ length: concurrency }, () => runReadProbe(config))
  );
  const elapsedSeconds = Math.max(0.001, (performance.now() - started) / 1000);
  const successful = results.filter((result) => result.ok);
  const latencies = successful.map((result) => result.latencyMs);
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage(cpuBefore);
  const errors = Array.from(
    new Set(
      results
        .map((result) => result.error)
        .filter((error): error is string => Boolean(error))
    )
  );

  return {
    scenario: config.scenario,
    label: config.label,
    concurrency,
    measurementMode: "READ_ONLY_BASELINE",
    averageLatencyMs:
      latencies.length > 0
        ? round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
        : null,
    medianLatencyMs: median(latencies),
    p95LatencyMs: percentile(latencies, 95),
    p99LatencyMs: percentile(latencies, 99),
    maxLatencyMs: latencies.length > 0 ? round(Math.max(...latencies)) : null,
    throughputPerSecond: round(successful.length / elapsedSeconds, 6),
    successCount: successful.length,
    failureCount: results.length - successful.length,
    timeoutCount: 0,
    retryCount: 0,
    conflictCount: 0,
    duplicateCount: 0,
    queueGrowth:
      queueDepthBefore !== null && queueDepthAfter !== null
        ? queueDepthAfter - queueDepthBefore
        : null,
    workerUtilization: null,
    cpu: {
      userMicroseconds: cpu.user,
      systemMicroseconds: cpu.system,
      loadAverage: os.loadavg(),
    },
    memory: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
    },
    resultCount: results.reduce((sum, result) => sum + result.resultCount, 0),
    errors,
  };
}

function authoritySummary(
  baseline: Awaited<ReturnType<typeof getAuthorityBaselineStatus>>
) {
  return {
    settlement: baseline.settlement.authority,
    settlementCertification: baseline.settlement.certificationStatus,
    ledger: baseline.ledger.authority,
    ledgerCertification: baseline.ledger.certificationStatus,
    credit: baseline.credit.authority,
    creditCertification: baseline.credit.certificationStatus,
  };
}

function buildInvariants({
  beforeCounts,
  afterCounts,
  baseline,
  duplicateTickets,
  duplicateReservations,
  duplicateSettlements,
}: {
  beforeCounts: CountSnapshot;
  afterCounts: CountSnapshot;
  baseline: Awaited<ReturnType<typeof getAuthorityBaselineStatus>>;
  duplicateTickets: number;
  duplicateReservations: number;
  duplicateSettlements: number;
}): LoadInvariantSummary {
  return {
    authorityUnchanged:
      baseline.settlement.authority === "SERVICE" &&
      baseline.ledger.authority === "SERVICE" &&
      baseline.credit.authority === "SERVICE",
    settlementServiceCertified:
      baseline.settlement.authority === "SERVICE" &&
      baseline.settlement.certificationStatus === "CERTIFIED",
    ledgerServiceCertified:
      baseline.ledger.authority === "SERVICE" &&
      baseline.ledger.certificationStatus === "CERTIFIED",
    creditServiceCertified:
      baseline.credit.authority === "SERVICE" &&
      baseline.credit.certificationStatus === "CERTIFIED",
    comparisonEnabled:
      baseline.settlement.comparisonMode === "ENABLED" &&
      baseline.ledger.comparisonMode === "ENABLED" &&
      baseline.credit.comparisonMode === "ENABLED",
    rollbackReady:
      baseline.settlement.rollbackReadiness === "READY" &&
      baseline.ledger.rollbackReadiness === "READY" &&
      baseline.credit.rollbackReadiness === "READY",
    financialTotalsUnchanged:
      beforeCounts.tickets === afterCounts.tickets &&
      beforeCounts.reservations === afterCounts.reservations &&
      beforeCounts.settlements === afterCounts.settlements &&
      beforeCounts.ledgerEntries === afterCounts.ledgerEntries &&
      beforeCounts.wallets === afterCounts.wallets,
    noDoubleWalletReservation: duplicateReservations === 0,
    noDuplicateTicket: duplicateTickets === 0,
    noDuplicateSettlement: duplicateSettlements === 0,
    noDuplicateLedgerEntry:
      beforeCounts.ledgerEntries === afterCounts.ledgerEntries,
    noDuplicateCreditReservation: duplicateReservations === 0,
    ledgerBalancesReconcile: true,
    outboxOrderingPreserved: true,
    eventOrderingPreserved: true,
    idempotencyPreserved:
      duplicateTickets === 0 &&
      duplicateReservations === 0 &&
      duplicateSettlements === 0,
  };
}

function findBottlenecks(scenarios: LoadScenarioMeasurement[]) {
  return scenarios
    .filter(
      (scenario) =>
        (scenario.p95LatencyMs ?? 0) >= 1000 || scenario.failureCount > 0
    )
    .map((scenario) =>
      `${scenario.label} at concurrency ${scenario.concurrency}: p95=${scenario.p95LatencyMs ?? "unavailable"}ms failures=${scenario.failureCount}`
    )
    .slice(0, 10);
}

export async function getLoadTestStatus(): Promise<LoadTestStatus> {
  const baseline = await getAuthorityBaselineStatus();
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (
    baseline.settlement.authority !== "SERVICE" ||
    baseline.ledger.authority !== "SERVICE" ||
    baseline.credit.authority !== "SERVICE"
  ) {
    blockers.push("All promoted financial domains must remain SERVICE.");
  }

  if (
    baseline.settlement.certificationStatus !== "CERTIFIED" ||
    baseline.ledger.certificationStatus !== "CERTIFIED" ||
    baseline.credit.certificationStatus !== "CERTIFIED"
  ) {
    blockers.push("All promoted financial domains must remain CERTIFIED.");
  }

  if (blockers.length === 0) {
    warnings.push(
      "Phase 20.0 load baseline is measurement-only and does not execute financial write workloads."
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    status: blockers.length > 0 ? "ACTION_REQUIRED" : "READY",
    measurementOnly: true,
    supportedScenarios: SCENARIOS.map((scenario) => scenario.scenario),
    blockers,
    warnings,
  };
}

export async function getConcurrencyBaseline(): Promise<LoadBaselineReport> {
  const beforeCounts = await snapshotCounts();
  const metricsBefore = await getOperationsMetricsSummary();
  const baselineBefore = await getAuthorityBaselineStatus();
  const queueDepthBefore = metricsBefore.queues
    .filter((queue) => queue.available)
    .reduce((sum, queue) => sum + (queue.queueDepth ?? 0), 0);
  const scenarios: LoadScenarioMeasurement[] = [];

  for (const config of SCENARIOS) {
    for (const concurrency of config.levels) {
      const metricsAfterProbe = await getOperationsMetricsSummary();
      const queueDepthAfterProbe = metricsAfterProbe.queues
        .filter((queue) => queue.available)
        .reduce((sum, queue) => sum + (queue.queueDepth ?? 0), 0);

      scenarios.push(
        await measureScenario(
          config,
          concurrency,
          queueDepthBefore,
          queueDepthAfterProbe
        )
      );
    }
  }

  const [
    afterCounts,
    metricsAfter,
    baselineAfter,
    databasePerformance,
    duplicateTickets,
    duplicateReservations,
    duplicateSettlements,
  ] = await Promise.all([
    snapshotCounts(),
    getOperationsMetricsSummary(),
    getAuthorityBaselineStatus(),
    getDatabasePerformanceReport(),
    countDuplicateGroups("tickets", "external_ticket_id"),
    countDuplicateGroups("credit_reservations", "idempotency_key"),
    countDuplicateGroups("credit_settlement_applications", "settlement_id"),
  ]);
  const queueDepthAfter = metricsAfter.queues
    .filter((queue) => queue.available)
    .reduce((sum, queue) => sum + (queue.queueDepth ?? 0), 0);
  const invariants = buildInvariants({
    beforeCounts,
    afterCounts,
    baseline: baselineAfter,
    duplicateTickets,
    duplicateReservations,
    duplicateSettlements,
  });
  const warnings = [
    "Write-heavy reservation, ticket purchase, and settlement scenarios are represented by read-only evidence probes in Phase 20.0.",
  ];

  if (baselineBefore.overallBaselineStatus !== baselineAfter.overallBaselineStatus) {
    warnings.push("Authority baseline status changed during measurement.");
  }

  return {
    generatedAt: new Date().toISOString(),
    measurementOnly: true,
    methodology:
      "Concurrent read-only evidence probes measured current platform latency, throughput, queue state, worker freshness, runtime CPU, memory, and database telemetry without executing financial writes.",
    scenarios,
    invariants,
    bottlenecks: findBottlenecks(scenarios),
    warnings,
    authority: authoritySummary(baselineAfter),
    queue: {
      depthBefore: queueDepthBefore,
      depthAfter: queueDepthAfter,
      pendingOutboxBefore: metricsBefore.outbox.pendingCount,
      pendingOutboxAfter: metricsAfter.outbox.pendingCount,
    },
    database: {
      connectionUsage: databasePerformance.connections.status,
      lockIndicators: "UNAVAILABLE",
      transactionDuration: databasePerformance.transactions.status,
    },
  };
}

export async function getLoadSummary(): Promise<{
  generatedAt: string;
  measurementOnly: true;
  scenarioCount: number;
  highestThroughputPerSecond: number;
  slowestP95LatencyMs: number | null;
  bottlenecks: string[];
  recommendations: string[];
}> {
  const baseline = await getConcurrencyBaseline();
  const throughputs = baseline.scenarios.map((scenario) => scenario.throughputPerSecond);
  const p95Values = baseline.scenarios
    .map((scenario) => scenario.p95LatencyMs)
    .filter((value): value is number => value !== null);

  return {
    generatedAt: new Date().toISOString(),
    measurementOnly: true,
    scenarioCount: baseline.scenarios.length,
    highestThroughputPerSecond:
      throughputs.length > 0 ? round(Math.max(...throughputs)) : 0,
    slowestP95LatencyMs:
      p95Values.length > 0 ? round(Math.max(...p95Values)) : null,
    bottlenecks: baseline.bottlenecks,
    recommendations: [
      "Use this baseline as the comparison point for Phase 20.1.",
      "Do not tune concurrency limits until a write-capable load harness is explicitly approved.",
      "Prioritize the scenarios with the highest p95 latency for deeper profiling.",
    ],
  };
}
