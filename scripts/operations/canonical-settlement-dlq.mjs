import { createHash, randomUUID } from "node:crypto";

import * as amqp from "amqplib";
import pg from "pg";

const { Pool } = pg;
const args = new Map(process.argv.slice(2).map((argument) => {
  const [key, ...value] = argument.replace(/^--/, "").split("=");
  return [key, value.join("=") || "true"];
}));
const mode = args.get("mode") ?? "inspect";
const limit = Number(args.get("limit") ?? 100);
const sourceQueue = args.get("queue") ?? "lottery.settlement.events.dlq";
const exchange = args.get("exchange") ?? "lottery.events";
const routingKey = "settlement.requested";
const rabbitUrl = process.env.RABBITMQ_URL ?? "amqp://lottery:lottery_dev_password@127.0.0.1:5672";
const databaseUrl = process.env.DATABASE_URL;

function fail(message, metadata = {}) {
  console.error(JSON.stringify({ status: "FAIL", message, ...metadata }, null, 2));
  process.exitCode = 1;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function requireReplayApproval() {
  const failures = [];
  if (process.env.DLQ_REPLAY_APPROVED !== "true") failures.push("DLQ_REPLAY_APPROVED must be true.");
  if (process.env.DLQ_REPLAY_IDEMPOTENCY_CONFIRMED !== "true") {
    failures.push("DLQ_REPLAY_IDEMPOTENCY_CONFIRMED must be true.");
  }
  if (!process.env.DLQ_REPLAY_APPROVAL_TOKEN?.trim()) {
    failures.push("DLQ_REPLAY_APPROVAL_TOKEN is required.");
  }
  if (!process.env.DLQ_REPLAY_OPERATOR?.trim()) failures.push("DLQ_REPLAY_OPERATOR is required.");
  if (!databaseUrl) failures.push("DATABASE_URL is required for durable replay evidence.");
  if (failures.length > 0) throw new Error(failures.join(" "));
}

function validateEnvelope(envelope) {
  const reasons = [];
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return ["Envelope must be a JSON object."];
  }
  if (typeof envelope.id !== "string" || !envelope.id.trim()) reasons.push("Event id is required.");
  if (envelope.contractVersion !== "1.0.0") reasons.push("Unsupported contract version.");
  if (envelope.type !== "settlement.requested") reasons.push("Unsupported event type.");
  if (envelope.idempotencyKey !== envelope.id) reasons.push("Idempotency key must equal event id.");
  if (typeof envelope.occurredAt !== "string" || !envelope.occurredAt.trim()) {
    reasons.push("Occurred-at timestamp is required.");
  }
  if (typeof envelope.correlationId !== "string" || !envelope.correlationId.trim()) {
    reasons.push("Correlation id is required.");
  }
  if (typeof envelope.causationId !== "string" || !envelope.causationId.trim()) {
    reasons.push("Causation id is required.");
  }
  const payload = envelope.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    reasons.push("Payload object is required.");
    return reasons;
  }
  for (const key of [
    "settlementRequestId", "outcomeVersionId", "drawId",
    "outcomeCertificateId", "outcomeCertificateHash", "auditReference",
    "executionManifestId", "executionManifestHash", "providerEvidenceId",
  ]) {
    if (typeof payload[key] !== "string" || !payload[key].trim()) reasons.push(`${key} is required.`);
  }
  if (!["Published", "Corrected", "Cancelled"].includes(payload.requestKind)) {
    reasons.push("requestKind is invalid.");
  }
  const hasSettlementInput =
    typeof payload.settlementInputId === "string" && payload.settlementInputId.trim() &&
    typeof payload.settlementInputHash === "string" && payload.settlementInputHash.trim();
  if (payload.requestKind === "Cancelled" && hasSettlementInput) {
    reasons.push("Cancelled outcome cannot contain SettlementInput.");
  }
  if (payload.requestKind !== "Cancelled" && !hasSettlementInput) {
    reasons.push("Financial outcome requires SettlementInput.");
  }
  return reasons;
}

function serializableProperties(properties) {
  return {
    contentType: properties.contentType ?? null,
    contentEncoding: properties.contentEncoding ?? null,
    headers: properties.headers ?? {},
    deliveryMode: properties.deliveryMode ?? null,
    priority: properties.priority ?? null,
    correlationId: properties.correlationId ?? null,
    replyTo: properties.replyTo ?? null,
    expiration: properties.expiration ?? null,
    messageId: properties.messageId ?? null,
    timestamp: properties.timestamp ?? null,
    type: properties.type ?? null,
    userId: properties.userId ?? null,
    appId: properties.appId ?? null,
  };
}

