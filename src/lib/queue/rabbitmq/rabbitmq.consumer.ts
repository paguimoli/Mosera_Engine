import * as amqp from "amqplib";
import type { ChannelModel, ConfirmChannel, ConsumeMessage } from "amqplib";

import {
  getWorkerInstanceId,
  safeRecordWorkerFailure,
  safeRecordWorkerHeartbeat,
  safeRecordWorkerProcessingMetric,
} from "@/src/domains/operations/worker-observability.service";
import { isRetryablePostgresError } from "@/src/lib/database/resilient-postgres-pool";
import { logger } from "@/src/lib/observability/logger";
import {
  CANONICAL_EVENT_CONTRACT_VERSION,
  type QueueMessage,
} from "../queue.types";
import { getRabbitMqQueueConfig } from "./rabbitmq.config";
import type { RabbitMqRouting } from "./rabbitmq.routing";

export type RabbitMqMessageHandler = (
  message: QueueMessage,
  rawMessage: ConsumeMessage
) => Promise<void>;

type ClassifiedWorkerError = Error & {
  readonly workerClassification?: string;
  readonly retryable?: boolean;
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown RabbitMQ error.";
}

function getMessageMetadata(rawMessage: ConsumeMessage, message?: QueueMessage) {
  return {
    eventType:
      message?.type ?? String(rawMessage.properties.headers?.eventType ?? ""),
    aggregateType:
      message?.aggregateType ??
      String(rawMessage.properties.headers?.aggregateType ?? ""),
    aggregateId:
      message?.aggregateId ??
      String(rawMessage.properties.headers?.aggregateId ?? ""),
    routingKey: rawMessage.fields.routingKey,
    correlationId:
      message?.correlationId ?? rawMessage.properties.correlationId ?? null,
  };
}

function getPositiveNumberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);

  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getConsumerPrefetch(workloadCategory: string) {
  const categoryName = `WORKER_RABBITMQ_PREFETCH_${workloadCategory}`;
  const configured = getPositiveNumberEnv(
    categoryName,
    getPositiveNumberEnv("WORKER_RABBITMQ_PREFETCH", 1)
  );
  return Math.min(32, Math.max(1, Math.floor(configured)));
}

function getConsumerExecutionConcurrency(workloadCategory: string, prefetch: number) {
  const categoryName = `WORKER_EXECUTION_CONCURRENCY_${workloadCategory}`;
  const configured = getPositiveNumberEnv(
    categoryName,
    getPositiveNumberEnv("WORKER_EXECUTION_CONCURRENCY", prefetch)
  );
  return Math.min(prefetch, Math.min(32, Math.max(1, Math.floor(configured))));
}

class AsyncExecutionGate {
  private readonly capacity: number;
  private available: number;
  private readonly waiting: Array<() => void> = [];

  constructor(capacity: number) {
    this.capacity = capacity;
    this.available = capacity;
  }

  async acquire(): Promise<() => void> {
    if (this.available === 0) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.available -= 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.available += 1;
    };
  }

  snapshot() {
    return {
      active: this.capacity - this.available,
      waiting: this.waiting.length,
      capacity: this.capacity,
    };
  }
}

export class RabbitMqQueueConsumer {
  private connection: ChannelModel | null = null;
  private channel: ConfirmChannel | null = null;
  private heartbeatIntervals = new Set<ReturnType<typeof setInterval>>();
  private disconnectPromise: Promise<void> = Promise.resolve();

