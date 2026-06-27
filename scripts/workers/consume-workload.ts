import { logger } from "@/src/lib/observability/logger";
import type { QueueWorkloadCategory } from "@/src/lib/queue/queue-topology";
import { getQueueTopologyEntry } from "@/src/lib/queue/queue-topology";
import { RabbitMqQueueConsumer } from "@/src/lib/queue/rabbitmq/rabbitmq.consumer";
import { resolveRabbitMqWorkloadRouting } from "@/src/lib/queue/rabbitmq/rabbitmq.routing";

const allowedCategories: QueueWorkloadCategory[] = [
  "CRITICAL_FINANCIAL",
  "SETTLEMENT",
  "ACCOUNTING",
  "COMMISSION",
  "RECONCILIATION",
  "OPERATIONAL_ACCESS",
  "REPORTING_LOW_PRIORITY",
  "TICKET_LIFECYCLE",
];

function parseCategory(value: string | undefined): QueueWorkloadCategory {
  const normalized = value?.trim().toUpperCase().replaceAll("-", "_");

  if (allowedCategories.includes(normalized as QueueWorkloadCategory)) {
    return normalized as QueueWorkloadCategory;
  }

  console.error(
    `Usage: node scripts/run-ts-script.mjs scripts/workers/consume-workload.ts <${allowedCategories.join("|")}>`
  );
  process.exit(1);
}

async function main() {
  const category = parseCategory(process.argv[2]);
  const routing = resolveRabbitMqWorkloadRouting(category);
  const topology = getQueueTopologyEntry(category);
  const workerName = topology.consumerOwner;
  const consumer = new RabbitMqQueueConsumer();
  let shuttingDown = false;

  async function shutdown(signal: NodeJS.Signals) {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info({
      message: "RabbitMQ workload consumer shutdown requested.",
      metadata: {
        signal,
        workloadCategory: category,
        queue: routing.queue,
      },
    });
    await consumer.close();
    process.exit(0);
  }

  process.once("SIGTERM", (signal) => {
    void shutdown(signal);
  });
  process.once("SIGINT", (signal) => {
    void shutdown(signal);
  });

  logger.info({
    message: "RabbitMQ workload consumer starting.",
    metadata: {
      workloadCategory: category,
      queue: routing.queue,
      routingKeyPattern: topology.routingKeyPattern,
      exchange: routing.exchange,
      consumerOwner: topology.consumerOwner,
    },
  });

  await consumer.consume({
    routing,
    workerName,
    handler: async (message) => {
      logger.info({
        message: "RabbitMQ workload event payload consumed.",
        correlationId: message.correlationId ?? null,
        metadata: {
          workloadCategory: category,
          eventType: message.type,
          aggregateType: message.aggregateType ?? null,
          aggregateId: message.aggregateId ?? null,
          messageId: message.id ?? null,
          payload: message.payload,
        },
      });
    },
  });
}

main().catch((error) => {
  logger.error({
    message: "RabbitMQ workload consumer failed.",
    metadata: {
      error: error instanceof Error ? error.message : "Unknown error",
    },
  });

  process.exit(1);
});