async function recordEvidence(pool, operationId, rawMessage, envelope, result, reason) {
  const body = rawMessage.content;
  const eventId = typeof envelope?.id === "string" && envelope.id.trim()
    ? envelope.id.trim()
    : `malformed:${sha256(body).slice(7, 39)}`;
  await pool.query(`
insert into game_engine.canonical_settlement_dlq_replay_evidence (
  replay_evidence_id, operation_id, event_id, source_queue,
  original_routing_key, original_envelope, original_body_base64,
  original_properties, original_envelope_hash, replay_result,
  approval_token_hash, operator_reference, reason)
values ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7, $8::jsonb,
  $9, $10, $11, $12, $13)
on conflict (operation_id, event_id) do nothing
`, [
    randomUUID(), operationId, eventId, sourceQueue, routingKey,
    JSON.stringify(envelope ?? { malformedBodyBase64: body.toString("base64") }),
    body.toString("base64"), JSON.stringify(serializableProperties(rawMessage.properties)),
    sha256(body), result, sha256(process.env.DLQ_REPLAY_APPROVAL_TOKEN ?? ""),
    process.env.DLQ_REPLAY_OPERATOR, reason,
  ]);
}

if (!["inspect", "replay"].includes(mode)) {
  fail("--mode must be inspect or replay.");
} else if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
  fail("--limit must be an integer from 1 through 1000.");
} else {
  let connection;
  let channel;
  let pool;
  try {
    if (mode === "replay") requireReplayApproval();
    connection = await amqp.connect(rabbitUrl);
    channel = mode === "replay"
      ? await connection.createConfirmChannel()
      : await connection.createChannel();
    await channel.assertQueue(sourceQueue, { durable: true });
    const messages = [];
    for (let index = 0; index < limit; index += 1) {
      const message = await channel.get(sourceQueue, { noAck: false });
      if (!message) break;
      messages.push(message);
    }

    const operationId = randomUUID();
    const report = [];
    if (mode === "inspect") {
      for (const message of messages) {
        let envelope;
        try { envelope = JSON.parse(message.content.toString("utf8")); } catch {}
        const reasons = validateEnvelope(envelope);
        report.push({
          eventId: envelope?.id ?? null,
          eventType: envelope?.type ?? null,
          requestKind: envelope?.payload?.requestKind ?? null,
          envelopeHash: sha256(message.content),
          replayEligible: reasons.length === 0,
          reasons,
        });
      }
      for (const message of messages.reverse()) channel.nack(message, false, true);
    } else {
      pool = new Pool({ connectionString: databaseUrl, max: 1 });
      await channel.assertExchange(exchange, "topic", { durable: true });
      for (const message of messages) {
        let envelope;
        try { envelope = JSON.parse(message.content.toString("utf8")); } catch {}
        const reasons = validateEnvelope(envelope);
        if (reasons.length > 0) {
          await recordEvidence(pool, operationId, message, envelope, "TERMINAL_CLASSIFIED", reasons.join(" "));
          channel.ack(message);
          report.push({ eventId: envelope?.id ?? null, result: "TERMINAL_CLASSIFIED", reasons });
          continue;
        }
        const published = channel.publish(exchange, routingKey, message.content, {
          ...message.properties,
          persistent: true,
          headers: {
            ...(message.properties.headers ?? {}),
            "x-mosera-dlq-replay-operation-id": operationId,
            "x-mosera-original-event-id": envelope.id,
          },
        });
        if (!published) await new Promise((resolve) => channel.once("drain", resolve));
        await channel.waitForConfirms();
        await recordEvidence(pool, operationId, message, envelope, "REPLAYED", "Governed idempotent replay confirmed by RabbitMQ.");
        channel.ack(message);
        report.push({ eventId: envelope.id, result: "REPLAYED", envelopeHash: sha256(message.content) });
      }
    }
    console.log(JSON.stringify({
      status: "PASS", mode, operationId, sourceQueue,
      inspected: messages.length, results: report,
    }, null, 2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    await pool?.end().catch(() => undefined);
    await channel?.close().catch(() => undefined);
    await connection?.close().catch(() => undefined);
  }
}
