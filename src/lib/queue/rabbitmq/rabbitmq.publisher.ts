import * as amqp from "amqplib";
import type { ChannelModel, ConfirmChannel } from "amqplib";

import {
  CANONICAL_EVENT_CONTRACT_VERSION,
  type QueueMessage,
  type QueuePublisher,
} from "../queue.types";
import { getRabbitMqQueueConfig } from "./rabbitmq.config";
import { resolveRabbitMqRouting } from "./rabbitmq.routing";

export class RabbitMqQueuePublisher implements QueuePublisher {
  private connection: ChannelModel | null = null;
  private channel: ConfirmChannel | null = null;

  async publish(message: QueueMessage): Promise<void> {
    if (
      !message.id?.trim() ||
      message.contractVersion !== CANONICAL_EVENT_CONTRACT_VERSION ||
      message.idempotencyKey !== message.id ||
      !message.occurredAt
    ) {
      throw new Error("Canonical event envelope is incomplete or unsupported.");
    }
    const channel = await this.getChannel();
    const config = getRabbitMqQueueConfig();
    const routing = resolveRabbitMqRouting(message.type);
    const body = Buffer.from(JSON.stringify(message));

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

    const published = channel.publish(
      routing.exchange,
      routing.routingKey,
      body,
      {
        contentType: "application/json",
        deliveryMode: 2,
        persistent: true,
        headers: {
          correlationId: message.correlationId ?? undefined,
          aggregateType: message.aggregateType ?? undefined,
          aggregateId: message.aggregateId ?? undefined,
          eventType: message.type,
          contractVersion: message.contractVersion,
          idempotencyKey: message.idempotencyKey,
          causationId: message.causationId ?? undefined,
          workloadCategory: routing.workloadCategory,
        },
        messageId: message.id,
        correlationId: message.correlationId ?? undefined,
        type: message.type,
      }
    );

    if (!published) {
      await new Promise<void>((resolve) => channel.once("drain", resolve));
    }
    await channel.waitForConfirms();
  }

  async close(): Promise<void> {
    const channel = this.channel;
    const connection = this.connection;
    this.channel = null;
    this.connection = null;
    await channel?.close().catch(() => undefined);
    await connection?.close().catch(() => undefined);
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
    const reset = () => {
      if (this.connection === connection) {
        this.connection = null;
        this.channel = null;
      }
    };
    connection.on("error", reset);
    connection.on("close", reset);
    this.connection = connection;
    this.channel = await connection.createConfirmChannel();

    return this.channel;
  }
}
