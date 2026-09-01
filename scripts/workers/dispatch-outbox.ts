import {
  getWorkerInstanceId,
  safeRecordWorkerFailure,
  safeRecordWorkerHeartbeat,
} from "@/src/domains/operations/worker-observability.service";
import { dispatchPendingOutboxEvents } from "@/src/domains/workers/outbox-dispatcher.service";
import { wakeSettlementOutboxAfterBrokerRecovery } from "@/src/domains/outbox/outbox.service";
import { createCorrelationId } from "@/src/lib/observability/correlation";
import { logger } from "@/src/lib/observability/logger";
import { createQueuePublisher } from "@/src/lib/queue/queue.publisher-factory";
import {
  closeCompiledWorkerRuntimePool,
  recordCompiledWorkerRuntime,
  startCompiledWorkerHeartbeat,
} from "@/src/domains/workers/worker-runtime-readiness";
import { closeSharedWorkerPostgresPool } from "@/src/lib/database/resilient-postgres-pool";

const workerName = "outbox_dispatcher";
const workloadCategory = "REPORTING_LOW_PRIORITY" as const;
const instanceId = getWorkerInstanceId(workerName);

function getPositiveNumberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);

  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const batchSize = getPositiveNumberEnv("OUTBOX_DISPATCH_BATCH_SIZE", 250);
const dispatchConcurrency = Math.min(
  32,
  getPositiveNumberEnv("OUTBOX_DISPATCH_CONCURRENCY", 16)
);
const idleIntervalMs = getPositiveNumberEnv(
  "OUTBOX_DISPATCH_IDLE_INTERVAL_MS",
  250
);
const backlogIntervalMs = getPositiveNumberEnv(
  "OUTBOX_DISPATCH_BACKLOG_INTERVAL_MS",
  10
);
const heartbeatIntervalMs = getPositiveNumberEnv(
  "WORKER_HEARTBEAT_INTERVAL_MS",
  30000
);

let shutdownRequested = false;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown dispatcher error.";
}

async function recordHeartbeat(metadata: Record<string, unknown> = {}) {
  await safeRecordWorkerHeartbeat({
    workerName,
    workloadCategory,
    instanceId,
    status: "ACTIVE",
    metadata: {
      mode: "continuous",
      batchSize,
      dispatchConcurrency,
      idleIntervalMs,
      backlogIntervalMs,
      ...metadata,
    },
  });
}

function requestShutdown(signal: NodeJS.Signals) {
  shutdownRequested = true;
  logger.info({
    message: "Continuous outbox dispatcher shutdown requested.",
    metadata: { signal },
  });
}

process.once("SIGTERM", requestShutdown);
process.once("SIGINT", requestShutdown);

async function main() {
  await recordCompiledWorkerRuntime({
    componentName: "outbox-dispatcher",
    status: "READY",
    metadata: { workloadCategory },
  });
  const stopRuntimeHeartbeat = startCompiledWorkerHeartbeat({
    componentName: "outbox-dispatcher",
    metadata: { workloadCategory },
  });
  const publisher = createQueuePublisher();
  logger.info({
    message: "Continuous outbox dispatcher starting.",
    metadata: {
      batchSize,
      dispatchConcurrency,
      idleIntervalMs,
      backlogIntervalMs,
      heartbeatIntervalMs,
      instanceId,
    },
  });

  await recordHeartbeat({ lifecycle: "started" });
  const heartbeat = setInterval(() => {
    void recordHeartbeat({ lifecycle: "idle-heartbeat" });
  }, heartbeatIntervalMs);

  try {
    while (!shutdownRequested) {
      const correlationId = createCorrelationId();

      try {
        const readiness = await publisher.probeReadiness?.([
          "settlement.requested",
        ]);
        if (readiness && !readiness.ready) {
          await safeRecordWorkerHeartbeat({
            workerName,
            workloadCategory: "SETTLEMENT",
            instanceId,
            status: "DEGRADED",
            metadata: {
              lifecycle: "broker-unavailable",
              unavailableSince: readiness.unavailableSince,
              consecutiveFailures: readiness.consecutiveFailures,
              retryAfterMs: readiness.retryAfterMs,
              error: readiness.error,
            },
          });
          await sleep(Math.max(idleIntervalMs, readiness.retryAfterMs));
          continue;
        }
        if (readiness?.recovered) {
          const recoveredAt = new Date();
          const wokenSettlementEvents =
            await wakeSettlementOutboxAfterBrokerRecovery(recoveredAt);
          logger.info({
            message: "RabbitMQ Settlement transport recovered.",
            correlationId,
            metadata: {
              recoveredAt: recoveredAt.toISOString(),
              wokenSettlementEvents,
            },
          });
        }
        const startedAt = Date.now();
        const result = await dispatchPendingOutboxEvents({
          limit: batchSize,
          concurrency: dispatchConcurrency,
          correlationId,
          publisher,
        });
        const dispatchDurationMs = Date.now() - startedAt;
        await recordCompiledWorkerRuntime({
          componentName: "outbox-dispatcher",
          status: "READY",
          metadata: { workloadCategory, lifecycle: "dispatch-cycle-complete" },
        });

        await recordHeartbeat({
          lifecycle: "dispatch-cycle-complete",
          correlationId,
          dispatchDurationMs,
          ...result,
        });

        if (result.processed < batchSize) {
          await sleep(result.processed > 0 ? backlogIntervalMs : idleIntervalMs);
        }
      } catch (error) {
        const errorMessage = getErrorMessage(error);

        logger.error({
          message: "Continuous outbox dispatcher cycle failed.",
          correlationId,
          metadata: { error: errorMessage },
        });
        await safeRecordWorkerFailure({
          workerName,
          workloadCategory,
          eventType: "outbox.dispatch",
          correlationId,
          errorCode: "OUTBOX_DISPATCH_CYCLE_FAILED",
          errorMessage,
          metadata: {
            mode: "continuous",
            batchSize,
            dispatchConcurrency,
          },
        });
        await safeRecordWorkerHeartbeat({
          workerName,
          workloadCategory,
          instanceId,
          status: "DEGRADED",
          metadata: {
            lifecycle: "dispatch-cycle-failed",
            correlationId,
            error: errorMessage,
          },
        });
        await recordCompiledWorkerRuntime({
          componentName: "outbox-dispatcher",
          status: "DEGRADED",
          metadata: {
            workloadCategory,
            lifecycle: "dispatch-cycle-failed",
            error: errorMessage,
          },
        }).catch(() => undefined);
        await sleep(idleIntervalMs);
      }
    }
  } finally {
    clearInterval(heartbeat);
    await publisher.close?.();
    await stopRuntimeHeartbeat();
    await closeCompiledWorkerRuntimePool();
    await closeSharedWorkerPostgresPool();
    await safeRecordWorkerHeartbeat({
      workerName,
      workloadCategory,
      instanceId,
      status: "STOPPED",
      metadata: {
        lifecycle: "stopped",
        mode: "continuous",
      },
    });
    logger.info({
      message: "Continuous outbox dispatcher stopped.",
      metadata: { instanceId },
    });
  }
}

main().catch((error) => {
  logger.error({
    message: "Continuous outbox dispatcher crashed.",
    metadata: { error: getErrorMessage(error) },
  });
  process.exit(1);
});
