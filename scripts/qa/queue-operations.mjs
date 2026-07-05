import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const topologyFile = "src/lib/queue/queue-topology.ts";
const publisherFile = "src/lib/queue/rabbitmq/rabbitmq.publisher.ts";
const consumerFile = "src/lib/queue/rabbitmq/rabbitmq.consumer.ts";
const dlqTool = "scripts/operations/dlq-tool.mjs";
const runbook = "docs/operations/queue-operations-runbook.md";
const qaDir = ".qa/queue-operations";
const syntheticInput = join(qaDir, "synthetic-dlq-messages.json");

function fail(message, metadata = {}) {
  console.error(JSON.stringify({ status: "FAIL", message, ...metadata }, null, 2));
  process.exit(1);
}

function assert(condition, message, metadata = {}) {
  if (!condition) fail(message, metadata);
}

function runNode(args, options = {}) {
  const result = spawnSync("node", args, {
    encoding: "utf8",
    env: {
      ...process.env,
      ...(options.env ?? {}),
    },
  });

  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? result.error?.message ?? "").trim(),
  };
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    fail(`${label} was not valid JSON.`, {
      error: error instanceof Error ? error.message : String(error),
      value,
    });
  }
}

const topology = readFileSync(topologyFile, "utf8");
const publisher = readFileSync(publisherFile, "utf8");
const consumer = readFileSync(consumerFile, "utf8");
const runbookText = readFileSync(runbook, "utf8");

const expected = [
  {
    category: "CRITICAL_FINANCIAL",
    queue: "lottery.critical-financial.events",
    dlq: "lottery.critical-financial.events.dlq",
    routing: "financial.#",
  },
  {
    category: "TICKET_LIFECYCLE",
    queue: "lottery.ticket-lifecycle.events",
    dlq: "lottery.ticket-lifecycle.events.dlq",
    routing: "ticket.#",
  },
  {
    category: "SETTLEMENT",
    queue: "lottery.settlement.events",
    dlq: "lottery.settlement.events.dlq",
    routing: "settlement.#",
  },
  {
    category: "ACCOUNTING",
    queue: "lottery.accounting.events",
    dlq: "lottery.accounting.events.dlq",
    routing: "accounting.#",
  },
  {
    category: "COMMISSION",
    queue: "lottery.commission.events",
    dlq: "lottery.commission.events.dlq",
    routing: "commission.#",
  },
  {
    category: "RECONCILIATION",
    queue: "lottery.reconciliation.events",
    dlq: "lottery.reconciliation.events.dlq",
    routing: "reconciliation.#",
  },
  {
    category: "OPERATIONAL_ACCESS",
    queue: "lottery.operational-access.events",
    dlq: "lottery.operational-access.events.dlq",
    routing: "operational-access.#",
  },
  {
    category: "REPORTING_LOW_PRIORITY",
    queue: "lottery.reporting-low-priority.events",
    dlq: "lottery.reporting-low-priority.events.dlq",
    routing: "reporting.#",
  },
];

for (const entry of expected) {
  assert(topology.includes(entry.category), `Topology must include ${entry.category}.`);
  assert(topology.includes(entry.queue), `Topology must include queue ${entry.queue}.`);
  assert(topology.includes(entry.dlq), `Topology must include DLQ ${entry.dlq}.`);
  assert(topology.includes(entry.routing), `Topology must include routing key ${entry.routing}.`);
}

for (const source of [publisher, consumer]) {
  assert(source.includes('assertExchange(routing.exchange, "topic"'), "RabbitMQ exchange must be asserted as topic.");
  assert(source.includes("assertQueue(routing.deadLetterQueue"), "RabbitMQ DLQ must be asserted.");
  assert(source.includes("deadLetterRoutingKey: routing.deadLetterQueue"), "RabbitMQ queue must dead-letter to the DLQ.");
  assert(source.includes("bindQueue(routing.queue, routing.exchange"), "RabbitMQ queue must bind routing keys.");
}

assert(!publisher.includes("messageTtl"), "No RabbitMQ message TTL is currently configured in publisher.");
assert(!consumer.includes("messageTtl"), "No RabbitMQ message TTL is currently configured in consumer.");

