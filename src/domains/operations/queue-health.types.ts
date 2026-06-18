import type {
  QueueTopologyEntry,
  QueueWorkloadCategory,
} from "@/src/lib/queue/queue-topology";

export type OutboxHealthSummary = {
  pendingCount: number;
  failedCount: number;
  deadLetterCount: number;
  oldestUnpublishedCreatedAt: string | null;
  oldestUnpublishedAgeSeconds: number | null;
  failedJobCount: number;
};

export type RabbitMqQueueHealth = {
  category: QueueWorkloadCategory;
  queueName: string;
  deadLetterQueueName: string;
  routingKeyPattern: string;
  priorityClass: string;
  consumerOwner: string;
  messagesReady: number | null;
  messagesUnacked: number | null;
  consumerCount: number | null;
  deadLetterMessagesReady: number | null;
  deadLetterMessagesUnacked: number | null;
  status: "HEALTHY" | "WARNING" | "CRITICAL" | "DEGRADED";
  available: boolean;
  error: string | null;
};

export type QueueHealthSummary = {
  generatedAt: string;
  exchange: string;
  topology: QueueTopologyEntry[];
  outbox: OutboxHealthSummary;
  rabbitmq: RabbitMqQueueHealth[];
};
