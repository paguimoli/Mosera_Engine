import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import * as amqp from "amqplib";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL ??
  "postgresql://lottery:lottery_dev_password@127.0.0.1:55432/lottery_local";
const rabbitUrl = process.env.RABBITMQ_URL ??
  "amqp://lottery:lottery_dev_password@127.0.0.1:5672";
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const checks = [];

function check(name, condition, metadata = {}) {
  checks.push({ name, status: condition ? "PASS" : "FAIL", metadata });
}

async function scalar(statement, values = []) {
  const result = await pool.query(statement, values);
  return result.rows[0] ? Object.values(result.rows[0])[0] : null;
}

let rabbit;
let channel;
try {
  const handler = readFileSync("src/domains/workers/canonical-settlement-request-handler.ts", "utf8");
  const consumer = readFileSync("src/lib/queue/rabbitmq/rabbitmq.consumer.ts", "utf8");
  const recovery = readFileSync(
    "services/game-engine/src/GameEngine.Infrastructure/Persistence/PostgresCanonicalOutcomePipelineRepository.cs",
    "utf8",
  );
  const hostedRecovery = readFileSync(
    "services/game-engine/src/GameEngine.Api/Infrastructure/CanonicalOutcomeRecoveryHostedService.cs",
    "utf8",
  );
  const dlqTool = readFileSync("scripts/operations/canonical-settlement-dlq.mjs", "utf8");

  check("one canonical event contract is enforced", consumer.includes(
    "message.contractVersion !== CANONICAL_EVENT_CONTRACT_VERSION"));
  check("superseded lifecycle versions remain consumable", !handler.includes(
    "where newer.draw_id = version.draw_id\n      and newer.version_number > version.version_number"));
  check("valid cancellation has an explicit non-financial completion path",
    handler.includes('payload.requestKind === "Cancelled"') &&
    handler.includes("settlement_acknowledgement_id, completion_kind") &&
    handler.includes("non-financial-cancellation"));
  check("consumer has bounded transient retry and governed exhaustion",
    consumer.includes("WORKER_CANONICAL_RETRY_LIMIT") &&
    consumer.includes("GOVERNED_RECOVERY_REQUIRED"));
  check("recovery uses durable terminal classifications",
    recovery.includes("HasTerminalRecoveryClassificationAsync") &&
    recovery.includes("LEGACY_INSUFFICIENT_EVIDENCE"));
  check("unchanged blocked logging has a bounded summary interval",
    hostedRecovery.includes("TimeSpan.FromMinutes(15)") &&
    hostedRecovery.includes("blockedSignature != lastBlockedSignature"));
  check("DLQ replay requires approval and preserves exact body",
    dlqTool.includes("DLQ_REPLAY_APPROVED") &&
    dlqTool.includes("DLQ_REPLAY_IDEMPOTENCY_CONFIRMED") &&
    dlqTool.includes("original_body_base64") &&
    dlqTool.includes("waitForConfirms"));

  check("processing evidence table is installed", await scalar(
    "select to_regclass('game_engine.canonical_settlement_event_processing_evidence') is not null") === true);
  check("recovery classification table is installed", await scalar(
    "select to_regclass('game_engine.canonical_outcome_recovery_classifications') is not null") === true);
  check("DLQ replay evidence table is installed", await scalar(
    "select to_regclass('game_engine.canonical_settlement_dlq_replay_evidence') is not null") === true);

  const lifecycleSuccess = await pool.query(`
select request.request_kind, count(*)::int as count
from game_engine.canonical_settlement_event_processing_evidence evidence
join game_engine.outcome_settlement_requests request
  on request.settlement_request_id = evidence.settlement_request_id
where evidence.classification in ('SUCCESS', 'IDEMPOTENT_DUPLICATE')
group by request.request_kind
`);
  const lifecycleCounts = Object.fromEntries(lifecycleSuccess.rows.map((row) => [row.request_kind, row.count]));
  check("Published, Corrected, and Cancelled events have successful consumption evidence",
    ["Published", "Corrected", "Cancelled"].every((kind) => Number(lifecycleCounts[kind] ?? 0) > 0),
    { lifecycleCounts });

  const providers = await pool.query(`
select distinct version.outcome_provider_category
from game_engine.canonical_settlement_event_processing_evidence evidence
join game_engine.outcome_settlement_requests request
  on request.settlement_request_id = evidence.settlement_request_id
join game_engine.canonical_outcome_versions version
  on version.outcome_version_id = request.outcome_version_id
where evidence.classification in ('SUCCESS', 'IDEMPOTENT_DUPLICATE')
`);
  const providerSet = new Set(providers.rows.map((row) => row.outcome_provider_category));
  check("all launch provider categories complete the same handoff",
    ["INTERNAL_CSPRNG", "OFFICIAL_RESULTS", "MANUAL_CERTIFIED"].every((item) => providerSet.has(item)),
    { providers: [...providerSet] });

  check("recovered outcome has completed consumption evidence", Number(await scalar(`
select count(*)::int
from game_engine.canonical_outcome_recovery_events recovery
join game_engine.outcome_settlement_requests request
  on request.settlement_request_id = recovery.settlement_request_id
join game_engine.canonical_draw_completion_evidence completion
  on completion.settlement_request_id = request.settlement_request_id
where recovery.recovery_action = 'REQUEST_CREATED'
`)) > 0);

  const historicalClassifications = Number(await scalar(`
select count(distinct classification.outcome_version_id)::int
from game_engine.canonical_outcome_recovery_classifications classification
join game_engine.canonical_outcome_versions version
  on version.outcome_version_id = classification.outcome_version_id
where version.actor_reference = 'operator:bf-4.7-qa'
  and classification.classification = 'LEGACY_INSUFFICIENT_EVIDENCE'
`));
  check("the historical blocked recovery records are durably classified",
    historicalClassifications >= 4, { historicalClassifications });

  check("no unclassified missing Settlement request remains", Number(await scalar(`
select count(*)::int
from game_engine.canonical_outcome_versions version
where not exists (
  select 1 from game_engine.canonical_outcome_versions newer
  where newer.draw_id = version.draw_id and newer.version_number > version.version_number)
and not exists (
  select 1 from game_engine.outcome_settlement_requests request
  where request.outcome_version_id = version.outcome_version_id)
and not exists (
  select 1 from game_engine.canonical_outcome_recovery_classifications classification
  where classification.outcome_version_id = version.outcome_version_id
    and classification.classification in (
      'GOVERNED_MANUAL_INTERVENTION_REQUIRED', 'LEGACY_INSUFFICIENT_EVIDENCE',
      'TERMINAL_INVALID', 'COMPLETED_STALE_PROJECTION'))
`)) === 0);

  check("no duplicate Settlement consumption exists", Number(await scalar(`
select count(*)::int from (
  select settlement_request_id from game_engine.outcome_settlement_consumptions
  group by settlement_request_id having count(*) > 1
) duplicates
`)) === 0);
  check("no duplicate canonical completion exists", Number(await scalar(`
select count(*)::int from (
  select outcome_version_id from game_engine.canonical_draw_completion_evidence
  group by outcome_version_id having count(*) > 1
) duplicates
`)) === 0);

  let immutable = false;
  try {
    await pool.query(`update game_engine.canonical_outcome_recovery_classifications
      set reason = 'tampered' where recovery_classification_id = (
        select recovery_classification_id from game_engine.canonical_outcome_recovery_classifications limit 1)`);
  } catch { immutable = true; }
  check("recovery classifications remain append-only", immutable);

  rabbit = await amqp.connect(rabbitUrl);
  channel = await rabbit.createConfirmChannel();
  let queue = await channel.checkQueue("lottery.settlement.events.dlq");
  check("Settlement DLQ begins without unresolved canonical events", queue.messageCount === 0, queue);

  const unsupportedEventId = randomUUID();
  const unsupported = {
    id: unsupportedEventId,
    type: "settlement.requested",
    contractVersion: "9.9.9",
    payload: {
      settlementRequestId: randomUUID(), outcomeVersionId: randomUUID(), drawId: randomUUID(),
      requestKind: "Published", settlementInputId: randomUUID(),
      settlementInputHash: "sha256:unsupported", outcomeCertificateId: randomUUID(),
      outcomeCertificateHash: "sha256:unsupported", auditReference: "qa:unsupported-contract",
      executionManifestId: randomUUID(), executionManifestHash: "sha256:unsupported",
      providerEvidenceId: randomUUID(),
    },
    idempotencyKey: unsupportedEventId,
    correlationId: `qa:${unsupportedEventId}`,
    causationId: `qa:${unsupportedEventId}`,
    aggregateType: "canonical_outcome",
    aggregateId: randomUUID().replaceAll("-", ""),
    occurredAt: new Date().toISOString(),
  };
  channel.publish("lottery.events", "settlement.requested", Buffer.from(JSON.stringify(unsupported)), {
    persistent: true, contentType: "application/json", messageId: unsupportedEventId,
  });
  channel.publish("lottery.events", "settlement.requested", Buffer.from("{malformed-json"), {
    persistent: true, contentType: "application/json", messageId: randomUUID(),
  });
  await channel.waitForConfirms();
  const deadline = Date.now() + 15_000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 250));
    queue = await channel.checkQueue("lottery.settlement.events.dlq");
  } while (queue.messageCount < 2 && Date.now() < deadline);
  check("unsupported contract and malformed envelope are terminally DLQed", queue.messageCount === 2, queue);
  await channel.close();
  await rabbit.close();
  channel = undefined;
  rabbit = undefined;

  const replay = spawnSync(process.execPath, [
    "scripts/operations/canonical-settlement-dlq.mjs", "--mode=replay", "--limit=10",
  ], {
    cwd: process.cwd(), encoding: "utf8", timeout: 30_000,
    env: {
      ...process.env, DATABASE_URL: databaseUrl, RABBITMQ_URL: rabbitUrl,
      DLQ_REPLAY_APPROVED: "true", DLQ_REPLAY_IDEMPOTENCY_CONFIRMED: "true",
      DLQ_REPLAY_APPROVAL_TOKEN: "qa-terminal-classification",
      DLQ_REPLAY_OPERATOR: "qa:outcome-settlement-remediation",
    },
  });
  check("governed replay tool terminally classifies malformed envelopes",
    replay.status === 0, { status: replay.status, stdout: replay.stdout, stderr: replay.stderr });

  rabbit = await amqp.connect(rabbitUrl);
  channel = await rabbit.createChannel();
  queue = await channel.checkQueue("lottery.settlement.events.dlq");
  check("Settlement DLQ ends without unresolved canonical events", queue.messageCount === 0, queue);
  check("terminal DLQ classifications retain durable envelopes", Number(await scalar(`
select count(*)::int
from game_engine.canonical_settlement_dlq_replay_evidence
where replay_result = 'TERMINAL_CLASSIFIED'
  and original_body_base64 <> ''
`)) >= 2);
} catch (error) {
  check("Outcome-to-Settlement remediation QA completes", false, {
    error: error instanceof Error ? error.message : String(error),
  });
} finally {
  await channel?.close().catch(() => undefined);
  await rabbit?.close().catch(() => undefined);
  await pool.end();
}

const failures = checks.filter((entry) => entry.status !== "PASS");
console.log(JSON.stringify({ status: failures.length === 0 ? "PASS" : "FAIL", checks }, null, 2));
if (failures.length > 0) process.exitCode = 1;
