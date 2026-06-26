import { supabaseServerAdmin } from "@/src/lib/supabase/server-admin-client";
import { listQueueTopology } from "@/src/lib/queue/queue-topology";
import type {
  OutboxHealthSummary,
  QueueHealthSummary,
  RabbitMqQueueHealth,
} from "./queue-health.types";

type RabbitMqQueueResponse = {
  messages_ready?: number;
  messages_unacknowledged?: number;
  consumers?: number;
  message_stats?: {
    publish_details?: { rate?: number };
    deliver_get_details?: { rate?: number };
    ack_details?: { rate?: number };
  };
};

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown queue health error.";
}

async function countRowsByStatus(table: string, status: string) {
  const { count, error } = await supabaseServerAdmin
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("status", status);

  if (error) {
    throw new Error(error.message ?? "Unable to count rows.");
  }

  return count ?? 0;
}

async function getOutboxHealth(now: Date): Promise<OutboxHealthSummary> {
  const [
    pendingCount,
    failedCount,
    deadLetterCount,
    failedJobCount,
    oldest,
    retryRows,
  ] = await Promise.all([
      countRowsByStatus("outbox_events", "PENDING"),
      countRowsByStatus("outbox_events", "FAILED"),
      countRowsByStatus("outbox_events", "DEAD_LETTER"),
      countRowsByStatus("job_runs", "FAILED"),
      supabaseServerAdmin
        .from("outbox_events")
        .select("created_at")
        .in("status", ["PENDING", "FAILED"])
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
      supabaseServerAdmin
        .from("outbox_events")
        .select("attempt_count")
        .gt("attempt_count", 0)
        .limit(1000),
    ]);

  if (oldest.error) {
    throw new Error(oldest.error.message);
  }
  if (retryRows.error) {
    throw new Error(retryRows.error.message);
  }

  const oldestCreatedAt =
    typeof oldest.data?.created_at === "string" ? oldest.data.created_at : null;
  const oldestAgeSeconds = oldestCreatedAt
    ? Math.max(
        0,
        Math.floor((now.getTime() - new Date(oldestCreatedAt).getTime()) / 1000)
      )
    : null;

  return {
    pendingCount,
    failedCount,
    deadLetterCount,
    retryCount: (retryRows.data ?? []).reduce(
      (sum, row) => sum + Math.max(0, Number(row.attempt_count ?? 0)),
      0
    ),
    oldestUnpublishedCreatedAt: oldestCreatedAt,
    oldestUnpublishedAgeSeconds: oldestAgeSeconds,
    failedJobCount,
  };
}

function getRabbitMqManagementConfig() {
  const explicitUrl = process.env.RABBITMQ_MANAGEMENT_URL?.trim();
  const amqpUrl = process.env.RABBITMQ_URL?.trim();

  if (!explicitUrl && !amqpUrl) {
    return null;
  }

  const sourceUrl = new URL(explicitUrl ?? amqpUrl ?? "");
  const protocol = sourceUrl.protocol === "https:" ? "https:" : "http:";
  const hostname = sourceUrl.hostname || "localhost";
  const port = explicitUrl ? sourceUrl.port : "15672";
  const username = decodeURIComponent(sourceUrl.username || "guest");
  const password = decodeURIComponent(sourceUrl.password || "guest");
  const vhost = sourceUrl.pathname && sourceUrl.pathname !== "/" ? sourceUrl.pathname.slice(1) : "/";
  const origin = `${protocol}//${hostname}${port ? `:${port}` : ""}`;

  return {
    origin,
    vhost,
    authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
  };
}

async function fetchRabbitMqQueue(
  queueName: string
): Promise<{
  ready: number;
  unacked: number;
  consumers: number;
  publishRate: number | null;
  consumeRate: number | null;
}> {
  const config = getRabbitMqManagementConfig();

  if (!config) {
    throw new Error("RabbitMQ management configuration is unavailable.");
  }

  const response = await fetch(
    `${config.origin}/api/queues/${encodeURIComponent(config.vhost)}/${encodeURIComponent(queueName)}`,
    {
      headers: {
        authorization: config.authorization,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`RabbitMQ management API returned ${response.status}.`);
  }

  const body = (await response.json()) as RabbitMqQueueResponse;

  return {
    ready: body.messages_ready ?? 0,
    unacked: body.messages_unacknowledged ?? 0,
    consumers: body.consumers ?? 0,
    publishRate: body.message_stats?.publish_details?.rate ?? null,
    consumeRate:
      body.message_stats?.deliver_get_details?.rate ??
      body.message_stats?.ack_details?.rate ??
      null,
  };
}

function getQueueStatus({
  ready,
  dlqReady,
  available,
}: {
  ready: number | null;
  dlqReady: number | null;
  available: boolean;
}): RabbitMqQueueHealth["status"] {
  if (!available) {
    return "DEGRADED";
  }

  if ((dlqReady ?? 0) > 0) {
    return "CRITICAL";
  }

  if ((ready ?? 0) > 0) {
    return "WARNING";
  }

  return "HEALTHY";
}

async function getRabbitMqHealth(): Promise<RabbitMqQueueHealth[]> {
  const topology = listQueueTopology();

  return Promise.all(
    topology.map(async (entry) => {
      try {
        const [queue, dlq] = await Promise.all([
          fetchRabbitMqQueue(entry.queueName),
          fetchRabbitMqQueue(entry.deadLetterQueueName),
        ]);

        return {
          category: entry.category,
          queueName: entry.queueName,
          deadLetterQueueName: entry.deadLetterQueueName,
          routingKeyPattern: entry.routingKeyPattern,
          priorityClass: entry.priorityClass,
          consumerOwner: entry.consumerOwner,
          messagesReady: queue.ready,
          messagesUnacked: queue.unacked,
          consumerCount: queue.consumers,
          publishRate: queue.publishRate,
          consumeRate: queue.consumeRate,
          queueDepth: queue.ready + queue.unacked,
          oldestQueuedMessageAgeSeconds: null,
          deadLetterMessagesReady: dlq.ready,
          deadLetterMessagesUnacked: dlq.unacked,
          deadLetterStatus: dlq.ready + dlq.unacked > 0 ? "HAS_MESSAGES" : "EMPTY",
          status: getQueueStatus({
            ready: queue.ready,
            dlqReady: dlq.ready,
            available: true,
          }),
          available: true,
          error: null,
        };
      } catch (error) {
        return {
          category: entry.category,
          queueName: entry.queueName,
          deadLetterQueueName: entry.deadLetterQueueName,
          routingKeyPattern: entry.routingKeyPattern,
          priorityClass: entry.priorityClass,
          consumerOwner: entry.consumerOwner,
          messagesReady: null,
          messagesUnacked: null,
          consumerCount: null,
          publishRate: null,
          consumeRate: null,
          queueDepth: null,
          oldestQueuedMessageAgeSeconds: null,
          deadLetterMessagesReady: null,
          deadLetterMessagesUnacked: null,
          deadLetterStatus: "UNAVAILABLE",
          status: "DEGRADED",
          available: false,
          error: getErrorMessage(error),
        };
      }
    })
  );
}

export async function getQueueHealthSummary(): Promise<QueueHealthSummary> {
  const now = new Date();
  const topology = listQueueTopology();
  const [outbox, rabbitmq] = await Promise.all([
    getOutboxHealth(now),
    getRabbitMqHealth(),
  ]);

  return {
    generatedAt: now.toISOString(),
    exchange: topology[0]?.exchange ?? "lottery.events",
    topology,
    outbox,
    rabbitmq,
  };
}
