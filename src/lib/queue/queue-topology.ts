import { getRabbitMqQueueConfig } from "./rabbitmq/rabbitmq.config";

export type QueueWorkloadCategory =
  | "CRITICAL_FINANCIAL"
  | "TICKET_LIFECYCLE"
  | "SETTLEMENT"
  | "ACCOUNTING"
  | "COMMISSION"
  | "RECONCILIATION"
  | "OPERATIONAL_ACCESS"
  | "REPORTING_LOW_PRIORITY";

export type QueuePriorityClass = "HIGH" | "NORMAL" | "LOW";

export type QueueRetryPolicy = {
  maxAttempts: number;
  backoffSeconds: number[];
  deadLetterAfterExhaustion: boolean;
};

export type QueueTopologyEntry = {
  category: QueueWorkloadCategory;
  exchange: string;
  routingKeyPattern: string;
  routingKeyPrefix: string;
  queueName: string;
  deadLetterQueueName: string;
  retryPolicy: QueueRetryPolicy;
  priorityClass: QueuePriorityClass;
  consumerOwner: string;
  examples: string[];
};

const TOPOLOGY_BY_CATEGORY: Record<
  QueueWorkloadCategory,
  Omit<QueueTopologyEntry, "exchange">
> = {
  CRITICAL_FINANCIAL: {
    category: "CRITICAL_FINANCIAL",
    routingKeyPattern: "financial.#",
    routingKeyPrefix: "financial",
    queueName: "lottery.critical-financial.events",
    deadLetterQueueName: "lottery.critical-financial.events.dlq",
    retryPolicy: {
      maxAttempts: 5,
      backoffSeconds: [60, 300, 900, 3600],
      deadLetterAfterExhaustion: true,
    },
    priorityClass: "HIGH",
    consumerOwner: "critical-financial-worker",
    examples: [
      "cashier.transaction.completed",
      "ledger.entry.posted",
      "wallet.balance.changed",
      "credit.reservation.created",
      "credit.settlement.applied",
      "credit.balance.updated",
      "settlement.ledger_effect.generated",
    ],
  },
  TICKET_LIFECYCLE: {
    category: "TICKET_LIFECYCLE",
    routingKeyPattern: "ticket.#",
    routingKeyPrefix: "ticket",
    queueName: "lottery.ticket-lifecycle.events",
    deadLetterQueueName: "lottery.ticket-lifecycle.events.dlq",
    retryPolicy: {
      maxAttempts: 5,
      backoffSeconds: [60, 300, 900, 3600],
      deadLetterAfterExhaustion: true,
    },
    priorityClass: "HIGH",
    consumerOwner: "ticket-lifecycle-worker",
    examples: ["ticket.accepted", "ticket.cancelled", "ticket.settled"],
  },
  SETTLEMENT: {
    category: "SETTLEMENT",
    routingKeyPattern: "settlement.#",
    routingKeyPrefix: "settlement",
    queueName: "lottery.settlement.events",
    deadLetterQueueName: "lottery.settlement.events.dlq",
    retryPolicy: {
      maxAttempts: 5,
      backoffSeconds: [60, 300, 900, 3600],
      deadLetterAfterExhaustion: true,
    },
    priorityClass: "HIGH",
    consumerOwner: "settlement-worker",
    examples: [
      "settlement.run.started",
      "settlement.run.completed",
      "settlement.failed",
    ],
  },
  ACCOUNTING: {
    category: "ACCOUNTING",
    routingKeyPattern: "accounting.#",
    routingKeyPrefix: "accounting",
    queueName: "lottery.accounting.events",
    deadLetterQueueName: "lottery.accounting.events.dlq",
    retryPolicy: {
      maxAttempts: 4,
      backoffSeconds: [300, 900, 3600],
      deadLetterAfterExhaustion: true,
    },
    priorityClass: "NORMAL",
    consumerOwner: "accounting-worker",
    examples: ["accounting.snapshot.generated", "accounting.week.closed"],
  },
  COMMISSION: {
    category: "COMMISSION",
    routingKeyPattern: "commission.#",
    routingKeyPrefix: "commission",
    queueName: "lottery.commission.events",
    deadLetterQueueName: "lottery.commission.events.dlq",
    retryPolicy: {
      maxAttempts: 4,
      backoffSeconds: [300, 900, 3600],
      deadLetterAfterExhaustion: true,
    },
    priorityClass: "NORMAL",
    consumerOwner: "commission-worker",
    examples: ["commission.run.completed", "commission.adjustment.created"],
  },
  RECONCILIATION: {
    category: "RECONCILIATION",
    routingKeyPattern: "reconciliation.#",
    routingKeyPrefix: "reconciliation",
    queueName: "lottery.reconciliation.events",
    deadLetterQueueName: "lottery.reconciliation.events.dlq",
    retryPolicy: {
      maxAttempts: 3,
      backoffSeconds: [900, 3600],
      deadLetterAfterExhaustion: true,
    },
    priorityClass: "LOW",
    consumerOwner: "reconciliation-worker",
    examples: [
      "reconciliation.run.completed",
      "reconciliation.finding.created",
      "reconciliation.finding.acknowledged",
      "reconciliation.finding.resolved",
    ],
  },
  OPERATIONAL_ACCESS: {
    category: "OPERATIONAL_ACCESS",
    routingKeyPattern: "operational-access.#",
    routingKeyPrefix: "operational-access",
    queueName: "lottery.operational-access.events",
    deadLetterQueueName: "lottery.operational-access.events.dlq",
    retryPolicy: {
      maxAttempts: 5,
      backoffSeconds: [60, 300, 900, 3600],
      deadLetterAfterExhaustion: true,
    },
    priorityClass: "HIGH",
    consumerOwner: "operational-access-worker",
    examples: [
      "break_glass.login",
      "session.revoked",
      "user.sessions.revoked",
    ],
  },
  REPORTING_LOW_PRIORITY: {
    category: "REPORTING_LOW_PRIORITY",
    routingKeyPattern: "reporting.#",
    routingKeyPrefix: "reporting",
    queueName: "lottery.reporting-low-priority.events",
    deadLetterQueueName: "lottery.reporting-low-priority.events.dlq",
    retryPolicy: {
      maxAttempts: 3,
      backoffSeconds: [900, 3600],
      deadLetterAfterExhaustion: true,
    },
    priorityClass: "LOW",
    consumerOwner: "reporting-worker",
    examples: ["report.export.requested", "report.export.completed"],
  },
};

