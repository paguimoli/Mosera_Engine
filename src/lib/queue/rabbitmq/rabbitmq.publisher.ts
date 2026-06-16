import * as amqp from "amqplib";
import type { Channel, ChannelModel } from "amqplib";

import type { QueueMessage, QueuePublisher } from "../queue.types";
import { getRabbitMqQueueConfig } from "./rabbitmq.config";
import { resolveRabbitMqRouting } from "./rabbitmq.routing";

export class RabbitMqQueuePublisher implements QueuePublisher {
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;

  async publish(message: QueueMessage): Promise<void> {
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
    await channel.bindQueue(routing.queue, routing.exchange, routing.routingKey);

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
        },
        messageId: message.id,
        correlationId: message.correlationId ?? undefined,
        type: message.type,
      }
    );

    if (!published) {
      throw new Error("RabbitMQ publish buffer is full.");
    }
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
