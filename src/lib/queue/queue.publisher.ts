import type { QueueMessage, QueuePublisher } from "./queue.types";

export class NoopQueuePublisher implements QueuePublisher {
  async publish(message: QueueMessage): Promise<void> {
    void message;

    return Promise.resolve();
  }
}

export const noopQueuePublisher = new NoopQueuePublisher();
