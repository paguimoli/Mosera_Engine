import * as amqp from "amqplib";
import type { ChannelModel, ConfirmChannel } from "amqplib";

import {
  CANONICAL_EVENT_CONTRACT_VERSION,
  type QueueMessage,
  type QueuePublisher,
  type QueueTransportReadiness,
} from "../queue.types";
import { getRabbitMqQueueConfig } from "./rabbitmq.config";
import { resolveRabbitMqRouting } from "./rabbitmq.routing";

export class RabbitMqQueuePublisher implements QueuePublisher {
  private connection: ChannelModel | null = null;
  private channel: ConfirmChannel | null = null;
  private channelPromise: Promise<ConfirmChannel> | null = null;
  private topologyPromises = new Map<string, Promise<void>>();
  private availability: "UNKNOWN" | "AVAILABLE" | "UNAVAILABLE" = "UNKNOWN";
  private unavailableSince: string | null = null;
  private consecutiveFailures = 0;
  private nextConnectionAttemptAt = 0;

  private static readonly CONNECTION_BACKOFF_MS = [250, 500, 1_000];

  async publish(message: QueueMessage): Promise<void> {
    await this.publishBatch([message]);
  }

  async publishBatch(messages: readonly QueueMessage[]): Promise<void> {
    if (messages.length === 0) return;
    for (const message of messages) this.validateMessage(message);
    const channel = await this.getChannel();
    const config = getRabbitMqQueueConfig();
    const routed = messages.map((message) => ({
      message,
      routing: resolveRabbitMqRouting(message.type),
    }));
    await Promise.all(routed.map(({ routing }) =>
      this.ensureTopology(channel, routing, config.durable)));

    let backpressured = false;
    for (const { message, routing } of routed) {
      const transportPublishStartedAt = new Date().toISOString();
      backpressured = !channel.publish(
        routing.exchange,
        routing.routingKey,
        Buffer.from(JSON.stringify(message)),
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
            "x-mosera-dispatcher-seen-at":
              message.transportDispatcherSeenAt ?? undefined,
            "x-mosera-publish-started-at": transportPublishStartedAt,
            "x-mosera-published-at": transportPublishStartedAt,
          },
          messageId: message.id,
          correlationId: message.correlationId ?? undefined,
          type: message.type,
        }
      ) || backpressured;
    }
    if (backpressured) {
      await new Promise<void>((resolve) => channel.once("drain", resolve));
    }
    await channel.waitForConfirms();
    this.markAvailable();
  }

  async probeReadiness(
    eventTypes: readonly string[]
  ): Promise<QueueTransportReadiness> {
    const checkedAt = new Date().toISOString();
    try {
      const channel = await this.getChannel();
      const config = getRabbitMqQueueConfig();
      const routings = eventTypes.map((eventType) =>
        resolveRabbitMqRouting(eventType)
      );
      await Promise.all(
        routings.map((routing) =>
          this.ensureTopology(channel, routing, config.durable)
        )
      );
      const recovered = this.availability === "UNAVAILABLE";
      const unavailableSince = this.unavailableSince;
      this.markAvailable();
      return {
        ready: true,
        recovered,
        checkedAt,
        unavailableSince,
        consecutiveFailures: 0,
        retryAfterMs: 0,
        error: null,
      };
    } catch (error) {
      if (this.availability !== "UNAVAILABLE") this.markUnavailable();
      return {
        ready: false,
        recovered: false,
        checkedAt,
        unavailableSince: this.unavailableSince,
        consecutiveFailures: this.consecutiveFailures,
        retryAfterMs: Math.max(0, this.nextConnectionAttemptAt - Date.now()),
        error: error instanceof Error ? error.message : "RabbitMQ is unavailable.",
      };
    }
  }

  private validateMessage(message: QueueMessage) {
    if (
      !message.id?.trim() ||
      message.contractVersion !== CANONICAL_EVENT_CONTRACT_VERSION ||
      message.idempotencyKey !== message.id ||
      !message.occurredAt
    ) {
      throw new Error("Canonical event envelope is incomplete or unsupported.");
    }
  }

  async close(): Promise<void> {
    const channel = this.channel;
    const connection = this.connection;
    this.channel = null;
    this.channelPromise = null;
    this.connection = null;
    this.topologyPromises.clear();
    await channel?.close().catch(() => undefined);
    await connection?.close().catch(() => undefined);
  }

  private markAvailable() {
    this.availability = "AVAILABLE";
    this.unavailableSince = null;
    this.consecutiveFailures = 0;
    this.nextConnectionAttemptAt = 0;
  }

  private markUnavailable() {
    if (this.availability !== "UNAVAILABLE") {
      this.unavailableSince = new Date().toISOString();
    }
    this.availability = "UNAVAILABLE";
    this.consecutiveFailures += 1;
    const index = Math.min(
      this.consecutiveFailures - 1,
      RabbitMqQueuePublisher.CONNECTION_BACKOFF_MS.length - 1
    );
    this.nextConnectionAttemptAt =
      Date.now() + RabbitMqQueuePublisher.CONNECTION_BACKOFF_MS[index];
  }

  private async ensureTopology(
    channel: ConfirmChannel,
    routing: ReturnType<typeof resolveRabbitMqRouting>,
    durable: boolean
  ): Promise<void> {
    const key = [
      routing.exchange,
      routing.queue,
      routing.deadLetterQueue,
      ...routing.bindingKeys,
    ].join("|");
    let topology = this.topologyPromises.get(key);
    if (!topology) {
      topology = (async () => {
        await channel.assertExchange(routing.exchange, "topic", { durable });
        await channel.assertQueue(routing.deadLetterQueue, { durable });
        await channel.assertQueue(routing.queue, {
          durable,
          deadLetterExchange: "",
          deadLetterRoutingKey: routing.deadLetterQueue,
        });
        for (const bindingKey of routing.bindingKeys) {
          await channel.bindQueue(routing.queue, routing.exchange, bindingKey);
        }
      })();
      this.topologyPromises.set(key, topology);
    }
    try {
      await topology;
    } catch (error) {
      this.topologyPromises.delete(key);
      throw error;
    }
  }

  private async getChannel(): Promise<ConfirmChannel> {
    if (this.channel) {
      return this.channel;
    }
    if (this.channelPromise) {
      return this.channelPromise;
    }
    if (Date.now() < this.nextConnectionAttemptAt) {
      throw new Error(
        `RabbitMQ reconnect is backed off for ${this.nextConnectionAttemptAt - Date.now()}ms.`
      );
    }
    const config = getRabbitMqQueueConfig();

    const connectionUrl = config.connectionUrl;
    if (!connectionUrl) {
      throw new Error("RabbitMQ connection URL is not configured.");
    }

    this.channelPromise = (async () => {
      const connection = await amqp.connect(connectionUrl, { timeout: 2_000 });
      const reset = () => {
        if (this.connection === connection) {
          this.connection = null;
          this.channel = null;
          this.channelPromise = null;
          this.topologyPromises.clear();
          this.markUnavailable();
        }
      };
      connection.on("error", reset);
      connection.on("close", reset);
      this.connection = connection;
      this.channel = await connection.createConfirmChannel();
      return this.channel;
    })();
    try {
      return await this.channelPromise;
    } catch (error) {
      this.channelPromise = null;
      this.markUnavailable();
      throw error;
    }
  }
}
