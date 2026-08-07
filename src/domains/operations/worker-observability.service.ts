import { logger } from "@/src/lib/observability/logger";
import os from "node:os";
import {
  classifyOutboxEventType,
  listQueueTopology,
  type QueueWorkloadCategory,
} from "@/src/lib/queue/queue-topology";
import { getQueueHealthSummary } from "./queue-health.service";
import type { RabbitMqQueueHealth } from "./queue-health.types";
import {
  insertWorkerFailure,
  insertWorkerProcessingMetric,
  getOutboxObservabilitySnapshot,
  listFreshWorkerHeartbeats,
  listRecentWorkerFailures,
  listRecentWorkerProcessingMetrics,
  listStaleWorkerHeartbeats,
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

const processStartedAt = new Date();

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

function getMetadataString(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];

  return typeof value === "string" ? value : null;
}

function getMetadataNumber(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];

  return typeof value === "number" ? value : null;
}

export async function safeRecordWorkerHeartbeat(
  input: RecordWorkerHeartbeatInput
) {
  try {
    await upsertWorkerHeartbeat({
      ...input,
      metadata: {
        workerVersion:
          process.env.WORKER_VERSION ?? process.env.npm_package_version ?? null,
        hostname: os.hostname(),
        processId: process.pid,
        processStartedAt: processStartedAt.toISOString(),
        uptimeSeconds: Math.floor(process.uptime()),
        ...(input.metadata ?? {}),
      },
    });
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

export async function getOutboxObservabilitySummary(
  now = new Date()
): Promise<OutboxObservabilitySummary> {
  const snapshot = await getOutboxObservabilitySnapshot();
  const {
    pendingCount,
    failedCount,
    deadLetterCount,
    publishedCount,
    failedJobCount,
    rows,
  } = snapshot;
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

  const oldestCreatedAt = snapshot.oldestCreatedAt;
  const oldestAgeSeconds = oldestCreatedAt
    ? Math.max(
        0,
        Math.floor((now.getTime() - new Date(oldestCreatedAt).getTime()) / 1000)
      )
    : null;
  const stalledPublisherDetected =
    oldestAgeSeconds !== null &&
    pendingCount > 0 &&
    oldestAgeSeconds >= getWorkerObservabilityThresholds().outboxCriticalAgeSeconds;
  const recommendation =
    deadLetterCount > 0 || failedCount > 0
      ? "ACTION_REQUIRED"
      : stalledPublisherDetected || oldestAgeSeconds !== null
        ? "WARNING"
        : "READY";

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
    dispatchLatency: {
      averageMs:
        publishLatencies.length > 0
          ? Math.round(
              publishLatencies.reduce((sum, item) => sum + item, 0) /
                publishLatencies.length
            )
          : null,
      maxMs: publishLatencies.length > 0 ? Math.max(...publishLatencies) : null,
    },
    oldestUnpublishedEvent: {
      createdAt: oldestCreatedAt,
      ageSeconds: oldestAgeSeconds,
    },
    stalledPublisher: {
      detected: stalledPublisherDetected,
      reason: stalledPublisherDetected
        ? "Oldest pending outbox event exceeds the critical publisher age threshold."
        : "No stalled publisher condition detected.",
    },
    recommendation,
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
  const staleCutoff = new Date(
    now.getTime() - thresholds.heartbeatStaleSeconds * 1000
  ).toISOString();
  const [
    storedFreshHeartbeats,
    storedStaleHeartbeats,
    recentMetrics,
    recentFailures,
  ] = await Promise.all([
    listFreshWorkerHeartbeats({ since: staleCutoff, limit: 50 }),
    listStaleWorkerHeartbeats({ before: staleCutoff, limit: 50 }),
    listRecentWorkerProcessingMetrics(100),
    listRecentWorkerFailures(100),
  ]);
  const heartbeats = [...storedFreshHeartbeats, ...storedStaleHeartbeats];
  const staleWorkers = storedStaleHeartbeats;
  const freshHeartbeats = storedFreshHeartbeats;
  const processedByWorkerName = new Map<string, number>();

  for (const metric of recentMetrics) {
    processedByWorkerName.set(
      metric.workerName,
      (processedByWorkerName.get(metric.workerName) ?? 0) + metric.processedCount
    );
  }
  const activeWorkerObserved = freshHeartbeats.some(
    (heartbeat) => heartbeat.status === "ACTIVE"
  );
  const processedJobs = recentMetrics.reduce(
    (sum, metric) => sum + metric.processedCount,
    0
  );

  return {
    generatedAt: now.toISOString(),
    heartbeats,
    freshHeartbeats,
    recentMetrics,
    recentFailures,
    staleWorkers,
    staleHeartbeatEvidence: staleWorkers,
    lastHeartbeat: heartbeats[0] ?? null,
    activeWorkerObserved,
    processedJobs,
    workerDetails: heartbeats.map((heartbeat) => ({
      workerName: heartbeat.workerName,
      instanceId: heartbeat.instanceId,
      workloadCategory: heartbeat.workloadCategory,
      status: heartbeat.status,
      lastSeenAt: heartbeat.lastSeenAt,
      workerVersion: getMetadataString(heartbeat.metadata, "workerVersion"),
      hostname: getMetadataString(heartbeat.metadata, "hostname"),
      uptimeSeconds: getMetadataNumber(heartbeat.metadata, "uptimeSeconds"),
      processedJobs: processedByWorkerName.get(heartbeat.workerName) ?? 0,
    })),
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
