export type RabbitMqQueueConfig = {
  exchangeName: string;
  connectionUrl?: string;
  durable: boolean;
};

export function getRabbitMqQueueConfig(): RabbitMqQueueConfig {
  return {
    exchangeName: process.env.RABBITMQ_EXCHANGE_NAME?.trim() || "lottery.events",
    connectionUrl: process.env.RABBITMQ_URL?.trim() || undefined,
    durable: true,
  };
}
