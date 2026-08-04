import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

import type { QueueMessage } from "@/src/lib/queue/queue.types";
import type { FinancialWorkerHandlingResult } from "./financial-worker-handlers";

type CanonicalSettlementPayload = {
  settlementRequestId: string;
  outcomeVersionId: string;
  drawId: string;
  requestKind: "Published" | "Corrected" | "Cancelled";
  settlementInputId?: string | null;
  settlementInputHash?: string | null;
  outcomeCertificateId: string;
  outcomeCertificateHash: string;
  auditReference: string;
};

export type CanonicalSettlementProcessingClassification =
  | "SUCCESS"
  | "IDEMPOTENT_DUPLICATE"
  | "TRANSIENT_RETRY"
  | "GOVERNED_RECOVERY_REQUIRED"
  | "TERMINAL_INVALID"
  | "LEGACY_UNPROCESSABLE";

export class CanonicalSettlementProcessingError extends Error {
  readonly workerClassification: CanonicalSettlementProcessingClassification;
  readonly retryable: boolean;

  constructor(
    message: string,
    classification: CanonicalSettlementProcessingClassification,
    retryable = false
  ) {
    super(message);
    this.name = "CanonicalSettlementProcessingError";
    this.workerClassification = classification;
    this.retryable = retryable;
  }
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

function hash(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalMessageHash(message: QueueMessage) {
  return hash(stableJson({
    aggregateId: message.aggregateId ?? null,
    aggregateType: message.aggregateType ?? null,
    eventId: message.id ?? null,
    eventType: message.type,
    payload: message.payload,
  }));
}

function classifyError(error: unknown) {
  if (error instanceof CanonicalSettlementProcessingError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
  const transient =
    code.startsWith("08") ||
    ["40001", "40P01", "53300", "57P01", "57P02", "57P03"].includes(code) ||
    /timeout|connection|temporarily unavailable/i.test(message);
  return new CanonicalSettlementProcessingError(
    message,
    transient ? "TRANSIENT_RETRY" : "TERMINAL_INVALID",
    transient
  );
}

async function appendProcessingEvidence(
  client: Pick<PoolClient, "query">,
  message: QueueMessage,
  classification: CanonicalSettlementProcessingClassification,
  reason: string,
  payload?: CanonicalSettlementPayload | null
) {
  await client.query(
    `
insert into game_engine.canonical_settlement_event_processing_evidence (
  processing_evidence_id, event_id, settlement_request_id, outcome_version_id,
  classification, canonical_message_hash, attempt_number, reason, correlation_id)
select
  $1::uuid, $2, $3::uuid, $4::uuid, $5, $6,
  coalesce(max(attempt_number), 0) + 1, $7, $8
from game_engine.canonical_settlement_event_processing_evidence
where event_id = $2
`,
    [
      randomUUID(),
      message.id ?? "missing-event-id",
      payload?.settlementRequestId ?? null,
      payload?.outcomeVersionId ?? null,
      classification,
      canonicalMessageHash(message),
      reason,
      message.correlationId ?? null,
    ]
  );
}

export async function recordCanonicalSettlementFinalClassification(
  message: QueueMessage,
  classification: "GOVERNED_RECOVERY_REQUIRED" | "TERMINAL_INVALID" | "LEGACY_UNPROCESSABLE",
  reason: string
) {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) return;
  const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 2_000, max: 1 });
  try {
    await appendProcessingEvidence(pool, message, classification, reason, null);
  } finally {
    await pool.end();
  }
}

function deterministicUuid(value: string) {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function requireString(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`settlement.requested payload requires ${key}.`);
  }
  return value.trim();
}

