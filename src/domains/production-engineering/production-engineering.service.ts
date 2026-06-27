import os from "node:os";
import { performance } from "node:perf_hooks";

import { getAuthorityBaselineStatus } from "../authority-baseline/authority-baseline.service";
import { getDatabaseObservabilityReport } from "../database-observability/database-observability.service";
import { getDatabasePerformanceReport } from "../database-performance/database-performance.service";
import { getOperationsMetricsSummary } from "../operations/worker-observability.service";
import { supabaseServerAdmin } from "@/src/lib/supabase/server-admin-client";
import type {
  DatabaseQueryMeasurement,
  EndpointLatency,
  LatencyMeasurement,
  PerformanceBaselineReport,
  ProductionBottleneck,
  RuntimeProfile,
  SystemThroughputProfile,
  ThroughputDomainProfile,
} from "./production-engineering.types";

const processStartedAt = new Date(Date.now() - process.uptime() * 1000);
const DEFAULT_WINDOW_SECONDS = 60 * 60;

type CreatedAtRow = { created_at: string };
type UpdatedAtRow = { created_at: string; updated_at?: string | null };
type OutboxRateRow = {
  status: string;
  attempt_count: number;
  created_at: string;
  published_at?: string | null;
};

function nowIso() {
  return new Date().toISOString();
}

function appBaseUrl() {
  return (
    process.env.APP_URL ??
    process.env.QA_APP_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "http://localhost:3000"
  );
}

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

function latencyStats(values: number[]): LatencyMeasurement {
  return {
    averageMs:
      values.length > 0
        ? round(values.reduce((sum, value) => sum + value, 0) / values.length)
        : null,
    p95Ms: percentile(values, 95),
    p99Ms: percentile(values, 99),
    maxMs: values.length > 0 ? round(Math.max(...values)) : null,
    samples: values.length,
  };
}

async function measureEndpoint(path: string): Promise<EndpointLatency> {
  const started = performance.now();

  try {
    const response = await fetch(`${appBaseUrl()}${path}`, {
      method: "GET",
      cache: "no-store",
    });
    await response.arrayBuffer();

    return {
      endpoint: path,
      method: "GET",
      status: response.ok ? "READY" : "WARNING",
      statusCode: response.status,
      latencyMs: round(performance.now() - started),
      error: null,
    };
  } catch (error) {
    return {
      endpoint: path,
      method: "GET",
      status: "UNAVAILABLE",
      statusCode: null,
      latencyMs: null,
      error: error instanceof Error ? error.message : "Unknown endpoint error.",
    };
  }
}

export async function getHttpLatencyProfile() {
  const endpoints = ["/api/health", "/api/health/db", "/api/health/redis"];
  const measuredEndpoints = await Promise.all(endpoints.map(measureEndpoint));
  const ready = measuredEndpoints.filter(
    (endpoint) => endpoint.latencyMs !== null
  ) as Array<EndpointLatency & { latencyMs: number }>;
  const sorted = [...ready].sort((left, right) => left.latencyMs - right.latencyMs);

  return {
    ...latencyStats(ready.map((endpoint) => endpoint.latencyMs)),
    fastestEndpoints: sorted.slice(0, 5),
    slowestEndpoints: sorted.slice(-5).reverse(),
    measuredEndpoints,
  };
}

async function timedCount(
  label: string,
  table: string,
  column = "id"
): Promise<DatabaseQueryMeasurement> {
  const started = performance.now();
  const { count, error } = await supabaseServerAdmin
    .from(table)
    .select(column, { count: "exact", head: true });

  if (error) {
    return {
      label,
      table,
      operation: "COUNT",
      durationMs: null,
      rowCount: null,
      status: "UNAVAILABLE",
      error: error.message,
    };
  }

  return {
    label,
    table,
    operation: "COUNT",
    durationMs: round(performance.now() - started),
    rowCount: count ?? 0,
    status: "READY",
    error: null,
  };
}

async function timedSample(label: string, table: string) {
  const started = performance.now();
  const { data, error } = await supabaseServerAdmin
    .from(table)
    .select("id, created_at")
    .order("created_at", { ascending: false })
    .limit(25);

  if (error) {
    return {
      label,
      table,
      operation: "SAMPLE" as const,
      durationMs: null,
      rowCount: null,
      status: "UNAVAILABLE" as const,
      error: error.message,
    };
  }

  return {
    label,
    table,
    operation: "SAMPLE" as const,
    durationMs: round(performance.now() - started),
    rowCount: (data ?? []).length,
    status: "READY" as const,
    error: null,
  };
}

