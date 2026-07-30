import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";

import { handleCanonicalSettlementRequest } from "@/src/domains/workers/canonical-settlement-request-handler";
import type { QueueMessage } from "@/src/lib/queue/queue.types";
import { createSettlementScopeFixture } from "./lib/settlement-scope-fixture";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for canonical Draw Orchestrator QA.");
}

const pool = new Pool({ connectionString: databaseUrl, max: 3 });
const checks: Array<{ name: string; status: "PASS" }> = [];

function hash(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function pass(name: string) {
  checks.push({ name, status: "PASS" });
}

function assert(condition: boolean, name: string): asserts condition {
  if (!condition) {
    throw new Error(name);
  }
  pass(name);
}

async function scalar(statement: string, values: unknown[] = []) {
  const result = await pool.query(statement, values);
  return result.rows[0] ? Object.values(result.rows[0])[0] : null;
}

async function seedCanonicalRequest() {
  const suffix = randomUUID();
  const drawId = randomUUID();
  const outcomeId = randomUUID();
  const outcomeCertificateId = randomUUID();
  const outcomeVersionId = randomUUID();
  const settlementInputId = randomUUID();
  const mathCertificateId = randomUUID();
  const publicationEventId = randomUUID();
  const settlementEventId = randomUUID();
  const canonicalSettlementRequestId = randomUUID();
  const strategyId = `bf-4.1-strategy:${suffix}`;
  const providerId = `bf-4.1-provider:${suffix}`;
  const outcomePayload = { numbers: [3, 8, 17, 24, 39] };
  const outcomeHash = hash(JSON.stringify(outcomePayload));
  const evidenceHash = hash(`rng-evidence:${suffix}`);
  const mathHash = hash(`math:${suffix}`);
  const settlementInputPayload = {
    mathEvaluationCertificateHash: mathHash,
    prizeFactsHash: mathHash,
    ticketReference: `ticket:${suffix}`,
  };
  const settlementInputHash = hash(JSON.stringify(settlementInputPayload));
  const ticketId = `ticket:${suffix}`;
  const ticketLineId = `ticket-line:${suffix}`;
  const scope = await createSettlementScopeFixture(pool, ticketId, "bf-4-1-draw-orchestrator");

  await pool.query(
    `
insert into game_engine.outcome_strategy_definitions (
  id, strategy_id, strategy_version, primitive_graph, input_schema, output_schema,
  constraints, jurisdiction_profile_references, lifecycle_state, content_hash,
  certification_binding_placeholder, signature_metadata)
values (
  $1, $2, '1.0.0', $3::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
  '[]'::jsonb, 'GovernanceApproved', $4, null, '{}'::jsonb);
`,
    [
      randomUUID(),
      strategyId,
      JSON.stringify([{
        nodeId: "numbers",
        primitiveType: "UniqueNumberSet",
        dependsOn: [],
        minNumber: 1,
        maxNumber: 40,
        count: 5,
      }]),
      hash(`strategy:${suffix}`),
    ],
  );
  await pool.query(
    `
insert into game_engine.rng_provider_definitions (
  id, provider_id, provider_version, provider_type, production_eligible,
  certification_state, algorithm_references, entropy_source_metadata,
  health_test_capabilities, failure_mode, content_hash, signature_metadata)
values (
  $1, $2, '1.0.0', 'TEST_DETERMINISTIC', false, 'InternalVerified',
  '["qa"]'::jsonb, '{}'::jsonb, '["qa"]'::jsonb, 'FailClosed', $3, '{}'::jsonb);
`,
    [randomUUID(), providerId, hash(`provider:${suffix}`)],
  );
  await pool.query(
    `
insert into game_engine.rng_provider_evidence (
  evidence_id, provider_id, provider_version, entropy_source_reference,
  health_test_result, known_answer_test_result, continuous_test_result,
  generated_at, canonical_evidence_hash, signing_metadata)
values ($1, $2, '1.0.0', 'qa', 'Passed', 'Passed', 'Passed', now(), $3, '{}'::jsonb);
`,
    [randomUUID(), providerId, evidenceHash],
  );

  await pool.query(
    `
insert into game_engine.outcome_events (
  outcome_id, request_id, draw_id, game_manifest_reference, strategy_id,
  strategy_version, rng_provider_id, rng_provider_version, rng_evidence_hash,
  idempotency_key, outcome_mode, outcome_payload, canonical_outcome_hash, generated_at)
values (
  $1, $2, $3, 'manifest:bf-4.1:1.0.0', $4, '1.0.0', $5, '1.0.0',
  $6, $7, 'DryRun', $8::jsonb, $9, now());
`,
    [
      outcomeId,
      randomUUID(),
      drawId,
      strategyId,
      providerId,
      evidenceHash,
      `bf-4.1-outcome:${suffix}`,
      JSON.stringify(outcomePayload),
      outcomeHash,
    ],
  );
  await pool.query(
    `
insert into game_engine.outcome_certificates (
  certificate_id, outcome_id, draw_id, strategy_id, strategy_version,
  rng_provider_id, rng_provider_version, canonical_outcome_hash,
  evidence_hash_reference, previous_certificates, signing_metadata, custody_state, issued_at)
values (
  $1, $2, $3, $4, '1.0.0', $5, '1.0.0', $6, $7,
  '[]'::jsonb, '{}'::jsonb, 'Certified', now());
`,
    [
      outcomeCertificateId,
      outcomeId,
      drawId,
      strategyId,
      providerId,
      outcomeHash,
      evidenceHash,
    ],
  );

  await pool.query(
    `
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
  $1, $2, $3, $4, $5, $6, 'manifest:bf-4.1', '1.0.0', $7,
  'math:bf-4.1', '1.0.0', $8, 'paytable:bf-4.1', '1.0.0', $9,
  'bf-4.1-evaluator', 'Win', 'QA', '{"outcome":"Win"}'::jsonb, $3,
  100, 2, $10, $11, now(), '{"authority":"MathAuthority"}'::jsonb,
  $12::jsonb, $13);
`,
    [
      settlementInputId,
      mathCertificateId,
      mathHash,
      outcomeCertificateId,
      outcomeHash,
      ticketLineId,
      hash(`manifest:${suffix}`),
      hash(`math-model:${suffix}`),
      hash(`paytable:${suffix}`),
      hash(`replay:${suffix}`),
      `bf-4.1-input:${suffix}`,
      JSON.stringify(settlementInputPayload),
      settlementInputHash,
    ],
  );

  const settlementPayload = {
    auditReference: `audit:${suffix}`,
    drawId,
    outcomeCertificateHash: outcomeHash,
    outcomeCertificateId,
    outcomeVersionId,
    requestKind: "Published",
    settlementInputHash,
    settlementInputId,
    settlementRequestId: canonicalSettlementRequestId,
  };
  await pool.query(
    `
insert into public.outbox_events (
  id, event_type, aggregate_type, aggregate_id, payload, status, correlation_id)
values
  ($1, 'outcome.published', 'canonical_outcome', $2, '{}'::jsonb, 'PUBLISHED', $3),
  ($4, 'settlement.requested', 'canonical_outcome', $2, $5::jsonb, 'PUBLISHED', $3);
`,
    [
      publicationEventId,
      outcomeVersionId.replaceAll("-", ""),
      `bf-4.1:${suffix}`,
      settlementEventId,
      JSON.stringify(settlementPayload),
    ],
  );
  await pool.query(
    `
insert into game_engine.canonical_outcome_versions (
  outcome_version_id, draw_id, product_reference, engine_name, engine_version,
  version_number, version_kind, outcome_id, outcome_certificate_id,
  outcome_certificate_hash, previous_outcome_version_id, outcome_payload,
  canonical_outcome_hash, generated_at, authoritative_source, correlation_id,
  causation_id, audit_reference, canonical_request_hash, idempotency_key,
  outbox_event_id, published_at)
select
  $1, $2, 'keno:bf-4.1', 'game-engine', 'bf-4.1', 1, 'Published',
  event.outcome_id, $3, $4, null, event.outcome_payload,
  event.canonical_outcome_hash, event.generated_at, 'OutcomeCertificate', $5,
  $6, $7, $8, $9, $10, now()
from game_engine.outcome_events event
where event.outcome_id = $11;
`,
    [
      outcomeVersionId,
      drawId,
      outcomeCertificateId,
      outcomeHash,
      `bf-4.1:${suffix}`,
      `execution:${suffix}`,
      `audit:${suffix}`,
      hash(`publication-request:${suffix}`),
      `bf-4.1-publication:${suffix}`,
      publicationEventId,
      outcomeId,
    ],
  );
  await pool.query(
    `
insert into game_engine.outcome_settlement_requests (
  settlement_request_id, outcome_version_id, draw_id, request_kind,
  settlement_input_id, canonical_request_hash, idempotency_key, correlation_id,
  causation_id, audit_reference, outbox_event_id, emitted_at)
values ($1, $2, $3, 'Published', $4, $5, $6, $7, $8, $9, $10, now());
`,
    [
      canonicalSettlementRequestId,
      outcomeVersionId,
      drawId,
      settlementInputId,
      hash(`settlement-request:${suffix}`),
      `bf-4.1-settlement:${suffix}`,
      `bf-4.1:${suffix}`,
      `execution:${suffix}`,
      `audit:${suffix}`,
      settlementEventId,
    ],
  );

  const message: QueueMessage = {
    id: settlementEventId,
    type: "settlement.requested",
    aggregateType: "canonical_outcome",
    aggregateId: outcomeVersionId.replaceAll("-", ""),
    correlationId: `bf-4.1:${suffix}`,
    payload: settlementPayload,
  };

  return {
    canonicalSettlementRequestId,
    drawId,
    mathCertificateId,
    mathHash,
    message,
    outcomeCertificateId,
    outcomeHash,
    outcomeVersionId,
    scope,
    settlementInputHash,
    settlementInputId,
    suffix,
    ticketId,
    ticketLineId,
  };
}

async function seedAuthoritativeSettlement(
  fixture: Awaited<ReturnType<typeof seedCanonicalRequest>>,
) {
  const authorityRequestId = randomUUID();
  const settlementId = randomUUID();
  const scopeHash = hash(
    [
      fixture.scope.tenantId,
      fixture.scope.brandId,
      fixture.scope.playerId,
      fixture.scope.reservationId,
      fixture.ticketId,
      "manifest:bf-4.1:1.0.0",
      `${fixture.outcomeCertificateId.replaceAll("-", "")}:${fixture.outcomeHash}`,
    ].join("|"),
  );
  const gameReference = "manifest:bf-4.1:1.0.0";
  const drawOutcomeReference =
    `${fixture.outcomeCertificateId.replaceAll("-", "")}:${fixture.outcomeHash}`;
  const canonicalSettlementHash = hash(`authoritative-settlement:${fixture.suffix}`);

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
values (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
  $13, 100, 'USD', 2, 'rounding:v1', $14, 'settlement:v1', now(),
  'DryRun', 'Accepted', '{"source":"bf-4.1"}'::jsonb,
  $15, $16, $17, $18, $19);
`,
    [
      authorityRequestId,
      `bf-4.1-authority-request:${fixture.suffix}`,
      hash(`authority-request:${fixture.suffix}`),
      fixture.settlementInputId,
      fixture.settlementInputHash,
      fixture.mathCertificateId,
      fixture.mathHash,
      fixture.outcomeCertificateId,
      fixture.outcomeHash,
      fixture.ticketId,
      fixture.ticketLineId,
      fixture.scope.playerId,
      `financial-context:${fixture.suffix}`,
      fixture.scope.reservationId,
      fixture.scope.tenantId,
      fixture.scope.brandId,
      gameReference,
      drawOutcomeReference,
      scopeHash,
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
values (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
  'USD', 2, 100, 200, 100, 'WIN', 'settlement:v1', $17, $18, now(),
  '{"authority":"SettlementAuthority"}'::jsonb,
  $12, $13, $14, $15, $16);
`,
    [
      settlementId,
      authorityRequestId,
      fixture.settlementInputId,
      fixture.settlementInputHash,
      fixture.mathCertificateId,
      fixture.mathHash,
      fixture.outcomeCertificateId,
      fixture.outcomeHash,
      fixture.ticketId,
      fixture.ticketLineId,
      fixture.scope.playerId,
      fixture.scope.tenantId,
      fixture.scope.brandId,
      gameReference,
      drawOutcomeReference,
      scopeHash,
      canonicalSettlementHash,
      `bf-4.1-authority-record:${fixture.suffix}`,
    ],
  );
}

