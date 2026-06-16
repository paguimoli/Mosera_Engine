import { NoopQueuePublisher } from "./queue.publisher";
import type { QueuePublisher } from "./queue.types";
import { RabbitMqQueuePublisher } from "./rabbitmq/rabbitmq.publisher";

export function createQueuePublisher(): QueuePublisher {
  if (process.env.RABBITMQ_URL?.trim()) {
    return new RabbitMqQueuePublisher();
  }

  return new NoopQueuePublisher();
}
