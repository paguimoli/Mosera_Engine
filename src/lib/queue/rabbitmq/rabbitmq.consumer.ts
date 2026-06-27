import * as amqp from "amqplib";
import type { Channel, ChannelModel, ConsumeMessage } from "amqplib";

import {
  getWorkerInstanceId,
  safeRecordWorkerFailure,
  safeRecordWorkerHeartbeat,
  safeRecordWorkerProcessingMetric,
} from "@/src/domains/operations/worker-observability.service";
import { logger } from "@/src/lib/observability/logger";
import type { QueueMessage } from "../queue.types";
import { getRabbitMqQueueConfig } from "./rabbitmq.config";
import type { RabbitMqRouting } from "./rabbitmq.routing";

export type RabbitMqMessageHandler = (
  message: QueueMessage,
  rawMessage: ConsumeMessage
) => Promise<void>;

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

export class RabbitMqQueueConsumer {
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private heartbeatIntervals = new Set<ReturnType<typeof setInterval>>();

  async consume({
    routing,
    handler,
    workerName,
    instanceId,
  }: {
    routing: RabbitMqRouting;
    handler: RabbitMqMessageHandler;
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
    await channel.prefetch(1);
    await safeRecordWorkerHeartbeat({
      workerName: resolvedWorkerName,
      workloadCategory: routing.workloadCategory,
      instanceId: resolvedInstanceId,
      status: "ACTIVE",
      metadata: {
        queue: routing.queue,
        routingKey: routing.routingKey,
      },
    });
    const heartbeatInterval = setInterval(() => {
      void safeRecordWorkerHeartbeat({
        workerName: resolvedWorkerName,
        workloadCategory: routing.workloadCategory,
        instanceId: resolvedInstanceId,
        status: "ACTIVE",
        metadata: {
          queue: routing.queue,
          routingKey: routing.routingKey,
          idle: true,
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

        let message: QueueMessage;

        const parseStartedAt = Date.now();

        try {
          message = JSON.parse(
            rawMessage.content.toString()
          ) as QueueMessage;
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
          await handler(message, rawMessage);
          channel.ack(rawMessage);
          const processingMs = Date.now() - startedAt;

          await safeRecordWorkerHeartbeat({
            workerName: resolvedWorkerName,
            workloadCategory: routing.workloadCategory,
            instanceId: resolvedInstanceId,
            status: "ACTIVE",
            metadata: {
              lastSuccessfulEventAt: new Date().toISOString(),
              eventType: message.type,
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
            metadata,
          });
        } catch (error) {
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

  private async getChannel(): Promise<Channel> {
    if (this.channel) {
      return this.channel;
    }

    const config = getRabbitMqQueueConfig();

    if (!config.connectionUrl) {
      throw new Error("RabbitMQ connection URL is not configured.");
    }

    this.connection = await amqp.connect(config.connectionUrl);
    this.channel = await this.connection.createChannel();

    return this.channel;
  }
}
