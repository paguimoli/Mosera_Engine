import { createCorrelationId } from "@/src/lib/observability/correlation";
import { logger } from "@/src/lib/observability/logger";
import {
  getWorkerInstanceId,
  safeRecordWorkerFailure,
  safeRecordWorkerHeartbeat,
  safeRecordWorkerProcessingMetric,
} from "@/src/domains/operations/worker-observability.service";
import { createQueuePublisher } from "@/src/lib/queue/queue.publisher-factory";
import type { QueuePublisher } from "@/src/lib/queue/queue.types";
import { CANONICAL_EVENT_CONTRACT_VERSION } from "@/src/lib/queue/queue.types";
import {
  resolveQueueTopologyForEvent,
  type QueueWorkloadCategory,
} from "@/src/lib/queue/queue-topology";
import {
  listDispatchableOutboxEvents,
  markOutboxEventDeadLetter,
  markOutboxEventFailed,
  markOutboxEventsPublished,
} from "../outbox/outbox.service";
import type { OutboxEvent } from "../outbox/outbox.types";
import { runTrackedJob } from "./job-executor.service";
import {
  calculateOutboxNextAttemptAt,
  shouldDeadLetterOutboxEvent,
} from "./worker.retry-policy";
import type { OutboxDispatchResult } from "./worker.types";

type DispatchPendingOutboxEventsOptions = {
  limit?: number;
  concurrency?: number;
  now?: Date;
  correlationId?: string;
  publisher?: QueuePublisher;
};

function getDispatchConcurrency(configured?: number) {
  const value = configured ?? Number(process.env.OUTBOX_DISPATCH_CONCURRENCY ?? 16);
  return Number.isFinite(value) ? Math.max(1, Math.min(32, Math.floor(value))) : 16;
}

function getClaimLeaseMs() {
  const value = Number(process.env.OUTBOX_DISPATCH_CLAIM_LEASE_MS ?? 120_000);
  return Number.isFinite(value) ? Math.max(1_000, Math.min(600_000, Math.floor(value))) : 120_000;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown publish error.";
}

function toQueueMessage(event: OutboxEvent, dispatcherSeenAt?: string) {
  return {
    id: event.id,
    type: event.eventType,
    contractVersion: CANONICAL_EVENT_CONTRACT_VERSION,
    payload: event.payload,
    idempotencyKey: event.id,
    correlationId: event.correlationId ?? null,
    causationId:
      typeof event.payload.causationId === "string"
        ? event.payload.causationId
        : null,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    occurredAt: event.createdAt,
    transportDispatcherSeenAt: dispatcherSeenAt,
  };
}

async function publishOutboxEvent(
  event: OutboxEvent,
  publisher: QueuePublisher,
  dispatcherSeenAt?: string
) {
  await publisher.publish(toQueueMessage(event, dispatcherSeenAt));
}

