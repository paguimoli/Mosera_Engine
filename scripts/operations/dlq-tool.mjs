import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.join("=") || "true"];
  })
);

const mode = args.get("mode") ?? "inspect";
const input = args.get("input");
const evidenceDir =
  args.get("evidence-dir") ??
  process.env.DLQ_EVIDENCE_DIR ??
  ".qa/dlq-operations";

const supportedPrefixes = [
  "financial.",
  "ticket.",
  "settlement.",
  "accounting.",
  "commission.",
  "reconciliation.",
  "operational-access.",
  "reporting.",
];

function fail(message, metadata = {}) {
  console.error(JSON.stringify({ status: "FAIL", message, ...metadata }, null, 2));
  process.exit(1);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readMessages() {
  if (!input) {
    fail("--input=<path> is required.");
  }

  if (!existsSync(input)) {
    fail("DLQ input file does not exist.", { input });
  }

  const raw = readFileSync(input, "utf8");
  const parsed = JSON.parse(raw);
  const messages = Array.isArray(parsed) ? parsed : parsed.messages;

  if (!Array.isArray(messages)) {
    fail("DLQ input must be an array or an object with a messages array.", {
      input,
    });
  }

  return { raw, messages };
}

function validateMessage(message) {
  const reasons = [];
  const payload = message?.payload;
  const type = payload?.type ?? message?.eventType;
  const routingKey = message?.routingKey;

  if (!message || typeof message !== "object") reasons.push("message must be an object");
  if (!message?.messageId || typeof message.messageId !== "string") reasons.push("messageId is required");
  if (!message?.deadLetterQueueName || typeof message.deadLetterQueueName !== "string") {
    reasons.push("deadLetterQueueName is required");
  }
  if (!routingKey || typeof routingKey !== "string") reasons.push("routingKey is required");
  if (!payload || typeof payload !== "object") reasons.push("payload object is required");
  if (!type || typeof type !== "string") reasons.push("payload.type or eventType is required");
  if (!payload?.id || typeof payload.id !== "string") reasons.push("payload.id is required");
  if (!payload?.correlationId || typeof payload.correlationId !== "string") {
    reasons.push("payload.correlationId is required");
  }
  if (!payload?.idempotencyKey && !message?.idempotencyKey) {
    reasons.push("idempotency key evidence is required");
  }
  if (
    typeof routingKey === "string" &&
    !supportedPrefixes.some((prefix) => routingKey.startsWith(prefix))
  ) {
    reasons.push("routingKey is not supported for guarded replay");
  }

  return {
    valid: reasons.length === 0,
    reasons,
    eventType: type ?? "unknown",
    routingKey: routingKey ?? "unknown",
  };
}

function requireReplayApproval() {
  const failures = [];

  if (process.env.DLQ_REPLAY_APPROVED !== "true") {
    failures.push("DLQ_REPLAY_APPROVED must be true.");
  }
  if (process.env.DLQ_REPLAY_IDEMPOTENCY_CONFIRMED !== "true") {
    failures.push("DLQ_REPLAY_IDEMPOTENCY_CONFIRMED must be true.");
  }
  if (!process.env.DLQ_REPLAY_APPROVAL_TOKEN?.trim()) {
    failures.push("DLQ_REPLAY_APPROVAL_TOKEN is required.");
  }
  if (!process.env.DLQ_REPLAY_OPERATOR?.trim()) {
    failures.push("DLQ_REPLAY_OPERATOR is required.");
  }

  if (failures.length > 0) {
    fail("DLQ replay approval requirements were not met.", { failures });
  }
}

function writeEvidence(report) {
  mkdirSync(evidenceDir, { recursive: true });
  const digest = sha256(JSON.stringify(report)).slice(0, 16);
  const evidencePath = join(evidenceDir, `dlq-${mode}-${digest}.json`);
  writeFileSync(evidencePath, JSON.stringify({ ...report, evidencePath }, null, 2));
  return evidencePath;
}

if (!["inspect", "replay"].includes(mode)) {
  fail("--mode must be inspect or replay.", { mode });
}

const { raw, messages } = readMessages();
const inspected = messages.map((message) => {
  const validation = validateMessage(message);

  return {
    messageId: message?.messageId ?? null,
    deadLetterQueueName: message?.deadLetterQueueName ?? null,
    routingKey: validation.routingKey,
    eventType: validation.eventType,
    replayEligible: validation.valid,
    blockedReasons: validation.reasons,
  };
});

const malformedCount = inspected.filter((message) => !message.replayEligible).length;
const eligibleCount = inspected.length - malformedCount;

if (mode === "replay") {
  requireReplayApproval();
}

const replayPlan =
  mode === "replay"
    ? inspected.map((message) => ({
        ...message,
        replayAction: message.replayEligible ? "WOULD_REPLAY_WITH_EXISTING_IDEMPOTENCY_KEY" : "BLOCKED",
      }))
    : [];

const report = {
  status: "PASS",
  mode,
  generatedAtUtc: new Date().toISOString(),
  operationId: randomUUID(),
  sourceDigest: sha256(raw),
  inspectOnly: mode === "inspect",
  replayApproved: mode === "replay",
  messageCount: inspected.length,
  eligibleCount,
  malformedCount,
  unsupportedCount: inspected.filter((message) =>
    message.blockedReasons.includes("routingKey is not supported for guarded replay")
  ).length,
  messages: inspected,
  replayPlan,
  approval: mode === "replay"
    ? {
        operator: process.env.DLQ_REPLAY_OPERATOR,
        approvalTokenDigest: sha256(process.env.DLQ_REPLAY_APPROVAL_TOKEN ?? ""),
        idempotencyConfirmed: process.env.DLQ_REPLAY_IDEMPOTENCY_CONFIRMED === "true",
      }
    : null,
};

const evidencePath = writeEvidence(report);
console.log(JSON.stringify({ ...report, evidencePath }, null, 2));
