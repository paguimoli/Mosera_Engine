import { getRabbitMqQueueConfig } from "./rabbitmq.config";

export type RabbitMqRouting = {
  exchange: string;
  routingKey: string;
  queue: string;
  deadLetterQueue: string;
};

const ROUTING_BY_EVENT_TYPE: Record<string, Omit<RabbitMqRouting, "exchange">> = {
  "cashier.transaction.completed": {
    routingKey: "cashier.transaction.completed",
    queue: "cashier.transaction.completed.queue",
    deadLetterQueue: "cashier.transaction.completed.dlq",
  },
};

export function resolveRabbitMqRouting(eventType: string): RabbitMqRouting {
  const config = getRabbitMqQueueConfig();
  const routing = ROUTING_BY_EVENT_TYPE[eventType] ?? {
    routingKey: eventType,
    queue: `${eventType}.queue`,
    deadLetterQueue: `${eventType}.dlq`,
  };

  return {
    exchange: config.exchangeName,
    ...routing,
  };
}
