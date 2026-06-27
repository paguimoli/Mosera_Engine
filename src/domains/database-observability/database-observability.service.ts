import { performance } from "node:perf_hooks";

import { getDatabasePerformanceReport } from "../database-performance/database-performance.service";
import type {
  DatabaseHotspot,
  DatabasePerformanceRecommendation,
  DatabaseQueryMeasurement,
} from "../database-performance/database-performance.types";
import { supabaseServerAdmin } from "@/src/lib/supabase/server-admin-client";
import type {
  DatabaseExplainPlanReport,
  DatabaseLockAnalysis,
  DatabaseObservabilityReport,
  DatabaseSessionAnalysis,
  DatabaseTimingRanking,
  ExplainPlanSummary,
  NativeDatabaseStatus,
} from "./database-observability.types";

type PgStatActivityRow = {
  state?: string | null;
  wait_event_type?: string | null;
  wait_event?: string | null;
  query_start?: string | null;
  xact_start?: string | null;
};

type PgLockRow = {
  mode?: string | null;
  granted?: boolean | null;
};

function nowIso() {
  return new Date().toISOString();
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

function average(values: number[]) {
  if (values.length === 0) return null;

  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function unavailableLimitations(error: string, source: string) {
  return [
    `${source} is not exposed through the current Supabase REST schema or service-role access model.`,
    `Observed access result: ${error}`,
    "No schema, migration, planner setting, query, or business behavior was changed to collect this telemetry.",
  ];
}

function countBy<T>(
  rows: T[],
  getKey: (row: T) => string
): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();

  for (const row of rows) {
    const key = getKey(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()].map(([key, count]) => ({ key, count }));
}

async function readPgStatActivity() {
  const { data, error } = await supabaseServerAdmin
    .from("pg_stat_activity")
    .select("state, wait_event_type, wait_event, query_start, xact_start")
    .limit(100);

  if (error) {
    return { rows: [] as PgStatActivityRow[], error: error.message };
  }

  return { rows: (data ?? []) as PgStatActivityRow[], error: null };
}

async function readPgLocks() {
  const { data, error } = await supabaseServerAdmin
    .from("pg_locks")
    .select("mode, granted")
    .limit(100);

  if (error) {
    return { rows: [] as PgLockRow[], error: error.message };
  }

  return { rows: (data ?? []) as PgLockRow[], error: null };
}

export async function getNativeDatabaseStatus(): Promise<NativeDatabaseStatus> {
  const generatedAt = nowIso();
  const activity = await readPgStatActivity();

  if (activity.error) {
    return {
      generatedAt,
      measurementOnly: true,
      status: "UNAVAILABLE",
      source: "SUPABASE_REST_LIMITED",
      sessions: {
        active: null,
        idle: null,
        waiting: null,
        total: null,
      },
      waitEvents: [],
      transactionStates: [],
      pool: {
        utilization: null,
        exhaustionEvents: null,
      },
      limitations: unavailableLimitations(activity.error, "pg_stat_activity"),
    };
  }

  const rows = activity.rows;
  const active = rows.filter((row) => row.state === "active").length;
  const idle = rows.filter((row) => row.state === "idle").length;
  const waiting = rows.filter((row) => row.wait_event || row.wait_event_type).length;

  return {
    generatedAt,
    measurementOnly: true,
    status: "READY",
    source: "PG_STAT_ACTIVITY",
    sessions: {
      active,
      idle,
      waiting,
      total: rows.length,
    },
    waitEvents: countBy(
      rows.filter((row) => row.wait_event || row.wait_event_type),
      (row) => `${row.wait_event_type ?? "unknown"}:${row.wait_event ?? "unknown"}`
    ).map((item) => {
      const [waitEventType, waitEvent] = item.key.split(":");

      return {
        waitEventType,
        waitEvent,
        count: item.count,
      };
    }),
    transactionStates: countBy(rows, (row) => row.state ?? "unknown").map(
      (item) => ({
        state: item.key,
        count: item.count,
      })
    ),
    pool: {
      utilization: rows.length > 0 ? round(active / rows.length, 6) : null,
      exhaustionEvents: null,
    },
    limitations: [
      "Pool exhaustion events are unavailable unless exposed by a pooler-specific telemetry source.",
    ],
  };
}

export async function getDatabaseLockAnalysis(): Promise<DatabaseLockAnalysis> {
  const generatedAt = nowIso();
  const locks = await readPgLocks();

  if (locks.error) {
    return {
      generatedAt,
      measurementOnly: true,
      status: "UNAVAILABLE",
      source: "SUPABASE_REST_LIMITED",
      lockWaits: null,
      blockedQueries: null,
      blockingSessions: null,
      locksByMode: [],
      limitations: unavailableLimitations(locks.error, "pg_locks"),
    };
  }

  const waitingLocks = locks.rows.filter((row) => row.granted === false);

  return {
    generatedAt,
    measurementOnly: true,
    status: "READY",
    source: "PG_LOCKS",
    lockWaits: waitingLocks.length,
    blockedQueries: waitingLocks.length,
    blockingSessions: null,
    locksByMode: countBy(
      locks.rows,
      (row) => `${row.mode ?? "unknown"}:${String(row.granted ?? null)}`
    ).map((item) => {
      const [mode, granted] = item.key.split(":");

      return {
        mode,
        granted: granted === "true" ? true : granted === "false" ? false : null,
        count: item.count,
      };
    }),
    limitations: [
      "Blocking session identity requires joining pg_locks to pg_stat_activity, which is not performed unless both native views are exposed.",
    ],
  };
}

export async function getDatabaseSessionAnalysis(): Promise<DatabaseSessionAnalysis> {
  const generatedAt = nowIso();
  const nativeStatus = await getNativeDatabaseStatus();

  if (nativeStatus.status === "UNAVAILABLE") {
    return {
      generatedAt,
      measurementOnly: true,
      status: "UNAVAILABLE",
      source: nativeStatus.source,
      activeSessions: null,
      idleSessions: null,
      waitingSessions: null,
      longestRunningSession: {
        durationMs: null,
        state: null,
        waitEventType: null,
        waitEvent: null,
      },
      transactionStates: [],
      waitEvents: [],
      limitations: nativeStatus.limitations,
    };
  }

  return {
    generatedAt,
    measurementOnly: true,
    status: nativeStatus.status,
    source: nativeStatus.source,
    activeSessions: nativeStatus.sessions.active,
    idleSessions: nativeStatus.sessions.idle,
    waitingSessions: nativeStatus.sessions.waiting,
    longestRunningSession: {
      durationMs: null,
      state: null,
      waitEventType: null,
      waitEvent: null,
    },
    transactionStates: nativeStatus.transactionStates,
    waitEvents: nativeStatus.waitEvents,
    limitations: [
      ...nativeStatus.limitations,
      "Longest-running session duration requires query_start/xact_start visibility from pg_stat_activity.",
    ],
  };
}

function statementTemplateForMeasurement(measurement: DatabaseQueryMeasurement) {
  if (measurement.operation === "COUNT") {
    return `EXPLAIN SELECT count(*) FROM ${measurement.table};`;
  }

  return `EXPLAIN SELECT ${measurement.table} sampled columns FROM ${measurement.table} ORDER BY observed timestamp DESC LIMIT 50;`;
}

function buildUnavailableExplainPlan(
  measurement: DatabaseQueryMeasurement,
  limitation: string
): ExplainPlanSummary {
  return {
    id: `explain-${measurement.id}`,
    label: measurement.label,
    table: measurement.table,
    sourceMeasurement: measurement,
    status: "UNAVAILABLE",
    source: "SUPABASE_REST_LIMITED",
    planAvailable: false,
    planningTimeMs: null,
    executionTimeMs: null,
    estimatedRows: null,
    estimatedCost: null,
    scanTypes: [],
    joinStrategies: [],
    sortOperations: [],
    aggregateOperations: [],
    sequentialScanIndicators: [],
    indexUsageIndicators: [],
    statementTemplate: statementTemplateForMeasurement(measurement),
    limitations: [
      limitation,
      "EXPLAIN ANALYZE was not used because it can execute the target statement.",
      "No planner settings, schema, index, or query text was changed.",
    ],
  };
}

export async function getDatabaseExplainPlanReport(): Promise<DatabaseExplainPlanReport> {
  const generatedAt = nowIso();
  const performanceReport = await getDatabasePerformanceReport();
  const candidates = performanceReport.slowQueries.topSlowQueries.slice(0, 5);
  const limitation =
    "Read-only EXPLAIN execution is not exposed through the current Supabase REST API without a dedicated safe RPC.";

  return {
    generatedAt,
    measurementOnly: true,
    status: "UNAVAILABLE",
    source: "SUPABASE_REST_LIMITED",
    plans: candidates.map((candidate) =>
      buildUnavailableExplainPlan(candidate, limitation)
    ),
    limitations: [
      limitation,
      "A future phase may add a reviewed read-only SECURITY DEFINER RPC for EXPLAIN without ANALYZE.",
    ],
  };
}

function durationsForMeasurements(measurements: DatabaseQueryMeasurement[]) {
  return measurements
    .map((measurement) => measurement.durationMs)
    .filter((duration): duration is number => duration !== null);
}

function measurementsForHotspot(
  hotspot: DatabaseHotspot,
  measurements: DatabaseQueryMeasurement[],
  kind: "repository" | "endpoint"
) {
  return measurements.filter((measurement) => {
    if (kind === "repository") {
      return (
        measurement.repositoryMethod !== null &&
        hotspot.evidence.some((item) => item.includes("direct sampled")) &&
        (hotspot.name.includes(measurement.repositoryMethod.split(".")[0]) ||
          measurement.repositoryMethod.includes(hotspot.name.split("/").at(-1) ?? ""))
      );
    }

    return measurement.endpoint === hotspot.name;
  });
}

export async function getDatabaseTimingRanking(): Promise<DatabaseTimingRanking> {
  const generatedAt = nowIso();
  const started = performance.now();
  const performanceReport = await getDatabasePerformanceReport();
  const measurementOverheadMs = round(performance.now() - started);

  return {
    generatedAt,
    measurementOnly: true,
    repositoryTiming: performanceReport.repositoryHotspots.map((hotspot) => {
      const measurements = measurementsForHotspot(
        hotspot,
        performanceReport.measurements,
        "repository"
      );
      const durations = durationsForMeasurements(measurements);
      const cumulative =
        durations.length > 0
          ? round(durations.reduce((sum, duration) => sum + duration, 0))
          : null;

      return {
        ...hotspot,
        invocationCount: measurements.length,
        cumulativeDbTimeMs: cumulative,
        averageDbTimeMs: average(durations),
        medianDbTimeMs: percentile(durations, 50),
        p95DbTimeMs: percentile(durations, 95),
        p99DbTimeMs: percentile(durations, 99),
      };
    }),
    endpointTiming: performanceReport.apiHotspots.map((hotspot) => {
      const measurements = measurementsForHotspot(
        hotspot,
        performanceReport.measurements,
        "endpoint"
      );
      const durations = durationsForMeasurements(measurements);
      const dbTime =
        durations.length > 0
          ? round(durations.reduce((sum, duration) => sum + duration, 0))
          : null;

      return {
        ...hotspot,
        invocationCount: measurements.length,
        dbTimeMs: dbTime,
        applicationTimeMs: dbTime === null ? null : measurementOverheadMs,
        serializationTimeMs: null,
        totalRequestTimeMs: dbTime === null ? null : measurementOverheadMs,
      };
    }),
  };
}

function buildRecommendations(input: {
  nativeStatus: NativeDatabaseStatus;
  lockAnalysis: DatabaseLockAnalysis;
  explainPlans: DatabaseExplainPlanReport;
  timing: DatabaseTimingRanking;
}): DatabasePerformanceRecommendation[] {
  const recommendations: Omit<DatabasePerformanceRecommendation, "rank">[] = [];
  const topEndpoint = input.timing.endpointTiming[0];
  const topRepository = input.timing.repositoryTiming[0];

  if (input.nativeStatus.status === "UNAVAILABLE") {
    recommendations.push({
      impact: "HIGH",
      area: "OBSERVABILITY",
      metric: "native session telemetry",
      observedValue: "UNAVAILABLE",
      recommendation:
        "Add a reviewed read-only native telemetry path for pg_stat_activity before pool or session tuning.",
    });
  }

  if (input.lockAnalysis.status === "UNAVAILABLE") {
    recommendations.push({
      impact: "HIGH",
      area: "TRANSACTIONS",
      metric: "lock waits",
      observedValue: "UNAVAILABLE",
      recommendation:
        "Expose read-only pg_locks telemetry before diagnosing transaction contention.",
    });
  }

  if (input.explainPlans.status === "UNAVAILABLE") {
    recommendations.push({
      impact: "HIGH",
      area: "QUERY_LATENCY",
      metric: "execution plans",
      observedValue: "UNAVAILABLE",
      recommendation:
        "Add a safe EXPLAIN-only RPC before considering query or index changes.",
    });
  }

  if (topRepository) {
    recommendations.push({
      impact: "MEDIUM",
      area: "REPOSITORY_HOTSPOT",
      metric: topRepository.name,
      observedValue: `${topRepository.queryCount} DB indicator(s)`,
      recommendation:
        "Use repository-level timing as the first candidate for deeper instrumentation.",
    });
  }

  if (topEndpoint) {
    recommendations.push({
      impact: "MEDIUM",
      area: "API_HOTSPOT",
      metric: topEndpoint.name,
      observedValue: `${topEndpoint.dbTimeMs ?? "unavailable"}ms DB time`,
      recommendation:
        "Use endpoint-level timing under controlled load before route optimization.",
    });
  }

  const impactScore = { HIGH: 3, MEDIUM: 2, LOW: 1 };

  return recommendations
    .sort((left, right) => impactScore[right.impact] - impactScore[left.impact])
    .slice(0, 10)
    .map((recommendation, index) => ({ rank: index + 1, ...recommendation }));
}

export async function getDatabaseObservabilityReport(): Promise<DatabaseObservabilityReport> {
  const [
    nativeStatus,
    lockAnalysis,
    sessionAnalysis,
    explainPlans,
    timing,
  ] = await Promise.all([
    getNativeDatabaseStatus(),
    getDatabaseLockAnalysis(),
    getDatabaseSessionAnalysis(),
    getDatabaseExplainPlanReport(),
    getDatabaseTimingRanking(),
  ]);
  const recommendations = buildRecommendations({
    nativeStatus,
    lockAnalysis,
    explainPlans,
    timing,
  });

  return {
    generatedAt: nowIso(),
    measurementOnly: true,
    nativeStatus,
    lockAnalysis,
    sessionAnalysis,
    explainPlans,
    timing,
    recommendations,
    limitations: [
      ...nativeStatus.limitations,
      ...lockAnalysis.limitations,
      ...explainPlans.limitations,
    ],
  };
}