for (const requiredRunbookText of [
  "Queue Health",
  "DLQ Policy",
  "Replay Approval",
  "Replay Evidence",
  "Rollback / Failure Handling",
]) {
  assert(runbookText.includes(requiredRunbookText), `Queue runbook must include ${requiredRunbookText}.`);
}

mkdirSync(qaDir, { recursive: true });
writeFileSync(
  syntheticInput,
  JSON.stringify({
    messages: [
      {
        messageId: "qa-dlq-message-1",
        deadLetterQueueName: "lottery.critical-financial.events.dlq",
        routingKey: "financial.cashier.transaction.completed",
        payload: {
          id: "qa-dlq-event-1",
          type: "cashier.transaction.completed",
          correlationId: "qa-dlq-correlation-1",
          aggregateType: "cashier_transaction",
          aggregateId: "qa-cashier-transaction-1",
          idempotencyKey: "qa-dlq-idempotency-1",
        },
      },
      {
        messageId: "qa-dlq-malformed",
        deadLetterQueueName: "lottery.critical-financial.events.dlq",
        routingKey: "unknown.not-supported",
        payload: {
          type: "unknown.not-supported",
        },
      },
    ],
  }, null, 2)
);

const inspect = runNode([dlqTool, `--mode=inspect`, `--input=${syntheticInput}`, `--evidence-dir=${qaDir}`]);
assert(inspect.ok, "DLQ inspect must work with synthetic data.", { result: inspect });
const inspectPayload = parseJson(inspect.stdout, "DLQ inspect output");
assert(inspectPayload.inspectOnly === true, "DLQ inspect must be inspect-only.", { inspectPayload });
assert(inspectPayload.eligibleCount === 1, "DLQ inspect must identify replay-eligible messages.", {
  inspectPayload,
});
assert(inspectPayload.malformedCount === 1, "DLQ inspect must flag malformed/unsupported messages.", {
  inspectPayload,
});

const replayWithoutApproval = runNode([
  dlqTool,
  "--mode=replay",
  `--input=${syntheticInput}`,
  `--evidence-dir=${qaDir}`,
]);
assert(!replayWithoutApproval.ok, "DLQ replay without approval must fail.", {
  result: replayWithoutApproval,
});

const replayWithApproval = runNode([
  dlqTool,
  "--mode=replay",
  `--input=${syntheticInput}`,
  `--evidence-dir=${qaDir}`,
], {
  env: {
    DLQ_REPLAY_APPROVED: "true",
    DLQ_REPLAY_IDEMPOTENCY_CONFIRMED: "true",
    DLQ_REPLAY_APPROVAL_TOKEN: "qa-approved-change-ticket-123",
    DLQ_REPLAY_OPERATOR: "qa-operator",
  },
});
assert(replayWithApproval.ok, "DLQ replay with synthetic approval evidence must pass.", {
  result: replayWithApproval,
});
const replayPayload = parseJson(replayWithApproval.stdout, "DLQ replay output");
assert(replayPayload.replayApproved === true, "Approved DLQ replay must record approval.", {
  replayPayload,
});
assert(replayPayload.replayPlan.some((message) => message.replayAction === "BLOCKED"), "Malformed/unsupported messages must not be replayed.", {
  replayPayload,
});
assert(replayPayload.evidencePath, "DLQ replay must produce evidence output.", { replayPayload });

const localCompose = spawnSync("docker", ["compose", "config", "--services"], {
  encoding: "utf8",
});
assert(localCompose.status === 0, "Local compose config must remain valid.", {
  stderr: localCompose.stderr,
});
for (const service of ["rabbitmq", "redis", "local-postgres", "app"]) {
  assert(localCompose.stdout.split("\n").includes(service), `Local runtime must still include ${service}.`);
}

console.log(JSON.stringify({
  status: "PASS",
  checks: {
    queueTopologyExpected: "PASS",
    deadLetterPoliciesExpected: "PASS",
    ttlPolicyExplicitlyAbsent: "PASS",
    dlqInspectSyntheticData: "PASS",
    replayWithoutApprovalFails: "PASS",
    replayWithSyntheticApprovalEvidencePasses: "PASS",
    malformedUnsupportedMessagesNotReplayed: "PASS",
    localRuntimeUnaffected: "PASS",
  },
}, null, 2));
