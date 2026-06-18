import { logger } from "@/src/lib/observability/logger";
import os from "node:os";
import { listRecentJobRuns } from "@/src/domains/jobs/job-run.service";
import {
  classifyOutboxEventType,
  listQueueTopology,
  type QueueWorkloadCategory,
} from "@/src/lib/queue/queue-topology";
import { supabaseServerAdmin } from "@/src/lib/supabase/server-admin-client";
import { getQueueHealthSummary } from "./queue-health.service";
import type { RabbitMqQueueHealth } from "./queue-health.types";
import {
  insertWorkerFailure,
  insertWorkerProcessingMetric,
  listRecentWorkerFailures,
  listRecentWorkerProcessingMetrics,
  listWorkerHeartbeats,
  upsertWorkerHeartbeat,
} from "./worker-observability.repository";
import type {
  LagClassification,
  OperationsMetricsSummary,
  OutboxObservabilitySummary,
  RecordWorkerFailureInput,
  RecordWorkerHeartbeatInput,
  RecordWorkerProcessingMetricInput,
  WorkerHeartbeat,
  WorkerObservabilitySummary,
} from "./worker-observability.types";

type OutboxMetricRow = {
  event_type: string;
  status: "PENDING" | "PUBLISHED" | "FAILED" | "DEAD_LETTER";
  attempt_count: number;
  created_at: string;
  published_at?: string | null;
};

function getNumberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);

  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function getWorkerObservabilityThresholds() {
  return {
    outboxWarningAgeSeconds: getNumberEnv(
      "WORKER_OUTBOX_WARNING_AGE_SECONDS",
      300
    ),
    outboxCriticalAgeSeconds: getNumberEnv(
      "WORKER_OUTBOX_CRITICAL_AGE_SECONDS",
      900
    ),
    queueWarningReadyCount: getNumberEnv("WORKER_QUEUE_WARNING_READY_COUNT", 100),
    criticalQueueCriticalReadyCount: getNumberEnv(
      "WORKER_CRITICAL_QUEUE_CRITICAL_READY_COUNT",
      25
    ),
    heartbeatStaleSeconds: getNumberEnv("WORKER_HEARTBEAT_STALE_SECONDS", 300),
  };
}

export function getWorkerInstanceId(workerName: string) {
  return (
    process.env.WORKER_INSTANCE_ID?.trim() ||
    `${workerName}:${os.hostname()}:${process.pid}`
  );
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown worker metrics error.";
}

export async function safeRecordWorkerHeartbeat(
  input: RecordWorkerHeartbeatInput
) {
  try {
    await upsertWorkerHeartbeat(input);
  } catch (error) {
    logger.warn({
      message: "Worker heartbeat metric write failed.",
      metadata: {
        workerName: input.workerName,
        workloadCategory: input.workloadCategory,
        error: getErrorMessage(error),
      },
    });
  }
}

export async function safeRecordWorkerProcessingMetric(
  input: RecordWorkerProcessingMetricInput
) {
  try {
    await insertWorkerProcessingMetric(input);
  } catch (error) {
    logger.warn({
      message: "Worker processing metric write failed.",
      metadata: {
        workerName: input.workerName,
        workloadCategory: input.workloadCategory,
        eventType: input.eventType,
        error: getErrorMessage(error),
      },
    });
  }
}

export async function safeRecordWorkerFailure(input: RecordWorkerFailureInput) {
  try {
    await insertWorkerFailure(input);
  } catch (error) {
    logger.warn({
      message: "Worker failure metric write failed.",
      correlationId: input.correlationId ?? null,
      metadata: {
        workerName: input.workerName,
        workloadCategory: input.workloadCategory,
        eventType: input.eventType,
        entityId: input.entityId ?? null,
        error: getErrorMessage(error),
      },
    });
  }
}

async function countRowsByStatus(table: string, status: string) {
  const { count, error } = await supabaseServerAdmin
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("status", status);

  if (error) {
    throw new Error(error.message);
  }

  return count ?? 0;
}

