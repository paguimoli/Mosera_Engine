import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import {
  appendCertifiedProviderResult,
  canonicalHash,
  createCanonicalOutcomeFixture,
} from "./lib/canonical-outcome-authority-fixture.mjs";

const gameEngineUrl = process.env.QA_GAME_ENGINE_URL ?? "http://127.0.0.1:5500";
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://lottery:lottery_dev_password@127.0.0.1:55432/lottery_local";
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const checks = [];

function pass(name, metadata = {}) {
  checks.push({ name, status: "PASS", metadata });
}

function fail(name, metadata = {}) {
  checks.push({ name, status: "FAIL", metadata });
  throw new Error(name);
}

function assert(condition, name, metadata = {}) {
  if (!condition) fail(name, metadata);
  pass(name, metadata);
}

function hash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function runDocker(...args) {
  const result = spawnSync("docker", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      COMPOSE_PROJECT_NAME: process.env.COMPOSE_PROJECT_NAME ?? "lottery-app",
    },
  });
  if (result.status !== 0) {
    fail(`docker ${args.join(" ")} succeeds`, {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  return result.stdout.trim();
}

async function waitFor(name, probe, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    try {
      lastValue = await probe();
      if (lastValue) {
        pass(name);
        return lastValue;
      }
    } catch (error) {
      lastValue = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail(name, { lastValue });
}

async function post(path, body) {
  const response = await fetch(`${gameEngineUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

async function scalar(statement, values = []) {
  const result = await pool.query(statement, values);
  return result.rows[0] ? Object.values(result.rows[0])[0] : null;
}

async function seedCertifiedOutcome(suffix) {
  const fixture = await createCanonicalOutcomeFixture(pool, { suffix });
  const result = await appendCertifiedProviderResult(pool, fixture);
  const settlementInputId = randomUUID();
  const mathCertificateId = randomUUID();
  const ticketId = randomUUID();
  const ticketLineId = randomUUID();
  const mathHash = hash(`math:${suffix}`);
  const canonicalSettlementPayload = {
    mathEvaluationCertificateHash: mathHash,
    prizeFactsHash: mathHash,
    ticketReference: `ticket:${suffix}`,
  };
  const canonicalPayload = (await pool.query(
    "select $1::jsonb::text as value",
    [JSON.stringify(canonicalSettlementPayload)],
  )).rows[0].value;
  await pool.query(`
insert into game_engine.settlement_input_records (
  settlement_input_id, math_evaluation_certificate_id,
  math_evaluation_certificate_hash, outcome_certificate_id,
  outcome_certificate_hash, ticket_reference, game_manifest_id,
  game_manifest_version, game_manifest_hash, math_model_id, math_model_version,
  math_model_hash, paytable_id, paytable_version, paytable_hash,
  evaluator_version, evaluation_outcome, prize_tier, prize_facts,
  prize_facts_hash, payout_units, multiplier, replay_hash, idempotency_key,
  issued_at, provenance, canonical_payload, canonical_payload_hash)
values (
  $1, $2, $3, $4, $5, $6, 'manifest:orchestration-qa', '1.0.0', $7,
  'math:orchestration-qa', '1.0.0', $8, 'paytable:orchestration-qa',
  '1.0.0', $9, $10, 'Win', 'QA', $11::jsonb, $3, 1, 1,
  $12, $13, now(), '{"authority":"MathAuthority"}'::jsonb, $14::jsonb, $15);
`, [
    settlementInputId, mathCertificateId, mathHash, result.certificateId,
    result.outcomeHash, ticketId, hash(`manifest:${suffix}`),
    hash(`math-model:${suffix}`), hash(`paytable:${suffix}`), fixture.evaluatorVersion,
    JSON.stringify({ outcome: "Win", prizeTier: "QA", payoutUnits: 1, multiplier: 1 }),
    hash(`replay:${suffix}`), `settlement-input:${suffix}`, canonicalPayload,
    canonicalHash(canonicalPayload),
  ]);
  return {
    certificateId: result.certificateId,
    drawId: fixture.drawId,
    mathCertificateId,
    mathHash,
    outcomeHash: result.outcomeHash,
    settlementInputId,
    ticketId,
    ticketLineId,
  };
}

async function seedAuthoritativeSettlement(evidence, suffix) {
  const organizationId = randomUUID();
  const tenantId = randomUUID();
  const brandId = randomUUID();
  const playerId = randomUUID();
  const walletId = randomUUID();
  const reservationOperationId = randomUUID();
  const authorityRequestId = randomUUID();
  const settlementId = randomUUID();
  const compactSuffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const gameReference = "manifest:orchestration-qa:1.0.0";
  const drawOutcomeReference =
    `${evidence.certificateId.replaceAll("-", "")}:${evidence.outcomeHash}`;

  await pool.query(
    `
insert into platform.organizations
  (id, organization_code, name, status, version, content_hash, audit_metadata)
values ($1, $2, $3, 'Active', '1.0.0', $4, '{"source":"bf-4.1"}'::jsonb);
`,
    [
      organizationId,
      `bf-4-1-org-${compactSuffix}`,
      `BF-4.1 Organization ${compactSuffix}`,
      hash(`organization:${suffix}`),
    ],
  );
  await pool.query(
    `
insert into platform.tenants (
  id, organization_id, tenant_code, name, status, default_language,
  default_currency, default_timezone, credit_enabled, cashier_enabled,
  version, content_hash, audit_metadata)
values (
  $1, $2, $3, $4, 'Active', 'en', 'USD', 'UTC', true, false,
  '1.0.0', $5, '{"source":"bf-4.1"}'::jsonb);
`,
    [
      tenantId,
      organizationId,
      `bf-4-1-tenant-${compactSuffix}`,
      `BF-4.1 Tenant ${compactSuffix}`,
      hash(`tenant:${suffix}`),
    ],
  );
  await pool.query(
    `
insert into platform.brands (
  id, tenant_id, brand_code, name, display_name, status, version,
  content_hash, audit_metadata)
values (
  $1, $2, $3, $3, $3, 'Active', '1.0.0', $4,
  '{"source":"bf-4.1"}'::jsonb);
`,
    [brandId, tenantId, `bf-4-1-brand-${compactSuffix}`, hash(`brand:${suffix}`)],
  );
  await pool.query(
    `
insert into public.accounts (id, account_type, account_code, display_name, status)
values ($1, 'PLAYER', $2, $3, 'ACTIVE');
`,
    [playerId, `bf-4-1-player-${compactSuffix}`, `BF-4.1 Player ${compactSuffix}`],
  );
  await pool.query(
    `
insert into public.financial_wallets (
  id, account_id, wallet_type, currency_code, balance_authority, status,
  balance, credit_limit, funding_model)
values ($1, $2, 'CREDIT', 'USD', 'INTERNAL', 'ACTIVE', 100000, 100000, 'HYBRID');
`,
    [walletId, playerId],
  );
  await pool.query(
    `
insert into credit_wallet_service.wallet_scopes (
  wallet_id, tenant_id, brand_id, player_id, instrument_code, currency,
  authority, audit_metadata)
values (
  $1, $2, $3, $4, 'CREDIT', 'USD', 'CREDIT_WALLET_SERVICE',
  '{"source":"bf-4.1"}'::jsonb);
`,
    [walletId, tenantId, brandId, playerId],
  );
  const reservation = await pool.query(
    `
select credit_wallet_service.reserve_wallet(
  $1, $2, $3, $4, $5, 'CREDIT', $6, 100, 'USD', $7, $8,
  '{"source":"bf-4.1"}'::jsonb) as reservation;
`,
    [
      reservationOperationId,
      walletId,
      tenantId,
      brandId,
      playerId,
      evidence.ticketId,
      `bf-4.1:reservation:${suffix}`,
      `bf-4.1:correlation:${suffix}`,
    ],
  );
  const reservationId = reservation.rows[0]?.reservation?.id;
  if (!reservationId) {
    throw new Error("Canonical Settlement reservation fixture was not created.");
  }
  const scopeHash = hash(
    [
      tenantId,
      brandId,
      playerId,
      reservationId,
      evidence.ticketId,
      gameReference,
      drawOutcomeReference,
    ].join("|"),
  );

  await pool.query(
    `
insert into settlement_service.settlement_requests (
  settlement_request_id, idempotency_key, canonical_request_hash,
  settlement_input_id, settlement_input_hash, math_evaluation_certificate_id,
  math_evaluation_certificate_hash, outcome_certificate_id, outcome_certificate_hash,
  ticket_id, ticket_line_id, player_account_reference,
  accepted_wager_financial_context_reference, accepted_stake_amount_minor,
  currency, minor_unit_precision, rounding_policy_reference,
  credit_reservation_reference, settlement_policy_version, accepted_at,
  mode, status, request_provenance, tenant_id, brand_id, game_reference,
  draw_outcome_reference, scope_hash)
select
  $1, $2, $3, input.settlement_input_id, input.canonical_payload_hash,
  input.math_evaluation_certificate_id, input.math_evaluation_certificate_hash,
  input.outcome_certificate_id, input.outcome_certificate_hash,
  $4, $5, $6, $7, 100, 'USD', 2, 'rounding:v1', $8,
  'settlement:v1', now(), 'DryRun', 'Accepted',
  '{"source":"bf-4.1"}'::jsonb, $9, $10, $11, $12, $13
from game_engine.settlement_input_records input
where input.settlement_input_id = $14;
`,
    [
      authorityRequestId,
      `bf-4.1-authority-request:${suffix}`,
      hash(`authority-request:${suffix}`),
      evidence.ticketId,
      evidence.ticketLineId,
      playerId,
      `financial-context:${suffix}`,
      reservationId,
      tenantId,
      brandId,
      gameReference,
      drawOutcomeReference,
      scopeHash,
      evidence.settlementInputId,
    ],
  );
  await pool.query(
    `
insert into settlement_service.authoritative_settlement_records (
  settlement_id, settlement_request_id, settlement_input_id, settlement_input_hash,
  math_evaluation_certificate_id, math_evaluation_certificate_hash,
  outcome_certificate_id, outcome_certificate_hash, ticket_id, ticket_line_id,
  player_account_reference, currency, minor_unit_precision, stake_amount_minor,
  gross_payout_amount_minor, net_result_amount_minor, settlement_outcome,
  policy_version, canonical_settlement_hash, idempotency_key, issued_at,
  provenance, tenant_id, brand_id, game_reference, draw_outcome_reference, scope_hash)
select
  $1, request.settlement_request_id, request.settlement_input_id,
  request.settlement_input_hash, request.math_evaluation_certificate_id,
  request.math_evaluation_certificate_hash, request.outcome_certificate_id,
  request.outcome_certificate_hash, request.ticket_id, request.ticket_line_id,
  request.player_account_reference, 'USD', 2, 100, 200, 100, 'WIN',
  'settlement:v1', $2, $3, now(), '{"authority":"SettlementAuthority"}'::jsonb,
  request.tenant_id, request.brand_id, request.game_reference,
  request.draw_outcome_reference, request.scope_hash
from settlement_service.settlement_requests request
where request.settlement_request_id = $4;
`,
    [
      settlementId,
      hash(`authoritative-settlement:${suffix}`),
      `bf-4.1-authority-record:${suffix}`,
      authorityRequestId,
    ],
  );
}

async function publish(evidence, suffix) {
  return post("/api/game-engine/outcome-publications", {
    idempotencyKey: `orchestration-publication:${suffix}`,
    drawId: evidence.drawId,
    productReference: "keno:orchestration-qa",
    engineName: "game-engine",
    engineVersion: "p1-012.2",
    outcomeCertificateId: evidence.certificateId,
    outcomeCertificateHash: evidence.outcomeHash,
    versionKind: "Published",
    previousOutcomeVersionId: null,
    authoritativeSource: "OutcomeCertificate",
    correlationId: `orchestration:${suffix}`,
    causationId: `draw-execution:${suffix}`,
    auditReference: `audit:${suffix}`,
    actorReference: "worker:canonical-draw-orchestration-qa",
    reasonCode: "CERTIFIED_RESULT_PUBLICATION",
    lifecycleEvidenceHash: hash(`lifecycle:${suffix}`),
  });
}

async function requestSettlement(outcomeVersionId, evidence, suffix) {
  return post("/api/game-engine/outcome-settlement-requests", {
    idempotencyKey: `orchestration-settlement:${suffix}`,
    outcomeVersionId,
    settlementInputId: evidence.settlementInputId,
    correlationId: `orchestration:${suffix}`,
    causationId: `publication:${outcomeVersionId}`,
    auditReference: `audit:settlement:${suffix}`,
  });
}

async function waitForCompletion(settlementRequestId) {
  return waitFor("settlement.requested is consumed and draw completes", async () => {
    const count = Number(
      await scalar(
        `
select count(*)::int
from game_engine.canonical_draw_completion_evidence
where settlement_request_id = $1
`,
        [settlementRequestId],
      ),
    );
    return count === 1;
  });
}

async function waitForComponent(componentName, newerThan = null) {
  return waitFor(`${componentName} compiled runtime is ready`, async () => {
    const result = await pool.query(
      `
select runtime_kind, status, last_seen_at
from game_engine.canonical_runtime_components
where component_name = $1
`,
      [componentName],
    );
    const row = result.rows[0];
    return (
      row?.runtime_kind === "COMPILED_JAVASCRIPT" &&
      row?.status === "READY" &&
      (!newerThan || new Date(row.last_seen_at) > newerThan)
    );
  });
}

const suffix = randomUUID();
let failed = false;

try {
  const localCompose = readFileSync("docker-compose.yml", "utf8");
  const productionCompose = readFileSync("docker-compose.production.yml", "utf8");
  assert(
    localCompose.includes(
      'command: ["node", "scripts/workers/runtime-bootstrap.cjs", "scripts/workers/consume-workload.js", "SETTLEMENT"]',
    ) &&
      productionCompose.includes(
        "exec node scripts/workers/runtime-bootstrap.cjs scripts/workers/consume-workload.js SETTLEMENT",
      ),
    "worker topology uses compiled JavaScript bootstrap",
  );
  assert(
    !localCompose.includes('command: ["npm", "run", "worker:settlement"]') &&
      !productionCompose.includes("exec npm run worker:settlement"),
    "settlement worker has no npm runtime dependency",
  );
  assert(
    productionCompose.includes('OUTCOME_LEGACY_PUBLICATION_ENABLED: "false"'),
    "legacy outcome publication is disabled in production",
  );
  assert(
    productionCompose.includes('OUTCOME_CANONICAL_PIPELINE_ENABLED: "false"'),
    "production Outcome Authority remains disabled",
  );

  await waitFor("Game Engine live endpoint is reachable", async () => {
    const response = await fetch(`${gameEngineUrl}/health/live`);
    return response.ok;
  });
  await waitForComponent("outbox-dispatcher");
  await waitForComponent("settlement-worker");

  const normal = await seedCertifiedOutcome(`${suffix}:normal`);
  const publication = await publish(normal, `${suffix}:normal`);
  assert(publication.status === 200, "normal draw publishes canonically", publication);
  const outcomeVersionId = publication.body?.data?.outcomeVersionId;
  const duplicatePublication = await publish(normal, `${suffix}:normal`);
  assert(
    duplicatePublication.status === 200 &&
      duplicatePublication.body?.data?.outcomeVersionId === outcomeVersionId,
    "duplicate draw/publication returns the canonical version",
  );

  const settlement = await requestSettlement(outcomeVersionId, normal, `${suffix}:normal`);
  assert(settlement.status === 200, "canonical settlement request is emitted", settlement);
  const settlementRequestId = settlement.body?.data?.settlementRequestId;
  const duplicateSettlement = await requestSettlement(
    outcomeVersionId,
    normal,
    `${suffix}:normal`,
  );
  assert(
    duplicateSettlement.status === 200 &&
      duplicateSettlement.body?.data?.settlementRequestId === settlementRequestId,
    "duplicate settlement request returns existing evidence",
  );
  await seedAuthoritativeSettlement(normal, `${suffix}:normal`);
  await waitForCompletion(settlementRequestId);

  const outboxEventId = await scalar(
    `
select outbox_event_id::text
from game_engine.outcome_settlement_requests
where settlement_request_id = $1
`,
    [settlementRequestId],
  );
  await pool.query(
    `
update public.outbox_events
set status = 'PENDING', published_at = null, next_attempt_at = null, last_error = null
where id = $1
`,
    [outboxEventId],
  );
  await waitFor("duplicate delivery is republished", async () => {
    return (
      (await scalar("select status from public.outbox_events where id = $1", [outboxEventId])) ===
      "PUBLISHED"
    );
  });
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert(
    Number(
      await scalar(
        `
select count(*)::int
from game_engine.outcome_settlement_consumptions
where settlement_request_id = $1
`,
        [settlementRequestId],
      ),
    ) === 1,
    "duplicate delivery cannot duplicate Settlement consumption",
  );

  const workerRestartedAt = new Date();
  runDocker("compose", "restart", "worker-settlement");
  await waitForComponent("settlement-worker", workerRestartedAt);
  pass("settlement worker restart preserves compiled runtime readiness");

  const rabbitRestartedAt = new Date();
  runDocker("compose", "restart", "rabbitmq");
  await waitFor("RabbitMQ returns healthy", async () => {
    const status = runDocker(
      "inspect",
      "--format",
      "{{if .State.Health}}{{.State.Health.Status}}{{end}}",
      "lottery-app-rabbitmq-1",
    );
    return status === "healthy";
  }, 90_000);
  await waitForComponent("settlement-worker", rabbitRestartedAt);
  pass("settlement worker reconnects after RabbitMQ restart");

  const missing = await seedCertifiedOutcome(`${suffix}:missing`);
  const missingPublication = await publish(missing, `${suffix}:missing`);
  assert(missingPublication.status === 200, "recovery draw publishes canonically");
  const missingVersionId = missingPublication.body?.data?.outcomeVersionId;
  const recovery = await post("/api/game-engine/outcome-publications/recover", {});
  assert(recovery.status === 200, "missing-request recovery runs", recovery);
  const recoveredRequestId = await waitFor("missing settlement request is recovered", async () => {
    return scalar(
      `
select settlement_request_id::text
from game_engine.outcome_settlement_requests
where outcome_version_id = $1
`,
      [missingVersionId],
    );
  });
  await seedAuthoritativeSettlement(missing, `${suffix}:missing`);
  await waitForCompletion(recoveredRequestId);
  assert(
    Number(
      await scalar(
        `
select count(*)::int
from game_engine.canonical_outcome_recovery_events
where outcome_version_id = $1 and recovery_action = 'REQUEST_CREATED'
`,
        [missingVersionId],
      ),
    ) === 1,
    "missing-request recovery preserves append-only audit evidence",
  );

  const interrupted = await seedCertifiedOutcome(`${suffix}:interrupted`);
  const interruptedPublication = await publish(interrupted, `${suffix}:interrupted`);
  const interruptedVersionId = interruptedPublication.body?.data?.outcomeVersionId;
  runDocker("compose", "stop", "worker-settlement");
  const interruptedRequest = await requestSettlement(
    interruptedVersionId,
    interrupted,
    `${suffix}:interrupted`,
  );
  const interruptedRequestId = interruptedRequest.body?.data?.settlementRequestId;
  const interruptedOutboxId = await scalar(
    `
select outbox_event_id::text
from game_engine.outcome_settlement_requests
where settlement_request_id = $1
`,
    [interruptedRequestId],
  );
  await waitFor("interrupted request reaches published outbox state", async () => {
    return (
      (await scalar("select status from public.outbox_events where id = $1", [
        interruptedOutboxId,
      ])) === "PUBLISHED"
    );
  });
  await pool.query(
    "update public.outbox_events set published_at = now() - interval '20 seconds' where id = $1",
    [interruptedOutboxId],
  );
  const replayRecovery = await post("/api/game-engine/outcome-publications/recover", {});
  assert(replayRecovery.status === 200, "unconfirmed outbox recovery runs", replayRecovery);
  assert(
    (await scalar("select status from public.outbox_events where id = $1", [
      interruptedOutboxId,
    ])) === "PENDING",
    "unconfirmed published event is safely requeued",
  );
  await seedAuthoritativeSettlement(interrupted, `${suffix}:interrupted`);
  runDocker("compose", "start", "worker-settlement");
  await waitForComponent("settlement-worker");
  await waitForCompletion(interruptedRequestId);
  assert(
    Number(
      await scalar(
        `
select count(*)::int
from game_engine.canonical_outcome_recovery_events
where outcome_version_id = $1 and recovery_action = 'EVENT_REQUEUED'
`,
        [interruptedVersionId],
      ),
    ) === 1,
    "outbox replay records recovery evidence",
  );

  let mutationBlocked = false;
  try {
    await pool.query(
      `
update game_engine.canonical_draw_completion_evidence
set completion_kind = 'Cancelled'
where settlement_request_id = $1
`,
      [settlementRequestId],
    );
  } catch {
    mutationBlocked = true;
  }
  assert(mutationBlocked, "canonical completion evidence remains immutable");
} catch (error) {
  failed = true;
  if (!checks.some((check) => check.status === "FAIL")) {
    checks.push({
      name: "canonical draw orchestration QA completes",
      status: "FAIL",
      metadata: { error: error instanceof Error ? error.message : String(error) },
    });
  }
} finally {
  const cleanup = spawnSync("docker", ["compose", "start", "worker-settlement"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      COMPOSE_PROJECT_NAME: process.env.COMPOSE_PROJECT_NAME ?? "lottery-app",
    },
  });
  if (cleanup.status !== 0) {
    checks.push({
      name: "settlement worker cleanup succeeds",
      status: "FAIL",
      metadata: { stdout: cleanup.stdout, stderr: cleanup.stderr },
    });
    failed = true;
  }
  await pool.end();
}

console.log(
  JSON.stringify(
    {
      status: failed ? "FAIL" : "PASS",
      checks,
      outcomeAuthorityActivated: false,
      directSettlementInvocation: false,
    },
    null,
    2,
  ),
);
if (failed) process.exitCode = 1;
