import * as amqp from "amqplib";
import type { Channel, ChannelModel, ConsumeMessage } from "amqplib";

import type { QueueMessage } from "../queue.types";
import { getRabbitMqQueueConfig } from "./rabbitmq.config";
import type { RabbitMqRouting } from "./rabbitmq.routing";

export type RabbitMqMessageHandler = (
  message: QueueMessage,
  rawMessage: ConsumeMessage
) => Promise<void>;

export class RabbitMqQueueConsumer {
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;

  async consume({
    routing,
    handler,
  }: {
    routing: RabbitMqRouting;
    handler: RabbitMqMessageHandler;
  }): Promise<void> {
    const channel = await this.getChannel();
    const config = getRabbitMqQueueConfig();

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
    await channel.prefetch(1);

    await channel.consume(
      routing.queue,
      async (rawMessage) => {
        if (!rawMessage) {
          return;
        }

        try {
          const message = JSON.parse(
            rawMessage.content.toString()
          ) as QueueMessage;
          await handler(message, rawMessage);
          channel.ack(rawMessage);
        } catch (error) {
          void error;
          channel.nack(rawMessage, false, false);
        }
      },
      {
        noAck: false,
      }
    );
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
