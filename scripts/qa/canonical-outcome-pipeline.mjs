import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { printJson, queryScalar, runPsql } from "../migrations/lib/local-migration-utils.mjs";

const checks = [];
const port = 18179;
const externalServiceUrl = process.env.QA_GAME_ENGINE_URL?.trim();
const baseUrl = externalServiceUrl || `http://127.0.0.1:${port}`;
let service;

function addCheck(name, passed, metadata = {}) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", metadata });
}

function sql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function json(value) {
  return `${sql(JSON.stringify(value))}::jsonb`;
}

function hash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function runSql(statement, options = {}) {
  return runPsql(["-q", "-c", statement], options);
}

function count(statement) {
  return Number(queryScalar(statement));
}

async function waitForService() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health/live`);
      if (response.ok) return;
    } catch {
      // The process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Game Engine did not become live for canonical outcome QA.");
}

async function startService() {
  if (externalServiceUrl) {
    await waitForService();
    return;
  }
  service = spawn(
    "dotnet",
    [
      "run",
      "--no-build",
      "--project",
      "services/game-engine/src/GameEngine.Api/GameEngine.Api.csproj",
      "--urls",
      baseUrl,
    ],
    {
      env: {
        ...process.env,
        ASPNETCORE_ENVIRONMENT: "Development",
        DATABASE_URL: process.env.DATABASE_URL,
        RABBITMQ_URL: process.env.RABBITMQ_URL ?? "amqp://guest:guest@127.0.0.1:5672",
        REDIS_URL: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
        OUTCOME_CANONICAL_PIPELINE_ENABLED: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await waitForService();
}

async function stopService() {
  if (!service || service.exitCode !== null) return;
  service.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => service.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (service.exitCode === null) service.kill("SIGKILL");
}

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, payload };
}

function seedOutcome({
  drawId,
  strategyId,
  providerId,
  evidenceHash,
  outcomeId,
  certificateId,
  outcomePayload,
  outcomeHash,
  suffix,
}) {
  runSql(`
insert into game_engine.outcome_events (
  outcome_id,
  request_id,
  draw_id,
  game_manifest_reference,
  strategy_id,
  strategy_version,
  rng_provider_id,
  rng_provider_version,
  rng_evidence_hash,
  idempotency_key,
  outcome_mode,
  outcome_payload,
  canonical_outcome_hash,
  generated_at)
values (
  '${outcomeId}',
  '${randomUUID()}',
  '${drawId}',
  'game-manifest:canonical-qa:1.0.0',
  ${sql(strategyId)},
  '1.0.0',
  ${sql(providerId)},
  '1.0.0',
  ${sql(evidenceHash)},
  ${sql(`canonical-outcome-source:${suffix}`)},
  'DryRun',
  ${json(outcomePayload)},
  ${sql(outcomeHash)},
  now());

insert into game_engine.outcome_certificates (
  certificate_id,
  outcome_id,
  draw_id,
  strategy_id,
  strategy_version,
  rng_provider_id,
  rng_provider_version,
  canonical_outcome_hash,
  evidence_hash_reference,
  previous_certificates,
  signing_metadata,
  custody_state,
  issued_at)
values (
  '${certificateId}',
  '${outcomeId}',
  '${drawId}',
  ${sql(strategyId)},
  '1.0.0',
  ${sql(providerId)},
  '1.0.0',
  ${sql(outcomeHash)},
  ${sql(evidenceHash)},
  '[]'::jsonb,
  ${json({ signingKeyId: "qa-only", signature: "qa-only" })},
  'Certified',
  now());
`);
}

function seedSettlementInput({ settlementInputId, certificateId, outcomeHash, suffix }) {
  const mathCertificateId = randomUUID();
  const mathHash = hash(`math:${suffix}`);
  const payload = {
    mathEvaluationCertificateHash: mathHash,
    prizeFactsHash: mathHash,
    ticketReference: `ticket:${suffix}`,
  };
  runSql(`
insert into game_engine.settlement_input_records (
  settlement_input_id,
  math_evaluation_certificate_id,
  math_evaluation_certificate_hash,
  outcome_certificate_id,
  outcome_certificate_hash,
  ticket_reference,
  game_manifest_id,
  game_manifest_version,
  game_manifest_hash,
  math_model_id,
  math_model_version,
  math_model_hash,
  paytable_id,
  paytable_version,
  paytable_hash,
  evaluator_version,
  evaluation_outcome,
  prize_tier,
  prize_facts,
  prize_facts_hash,
  payout_units,
  multiplier,
  replay_hash,
  idempotency_key,
  issued_at,
  provenance,
  canonical_payload,
  canonical_payload_hash)