async function listRecentRows<T>(table: string, select: string, sinceIso: string) {
  const { data, error } = await supabaseServerAdmin
    .from(table)
    .select(select)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error) return [] as T[];

  return (data ?? []) as T[];
}

function profileFromRows(rows: CreatedAtRow[], windowSeconds: number) {
  return {
    windowSeconds,
    count: rows.length,
    perSecond: round(rows.length / windowSeconds, 6),
    averageDurationMs: null,
    maxDurationMs: null,
  };
}

function durationProfileFromUpdatedRows(
  rows: UpdatedAtRow[],
  windowSeconds: number
): ThroughputDomainProfile {
  const durations = rows
    .map((row) =>
      row.updated_at
        ? Math.max(
            0,
            new Date(row.updated_at).getTime() - new Date(row.created_at).getTime()
          )
        : null
    )
    .filter((value): value is number => value !== null);

  return {
    windowSeconds,
    count: rows.length,
    perSecond: round(rows.length / windowSeconds, 6),
    averageDurationMs:
      durations.length > 0
        ? round(durations.reduce((sum, duration) => sum + duration, 0) / durations.length)
        : null,
    maxDurationMs: durations.length > 0 ? Math.max(...durations) : null,
  };
}

export async function getDatabaseLatencyProfile() {
  const sampledQueries = await Promise.all([
    timedCount("wallet count", "financial_wallets"),
    timedCount("ledger entry count", "financial_ledger_entries"),
    timedCount("credit reservation count", "credit_reservations"),
    timedCount("settlement application count", "credit_settlement_applications"),
    timedCount("outbox event count", "outbox_events"),
    timedSample("recent ledger entries", "financial_ledger_entries"),
    timedSample("recent outbox events", "outbox_events"),
  ]);
  const durations = sampledQueries
    .map((query) => query.durationMs)
    .filter((value): value is number => value !== null);

  return {
    averageQueryDurationMs:
      durations.length > 0
        ? round(durations.reduce((sum, duration) => sum + duration, 0) / durations.length)
        : null,
    longestQueries: [...sampledQueries]
      .sort((left, right) => (right.durationMs ?? -1) - (left.durationMs ?? -1))
      .slice(0, 10),
    sampledQueries,
    connectionPoolUsage: "UNAVAILABLE" as const,
    concurrentConnections: null,
    readWriteRatio: {
      reads: sampledQueries.length,
      writes: 0,
      ratio: `${sampledQueries.length}:0`,
      methodology:
        "Phase 19.0 baseline APIs perform read-only sampled queries; production write ratio requires database telemetry integration.",
    },
    transactionDurationMs: null,
  };
}

export async function getRuntimeProfile(): Promise<RuntimeProfile> {
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  const containerStartedAt = process.env.CONTAINER_STARTED_AT
    ? new Date(process.env.CONTAINER_STARTED_AT)
    : null;
  const buildDuration = Number(process.env.BUILD_DURATION_MS);

  return {
    generatedAt: nowIso(),
    memory: {
      rssBytes: memory.rss,
      heapTotalBytes: memory.heapTotal,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
    },
    cpu: {
      userMicroseconds: cpu.user,
      systemMicroseconds: cpu.system,
      loadAverage: os.loadavg(),
    },
    uptime: {
      nodeUptimeSeconds: round(process.uptime()),
      dockerUptimeSeconds: containerStartedAt
        ? round((Date.now() - containerStartedAt.getTime()) / 1000)
        : null,
      processStartedAt: processStartedAt.toISOString(),
    },
    build: {
      buildDurationMs: Number.isFinite(buildDuration) ? buildDuration : null,
      containerStartupDurationMs: round(process.uptime() * 1000),
      measurement: Number.isFinite(buildDuration)
        ? "ENV_PROVIDED"
        : "RUNTIME_APPROXIMATION",
    },
  };
}