function parsePayload(message: QueueMessage): CanonicalSettlementPayload {
  if (!message.id?.trim()) {
    throw new Error("settlement.requested requires the durable outbox event id.");
  }
  if (message.type !== "settlement.requested") {
    throw new Error("Canonical Settlement handler only accepts settlement.requested.");
  }

  const payload = message.payload;
  const requestKind = requireString(payload, "requestKind");
  if (!["Published", "Corrected", "Cancelled"].includes(requestKind)) {
    throw new Error("settlement.requested requestKind is invalid.");
  }

  const settlementInputId =
    typeof payload.settlementInputId === "string" && payload.settlementInputId.trim()
      ? payload.settlementInputId.trim()
      : null;
  const settlementInputHash =
    typeof payload.settlementInputHash === "string" && payload.settlementInputHash.trim()
      ? payload.settlementInputHash.trim()
      : null;

  if (requestKind === "Cancelled" && (settlementInputId || settlementInputHash)) {
    throw new Error("Cancelled canonical outcomes cannot carry SettlementInput evidence.");
  }
  if (requestKind !== "Cancelled" && (!settlementInputId || !settlementInputHash)) {
    throw new Error("Published and corrected outcomes require SettlementInput evidence.");
  }

  return {
    settlementRequestId: requireString(payload, "settlementRequestId"),
    outcomeVersionId: requireString(payload, "outcomeVersionId"),
    drawId: requireString(payload, "drawId"),
    requestKind: requestKind as CanonicalSettlementPayload["requestKind"],
    settlementInputId,
    settlementInputHash,
    outcomeCertificateId: requireString(payload, "outcomeCertificateId"),
    outcomeCertificateHash: requireString(payload, "outcomeCertificateHash"),
    auditReference: requireString(payload, "auditReference"),
  };
}

async function loadCanonicalEvidence(
  client: PoolClient,
  message: QueueMessage,
  payload: CanonicalSettlementPayload
) {
  const result = await client.query<{
    settlement_request_id: string;
    outcome_version_id: string;
    draw_id: string;
    request_kind: string;
    settlement_input_id: string | null;
    settlement_input_hash: string | null;
    outcome_certificate_id: string;
    outcome_certificate_hash: string;
    outbox_event_id: string;
  }>(
    `
select
  request.settlement_request_id::text,
  request.outcome_version_id::text,
  request.draw_id::text,
  request.request_kind,
  request.settlement_input_id::text,
  input.canonical_payload_hash as settlement_input_hash,
  version.outcome_certificate_id::text,
  version.outcome_certificate_hash,
  request.outbox_event_id::text
from game_engine.outcome_settlement_requests request
join game_engine.canonical_outcome_versions version
  on version.outcome_version_id = request.outcome_version_id
left join game_engine.settlement_input_records input
  on input.settlement_input_id = request.settlement_input_id
where request.settlement_request_id = $1::uuid
for update of request
`,
    [payload.settlementRequestId]
  );
  const evidence = result.rows[0];
  if (!evidence) {
    throw new Error("Current canonical Settlement request evidence was not found.");
  }

  const expected = {
    settlementRequestId: evidence.settlement_request_id,
    outcomeVersionId: evidence.outcome_version_id,
    drawId: evidence.draw_id,
    requestKind: evidence.request_kind,
    settlementInputId: evidence.settlement_input_id,
    settlementInputHash: evidence.settlement_input_hash,
    outcomeCertificateId: evidence.outcome_certificate_id,
    outcomeCertificateHash: evidence.outcome_certificate_hash,
    outboxEventId: evidence.outbox_event_id,
  };
  const received = {
    settlementRequestId: payload.settlementRequestId,
    outcomeVersionId: payload.outcomeVersionId,
    drawId: payload.drawId,
    requestKind: payload.requestKind,
    settlementInputId: payload.settlementInputId ?? null,
    settlementInputHash: payload.settlementInputHash ?? null,
    outcomeCertificateId: payload.outcomeCertificateId,
    outcomeCertificateHash: payload.outcomeCertificateHash,
    outboxEventId: message.id,
  };
  if (stableJson(expected) !== stableJson(received)) {
    throw new Error("settlement.requested does not match canonical durable evidence.");
  }
}

