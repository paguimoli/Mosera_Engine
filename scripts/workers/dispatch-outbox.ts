import {
  getWorkerInstanceId,
  safeRecordWorkerFailure,
  safeRecordWorkerHeartbeat,
} from "@/src/domains/operations/worker-observability.service";
import { dispatchPendingOutboxEvents } from "@/src/domains/workers/outbox-dispatcher.service";
import { createCorrelationId } from "@/src/lib/observability/correlation";
import { logger } from "@/src/lib/observability/logger";

const workerName = "outbox_dispatcher";
const workloadCategory = "REPORTING_LOW_PRIORITY" as const;
const instanceId = getWorkerInstanceId(workerName);

function getPositiveNumberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);

  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const batchSize = getPositiveNumberEnv("OUTBOX_DISPATCH_BATCH_SIZE", 50);
const idleIntervalMs = getPositiveNumberEnv(
  "OUTBOX_DISPATCH_IDLE_INTERVAL_MS",
  5000
);
const backlogIntervalMs = getPositiveNumberEnv(
  "OUTBOX_DISPATCH_BACKLOG_INTERVAL_MS",
  250
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
  logger.info({
    message: "Continuous outbox dispatcher starting.",
    metadata: {
      batchSize,
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
        const startedAt = Date.now();
        const result = await dispatchPendingOutboxEvents({
          limit: batchSize,
          correlationId,
        });
        const dispatchDurationMs = Date.now() - startedAt;

        await recordHeartbeat({
          lifecycle: "dispatch-cycle-complete",
          correlationId,
          dispatchDurationMs,
          ...result,
        });

        await sleep(result.processed > 0 ? backlogIntervalMs : idleIntervalMs);
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
        await sleep(idleIntervalMs);
      }
    }
  } finally {
    clearInterval(heartbeat);
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
