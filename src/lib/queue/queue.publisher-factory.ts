import type { QueuePublisher } from "./queue.types";
import { RabbitMqQueuePublisher } from "./rabbitmq/rabbitmq.publisher";

export function createQueuePublisher(): QueuePublisher {
  if (!process.env.RABBITMQ_URL?.trim()) {
    throw new Error(
      "RABBITMQ_URL is required for the canonical outbox publisher."
    );
  }

  return new RabbitMqQueuePublisher();
}