export async function getSystemThroughputProfile(
  windowSeconds = DEFAULT_WINDOW_SECONDS
): Promise<SystemThroughputProfile> {
  const sinceIso = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const [
    settlementRows,
    ledgerRows,
    creditReservationRows,
    creditSettlementRows,
    creditShadowRows,
    outboxRows,
    metrics,
  ] = await Promise.all([
    listRecentRows<CreatedAtRow>(
      "credit_settlement_applications",
      "id, created_at",
      sinceIso
    ),
    listRecentRows<CreatedAtRow>(
      "financial_ledger_entries",
      "id, created_at",
      sinceIso
    ),
    listRecentRows<UpdatedAtRow>(
      "credit_reservations",
      "id, created_at, updated_at",
      sinceIso
    ),
    listRecentRows<CreatedAtRow>(
      "credit_settlement_applications",
      "id, created_at",
      sinceIso
    ),
    listRecentRows<CreatedAtRow>("credit_shadow_runs", "id, created_at", sinceIso),
    listRecentRows<OutboxRateRow>(
      "outbox_events",
      "status, attempt_count, created_at, published_at",
      sinceIso
    ),
    getOperationsMetricsSummary(),
  ]);
  const workerDurations = metrics.workers.recentMetrics
    .filter((metric) => metric.processedCount > 0)
    .map((metric) => metric.totalProcessingMs / metric.processedCount);
  const publishedRows = outboxRows.filter(
    (row) => row.status === "PUBLISHED" && row.published_at
  );
  const publishLatencies = publishedRows.map(
    (row) =>
      new Date(row.published_at ?? row.created_at).getTime() -
      new Date(row.created_at).getTime()
  );
  const availableQueues = metrics.queues.filter((queue) => queue.available);
  const queueDepth = availableQueues.reduce(
    (sum, queue) => sum + (queue.queueDepth ?? 0),
    0
  );
  const publishRates = availableQueues
    .map((queue) => queue.publishRate)
    .filter((value): value is number => value !== null);
  const consumeRates = availableQueues
    .map((queue) => queue.consumeRate)
    .filter((value): value is number => value !== null);
  const staleHeartbeatIds = new Set(
    metrics.workers.staleWorkers.map((heartbeat) => heartbeat.id)
  );
  const freshHeartbeats = metrics.workers.heartbeats.filter(
    (heartbeat) => !staleHeartbeatIds.has(heartbeat.id)
  );

  return {
    generatedAt: nowIso(),
    windowSeconds,
    settlement: {
      ...profileFromRows(settlementRows, windowSeconds),
      shadowComparisonAverageMs: null,
    },
    ledger: {
      ...profileFromRows(ledgerRows, windowSeconds),
      postingLatencyMs: null,
    },
    credit: {
      reservations: durationProfileFromUpdatedRows(
        creditReservationRows,
        windowSeconds
      ),
      exposureUpdates: profileFromRows(creditSettlementRows, windowSeconds),
      walletOperations: profileFromRows(creditShadowRows, windowSeconds),
    },
    rabbitmq: {
      publishRate:
        publishRates.length > 0
          ? round(publishRates.reduce((sum, rate) => sum + rate, 0))
          : null,
      consumeRate:
        consumeRates.length > 0
          ? round(consumeRates.reduce((sum, rate) => sum + rate, 0))
          : null,
      ackRate:
        consumeRates.length > 0
          ? round(consumeRates.reduce((sum, rate) => sum + rate, 0))
          : null,
      queueDepth,
      consumerLag: queueDepth,
      messageThroughput:
        consumeRates.length > 0
          ? round(consumeRates.reduce((sum, rate) => sum + rate, 0))
          : null,
    },
    outbox: {
      pending: metrics.outbox.pendingCount,
      publishedPerSecond: round(publishedRows.length / windowSeconds, 6),
      publishLatencyMs:
        publishLatencies.length > 0
          ? round(
              publishLatencies.reduce((sum, latency) => sum + latency, 0) /
                publishLatencies.length
            )
          : null,
      retryRate: round(
        outboxRows.reduce((sum, row) => sum + Math.max(0, row.attempt_count), 0) /
          windowSeconds,
        6
      ),
      failedPublishes: outboxRows.filter((row) => row.status === "FAILED").length,
      oldestUnpublishedEventAgeSeconds:
        metrics.outbox.oldestUnpublishedEvent.ageSeconds,
    },
    workers: {
      runningWorkers: freshHeartbeats.filter(
        (heartbeat) => heartbeat.status === "ACTIVE"
      ).length,
      idleWorkers: freshHeartbeats.filter(
        (heartbeat) => heartbeat.status === "IDLE"
      ).length,
      staleWorkers: metrics.workers.staleWorkers.length,
      averageProcessingDurationMs:
        workerDurations.length > 0
          ? round(
              workerDurations.reduce((sum, duration) => sum + duration, 0) /
                workerDurations.length
            )
          : null,
      averageQueueWaitMs: null,
    },
  };
}

function formatMetric(value: unknown) {
  return value === null || value === undefined ? "unavailable" : String(value);
}

