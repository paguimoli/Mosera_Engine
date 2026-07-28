import { createHash } from "node:crypto";
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
  and not exists (
    select 1
    from game_engine.canonical_outcome_versions newer
    where newer.draw_id = version.draw_id
      and newer.version_number > version.version_number
  )
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

  const payload = parsePayload(message);
  const eventId = message.id!.trim();
  const canonicalMessageHash = hash(stableJson({
    aggregateId: message.aggregateId ?? null,
    aggregateType: message.aggregateType ?? null,
    eventId,
    eventType: message.type,
    payload: message.payload,
  }));
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
      if (existing.rows[0].canonical_message_hash !== canonicalMessageHash) {
        throw new Error("Conflicting duplicate settlement.requested payload.");
      }
      await client.query("commit");
      return {
        eventId,
        eventType: message.type,
        status: "HANDLED",
        duplicate: true,
        message: "Canonical Settlement request already consumed idempotently.",
        metadata: {
          settlementRequestId: payload.settlementRequestId,
          consumptionId: existing.rows[0].consumption_id,
        },
      };
    }

    const consumptionId = deterministicUuid(`consumption:${eventId}`);
    const completionId = deterministicUuid(`completion:${payload.outcomeVersionId}`);
    const completionHash = hash(
      `${payload.drawId}|${payload.outcomeVersionId}|${payload.settlementRequestId}|${consumptionId}|${canonicalMessageHash}`
    );

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
        canonicalMessageHash,
        message.correlationId ?? payload.settlementRequestId,
        payload.auditReference,
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
  completion_kind,
  canonical_evidence_hash
)
values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7)
`,
      [
        completionId,
        payload.drawId,
        payload.outcomeVersionId,
        payload.settlementRequestId,
        consumptionId,
        payload.requestKind,
        completionHash,
      ]
    );
    await client.query("commit");

    return {
      eventId,
      eventType: message.type,
      status: "HANDLED",
      duplicate: false,
      message: "Canonical Settlement request consumed; draw completion evidence appended.",
      metadata: {
        completionId,
        consumptionId,
        outcomeVersionId: payload.outcomeVersionId,
        settlementRequestId: payload.settlementRequestId,
      },
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
