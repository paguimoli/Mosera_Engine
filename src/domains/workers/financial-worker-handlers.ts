import { createHash } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";

import { logger } from "@/src/lib/observability/logger";
import type { QueueMessage } from "@/src/lib/queue/queue.types";
import type { QueueWorkloadCategory } from "@/src/lib/queue/queue-topology";

export type FinancialWorkerHandlingStatus =
  | "IN_PROGRESS"
  | "HANDLED"
  | "NO_OP"
  | "FAILED";

export type FinancialWorkerHandlingResult = {
  eventId: string;
  eventType: string;
  status: Exclude<FinancialWorkerHandlingStatus, "IN_PROGRESS">;
  duplicate: boolean;
  message: string;
  metadata: Record<string, unknown>;
};

type FinancialWorkerEventRecord = {
  eventId: string;
  eventType: string;
  aggregateType?: string | null;
  aggregateId?: string | null;
  idempotencyKey: string;
  handlingStatus: FinancialWorkerHandlingStatus;
  handlerName: string;
  correlationId?: string | null;
  errorMessage?: string | null;
  metadata: Record<string, unknown>;
  firstSeenAt: string;
  handledAt?: string | null;
  updatedAt?: string | null;
};

type ClaimResult = {
  record: FinancialWorkerEventRecord;
  duplicate: boolean;
};

type ClaimInput = {
  eventId: string;
  eventType: string;
  aggregateType?: string | null;
  aggregateId?: string | null;
  idempotencyKey: string;
  handlerName: string;
  correlationId?: string | null;
  metadata?: Record<string, unknown>;
};

type CompleteInput = {
  eventId: string;
  status: Exclude<FinancialWorkerHandlingStatus, "IN_PROGRESS">;
  metadata?: Record<string, unknown>;
  errorMessage?: string | null;
};

type CashierCompletionEvidence = {
  transactionId: string;
  transactionStatus: string;
  ledgerEntryId: string | null;
  ledgerEntryCount: number;
  outboxEventCount: number;
};

export type FinancialWorkerEventRepository = {
  readonly mode: "postgres" | "in-memory";
  claim(input: ClaimInput): Promise<ClaimResult>;
  complete(input: CompleteInput): Promise<FinancialWorkerEventRecord>;
  getCashierCompletionEvidence(transactionId: string): Promise<CashierCompletionEvidence | null>;
  close(): Promise<void>;
};

type FinancialWorkerEventRow = QueryResultRow & {
  event_id: string;
  event_type: string;
  aggregate_type: string | null;
  aggregate_id: string | null;
  idempotency_key: string;
  handling_status: FinancialWorkerHandlingStatus;
  handler_name: string;
  correlation_id: string | null;
  error_message: string | null;
  metadata: Record<string, unknown> | string | null;
  first_seen_at: Date | string;
  handled_at: Date | string | null;
  updated_at: Date | string | null;
};

type CashierEvidenceRow = QueryResultRow & {
  transaction_id: string;
  transaction_status: string;
  ledger_entry_id: string | null;
  ledger_entry_count: string | number;
  outbox_event_count: string | number;
};

export class FinancialWorkerNonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FinancialWorkerNonRetryableError";
  }
}