values (
  '${settlementInputId}',
  '${mathCertificateId}',
  ${sql(mathHash)},
  '${certificateId}',
  ${sql(outcomeHash)},
  ${sql(`ticket:${suffix}`)},
  'manifest:canonical-qa',
  '1.0.0',
  ${sql(hash(`manifest:${suffix}`))},
  'math:canonical-qa',
  '1.0.0',
  ${sql(hash(`math-model:${suffix}`))},
  'paytable:canonical-qa',
  '1.0.0',
  ${sql(hash(`paytable:${suffix}`))},
  'qa-evaluator-1',
  'Win',
  'QA',
  ${json({ outcome: "Win", prizeTier: "QA", payoutUnits: 1, multiplier: 1 })},
  ${sql(mathHash)},
  1,
  1,
  ${sql(hash(`replay:${suffix}`))},
  ${sql(`settlement-input:${suffix}`)},
  now(),
  ${json({ authority: "MathAuthority" })},
  ${json(payload)},
  ${sql(hash(JSON.stringify(payload)))});
`);
}

const runId = randomUUID();
const strategyId = `strategy:canonical:${runId}`;
const providerId = `provider:canonical:${runId}`;
const evidenceHash = hash(`evidence:${runId}`);
const drawId = randomUUID();
const firstOutcomeId = randomUUID();
const firstCertificateId = randomUUID();
const firstOutcomePayload = { numbers: [1, 4, 9, 16, 25] };
const firstOutcomeHash = hash(JSON.stringify(firstOutcomePayload));
const firstSettlementInputId = randomUUID();
const correctedOutcomeId = randomUUID();
const correctedCertificateId = randomUUID();
const correctedOutcomePayload = { numbers: [2, 5, 10, 17, 26] };
const correctedOutcomeHash = hash(JSON.stringify(correctedOutcomePayload));
const correctedSettlementInputId = randomUUID();
const concurrentDrawId = randomUUID();
const concurrentOutcomeId = randomUUID();
const concurrentCertificateId = randomUUID();
const concurrentOutcomePayload = { numbers: [3, 6, 12, 18, 27] };
const concurrentOutcomeHash = hash(JSON.stringify(concurrentOutcomePayload));

try {
  addCheck(
    "canonical publication tables exist",
    queryScalar("select to_regclass('game_engine.canonical_outcome_versions') is not null;") === "t" &&
      queryScalar("select to_regclass('game_engine.outcome_settlement_requests') is not null;") === "t",
  );

  runSql(`
insert into game_engine.outcome_strategy_definitions (
  id, strategy_id, strategy_version, primitive_graph, input_schema, output_schema,
  constraints, jurisdiction_profile_references, lifecycle_state, content_hash,
  certification_binding_placeholder, signature_metadata)
values (
  '${randomUUID()}',
  ${sql(strategyId)},
  '1.0.0',
  ${json([{ nodeId: "numbers", primitiveType: "UniqueNumberSet", dependsOn: [], minNumber: 1, maxNumber: 40, count: 5 }])},
  '{}'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb,
  '[]'::jsonb,
  'GovernanceApproved',
  ${sql(hash(`strategy:${runId}`))},
  null,
  ${json({ signingKeyId: "qa-only", signature: "qa-only" })});

insert into game_engine.rng_provider_definitions (
  id, provider_id, provider_version, provider_type, production_eligible,
  certification_state, algorithm_references, entropy_source_metadata,
  health_test_capabilities, failure_mode, content_hash, signature_metadata)
values (
  '${randomUUID()}',
  ${sql(providerId)},
  '1.0.0',
  'TEST_DETERMINISTIC',
  false,
  'InternalVerified',
  '["deterministic-test-v1"]'::jsonb,
  '{}'::jsonb,
  '["qa"]'::jsonb,
  'FailClosed',
  ${sql(hash(`provider:${runId}`))},
  ${json({ signingKeyId: "qa-only", signature: "qa-only" })});

insert into game_engine.rng_provider_evidence (
  evidence_id, provider_id, provider_version, entropy_source_reference,
  health_test_result, known_answer_test_result, continuous_test_result,
  generated_at, canonical_evidence_hash, signing_metadata)
values (
  '${randomUUID()}',
  ${sql(providerId)},
  '1.0.0',
  'qa:deterministic',
  'Passed',
  'Passed',
  'Passed',
  now(),
  ${sql(evidenceHash)},
  ${json({ signingKeyId: "qa-only", signature: "qa-only" })});