function rankBottlenecks(input: {
  http: Awaited<ReturnType<typeof getHttpLatencyProfile>>;
  database: Awaited<ReturnType<typeof getDatabaseLatencyProfile>>;
  throughput: SystemThroughputProfile;
  runtime: RuntimeProfile;
}): ProductionBottleneck[] {
  const candidates: Omit<ProductionBottleneck, "rank">[] = [];
  const slowestEndpoint = input.http.slowestEndpoints[0];
  const slowestQuery = input.database.longestQueries[0];

  if (input.throughput.outbox.oldestUnpublishedEventAgeSeconds !== null) {
    candidates.push({
      area: "OUTBOX",
      impact: "HIGH",
      metric: "oldest unpublished event age",
      observedValue: `${input.throughput.outbox.oldestUnpublishedEventAgeSeconds}s`,
      recommendation: "Measure dispatcher throughput and publish latency before tuning.",
    });
  }
  if (input.throughput.workers.runningWorkers === 0) {
    candidates.push({
      area: "WORKERS",
      impact: "HIGH",
      metric: "running workers",
      observedValue: "0",
      recommendation: "Measure worker activation and queue drain behavior.",
    });
  }
  if (input.throughput.workers.staleWorkers > 0) {
    candidates.push({
      area: "WORKERS",
      impact: "MEDIUM",
      metric: "stale workers",
      observedValue: String(input.throughput.workers.staleWorkers),
      recommendation: "Measure heartbeat freshness before changing worker deployment.",
    });
  }
  if (input.throughput.rabbitmq.queueDepth !== null && input.throughput.rabbitmq.queueDepth > 0) {
    candidates.push({
      area: "RABBITMQ",
      impact: "MEDIUM",
      metric: "queue depth",
      observedValue: String(input.throughput.rabbitmq.queueDepth),
      recommendation: "Measure queue drain and consumer lag before topology changes.",
    });
  }
  if (slowestEndpoint) {
    candidates.push({
      area: "HTTP",
      impact: "MEDIUM",
      metric: `slowest measured endpoint ${slowestEndpoint.endpoint}`,
      observedValue: `${slowestEndpoint.latencyMs}ms`,
      recommendation: "Use this endpoint as the first HTTP before/after benchmark.",
    });
  }
  if (slowestQuery) {
    candidates.push({
      area: "DATABASE",
      impact: "MEDIUM",
      metric: `slowest sampled query ${slowestQuery.label}`,
      observedValue: `${formatMetric(slowestQuery.durationMs)}ms`,
      recommendation: "Measure query plans before adding indexes or rewriting queries.",
    });
  }
  if (input.database.connectionPoolUsage === "UNAVAILABLE") {
    candidates.push({
      area: "DATABASE",
      impact: "LOW",
      metric: "connection pool usage",
      observedValue: "unavailable",
      recommendation: "Add database telemetry integration before pool tuning.",
    });
  }
  if (input.throughput.settlement.perSecond === 0) {
    candidates.push({
      area: "SETTLEMENT",
      impact: "LOW",
      metric: "settlements/sec",
      observedValue: "0",
      recommendation: "Run controlled load measurement before optimizing settlement flow.",
    });
  }
  if (input.throughput.ledger.perSecond === 0) {
    candidates.push({
      area: "LEDGER",
      impact: "LOW",
      metric: "ledger entries/sec",
      observedValue: "0",
      recommendation: "Run controlled ledger posting benchmark before optimizing.",
    });
  }
  if (input.runtime.build.buildDurationMs === null) {
    candidates.push({
      area: "BUILD",
      impact: "LOW",
      metric: "build duration",
      observedValue: "runtime measurement unavailable",
      recommendation: "Capture CI build timings for future production engineering comparisons.",
    });
  }

  const impactScore = { HIGH: 3, MEDIUM: 2, LOW: 1 };

  return candidates
    .sort((left, right) => impactScore[right.impact] - impactScore[left.impact])
    .slice(0, 10)
    .map((item, index) => ({ rank: index + 1, ...item }));
}

export async function getPerformanceBaselineReport(): Promise<PerformanceBaselineReport> {
  const [
    authorityBaseline,
    http,
    database,
    throughput,
    databasePerformance,
    databaseObservability,
    runtime,
    operationsMetrics,
  ] =
    await Promise.all([
      getAuthorityBaselineStatus(),
      getHttpLatencyProfile(),
      getDatabaseLatencyProfile(),
      getSystemThroughputProfile(),
      getDatabasePerformanceReport(),
      getDatabaseObservabilityReport(),
      getRuntimeProfile(),
      getOperationsMetricsSummary(),
    ]);
  const bottlenecks = rankBottlenecks({ http, database, throughput, runtime });

  return {
    generatedAt: nowIso(),
    measurementOnly: true,
    authorityBaseline,
    http,
    database,
    throughput,
    databasePerformance,
    databaseObservability,
    runtime,
    operationsMetrics,
    bottlenecks,
    recommendedOptimizationPriority: bottlenecks.map(
      (bottleneck) => `${bottleneck.area}: ${bottleneck.metric}`
    ),
  };
}