const EXACT_EVENT_CATEGORY: Record<string, QueueWorkloadCategory> = {
  "cashier.transaction.completed": "CRITICAL_FINANCIAL",
  "settlement.ledger_effect.generated": "CRITICAL_FINANCIAL",
  "credit.settlement.applied": "CRITICAL_FINANCIAL",
  "credit.balance.updated": "CRITICAL_FINANCIAL",
  "ticket.accepted": "TICKET_LIFECYCLE",
  "ticket.cancelled": "TICKET_LIFECYCLE",
  "ticket.settled": "TICKET_LIFECYCLE",
  "accounting.snapshot.generated": "ACCOUNTING",
  "accounting.week.closed": "ACCOUNTING",
  "commission.run.completed": "COMMISSION",
  "commission.adjustment.created": "COMMISSION",
  "reconciliation.finding.acknowledged": "RECONCILIATION",
  "reconciliation.finding.resolved": "RECONCILIATION",
  "reconciliation.run.reviewed": "RECONCILIATION",
  "reconciliation.run.requires_attention": "RECONCILIATION",
};

const PREFIX_EVENT_CATEGORY: Array<[string, QueueWorkloadCategory]> = [
  ["ledger.", "CRITICAL_FINANCIAL"],
  ["wallet.", "CRITICAL_FINANCIAL"],
  ["credit.reservation.", "CRITICAL_FINANCIAL"],
  ["credit.exposure.", "CRITICAL_FINANCIAL"],
  ["credit.release.", "CRITICAL_FINANCIAL"],
  ["credit.balance.", "CRITICAL_FINANCIAL"],
  ["ticket.", "TICKET_LIFECYCLE"],
  ["settlement.", "SETTLEMENT"],
  ["accounting.", "ACCOUNTING"],
  ["commission.", "COMMISSION"],
  ["reconciliation.", "RECONCILIATION"],
  ["break_glass.", "OPERATIONAL_ACCESS"],
  ["session.", "OPERATIONAL_ACCESS"],
  ["user.sessions.", "OPERATIONAL_ACCESS"],
  ["report.", "REPORTING_LOW_PRIORITY"],
];

export function listQueueTopology(): QueueTopologyEntry[] {
  const exchange = getRabbitMqQueueConfig().exchangeName;

  return Object.values(TOPOLOGY_BY_CATEGORY).map((entry) => ({
    ...entry,
    exchange,
  }));
}

export function getQueueTopologyEntry(
  category: QueueWorkloadCategory
): QueueTopologyEntry {
  const exchange = getRabbitMqQueueConfig().exchangeName;

  return {
    ...TOPOLOGY_BY_CATEGORY[category],
    exchange,
  };
}

export function classifyOutboxEventType(
  eventType: string
): QueueWorkloadCategory {
  const normalized = eventType.trim().toLowerCase();
  const exact = EXACT_EVENT_CATEGORY[normalized];

  if (exact) {
    return exact;
  }

  return (
    PREFIX_EVENT_CATEGORY.find(([prefix]) => normalized.startsWith(prefix))?.[1] ??
    "REPORTING_LOW_PRIORITY"
  );
}

export function buildRoutingKey(eventType: string): string {
  const entry = getQueueTopologyEntry(classifyOutboxEventType(eventType));

  return `${entry.routingKeyPrefix}.${eventType.trim().toLowerCase()}`;
}

export function resolveQueueTopologyForEvent(
  eventType: string
): QueueTopologyEntry & { routingKey: string } {
  const category = classifyOutboxEventType(eventType);
  const entry = getQueueTopologyEntry(category);

  return {
    ...entry,
    routingKey: buildRoutingKey(eventType),
  };
}