export async function getOutboxObservabilitySummary(
  now = new Date()
): Promise<OutboxObservabilitySummary> {
  const [
    pendingCount,
    failedCount,
    deadLetterCount,
    publishedCount,
    failedJobCount,
    oldest,
    rowsResult,
  ] = await Promise.all([
    countRowsByStatus("outbox_events", "PENDING"),
    countRowsByStatus("outbox_events", "FAILED"),
    countRowsByStatus("outbox_events", "DEAD_LETTER"),
    countRowsByStatus("outbox_events", "PUBLISHED"),
    countRowsByStatus("job_runs", "FAILED"),
    supabaseServerAdmin
      .from("outbox_events")
      .select("created_at")
      .in("status", ["PENDING", "FAILED"])
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabaseServerAdmin
      .from("outbox_events")
      .select("event_type, status, attempt_count, created_at, published_at")
      .order("created_at", { ascending: false })
      .limit(1000),
  ]);

  if (oldest.error) {
    throw new Error(oldest.error.message);
  }

  if (rowsResult.error) {
    throw new Error(rowsResult.error.message);
  }

  const rows = (rowsResult.data ?? []) as OutboxMetricRow[];
  const distribution = new Map<
    QueueWorkloadCategory,
    { pendingCount: number; failedCount: number; deadLetterCount: number }
  >();
  let retryCount = 0;
  const publishLatencies: number[] = [];

  for (const entry of listQueueTopology()) {
    distribution.set(entry.category, {
      pendingCount: 0,
      failedCount: 0,
      deadLetterCount: 0,
    });
  }

  for (const row of rows) {
    const category = classifyOutboxEventType(row.event_type);
    const item =
      distribution.get(category) ??
      { pendingCount: 0, failedCount: 0, deadLetterCount: 0 };

    if (row.status === "PENDING") {
      item.pendingCount += 1;
    }

    if (row.status === "FAILED") {
      item.failedCount += 1;
    }

    if (row.status === "DEAD_LETTER") {
      item.deadLetterCount += 1;
    }

    if (row.status === "PUBLISHED" && row.published_at) {
      publishLatencies.push(
        Math.max(
          0,
          new Date(row.published_at).getTime() -
            new Date(row.created_at).getTime()
        )
      );
    }

    retryCount += Math.max(0, row.attempt_count);
    distribution.set(category, item);
  }

  const oldestCreatedAt =
    typeof oldest.data?.created_at === "string" ? oldest.data.created_at : null;
  const oldestAgeSeconds = oldestCreatedAt
    ? Math.max(
        0,
        Math.floor((now.getTime() - new Date(oldestCreatedAt).getTime()) / 1000)
      )
    : null;

  return {
    pendingCount,
    failedCount,
    deadLetterCount,
    oldestUnpublishedCreatedAt: oldestCreatedAt,
    oldestUnpublishedAgeSeconds: oldestAgeSeconds,
    failedJobCount,
    retryCount,
    publishedCount,
    averagePublishLatencyMs:
      publishLatencies.length > 0
        ? Math.round(
            publishLatencies.reduce((sum, item) => sum + item, 0) /
              publishLatencies.length
          )
        : null,
    maxPublishLatencyMs:
      publishLatencies.length > 0 ? Math.max(...publishLatencies) : null,
    workloadDistribution: [...distribution.entries()].map(
      ([workloadCategory, counts]) => ({
        workloadCategory,
        ...counts,
      })
    ),
  };
}