export async function dispatchPendingOutboxEvents(
  options: DispatchPendingOutboxEventsOptions = {}
): Promise<OutboxDispatchResult> {
  const now = options.now ?? new Date();
  const correlationId = options.correlationId ?? createCorrelationId();
  const publisher = options.publisher ?? createQueuePublisher();
  const concurrency = getDispatchConcurrency(options.concurrency);
  const claimLeaseMs = getClaimLeaseMs();
  const workerName = "outbox_dispatcher";
  const instanceId = getWorkerInstanceId(workerName);

  const execute = async () => {
        logger.info({
          message: "Outbox dispatcher started.",
          correlationId,
          metadata: {
            limit: options.limit ?? 25,
            concurrency,
            claimLeaseMs,
          },
        });
        await safeRecordWorkerHeartbeat({
          workerName,
          workloadCategory: "REPORTING_LOW_PRIORITY",
          instanceId,
          status: "ACTIVE",
          metadata: {
            limit: options.limit ?? 25,
            concurrency,
            claimLeaseMs,
          },
        });

        const events = await listDispatchableOutboxEvents({
          limit: options.limit ?? 25,
          now: now.toISOString(),
          claimLeaseMs,
        });
        const dispatcherSeenAt = new Date().toISOString();

        const result: OutboxDispatchResult = {
          processed: 0,
          published: 0,
          failed: 0,
          deadLettered: 0,
        };
        const successfulMetrics = new Map<string, {
          eventType: string;
          workloadCategory: QueueWorkloadCategory;
          processedCount: number;
          totalProcessingMs: number;
          maxProcessingMs: number;
        }>();

        const recordSuccessfulEvent = (event: OutboxEvent, processingMs: number) => {
          const topology = resolveQueueTopologyForEvent(event.eventType);
          const metricKey = `${topology.category}:${event.eventType}`;
          const metric = successfulMetrics.get(metricKey) ?? {
            eventType: event.eventType,
            workloadCategory: topology.category,
            processedCount: 0,
            totalProcessingMs: 0,
            maxProcessingMs: 0,
          };
          metric.processedCount += 1;
          metric.totalProcessingMs += processingMs;
          metric.maxProcessingMs = Math.max(metric.maxProcessingMs, processingMs);
          successfulMetrics.set(metricKey, metric);
        };

        const recordFailedEvent = async (event: OutboxEvent, error: unknown, startedAt: number) => {
            const topology = resolveQueueTopologyForEvent(event.eventType);
            const attemptCount = event.attemptCount + 1;
            const errorMessage = getErrorMessage(error);
            const processingMs = Date.now() - startedAt;

            await safeRecordWorkerHeartbeat({
              workerName,
              workloadCategory: topology.category,
              instanceId,
              status: "DEGRADED",
              metadata: {
                lastFailureAt: new Date().toISOString(),
                eventType: event.eventType,
              },
            });
            await safeRecordWorkerProcessingMetric({
              workerName,
              workloadCategory: topology.category,
              eventType: event.eventType,
              failedCount: 1,
              retryCount: 1,
              totalProcessingMs: processingMs,
              maxProcessingMs: processingMs,
            });
            await safeRecordWorkerFailure({
              workerName,
              workloadCategory: topology.category,
              eventType: event.eventType,
              entityId: event.aggregateId,
              correlationId: event.correlationId ?? correlationId,
              errorMessage,
              metadata: {
                outboxEventId: event.id,
                aggregateType: event.aggregateType,
                attemptCount,
              },
            });

            if (shouldDeadLetterOutboxEvent(event.eventType, attemptCount)) {
              await markOutboxEventDeadLetter({
                id: event.id,
                attemptCount,
                lastError: errorMessage,
                claimUntil: event.nextAttemptAt,
              });
              result.deadLettered += 1;

              logger.error({
                message: "Outbox event dead-lettered.",
                correlationId: event.correlationId ?? correlationId,
                metadata: {
                  outboxEventId: event.id,
                  eventType: event.eventType,
                  attemptCount,
                  workloadCategory: topology.category,
                  queue: topology.queueName,
                  deadLetterQueue: topology.deadLetterQueueName,
                  error: errorMessage,
                },
              });

              return;
            }

            const nextAttemptAt = calculateOutboxNextAttemptAt(
              event.eventType,
              attemptCount,
              new Date()
            );

            await markOutboxEventFailed({
              id: event.id,
              attemptCount,
              lastError: errorMessage,
              nextAttemptAt: nextAttemptAt?.toISOString() ?? null,
              claimUntil: event.nextAttemptAt,
            });
            result.failed += 1;

            logger.warn({
              message: "Outbox event failed.",
              correlationId: event.correlationId ?? correlationId,
              metadata: {
                outboxEventId: event.id,
                eventType: event.eventType,
                attemptCount,
                nextAttemptAt: nextAttemptAt?.toISOString() ?? null,
                workloadCategory: topology.category,
                queue: topology.queueName,
                error: errorMessage,
              },
            });
        };

        const dispatchBatchSize = publisher.publishBatch ? Math.max(events.length, 1) : concurrency;
        for (let offset = 0; offset < events.length; offset += dispatchBatchSize) {
          const batch = events.slice(offset, offset + dispatchBatchSize);
          const startedAt = Date.now();
          result.processed += batch.length;
          try {
            if (publisher.publishBatch) {
              await publisher.publishBatch(
                batch.map((event) => toQueueMessage(event, dispatcherSeenAt))
              );
            } else {
              await Promise.all(batch.map((event) =>
                publishOutboxEvent(event, publisher, dispatcherSeenAt)));
            }
            const publishedAt = new Date().toISOString();
            const acknowledged = await markOutboxEventsPublished({
              ids: batch.map((event) => event.id),
              publishedAt,
              claimUntil: batch[0]?.nextAttemptAt,
            });
            if (acknowledged !== batch.length) {
              throw new Error(
                `Outbox claim lease changed before acknowledgement; expected ${batch.length}, acknowledged ${acknowledged}.`
              );
            }
            result.published += batch.length;
            const processingMs = Date.now() - startedAt;
            for (const event of batch) recordSuccessfulEvent(event, processingMs);
            logger.info({
              message: "Outbox batch published and acknowledged.",
              correlationId,
              metadata: {
                batchSize: batch.length,
                processingMs,
                firstOutboxEventId: batch[0]?.id,
                lastOutboxEventId: batch.at(-1)?.id,
              },
            });
          } catch (error) {
            await Promise.all(batch.map((event) => recordFailedEvent(event, error, startedAt)));
          }
        }

        for (const metric of successfulMetrics.values()) {
          await safeRecordWorkerHeartbeat({
            workerName,
            workloadCategory: metric.workloadCategory,
            instanceId,
            status: "ACTIVE",
            metadata: {
              lastSuccessfulEventAt: new Date().toISOString(),
              eventType: metric.eventType,
              processedCount: metric.processedCount,
            },
          });
          await safeRecordWorkerProcessingMetric({
            workerName,
            workloadCategory: metric.workloadCategory,
            eventType: metric.eventType,
            processedCount: metric.processedCount,
            totalProcessingMs: metric.totalProcessingMs,
            maxProcessingMs: metric.maxProcessingMs,
          });
        }

        logger.info({
          message: "Outbox dispatcher completed.",
          correlationId,
          metadata: result,
        });
        await safeRecordWorkerHeartbeat({
          workerName,
          workloadCategory: "REPORTING_LOW_PRIORITY",
          instanceId,
          status: "IDLE",
          metadata: result,
        });

        return result;
  };

  try {
    if (process.env.DATABASE_URL?.trim()) {
      return await execute();
    }
    return await runTrackedJob({
      jobName: workerName,
      correlationId,
      metadata: {
        limit: options.limit ?? 25,
        now: now.toISOString(),
      },
      execute,
    });
  } catch (error) {
    logger.error({
      message: "Outbox dispatcher crashed.",
      correlationId,
      metadata: {
        error: getErrorMessage(error),
      },
    });

    throw error;
  }
}