`);

  seedOutcome({
    drawId,
    strategyId,
    providerId,
    evidenceHash,
    outcomeId: firstOutcomeId,
    certificateId: firstCertificateId,
    outcomePayload: firstOutcomePayload,
    outcomeHash: firstOutcomeHash,
    suffix: `${runId}:first`,
  });
  seedSettlementInput({
    settlementInputId: firstSettlementInputId,
    certificateId: firstCertificateId,
    outcomeHash: firstOutcomeHash,
    suffix: `${runId}:first`,
  });

  await startService();
  const publication = {
    idempotencyKey: `publish:${runId}:1`,
    drawId,
    productReference: "keno:qa",
    engineName: "game-engine",
    engineVersion: "p1-012.1",
    outcomeCertificateId: firstCertificateId,
    outcomeCertificateHash: firstOutcomeHash,
    versionKind: "Published",
    previousOutcomeVersionId: null,
    authoritativeSource: "OutcomeCertificate",
    correlationId: `correlation:${runId}`,
    causationId: `draw-execution:${runId}`,
    auditReference: `audit:${runId}:1`,
  };
  const first = await post("/api/game-engine/outcome-publications", publication);
  addCheck("normal outcome publication succeeds", first.status === 200, { status: first.status, payload: first.payload });
  const firstVersionId = first.payload?.data?.outcomeVersionId;

  const duplicate = await post("/api/game-engine/outcome-publications", publication);
  addCheck(
    "duplicate publication is idempotent",
    duplicate.status === 200 && duplicate.payload?.data?.outcomeVersionId === firstVersionId,
  );

  const conflict = await post("/api/game-engine/outcome-publications", {
    ...publication,
    engineVersion: "conflicting-version",
  });
  addCheck("conflicting publication fails closed", conflict.status === 409, { status: conflict.status });

  const firstSettlement = {
    idempotencyKey: `settlement-request:${runId}:1`,
    outcomeVersionId: firstVersionId,
    settlementInputId: firstSettlementInputId,
    correlationId: `correlation:${runId}`,
    causationId: `publication:${firstVersionId}`,
    auditReference: `audit:${runId}:settlement:1`,
  };
  const settlementResult = await post("/api/game-engine/outcome-settlement-requests", firstSettlement);
  const duplicateSettlement = await post("/api/game-engine/outcome-settlement-requests", firstSettlement);
  addCheck(
    "one idempotent settlement request is emitted",
    settlementResult.status === 200 &&
      duplicateSettlement.status === 200 &&
      settlementResult.payload?.data?.settlementRequestId === duplicateSettlement.payload?.data?.settlementRequestId,
  );

  seedOutcome({
    drawId: concurrentDrawId,
    strategyId,
    providerId,
    evidenceHash,
    outcomeId: concurrentOutcomeId,
    certificateId: concurrentCertificateId,
    outcomePayload: concurrentOutcomePayload,
    outcomeHash: concurrentOutcomeHash,
    suffix: `${runId}:concurrent`,
  });
  const concurrentBase = {
    ...publication,
    drawId: concurrentDrawId,
    outcomeCertificateId: concurrentCertificateId,
    outcomeCertificateHash: concurrentOutcomeHash,
    correlationId: `correlation:${runId}:concurrent`,
    causationId: `draw-execution:${runId}:concurrent`,
    auditReference: `audit:${runId}:concurrent`,
  };
  const concurrentResults = await Promise.all([
    post("/api/game-engine/outcome-publications", {
      ...concurrentBase,
      idempotencyKey: `publish:${runId}:concurrent:a`,
    }),
    post("/api/game-engine/outcome-publications", {
      ...concurrentBase,
      idempotencyKey: `publish:${runId}:concurrent:b`,
    }),
  ]);
  addCheck(
    "concurrent draw execution produces one publication",
    concurrentResults.filter((result) => result.status === 200).length === 1 &&
      concurrentResults.filter((result) => result.status === 409).length === 1 &&
      count(`select count(*) from game_engine.canonical_outcome_versions where draw_id = '${concurrentDrawId}';`) === 1,
    { statuses: concurrentResults.map((result) => result.status) },
  );

  await stopService();
  await startService();
  const recovered = await post("/api/game-engine/outcome-publications", publication);
  addCheck(
    "process restart returns durable publication",
    recovered.status === 200 && recovered.payload?.data?.outcomeVersionId === firstVersionId,
  );

  seedOutcome({
    drawId,
    strategyId,
    providerId,
    evidenceHash,
    outcomeId: correctedOutcomeId,
    certificateId: correctedCertificateId,
    outcomePayload: correctedOutcomePayload,
    outcomeHash: correctedOutcomeHash,
    suffix: `${runId}:corrected`,
  });
  seedSettlementInput({
    settlementInputId: correctedSettlementInputId,
    certificateId: correctedCertificateId,
    outcomeHash: correctedOutcomeHash,
    suffix: `${runId}:corrected`,
  });

  const correction = await post("/api/game-engine/outcome-publications", {
    ...publication,
    idempotencyKey: `publish:${runId}:2`,
    outcomeCertificateId: correctedCertificateId,
    outcomeCertificateHash: correctedOutcomeHash,
    versionKind: "Corrected",
    previousOutcomeVersionId: firstVersionId,
    auditReference: `audit:${runId}:2`,
  });
  const correctedVersionId = correction.payload?.data?.outcomeVersionId;
  addCheck(
    "correction appends version two",
    correction.status === 200 &&
      correction.payload?.data?.versionNumber === 2 &&
      correction.payload?.data?.previousOutcomeVersionId === firstVersionId,
  );

  const correctedSettlement = await post("/api/game-engine/outcome-settlement-requests", {
    ...firstSettlement,
    idempotencyKey: `settlement-request:${runId}:2`,
    outcomeVersionId: correctedVersionId,
    settlementInputId: correctedSettlementInputId,
    causationId: `publication:${correctedVersionId}`,
    auditReference: `audit:${runId}:settlement:2`,
  });
  addCheck("corrected outcome emits one corrected settlement request", correctedSettlement.status === 200);

  const cancellation = await post("/api/game-engine/outcome-publications", {
    ...publication,
    idempotencyKey: `publish:${runId}:3`,
    outcomeCertificateId: correctedCertificateId,
    outcomeCertificateHash: correctedOutcomeHash,
    versionKind: "Cancelled",
    previousOutcomeVersionId: correctedVersionId,
    auditReference: `audit:${runId}:3`,
  });
  const cancelledVersionId = cancellation.payload?.data?.outcomeVersionId;
  addCheck("cancellation appends terminal version", cancellation.status === 200 && cancellation.payload?.data?.versionNumber === 3);

  const cancellationSettlement = await post("/api/game-engine/outcome-settlement-requests", {
    ...firstSettlement,
    idempotencyKey: `settlement-request:${runId}:3`,
    outcomeVersionId: cancelledVersionId,
    settlementInputId: null,
    causationId: `publication:${cancelledVersionId}`,
    auditReference: `audit:${runId}:settlement:3`,
  });
  addCheck("cancellation emits request without financial input", cancellationSettlement.status === 200);

  const staleReplay = await post("/api/game-engine/outcome-settlement-requests", {
    ...firstSettlement,
    idempotencyKey: `settlement-request:${runId}:stale`,
  });
  addCheck("stale outcome settlement emission fails closed", staleReplay.status === 409);

  const updateAttempt = runSql(
    `update game_engine.canonical_outcome_versions set product_reference = 'tampered' where outcome_version_id = '${firstVersionId}';`,
    { allowFailure: true },
  );
  const deleteAttempt = runSql(
    `delete from game_engine.outcome_settlement_requests where outcome_version_id = '${firstVersionId}';`,
    { allowFailure: true },
  );
  addCheck("outcome history is immutable", updateAttempt.status !== 0);
  addCheck("settlement request evidence is immutable", deleteAttempt.status !== 0);
  addCheck(
    "version chain remains complete",
    count(`select count(*) from game_engine.canonical_outcome_versions where draw_id = '${drawId}';`) === 3,
  );
  addCheck(
    "outbox has one event per publication and settlement request",
    count(`
select count(*)
from public.outbox_events
where correlation_id = ${sql(`correlation:${runId}`)}
  and event_type in ('outcome.published', 'outcome.corrected', 'outcome.cancelled', 'settlement.requested');
`) === 6,
  );
  addCheck(
    "settlement requests reference only canonical versions",
    count(`
select count(*)
from game_engine.outcome_settlement_requests request
join game_engine.canonical_outcome_versions version
  on version.outcome_version_id = request.outcome_version_id
where version.draw_id = '${drawId}';
`) === 3,
  );
  addCheck(
    "no direct Settlement authority writes occurred",
    count(`
select count(*)
from settlement_service.settlement_requests
where settlement_input_id in ('${firstSettlementInputId}', '${correctedSettlementInputId}');
`) === 0,
  );
} catch (error) {
  addCheck("canonical outcome QA completed", false, { error: error.message });
} finally {
  await stopService();
}

const failed = checks.filter((check) => check.status !== "PASS");
printJson({ status: failed.length === 0 ? "PASS" : "FAIL", checks });
if (failed.length > 0) process.exitCode = 1;