function toIso(value: Date | string | null | undefined) {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function rowMetadata(value: Record<string, unknown> | string | null) {
  if (typeof value === "string") {
    return JSON.parse(value) as Record<string, unknown>;
  }

  return value ?? {};
}

function mapWorkerEvent(row: FinancialWorkerEventRow): FinancialWorkerEventRecord {
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    idempotencyKey: row.idempotency_key,
    handlingStatus: row.handling_status,
    handlerName: row.handler_name,
    correlationId: row.correlation_id,
    errorMessage: row.error_message,
    metadata: rowMetadata(row.metadata),
    firstSeenAt: toIso(row.first_seen_at) ?? new Date().toISOString(),
    handledAt: toIso(row.handled_at),
    updatedAt: toIso(row.updated_at),
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function stableEventId(message: QueueMessage) {
  if (message.id?.trim()) {
    return message.id.trim();
  }

  return createHash("sha256")
    .update(
      [
        message.type,
        message.aggregateType ?? "",
        message.aggregateId ?? "",
        stableJson(message.payload ?? {}),
      ].join("|")
    )
    .digest("hex");
}

function eventIdempotencyKey(message: QueueMessage, eventId: string) {
  return `financial-worker:${message.type}:${eventId}`;
}

function getPayloadString(payload: Record<string, unknown>, key: string) {
  const value = payload[key];

  return typeof value === "string" && value.trim() ? value.trim() : null;
}

class InMemoryFinancialWorkerEventRepository implements FinancialWorkerEventRepository {
  readonly mode = "in-memory" as const;
  private readonly events = new Map<string, FinancialWorkerEventRecord>();
  private readonly cashierEvidence = new Map<string, CashierCompletionEvidence>();

  constructor(evidence: CashierCompletionEvidence[] = []) {
    for (const item of evidence) {
      this.cashierEvidence.set(item.transactionId, item);
    }
  }

  async claim(input: ClaimInput): Promise<ClaimResult> {
    const existing = this.events.get(input.eventId);

    if (existing) {
      return { record: existing, duplicate: true };
    }

    const record: FinancialWorkerEventRecord = {
      eventId: input.eventId,
      eventType: input.eventType,
      aggregateType: input.aggregateType ?? null,
      aggregateId: input.aggregateId ?? null,
      idempotencyKey: input.idempotencyKey,
      handlingStatus: "IN_PROGRESS",
      handlerName: input.handlerName,
      correlationId: input.correlationId ?? null,
      errorMessage: null,
      metadata: input.metadata ?? {},
      firstSeenAt: new Date().toISOString(),
      handledAt: null,
      updatedAt: null,
    };

    this.events.set(input.eventId, record);

    return { record, duplicate: false };
  }

  async complete(input: CompleteInput) {
    const existing = this.events.get(input.eventId);

    if (!existing) {
      throw new Error("Financial worker event was not claimed.");
    }

    const completed = {
      ...existing,
      handlingStatus: input.status,
      metadata: {
        ...existing.metadata,
        ...(input.metadata ?? {}),
      },
      errorMessage: input.errorMessage ?? null,
      handledAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.events.set(input.eventId, completed);

    return completed;
  }

  async getCashierCompletionEvidence(transactionId: string) {
    return this.cashierEvidence.get(transactionId) ?? null;
  }

  async close() {
    return;
  }
}

class PostgresFinancialWorkerEventRepository implements FinancialWorkerEventRepository {
  readonly mode = "postgres" as const;

  constructor(private readonly pool: Pool) {}

  async claim(input: ClaimInput): Promise<ClaimResult> {
    const result = await this.pool.query<FinancialWorkerEventRow>(
      `
insert into public.financial_worker_event_handlers (
  event_id,
  event_type,
  aggregate_type,
  aggregate_id,
  idempotency_key,
  handling_status,
  handler_name,
  correlation_id,
  metadata
)
values ($1, $2, $3, $4, $5, 'IN_PROGRESS', $6, $7, $8::jsonb)
on conflict (event_id) do nothing
returning *
`,
      [
        input.eventId,
        input.eventType,
        input.aggregateType ?? null,
        input.aggregateId ?? null,
        input.idempotencyKey,
        input.handlerName,
        input.correlationId ?? null,
        JSON.stringify(input.metadata ?? {}),
      ]
    );

    if (result.rows[0]) {
      return { record: mapWorkerEvent(result.rows[0]), duplicate: false };
    }

    const existing = await this.pool.query<FinancialWorkerEventRow>(
      `
select *
from public.financial_worker_event_handlers
where event_id = $1
`,
      [input.eventId]
    );

    if (!existing.rows[0]) {
      throw new Error("Unable to claim financial worker event.");
    }

    return { record: mapWorkerEvent(existing.rows[0]), duplicate: true };
  }

  async complete(input: CompleteInput) {
    const result = await this.pool.query<FinancialWorkerEventRow>(
      `
update public.financial_worker_event_handlers
set
  handling_status = $2,
  metadata = coalesce(metadata, '{}'::jsonb) || $3::jsonb,
  error_message = $4,
  handled_at = now()
where event_id = $1
returning *
`,
      [
        input.eventId,
        input.status,
        JSON.stringify(input.metadata ?? {}),
        input.errorMessage ?? null,
      ]
    );

    if (!result.rows[0]) {
      throw new Error("Unable to complete financial worker event.");
    }

    return mapWorkerEvent(result.rows[0]);
  }

  async getCashierCompletionEvidence(transactionId: string) {
    const result = await this.pool.query<CashierEvidenceRow>(
      `
select
  ct.id::text as transaction_id,
  ct.status as transaction_status,
  ct.ledger_entry_id::text as ledger_entry_id,
  (
    select count(*)::text
    from public.financial_ledger_entries fle
    where fle.reference_type = 'cashier_transaction'
      and fle.reference_id = ct.id::text
  ) as ledger_entry_count,
  (
    select count(*)::text
    from public.outbox_events oe
    where oe.event_type = 'cashier.transaction.completed'
      and oe.aggregate_type = 'cashier_transaction'
      and oe.aggregate_id = ct.id::text
  ) as outbox_event_count
from public.cashier_transactions ct
where ct.id = $1
`,
      [transactionId]
    );

    const row = result.rows[0];

    if (!row) {
      return null;
    }

    return {
      transactionId: row.transaction_id,
      transactionStatus: row.transaction_status,
      ledgerEntryId: row.ledger_entry_id,
      ledgerEntryCount: Number(row.ledger_entry_count),
      outboxEventCount: Number(row.outbox_event_count),
    };
  }

  async close() {
    await this.pool.end();
  }
}

export function createInMemoryFinancialWorkerEventRepository(
  evidence: CashierCompletionEvidence[] = []
): FinancialWorkerEventRepository {
  return new InMemoryFinancialWorkerEventRepository(evidence);
}

export async function createFinancialWorkerEventRepository({
  databaseUrl = process.env.DATABASE_URL,
}: {
  databaseUrl?: string | null;
} = {}): Promise<FinancialWorkerEventRepository> {
  if (!databaseUrl) {
    return createInMemoryFinancialWorkerEventRepository();
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 1_000,
    max: 4,
  });

  try {
    await pool.query("select 1");
    return new PostgresFinancialWorkerEventRepository(pool);
  } catch {
    await pool.end();
    return createInMemoryFinancialWorkerEventRepository();
  }
}

function resultFromRecord(
  record: FinancialWorkerEventRecord,
  duplicate: boolean,
  message: string
): FinancialWorkerHandlingResult {
  const status: Exclude<FinancialWorkerHandlingStatus, "IN_PROGRESS"> =
    record.handlingStatus === "IN_PROGRESS" ? "FAILED" : record.handlingStatus;

  return {
    eventId: record.eventId,
    eventType: record.eventType,
    status,
    duplicate,
    message,
    metadata: record.metadata,
  };
}

async function failEvent({
  repository,
  eventId,
  message,
  metadata,
}: {
  repository: FinancialWorkerEventRepository;
  eventId: string;
  message: string;
  metadata: Record<string, unknown>;
}): Promise<never> {
  await repository.complete({
    eventId,
    status: "FAILED",
    errorMessage: message,
    metadata,
  });

  throw new FinancialWorkerNonRetryableError(message);
}

async function handleCashierCompletion({
  message,
  repository,
  eventId,
}: {
  message: QueueMessage;
  repository: FinancialWorkerEventRepository;
  eventId: string;
}) {
  const transactionId =
    getPayloadString(message.payload, "transactionId") ??
    (message.aggregateType === "cashier_transaction" ? message.aggregateId : null);

  if (!transactionId) {
    return failEvent({
      repository,
      eventId,
      message: "cashier.transaction.completed payload requires transactionId.",
      metadata: { payload: message.payload },
    });
  }

  const evidence = await repository.getCashierCompletionEvidence(transactionId);

  if (!evidence) {
    return failEvent({
      repository,
      eventId,
      message: "Cashier transaction completion evidence was not found.",
      metadata: { transactionId },
    });
  }

  if (evidence.transactionStatus !== "COMPLETED") {
    return failEvent({
      repository,
      eventId,
      message: "Cashier transaction is not completed.",
      metadata: { evidence },
    });
  }

  if (!evidence.ledgerEntryId || evidence.ledgerEntryCount !== 1) {
    return failEvent({
      repository,
      eventId,
      message: "Cashier transaction does not have exactly one ledger posting.",
      metadata: { evidence },
    });
  }

  if (evidence.outboxEventCount < 1) {
    return failEvent({
      repository,
      eventId,
      message: "Cashier transaction completion outbox event is missing.",
      metadata: { evidence },
    });
  }

  const completed = await repository.complete({
    eventId,
    status: "HANDLED",
    metadata: {
      transactionId,
      ledgerEntryId: evidence.ledgerEntryId,
      ledgerEntryCount: evidence.ledgerEntryCount,
      outboxEventCount: evidence.outboxEventCount,
      effect: "verified_atomic_completion",
    },
  });

  return resultFromRecord(
    completed,
    false,
    "cashier.transaction.completed verified idempotently."
  );
}

async function handleNoOp({
  message,
  repository,
  eventId,
  reason,
}: {
  message: QueueMessage;
  repository: FinancialWorkerEventRepository;
  eventId: string;
  reason: string;
}) {
  const completed = await repository.complete({
    eventId,
    status: "NO_OP",
    metadata: {
      reason,
      eventType: message.type,
      aggregateType: message.aggregateType ?? null,
      aggregateId: message.aggregateId ?? null,
    },
  });

  return resultFromRecord(completed, false, reason);
}

export async function handleWorkloadMessage({
  category,
  message,
  repository,
}: {
  category: QueueWorkloadCategory;
  message: QueueMessage;
  repository?: FinancialWorkerEventRepository;
}): Promise<FinancialWorkerHandlingResult> {
  const resolvedRepository =
    repository ?? (await createFinancialWorkerEventRepository());
  const shouldCloseRepository = !repository;
  const eventId = stableEventId(message);
  const handlerName = `${category.toLowerCase()}-worker`;

  try {
    const claim = await resolvedRepository.claim({
      eventId,
      eventType: message.type,
      aggregateType: message.aggregateType ?? null,
      aggregateId: message.aggregateId ?? null,
      idempotencyKey: eventIdempotencyKey(message, eventId),
      handlerName,
      correlationId: message.correlationId ?? null,
      metadata: {
        category,
        payload: message.payload,
      },
    });

    if (claim.duplicate) {
      logger.info({
        message: "Worker event already handled or claimed.",
        correlationId: message.correlationId ?? null,
        metadata: {
          eventId,
          eventType: message.type,
          status: claim.record.handlingStatus,
        },
      });

      if (claim.record.handlingStatus === "FAILED") {
        throw new FinancialWorkerNonRetryableError(
          claim.record.errorMessage ?? "Financial worker event previously failed."
        );
      }

      return resultFromRecord(claim.record, true, "duplicate event ignored idempotently.");
    }

    let result: FinancialWorkerHandlingResult;

    if (category === "CRITICAL_FINANCIAL" && message.type === "cashier.transaction.completed") {
      result = await handleCashierCompletion({
        message,
        repository: resolvedRepository,
        eventId,
      });
    } else if (message.type === "settlement.ledger_effect.generated") {
      result = await handleNoOp({
        message,
        repository: resolvedRepository,
        eventId,
        reason:
          "settlement.ledger_effect.generated is not emitted through a production-safe worker mutation path yet.",
      });
    } else if (message.type.startsWith("reconciliation.")) {
      result = await handleNoOp({
        message,
        repository: resolvedRepository,
        eventId,
        reason: "reconciliation worker financial mutation remains no-op in this phase.",
      });
    } else {
      result = await handleNoOp({
        message,
        repository: resolvedRepository,
        eventId,
        reason: "unsupported worker event acknowledged as explicit no-op.",
      });
    }

    logger.info({
      message: "Worker event handled.",
      correlationId: message.correlationId ?? null,
      metadata: result,
    });

    return result;
  } catch (error) {
    logger.error({
      message: "Worker event handling failed.",
      correlationId: message.correlationId ?? null,
      metadata: {
        eventId,
        eventType: message.type,
        error: error instanceof Error ? error.message : "Unknown error",
      },
    });

    throw error;
  } finally {
    if (shouldCloseRepository) {
      await resolvedRepository.close();
    }
  }
}