export async function getWorkerObservabilitySummary(
  now = new Date()
): Promise<WorkerObservabilitySummary> {
  const thresholds = getWorkerObservabilityThresholds();
  const [storedHeartbeats, recentMetrics, recentFailures] = await Promise.all([
    listWorkerHeartbeats(100),
    listRecentWorkerProcessingMetrics(100),
    listRecentWorkerFailures(100),
  ]);
  const heartbeats =
    storedHeartbeats.length > 0
      ? storedHeartbeats
      : (await listRecentJobRuns({ limit: 25 })).map((jobRun) => ({
          id: jobRun.id,
          workerName: jobRun.jobName,
          workloadCategory: "REPORTING_LOW_PRIORITY" as const,
          instanceId: jobRun.id,
          status:
            jobRun.status === "FAILED"
              ? ("DEGRADED" as const)
              : jobRun.status === "STARTED"
                ? ("ACTIVE" as const)
                : ("IDLE" as const),
          lastSeenAt: jobRun.finishedAt ?? jobRun.startedAt,
          metadata: {
            derivedFromJobRun: true,
            jobRunStatus: jobRun.status,
            correlationId: jobRun.correlationId,
          },
          createdAt: jobRun.startedAt,
          updatedAt: jobRun.finishedAt ?? null,
        }));
  const staleWorkers = heartbeats.filter(
    (heartbeat) =>
      now.getTime() - new Date(heartbeat.lastSeenAt).getTime() >
      thresholds.heartbeatStaleSeconds * 1000
  );

  return {
    generatedAt: now.toISOString(),
    heartbeats,
    recentMetrics,
    recentFailures,
    staleWorkers,
  };
}

function classifyLag({
  outbox,
  queues,
  workers,
}: {
  outbox: OutboxObservabilitySummary;
  queues: RabbitMqQueueHealth[];
  workers: WorkerHeartbeat[];
}): LagClassification {
  const thresholds = getWorkerObservabilityThresholds();
  const reasons: string[] = [];
  let severity: LagClassification["severity"] = "HEALTHY";

  function raise(next: LagClassification["severity"], reason: string) {
    reasons.push(reason);

    if (next === "CRITICAL") {
      severity = "CRITICAL";
      return;
    }

    if (next === "WARNING" && severity === "HEALTHY") {
      severity = "WARNING";
      return;
    }

    if (next === "DEGRADED" && severity === "HEALTHY") {
      severity = "DEGRADED";
    }
  }

  if (outbox.deadLetterCount > 0) {
    raise("CRITICAL", "Outbox has dead-lettered events.");
  }

  if (
    outbox.oldestUnpublishedAgeSeconds !== null &&
    outbox.oldestUnpublishedAgeSeconds >= thresholds.outboxCriticalAgeSeconds
  ) {
    raise("CRITICAL", "Oldest unpublished outbox event exceeds critical age.");
  } else if (
    outbox.oldestUnpublishedAgeSeconds !== null &&
    outbox.oldestUnpublishedAgeSeconds >= thresholds.outboxWarningAgeSeconds
  ) {
    raise("WARNING", "Oldest unpublished outbox event exceeds warning age.");
  }

  for (const queue of queues) {
    if (!queue.available) {
      raise("DEGRADED", `${queue.category} queue metrics are unavailable.`);
      continue;
    }

    if ((queue.deadLetterMessagesReady ?? 0) > 0) {
      raise("CRITICAL", `${queue.category} DLQ has ready messages.`);
    }

    if (
      queue.category === "CRITICAL_FINANCIAL" &&
      (queue.messagesReady ?? 0) >= thresholds.criticalQueueCriticalReadyCount
    ) {
      raise("CRITICAL", "Critical financial queue backlog exceeds threshold.");
    } else if ((queue.messagesReady ?? 0) >= thresholds.queueWarningReadyCount) {
      raise("WARNING", `${queue.category} queue backlog exceeds warning threshold.`);
    }
  }

  const activeWorkers = workers.filter((worker) => worker.status === "ACTIVE");

  if (workers.length > 0 && activeWorkers.length === 0) {
    raise("WARNING", "Worker heartbeats exist but no worker is active.");
  }

  return {
    severity,
    reasons,
    thresholds,
  };
}

export async function getOperationsMetricsSummary(): Promise<OperationsMetricsSummary> {
  const now = new Date();
  const [queueHealth, outbox, workers] = await Promise.all([
    getQueueHealthSummary(),
    getOutboxObservabilitySummary(now),
    getWorkerObservabilitySummary(now),
  ]);

  return {
    generatedAt: now.toISOString(),
    outbox,
    queues: queueHealth.rabbitmq,
    workers,
    lag: classifyLag({
      outbox,
      queues: queueHealth.rabbitmq,
      workers: workers.heartbeats,
    }),
    bestEffortMetrics: true,
  };
}
