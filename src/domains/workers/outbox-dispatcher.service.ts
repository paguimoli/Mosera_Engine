import { createCorrelationId } from "@/src/lib/observability/correlation";
import { logger } from "@/src/lib/observability/logger";
import { createQueuePublisher } from "@/src/lib/queue/queue.publisher-factory";
import type { QueuePublisher } from "@/src/lib/queue/queue.types";
import {
  listDispatchableOutboxEvents,
  markOutboxEventDeadLetter,
  markOutboxEventFailed,
  markOutboxEventPublished,
} from "../outbox/outbox.service";
import type { OutboxEvent } from "../outbox/outbox.types";
import { runTrackedJob } from "./job-executor.service";
import {
  calculateNextAttemptAt,
  shouldDeadLetter,
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

  try {
    return await runTrackedJob({
      jobName: "outbox_dispatcher",
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

          try {
            await publishOutboxEvent(event, publisher);
            await markOutboxEventPublished({
              id: event.id,
              publishedAt: now.toISOString(),
            });
            result.published += 1;

            logger.info({
              message: "Outbox event published.",
              correlationId: event.correlationId ?? correlationId,
              metadata: {
                outboxEventId: event.id,
                eventType: event.eventType,
                aggregateType: event.aggregateType,
                aggregateId: event.aggregateId,
              },
            });
          } catch (error) {
            const attemptCount = event.attemptCount + 1;
            const errorMessage = getErrorMessage(error);

            if (shouldDeadLetter(attemptCount)) {
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
                  error: errorMessage,
                },
              });

              continue;
            }

            const nextAttemptAt = calculateNextAttemptAt(attemptCount, now);

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
