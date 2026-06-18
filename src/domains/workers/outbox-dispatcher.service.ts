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
import { resolveQueueTopologyForEvent } from "@/src/lib/queue/queue-topology";
import {
  listDispatchableOutboxEvents,
  markOutboxEventDeadLetter,
  markOutboxEventFailed,
  markOutboxEventPublished,
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
  now?: Date;
  correlationId?: string;
  publisher?: QueuePublisher;
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown publish error.";
}

async function publishOutboxEvent(
  event: OutboxEvent,
  publisher: QueuePublisher
) {
  await publisher.publish({
    id: event.id,
    type: event.eventType,
    payload: event.payload,
    correlationId: event.correlationId ?? null,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
  });
}

export async function dispatchPendingOutboxEvents(
  options: DispatchPendingOutboxEventsOptions = {}
): Promise<OutboxDispatchResult> {
  const now = options.now ?? new Date();
  const correlationId = options.correlationId ?? createCorrelationId();
  const publisher = options.publisher ?? createQueuePublisher();
  const workerName = "outbox_dispatcher";
  const instanceId = getWorkerInstanceId(workerName);

  try {
    return await runTrackedJob({
      jobName: workerName,
      correlationId,
      metadata: {
        limit: options.limit ?? 25,
        now: now.toISOString(),
      },
      execute: async () => {
        logger.info({
          message: "Outbox dispatcher started.",
          correlationId,
          metadata: {
            limit: options.limit ?? 25,
          },
        });
        await safeRecordWorkerHeartbeat({
          workerName,
          workloadCategory: "REPORTING_LOW_PRIORITY",
          instanceId,
          status: "ACTIVE",
          metadata: {
            limit: options.limit ?? 25,
          },
        });

        const events = await listDispatchableOutboxEvents({
          limit: options.limit ?? 25,
          now: now.toISOString(),
        });

        const result: OutboxDispatchResult = {
          processed: 0,
          published: 0,
          failed: 0,
          deadLettered: 0,
        };

        for (const event of events) {
          result.processed += 1;
          const topology = resolveQueueTopologyForEvent(event.eventType);
          const startedAt = Date.now();

          try {
            await publishOutboxEvent(event, publisher);
            await markOutboxEventPublished({
              id: event.id,
              publishedAt: now.toISOString(),
            });
            result.published += 1;
            const processingMs = Date.now() - startedAt;

            await safeRecordWorkerHeartbeat({
              workerName,
              workloadCategory: topology.category,
              instanceId,
              status: "ACTIVE",
              metadata: {
                lastSuccessfulEventAt: new Date().toISOString(),
                eventType: event.eventType,
              },
            });
            await safeRecordWorkerProcessingMetric({
              workerName,
              workloadCategory: topology.category,
              eventType: event.eventType,
              processedCount: 1,
              totalProcessingMs: processingMs,
              maxProcessingMs: processingMs,
            });

            logger.info({
              message: "Outbox event published.",
              correlationId: event.correlationId ?? correlationId,
              metadata: {
                outboxEventId: event.id,
                eventType: event.eventType,
                aggregateType: event.aggregateType,
                aggregateId: event.aggregateId,
                workloadCategory: topology.category,
                routingKey: topology.routingKey,
                queue: topology.queueName,
              },
            });
          } catch (error) {
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

              continue;
            }

            const nextAttemptAt = calculateOutboxNextAttemptAt(
              event.eventType,
              attemptCount,
              now
            );

            await markOutboxEventFailed({
              id: event.id,
              attemptCount,
              lastError: errorMessage,
              nextAttemptAt: nextAttemptAt?.toISOString() ?? null,
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
          }
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
      },
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