async function main() {
  try {
  const leaseDrawId = randomUUID();
  const firstLease = randomUUID();
  const secondLease = randomUUID();
  assert(
    await scalar(
      "select game_engine.claim_canonical_draw_execution_lease($1, $2, 'qa:first', interval '30 seconds')",
      [leaseDrawId, firstLease],
    ) === true,
    "first execution lease is acquired",
  );
  assert(
    await scalar(
      "select game_engine.claim_canonical_draw_execution_lease($1, $2, 'qa:second', interval '30 seconds')",
      [leaseDrawId, secondLease],
    ) === false,
    "concurrent execution lease is rejected",
  );
  assert(
    await scalar(
      "select game_engine.release_canonical_draw_execution_lease($1, $2)",
      [leaseDrawId, firstLease],
    ) === true,
    "execution lease releases deterministically",
  );
  assert(
    await scalar(
      "select game_engine.claim_canonical_draw_execution_lease($1, $2, 'qa:second', interval '30 seconds')",
      [leaseDrawId, secondLease],
    ) === true,
    "released draw can be reclaimed",
  );
  await scalar(
    "select game_engine.release_canonical_draw_execution_lease($1, $2)",
    [leaseDrawId, secondLease],
  );

  const fixture = await seedCanonicalRequest();
  let rejectedBeforeAcknowledgement = false;
  try {
    await handleCanonicalSettlementRequest(fixture.message);
  } catch (error) {
    rejectedBeforeAcknowledgement =
      error instanceof Error &&
      error.message.includes("Authoritative Settlement acknowledgement is not available");
  }
  assert(rejectedBeforeAcknowledgement, "queue receipt cannot complete a draw");
  assert(
    Number(await scalar(
      "select count(*) from game_engine.canonical_draw_completion_evidence where draw_id = $1",
      [fixture.drawId],
    )) === 0,
    "draw remains incomplete before Settlement acknowledgement",
  );

  await seedAuthoritativeSettlement(fixture);
  const completed = await handleCanonicalSettlementRequest(fixture.message);
  assert(completed.duplicate === false, "authoritative Settlement acknowledgement completes draw");
  assert(
    Number(await scalar(
      "select count(*) from game_engine.outcome_settlement_acknowledgements where settlement_request_id = $1",
      [fixture.canonicalSettlementRequestId],
    )) === 1,
    "one immutable Settlement acknowledgement is stored",
  );
  assert(
    Number(await scalar(
      "select count(*) from game_engine.canonical_draw_completion_evidence where draw_id = $1 and settlement_acknowledgement_id is not null",
      [fixture.drawId],
    )) === 1,
    "draw completion binds the acknowledgement",
  );

  const duplicate = await handleCanonicalSettlementRequest(fixture.message);
  assert(duplicate.duplicate === true, "duplicate delivery returns existing completion");
  assert(
    Number(await scalar(
      "select count(*) from game_engine.canonical_draw_completion_evidence where draw_id = $1",
      [fixture.drawId],
    )) === 1,
    "duplicate delivery cannot duplicate completion",
  );

  let mutationBlocked = false;
  try {
    await pool.query(
      "update game_engine.outcome_settlement_acknowledgements set acknowledgement_status = 'ACKNOWLEDGED' where settlement_request_id = $1",
      [fixture.canonicalSettlementRequestId],
    );
  } catch {
    mutationBlocked = true;
  }
  assert(mutationBlocked, "Settlement acknowledgement evidence is append-only");

  console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      status: "FAIL",
      error: error instanceof Error ? error.message : String(error),
      checks,
    }, null, 2));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