export async function handleCanonicalSettlementRequest(
  message: QueueMessage
): Promise<FinancialWorkerHandlingResult> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for canonical Settlement consumption.");
  }

  let payload: CanonicalSettlementPayload;
  try {
    payload = parsePayload(message);
  } catch (error) {
    const classified = classifyError(error);
    await recordCanonicalSettlementFinalClassification(
      message,
      "TERMINAL_INVALID",
      classified.message
    );
    throw classified;
  }
  const eventId = message.id!.trim();
  const messageHash = canonicalMessageHash(message);
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 2_000,
    max: 2,
  });
  const client = await pool.connect();

  try {
    await client.query("begin");
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`canonical-settlement-consumption:${payload.settlementRequestId}`]
    );
    await loadCanonicalEvidence(client, message, payload);

    const existing = await client.query<{
      canonical_message_hash: string;
      consumption_id: string;
    }>(
      `
select canonical_message_hash, consumption_id::text
from game_engine.outcome_settlement_consumptions
where settlement_request_id = $1::uuid
`,
      [payload.settlementRequestId]
    );
    if (existing.rows[0]) {
      if (existing.rows[0].canonical_message_hash !== messageHash) {
        throw new CanonicalSettlementProcessingError(
          "Conflicting duplicate settlement.requested payload.",
          "TERMINAL_INVALID"
        );
      }
      const completed = await client.query<{ completion_id: string }>(
        `
select completion_id::text
from game_engine.canonical_draw_completion_evidence
where settlement_request_id = $1::uuid
`,
        [payload.settlementRequestId]
      );
      if (completed.rows[0]) {
        await appendProcessingEvidence(
          client,
          message,
          "IDEMPOTENT_DUPLICATE",
          "Canonical Settlement event was already completed.",
          payload
        );
        await client.query("commit");
        return {
          eventId,
          eventType: message.type,
          status: "HANDLED",
          duplicate: true,
          message: "Canonical Settlement acknowledgement already completed this draw.",
          metadata: {
            settlementRequestId: payload.settlementRequestId,
            consumptionId: existing.rows[0].consumption_id,
            completionId: completed.rows[0].completion_id,
          },
        };
      }
    }

    const consumptionId =
      existing.rows[0]?.consumption_id ?? deterministicUuid(`consumption:${eventId}`);
    if (!existing.rows[0]) {
      await client.query(
        `
insert into game_engine.outcome_settlement_consumptions (
  consumption_id,
  settlement_request_id,
  outcome_version_id,
  outbox_event_id,
  consumer_name,
  canonical_message_hash,
  correlation_id,
  audit_reference
)
values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'settlement-worker', $5, $6, $7)
`,
        [
          consumptionId,
          payload.settlementRequestId,
          payload.outcomeVersionId,
          eventId,
          messageHash,
          message.correlationId ?? payload.settlementRequestId,
          payload.auditReference,
        ]
      );
    }

    if (payload.requestKind === "Cancelled") {
      const completionId = deterministicUuid(`completion:${payload.outcomeVersionId}`);
      const completionHash = hash(
        `${payload.drawId}|${payload.outcomeVersionId}|${payload.settlementRequestId}|${consumptionId}|non-financial-cancellation`
      );
      await client.query(
        `
insert into game_engine.canonical_draw_completion_evidence (
  completion_id, draw_id, outcome_version_id, settlement_request_id,
  consumption_id, settlement_acknowledgement_id, completion_kind,
  canonical_evidence_hash)
values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, null, 'Cancelled', $6)
on conflict (outcome_version_id) do nothing
`,
        [
          completionId,
          payload.drawId,
          payload.outcomeVersionId,
          payload.settlementRequestId,
          consumptionId,
          completionHash,
        ]
      );
      await client.query(
        `
insert into game_engine.canonical_draw_orchestration_events (
  orchestration_event_id, draw_id, event_type, evidence_reference,
  canonical_evidence_hash)
values ($1::uuid, $2::uuid, 'DRAW_COMPLETED', $3, $4)
on conflict (draw_id, event_type, evidence_reference) do nothing
`,
        [
          deterministicUuid(`orchestration:draw-cancelled:${completionId}`),
          payload.drawId,
          completionId,
          completionHash,
        ]
      );
      await appendProcessingEvidence(
        client,
        message,
        existing.rows[0] ? "IDEMPOTENT_DUPLICATE" : "SUCCESS",
        "Canonical cancellation acknowledged without fabricated financial SettlementInput.",
        payload
      );
      await client.query("commit");
      return {
        eventId,
        eventType: message.type,
        status: "HANDLED",
        duplicate: Boolean(existing.rows[0]),
        message: "Canonical non-financial cancellation acknowledged.",
        metadata: { completionId, consumptionId, settlementRequestId: payload.settlementRequestId },
      };
    }

    if (!payload.settlementInputId || !payload.settlementInputHash) {
      throw new CanonicalSettlementProcessingError(
        "Canonical financial outcome requires SettlementInput evidence.",
        "TERMINAL_INVALID"
      );
    }

    const settlementEvidence = await client.query<{
      settlement_id: string;
      settlement_request_id: string;
      canonical_settlement_hash: string;
    }>(
      `
select
  record.settlement_id::text,
  record.settlement_request_id::text,
  record.canonical_settlement_hash
from settlement_service.authoritative_settlement_records record
where record.settlement_input_id = $1::uuid
  and record.settlement_input_hash = $2
  and record.outcome_certificate_id = $3::uuid
  and record.outcome_certificate_hash = $4
order by record.issued_at, record.settlement_id
limit 2
`,
      [
        payload.settlementInputId,
        payload.settlementInputHash,
        payload.outcomeCertificateId,
        payload.outcomeCertificateHash,
      ]
    );
    if (settlementEvidence.rowCount !== 1) {
      throw settlementEvidence.rowCount === 0
        ? new CanonicalSettlementProcessingError(
            "Authoritative Settlement acknowledgement is not available yet.",
            "TRANSIENT_RETRY",
            true
          )
        : new CanonicalSettlementProcessingError(
            "Multiple authoritative Settlement records conflict with one canonical request.",
            "TERMINAL_INVALID"
          );
    }

    const authority = settlementEvidence.rows[0];
    const acknowledgementId = deterministicUuid(
      `settlement-acknowledgement:${payload.settlementRequestId}`
    );
    const acknowledgementHash = hash(
      `${payload.settlementRequestId}|${payload.outcomeVersionId}|${consumptionId}|${authority.settlement_request_id}|${authority.settlement_id}|${authority.canonical_settlement_hash}`
    );
    const completionId = deterministicUuid(`completion:${payload.outcomeVersionId}`);
    const completionHash = hash(
      `${payload.drawId}|${payload.outcomeVersionId}|${payload.settlementRequestId}|${acknowledgementId}|${authority.canonical_settlement_hash}`
    );

    await client.query(
      `
insert into game_engine.outcome_settlement_acknowledgements (
  settlement_acknowledgement_id,
  settlement_request_id,
  outcome_version_id,
  consumption_id,
  settlement_authority_request_id,
  authoritative_settlement_id,
  canonical_settlement_hash,
  acknowledgement_status,
  canonical_acknowledgement_hash
)
values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, 'ACKNOWLEDGED', $8)
`,
      [
        acknowledgementId,
        payload.settlementRequestId,
        payload.outcomeVersionId,
        consumptionId,
        authority.settlement_request_id,
        authority.settlement_id,
        authority.canonical_settlement_hash,
        acknowledgementHash,
      ]
    );
    await client.query(
      `
insert into game_engine.canonical_draw_orchestration_events (
  orchestration_event_id,
  draw_id,
  event_type,
  evidence_reference,
  canonical_evidence_hash
)
values ($1::uuid, $2::uuid, 'SETTLEMENT_ACKNOWLEDGED', $3, $4)
on conflict (draw_id, event_type, evidence_reference) do nothing
`,
      [
        deterministicUuid(`orchestration:settlement-acknowledged:${acknowledgementId}`),
        payload.drawId,
        acknowledgementId,
        acknowledgementHash,
      ]
    );
    await client.query(
      `
insert into game_engine.canonical_draw_completion_evidence (
  completion_id,
  draw_id,
  outcome_version_id,
  settlement_request_id,
  consumption_id,
  settlement_acknowledgement_id,
  completion_kind,
  canonical_evidence_hash
)
values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8)
`,
      [
        completionId,
        payload.drawId,
        payload.outcomeVersionId,
        payload.settlementRequestId,
        consumptionId,
        acknowledgementId,
        payload.requestKind,
        completionHash,
      ]
    );
    await client.query(
      `
insert into game_engine.canonical_draw_orchestration_events (
  orchestration_event_id,
  draw_id,
  event_type,
  evidence_reference,
  canonical_evidence_hash
)
values ($1::uuid, $2::uuid, 'DRAW_COMPLETED', $3, $4)
on conflict (draw_id, event_type, evidence_reference) do nothing
`,
      [
        deterministicUuid(`orchestration:draw-completed:${completionId}`),
        payload.drawId,
        completionId,
        completionHash,
      ]
    );
    await appendProcessingEvidence(
      client,
      message,
      "SUCCESS",
      "Authoritative Settlement acknowledgement bound.",
      payload
    );
    await client.query("commit");

    return {
      eventId,
      eventType: message.type,
      status: "HANDLED",
      duplicate: false,
      message: "Authoritative Settlement acknowledgement bound; draw completion evidence appended.",
      metadata: {
        acknowledgementId,
        authoritativeSettlementId: authority.settlement_id,
        completionId,
        consumptionId,
        outcomeVersionId: payload.outcomeVersionId,
        settlementRequestId: payload.settlementRequestId,
      },
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    const classified = classifyError(error);
    const evidenceClient = await pool.connect();
    try {
      await appendProcessingEvidence(
        evidenceClient,
        message,
        classified.workerClassification,
        classified.message,
        payload
      );
    } finally {
      evidenceClient.release();
    }
    throw classified;
  } finally {
    client.release();
    await pool.end();
  }
}