  async consume({
    routing,
    handler,
    onGovernedRecoveryRequired,
    workerName,
    instanceId,
  }: {
    routing: RabbitMqRouting;
    handler: RabbitMqMessageHandler;
    onGovernedRecoveryRequired?: (message: QueueMessage, reason: string) => Promise<void>;
    workerName?: string;
    instanceId?: string;
  }): Promise<void> {
    const channel = await this.getChannel();
    const config = getRabbitMqQueueConfig();
    const resolvedWorkerName = workerName ?? routing.workloadCategory.toLowerCase();
    const resolvedInstanceId =
      instanceId ?? getWorkerInstanceId(resolvedWorkerName);

    await channel.assertExchange(routing.exchange, "topic", {
      durable: config.durable,
    });
    await channel.assertQueue(routing.deadLetterQueue, {
      durable: config.durable,
    });
    await channel.assertQueue(routing.queue, {
      durable: config.durable,
      deadLetterExchange: "",
      deadLetterRoutingKey: routing.deadLetterQueue,
    });
    for (const bindingKey of routing.bindingKeys) {
      await channel.bindQueue(routing.queue, routing.exchange, bindingKey);
    }
    const prefetch = getConsumerPrefetch(routing.workloadCategory);
    const executionConcurrency = getConsumerExecutionConcurrency(
      routing.workloadCategory,
      prefetch
    );
    const executionGate = new AsyncExecutionGate(executionConcurrency);
    await channel.prefetch(prefetch);
    await safeRecordWorkerHeartbeat({
      workerName: resolvedWorkerName,
      workloadCategory: routing.workloadCategory,
      instanceId: resolvedInstanceId,
      status: "ACTIVE",
      metadata: {
        queue: routing.queue,
        routingKey: routing.routingKey,
        prefetch,
        executionConcurrency,
      },
    });
    const heartbeatInterval = setInterval(() => {
      const execution = executionGate.snapshot();
      void safeRecordWorkerHeartbeat({
        workerName: resolvedWorkerName,
        workloadCategory: routing.workloadCategory,
        instanceId: resolvedInstanceId,
        status: "ACTIVE",
        metadata: {
          queue: routing.queue,
          routingKey: routing.routingKey,
          prefetch,
          executionConcurrency,
          activeHandlers: execution.active,
          waitingHandlers: execution.waiting,
          idle: execution.active === 0 && execution.waiting === 0,
        },
      });
    }, getPositiveNumberEnv("WORKER_HEARTBEAT_INTERVAL_MS", 30000));
    this.heartbeatIntervals.add(heartbeatInterval);

    await channel.consume(
      routing.queue,
      async (rawMessage) => {
        if (!rawMessage) {
          return;
        }

        const transportReceivedAt = new Date().toISOString();
        let message: QueueMessage;

        const parseStartedAt = Date.now();

        try {
          message = JSON.parse(
            rawMessage.content.toString()
          ) as QueueMessage;
          if (
            !message.id?.trim() ||
            message.contractVersion !== CANONICAL_EVENT_CONTRACT_VERSION ||
            message.idempotencyKey !== message.id ||
            !message.occurredAt
          ) {
            throw new Error("Canonical event envelope is incomplete or unsupported.");
          }
          const transportPublishedAt =
            rawMessage.properties.headers?.["x-mosera-published-at"];
          if (typeof transportPublishedAt === "string") {
            message.transportPublishedAt = transportPublishedAt;
          }
          const transportDispatcherSeenAt =
            rawMessage.properties.headers?.["x-mosera-dispatcher-seen-at"];
          if (typeof transportDispatcherSeenAt === "string") {
            message.transportDispatcherSeenAt = transportDispatcherSeenAt;
          }
          const transportPublishStartedAt =
            rawMessage.properties.headers?.["x-mosera-publish-started-at"];
          if (typeof transportPublishStartedAt === "string") {
            message.transportPublishStartedAt = transportPublishStartedAt;
          }
          message.transportReceivedAt = transportReceivedAt;
          message.transportConsumerCallbackEnteredAt = transportReceivedAt;
          message.transportConsumerInstanceId = resolvedInstanceId;
          message.transportConsumerPrefetch = prefetch;
          message.transportConsumerExecutionConcurrency = executionConcurrency;
        } catch (error) {
          const metadata = getMessageMetadata(rawMessage);

          logger.error({
            message: "RabbitMQ message parse failed.",
            correlationId: metadata.correlationId,
            metadata: {
              ...metadata,
              error: getErrorMessage(error),
            },
          });

          channel.nack(rawMessage, false, false);
          await safeRecordWorkerFailure({
            workerName: resolvedWorkerName,
            workloadCategory: routing.workloadCategory,
            eventType: metadata.eventType || "unknown",
            entityId: metadata.aggregateId || null,
            correlationId: metadata.correlationId,
            errorCode: "MESSAGE_PARSE_FAILED",
            errorMessage: getErrorMessage(error),
            metadata,
          });
          await safeRecordWorkerProcessingMetric({
            workerName: resolvedWorkerName,
            workloadCategory: routing.workloadCategory,
            eventType: metadata.eventType || "unknown",
            failedCount: 1,
            totalProcessingMs: Date.now() - parseStartedAt,
            maxProcessingMs: Date.now() - parseStartedAt,
          });
          logger.warn({
            message: "RabbitMQ message rejected.",
            correlationId: metadata.correlationId,
            metadata,
          });
          return;
        }

        const metadata = getMessageMetadata(rawMessage, message);
        const startedAt = Date.now();

        logger.info({
          message: "RabbitMQ message received.",
          correlationId: metadata.correlationId,
          metadata,
        });

        try {
          const slotRequestedAt = new Date();
          message.transportExecutionSlotRequestedAt = slotRequestedAt.toISOString();
          const release = await executionGate.acquire();
          const slotAcquiredAt = new Date();
          const executionAtStart = executionGate.snapshot();
          message.transportExecutionSlotAcquiredAt = slotAcquiredAt.toISOString();
          message.transportHandlerStartedAt = slotAcquiredAt.toISOString();
          message.transportActiveHandlersAtStart = executionAtStart.active;
          message.transportWaitingHandlersAtStart = executionAtStart.waiting;
          try {
            await handler(message, rawMessage);
          } finally {
            release();
          }
          channel.ack(rawMessage);
          const processingMs = Date.now() - startedAt;
          const executionAfterAck = executionGate.snapshot();

          await safeRecordWorkerHeartbeat({
            workerName: resolvedWorkerName,
            workloadCategory: routing.workloadCategory,
            instanceId: resolvedInstanceId,
            status: "ACTIVE",
            metadata: {
              lastSuccessfulEventAt: new Date().toISOString(),
              eventType: message.type,
              prefetch,
              executionConcurrency,
              activeHandlers: executionAfterAck.active,
              waitingHandlers: executionAfterAck.waiting,
            },
          });
          await safeRecordWorkerProcessingMetric({
            workerName: resolvedWorkerName,
            workloadCategory: routing.workloadCategory,
            eventType: message.type,
            processedCount: 1,
            totalProcessingMs: processingMs,
            maxProcessingMs: processingMs,
          });
          logger.info({
            message: "RabbitMQ message acknowledged.",
            correlationId: metadata.correlationId,
            metadata: {
              ...metadata,
              callbackToSlotRequestMs:
                slotRequestedAt.getTime() - new Date(transportReceivedAt).getTime(),
              executionAdmissionMs:
                slotAcquiredAt.getTime() - slotRequestedAt.getTime(),
              handlerAndAckMs: Date.now() - slotAcquiredAt.getTime(),
              activeHandlersAtStart: executionAtStart.active,
              waitingHandlersAtStart: executionAtStart.waiting,
              prefetch,
              executionConcurrency,
            },
          });
        } catch (error) {
          const classified = error as ClassifiedWorkerError;
          const retryable =
            classified.retryable === true || isRetryablePostgresError(error);
          const retryCount = Number(rawMessage.properties.headers?.["x-mosera-retry-count"] ?? 0);
          const maxRetries = getPositiveNumberEnv("WORKER_CANONICAL_RETRY_LIMIT", 5);
          if (retryable && retryCount < maxRetries) {
            const nextRetryCount = retryCount + 1;
            const delayMs = Math.min(2_000, 250 * nextRetryCount);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            channel.publish(
              rawMessage.fields.exchange || routing.exchange,
              rawMessage.fields.routingKey,
              rawMessage.content,
              {
                ...rawMessage.properties,
                persistent: true,
                headers: {
                  ...(rawMessage.properties.headers ?? {}),
                  "x-mosera-retry-count": nextRetryCount,
                  "x-mosera-original-event-id": message.id,
                },
              }
            );
            await channel.waitForConfirms();
            channel.ack(rawMessage);
            logger.warn({
              message: "RabbitMQ transient event scheduled for bounded retry.",
              correlationId: metadata.correlationId,
              metadata: {
                ...metadata,
                retryCount: nextRetryCount,
                retryLimit: maxRetries,
                error: getErrorMessage(error),
              },
            });
            return;
          }

          if (retryable) {
            await onGovernedRecoveryRequired?.(message, getErrorMessage(error));
            channel.ack(rawMessage);
            logger.error({
              message: "RabbitMQ bounded retries exhausted; event requires governed recovery.",
              correlationId: metadata.correlationId,
              metadata: {
                ...metadata,
                retryCount,
                retryLimit: maxRetries,
                classification: "GOVERNED_RECOVERY_REQUIRED",
                error: getErrorMessage(error),
              },
            });
            return;
          }

          logger.error({
            message: "RabbitMQ message handler failed.",
            correlationId: metadata.correlationId,
            metadata: {
              ...metadata,
              error: getErrorMessage(error),
            },
          });

          channel.nack(rawMessage, false, false);
          const processingMs = Date.now() - startedAt;

          await safeRecordWorkerHeartbeat({
            workerName: resolvedWorkerName,
            workloadCategory: routing.workloadCategory,
            instanceId: resolvedInstanceId,
            status: "DEGRADED",
            metadata: {
              lastFailureAt: new Date().toISOString(),
              eventType: message.type,
            },
          });
          await safeRecordWorkerProcessingMetric({
            workerName: resolvedWorkerName,
            workloadCategory: routing.workloadCategory,
            eventType: message.type,
            failedCount: 1,
            retryCount: 1,
            totalProcessingMs: processingMs,
            maxProcessingMs: processingMs,
          });
          await safeRecordWorkerFailure({
            workerName: resolvedWorkerName,
            workloadCategory: routing.workloadCategory,
            eventType: message.type,
            entityId: message.aggregateId ?? null,
            correlationId: message.correlationId ?? null,
            errorMessage: getErrorMessage(error),
            metadata: {
              queue: routing.queue,
              routingKey: rawMessage.fields.routingKey,
            },
          });
          logger.warn({
            message: "RabbitMQ message rejected.",
            correlationId: metadata.correlationId,
            metadata,
          });
        }
      },
      {
        noAck: false,
      }
    );
  }

  async close(): Promise<void> {
    for (const heartbeatInterval of this.heartbeatIntervals) {
      clearInterval(heartbeatInterval);
    }
    this.heartbeatIntervals.clear();

    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
    this.channel = null;
    this.connection = null;
  }

  waitForDisconnect(): Promise<void> {
    return this.disconnectPromise;
  }

  private async getChannel(): Promise<ConfirmChannel> {
    if (this.channel) {
      return this.channel;
    }

    const config = getRabbitMqQueueConfig();

    if (!config.connectionUrl) {
      throw new Error("RabbitMQ connection URL is not configured.");
    }

    const connection = await amqp.connect(config.connectionUrl);
    this.disconnectPromise = new Promise((resolve) => {
      let disconnected = false;
      const markDisconnected = () => {
        if (disconnected) return;
        disconnected = true;
        resolve();
      };
      connection.on("error", (error) => {
        logger.warn({
          message: "RabbitMQ consumer connection error.",
          metadata: { error: getErrorMessage(error) },
        });
        markDisconnected();
      });
      connection.on("close", markDisconnected);
    });
    this.connection = connection;
    this.channel = await connection.createConfirmChannel();

    return this.channel;
  }
}
