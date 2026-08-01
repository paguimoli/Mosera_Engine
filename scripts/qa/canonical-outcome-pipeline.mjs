import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Pool } from "pg";

import {
  appendCertifiedProviderResult,
  canonicalHash,
  createCanonicalOutcomeFixture,
  publicationCommand,
} from "./lib/canonical-outcome-authority-fixture.mjs";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for Canonical Outcome Authority QA.");
const pool = new Pool({ connectionString: databaseUrl, max: 6 });
const checks = [];
const port = 18179;
const externalUrl = process.env.QA_GAME_ENGINE_URL?.trim();
const baseUrl = externalUrl || `http://127.0.0.1:${port}`;
let service;

function check(name, condition, metadata = {}) {
  checks.push({ name, status: condition ? "PASS" : "FAIL", metadata });
}

async function waitForService() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/health/live`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Game Engine did not become live for Canonical Outcome Authority QA.");
}

async function startService() {
  if (externalUrl) return waitForService();
  service = spawn("dotnet", [
    "run", "--no-build", "--project",
    "services/game-engine/src/GameEngine.Api/GameEngine.Api.csproj", "--urls", baseUrl,
  ], {
    env: {
      ...process.env,
      ASPNETCORE_ENVIRONMENT: "Development",
      DATABASE_URL: databaseUrl,
      RABBITMQ_URL: process.env.RABBITMQ_URL ?? "amqp://guest:guest@127.0.0.1:5672",
      REDIS_URL: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
      OUTCOME_CANONICAL_PIPELINE_ENABLED: "true",
      OUTCOME_CANONICAL_RECOVERY_ENABLED: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return waitForService();
}

async function stopService() {
  if (!service || service.exitCode !== null) return;
  service.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => service.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (service.exitCode === null) service.kill("SIGKILL");
  service = undefined;
}

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let payload;
  try { payload = await response.json(); } catch { payload = null; }
  return { status: response.status, payload };
}

async function scalar(statement, values = []) {
  const result = await pool.query(statement, values);
  return result.rows[0] ? Object.values(result.rows[0])[0] : null;
}

async function seedSettlementInput(fixture, result, suffix) {
  const id = randomUUID();
  const mathHash = canonicalHash(`math:${suffix}`);
  const payload = { mathEvaluationCertificateHash: mathHash, ticketReference: `ticket:${suffix}` };
  const canonicalPayload = (await pool.query("select $1::jsonb::text as value", [JSON.stringify(payload)])).rows[0].value;
  await pool.query(`
insert into game_engine.settlement_input_records (
  settlement_input_id, math_evaluation_certificate_id, math_evaluation_certificate_hash,
  outcome_certificate_id, outcome_certificate_hash, ticket_reference,
  game_manifest_id, game_manifest_version, game_manifest_hash,
  math_model_id, math_model_version, math_model_hash,
  paytable_id, paytable_version, paytable_hash, evaluator_version,
  evaluation_outcome, prize_tier, prize_facts, prize_facts_hash,
  payout_units, multiplier, replay_hash, idempotency_key, issued_at,
  provenance, canonical_payload, canonical_payload_hash)
values ($1, $2, $3, $4, $5, $6, 'manifest:bf-4.7', '1.0.0', $7,
  'math:bf-4.7', '1.0.0', $8, 'paytable:bf-4.7', '1.0.0', $9, $10,
  'Win', 'QA', '{"outcome":"Win"}'::jsonb, $3, 1, 1, $11, $12, now(),
  '{"authority":"MathAuthority"}'::jsonb, $13::jsonb, $14);
`, [
    id, randomUUID(), mathHash, result.certificateId, result.outcomeHash, `ticket:${suffix}`,
    canonicalHash(`manifest:${suffix}`), canonicalHash(`math-model:${suffix}`),
    canonicalHash(`paytable:${suffix}`), fixture.evaluatorVersion,
    canonicalHash(`replay:${suffix}`), `settlement-input:${suffix}`, canonicalPayload,
    canonicalHash(canonicalPayload),
  ]);
  return id;
}

try {
  await startService();
  const categories = ["INTERNAL_CSPRNG", "OFFICIAL_RESULTS", "MANUAL_CERTIFIED"];
  const published = [];
  for (const category of categories) {
    const fixture = await createCanonicalOutcomeFixture(pool, { category });
    const result = await appendCertifiedProviderResult(pool, fixture);
    const response = await post("/api/game-engine/outcome-publications", publicationCommand(fixture, result));
    check(`${category} publishes through the canonical authority`, response.status === 200, response);
    published.push({ fixture, result, response });
  }

  const invalidNumberFixture = await createCanonicalOutcomeFixture(pool);
  const invalidNumberResult = await appendCertifiedProviderResult(pool, invalidNumberFixture, {
    primary: invalidNumberFixture.primary.map((value, index) => index === 0 ? 999999 : value),
  });
  const invalidNumber = await post("/api/game-engine/outcome-publications",
    publicationCommand(invalidNumberFixture, invalidNumberResult));
  check("out-of-universe provider result fails closed", invalidNumber.status === 409, invalidNumber);

  if (invalidNumberFixture.bonus.length > 0) {
    const invalidBonusFixture = await createCanonicalOutcomeFixture(pool);
    const invalidBonusResult = await appendCertifiedProviderResult(pool, invalidBonusFixture, {
      bonus: invalidBonusFixture.bonus.map((value, index) => index === 0 ? 999999 : value),
    });
    const invalidBonus = await post("/api/game-engine/outcome-publications",
      publicationCommand(invalidBonusFixture, invalidBonusResult));
    check("invalid bonus result fails closed", invalidBonus.status === 409, invalidBonus);
  }

  const invalidSignatureFixture = await createCanonicalOutcomeFixture(pool);
  const invalidSignatureResult = await appendCertifiedProviderResult(pool, invalidSignatureFixture, {
    invalidSignature: true,
  });
  const invalidSignature = await post("/api/game-engine/outcome-publications",
    publicationCommand(invalidSignatureFixture, invalidSignatureResult));
  check("unverified certificate content fails closed", invalidSignature.status === 409, invalidSignature);

  const concurrentFixture = await createCanonicalOutcomeFixture(pool);
  const concurrentResult = await appendCertifiedProviderResult(pool, concurrentFixture);
  const concurrentBase = publicationCommand(concurrentFixture, concurrentResult);
  const concurrent = await Promise.all([
    post("/api/game-engine/outcome-publications", { ...concurrentBase, idempotencyKey: `${concurrentBase.idempotencyKey}:a` }),
    post("/api/game-engine/outcome-publications", { ...concurrentBase, idempotencyKey: `${concurrentBase.idempotencyKey}:b` }),
  ]);
  check("concurrent publication creates exactly one canonical version",
    concurrent.filter((entry) => entry.status === 200).length === 1 &&
      concurrent.filter((entry) => entry.status === 409).length === 1 &&
      Number(await scalar("select count(*) from game_engine.canonical_outcome_versions where draw_id = $1",
        [concurrentFixture.drawId])) === 1,
  { statuses: concurrent.map((entry) => entry.status) });

  const lifecycleRaceFixture = await createCanonicalOutcomeFixture(pool);
  const lifecycleRaceInitial = await appendCertifiedProviderResult(pool, lifecycleRaceFixture);
  const lifecycleRacePublished = await post(
    "/api/game-engine/outcome-publications",
    publicationCommand(lifecycleRaceFixture, lifecycleRaceInitial),
  );
  const lifecycleRacePreviousId = lifecycleRacePublished.payload?.data?.outcomeVersionId;
  const raceReplacement = lifecycleRaceFixture.primaryUniverse.find((value) =>
    !lifecycleRaceFixture.primary.includes(value) && !lifecycleRaceFixture.bonus.includes(value));
  if (raceReplacement === undefined) throw new Error("Lifecycle race fixture lacks an alternate valid number.");
  const racePrimary = [...lifecycleRaceFixture.primary];
  racePrimary[0] = raceReplacement;
  if (lifecycleRaceFixture.primaryOrdering === "Ascending") racePrimary.sort((left, right) => left - right);
  const lifecycleRaceCorrection = await appendCertifiedProviderResult(pool, lifecycleRaceFixture, {
    primary: racePrimary,
    outcomePayload: { numbers: racePrimary, bonusNumbers: lifecycleRaceFixture.bonus },
    previousCertificateId: lifecycleRaceInitial.certificateId,
    previousCertificateHash: lifecycleRaceInitial.outcomeHash,
  });
  const lifecycleRace = await Promise.all([
    post("/api/game-engine/outcome-publications", publicationCommand(
      lifecycleRaceFixture,
      lifecycleRaceCorrection,
      {
        idempotencyKey: `publish:${lifecycleRaceFixture.suffix}:race-correct`,
        versionKind: "Corrected",
        previousOutcomeVersionId: lifecycleRacePreviousId,
        reasonCode: "CONCURRENT_CERTIFIED_CORRECTION",
      },
    )),
    post("/api/game-engine/outcome-publications", publicationCommand(
      lifecycleRaceFixture,
      lifecycleRaceInitial,
      {
        idempotencyKey: `publish:${lifecycleRaceFixture.suffix}:race-cancel`,
        versionKind: "Cancelled",
        previousOutcomeVersionId: lifecycleRacePreviousId,
        reasonCode: "CONCURRENT_GOVERNED_CANCELLATION",
      },
    )),
  ]);
  check("concurrent correction and cancellation append exactly one lifecycle version",
    lifecycleRace.filter((entry) => entry.status === 200).length === 1 &&
      lifecycleRace.filter((entry) => entry.status === 409).length === 1 &&
      Number(await scalar(
        "select count(*) from game_engine.canonical_outcome_versions where draw_id = $1",
        [lifecycleRaceFixture.drawId],
      )) === 2,
  { statuses: lifecycleRace.map((entry) => entry.status) });

  const { fixture, result: initial, response: firstResponse } = published[0];
  const firstVersionId = firstResponse.payload?.data?.outcomeVersionId;
  const initialCommand = publicationCommand(fixture, initial);
  const duplicate = await post("/api/game-engine/outcome-publications", initialCommand);
  check("duplicate publication returns the immutable existing aggregate",
    duplicate.status === 200 && duplicate.payload?.data?.outcomeVersionId === firstVersionId);
  const conflict = await post("/api/game-engine/outcome-publications", {
    ...initialCommand, reasonCode: "CONFLICTING_REUSE",
  });
  check("conflicting idempotency fails closed", conflict.status === 409, conflict);

  const firstInput = await seedSettlementInput(fixture, initial, `${fixture.suffix}:first`);
  const settlementCommand = {
    idempotencyKey: `settlement:${fixture.suffix}:1`, outcomeVersionId: firstVersionId,
    settlementInputId: firstInput, correlationId: `correlation:${fixture.suffix}`,
    causationId: `publication:${firstVersionId}`, auditReference: `audit:settlement:${fixture.suffix}:1`,
  };
  const settlement = await post("/api/game-engine/outcome-settlement-requests", settlementCommand);
  const duplicateSettlement = await post("/api/game-engine/outcome-settlement-requests", settlementCommand);
  check("exact SettlementInput is emitted idempotently", settlement.status === 200 &&
    duplicateSettlement.payload?.data?.settlementRequestId === settlement.payload?.data?.settlementRequestId,
  { settlement, duplicateSettlement });

  const replacement = fixture.primaryUniverse.find((value) =>
    !fixture.primary.includes(value) && !fixture.bonus.includes(value));
  if (replacement === undefined) throw new Error("Correction fixture lacks an alternate valid number.");
  const nextPrimary = [...fixture.primary];
  nextPrimary[0] = replacement;
  if (fixture.primaryOrdering === "Ascending") nextPrimary.sort((left, right) => left - right);
  const corrected = await appendCertifiedProviderResult(pool, fixture, {
    primary: nextPrimary,
    outcomePayload: { numbers: nextPrimary, bonusNumbers: fixture.bonus },
    previousCertificateId: initial.certificateId,
    previousCertificateHash: initial.outcomeHash,
  });
  const correctionCommand = publicationCommand(fixture, corrected, {
    versionKind: "Corrected", previousOutcomeVersionId: firstVersionId,
    reasonCode: "CERTIFIED_CORRECTION",
  });
  const correction = await post("/api/game-engine/outcome-publications", correctionCommand);
  const correctedVersionId = correction.payload?.data?.outcomeVersionId;
  check("correction appends certified superseding evidence", correction.status === 200 &&
    correction.payload?.data?.versionNumber === 2 &&
    correction.payload?.data?.previousOutcomeVersionId === firstVersionId, correction);

  const correctedInput = await seedSettlementInput(fixture, corrected, `${fixture.suffix}:corrected`);
  const correctedSettlement = await post("/api/game-engine/outcome-settlement-requests", {
    ...settlementCommand, idempotencyKey: `settlement:${fixture.suffix}:2`,
    outcomeVersionId: correctedVersionId, settlementInputId: correctedInput,
    causationId: `publication:${correctedVersionId}`,
  });
  check("corrected outcome emits its exact SettlementInput", correctedSettlement.status === 200, correctedSettlement);

  const cancellationCommand = publicationCommand(fixture, corrected, {
    idempotencyKey: `publish:${fixture.suffix}:cancel`, versionKind: "Cancelled",
    previousOutcomeVersionId: correctedVersionId, reasonCode: "GOVERNED_DRAW_CANCELLATION",
    lifecycleEvidenceHash: canonicalHash(`cancel:${fixture.suffix}`),
  });
  const cancellation = await post("/api/game-engine/outcome-publications", cancellationCommand);
  const cancelledVersionId = cancellation.payload?.data?.outcomeVersionId;
  check("cancellation appends a terminal lifecycle version", cancellation.status === 200 &&
    cancellation.payload?.data?.versionNumber === 3, cancellation);
  const cancellationSettlement = await post("/api/game-engine/outcome-settlement-requests", {
    ...settlementCommand, idempotencyKey: `settlement:${fixture.suffix}:cancel`,
    outcomeVersionId: cancelledVersionId, settlementInputId: null,
    causationId: `publication:${cancelledVersionId}`,
  });
  check("cancelled outcome emits no financial input", cancellationSettlement.status === 200, cancellationSettlement);
  const afterCancellation = await post("/api/game-engine/outcome-publications", {
    ...correctionCommand, idempotencyKey: `publish:${fixture.suffix}:after-cancel`,
    previousOutcomeVersionId: cancelledVersionId,
  });
  check("cancelled outcome is terminal", afterCancellation.status === 409, afterCancellation);
  check("correction and cancellation retain immutable lifecycle audit evidence",
    Number(await scalar(`select count(*) from game_engine.canonical_outcome_lifecycle_events
      where draw_id = $1 and operation in ('CORRECTION', 'CANCELLATION')`, [fixture.drawId])) === 2);

  const immutable = await pool.query(
    "update game_engine.canonical_outcome_versions set reason_code = 'tampered' where outcome_version_id = $1",
    [firstVersionId],
  ).then(() => false).catch(() => true);
  check("canonical outcome aggregate is append-only", immutable);
  check("one canonical version chain is retained",
    Number(await scalar("select count(*) from game_engine.canonical_outcome_versions where draw_id = $1", [fixture.drawId])) === 3);
  check("all new outcome versions use CANONICAL_V1",
    Number(await scalar("select count(*) from game_engine.canonical_outcome_versions where draw_id = $1 and authority_model_version = 'CANONICAL_V1'", [fixture.drawId])) === 3);
  check("publication and Settlement handoff are outbox-backed",
    Number(await scalar(`select count(*) from public.outbox_events where correlation_id = $1
      and event_type in ('outcome.published','outcome.corrected','outcome.cancelled','settlement.requested')`,
      [`correlation:${fixture.suffix}`])) === 6);
  check("no Settlement authority write is performed by outcome publication",
    Number(await scalar("select count(*) from settlement_service.settlement_requests where settlement_input_id = any($1::uuid[])",
      [[firstInput, correctedInput]])) === 0);
  const derived = await pool.query(`select validated_primary_result, validated_bonus_result, derived_outcome_data
    from game_engine.canonical_outcome_versions where outcome_version_id = $1`, [correctedVersionId]);
  check("derived and Bullseye consumers retain references to the same validated result sets",
    derived.rows[0].derived_outcome_data.primaryResultHash === canonicalHash(JSON.stringify(derived.rows[0].validated_primary_result)) &&
      derived.rows[0].derived_outcome_data.bonusResultHash === canonicalHash(JSON.stringify(derived.rows[0].validated_bonus_result)));

  const recoveryFixture = await createCanonicalOutcomeFixture(pool);
  const recoveryResult = await appendCertifiedProviderResult(pool, recoveryFixture);
  const recoveryPublication = await post(
    "/api/game-engine/outcome-publications",
    publicationCommand(recoveryFixture, recoveryResult),
  );
  const recoveryVersionId = recoveryPublication.payload?.data?.outcomeVersionId;
  const recoveryInputId = await seedSettlementInput(
    recoveryFixture,
    recoveryResult,
    `${recoveryFixture.suffix}:recovery`,
  );
  check("interrupted Settlement handoff fixture begins without a request",
    Number(await scalar(
      "select count(*) from game_engine.outcome_settlement_requests where outcome_version_id = $1",
      [recoveryVersionId],
    )) === 0);

  const beforeRecovery = Number(await scalar(
    "select count(*) from game_engine.canonical_outcome_versions where draw_id = $1", [fixture.drawId]));
  const recovery = await post("/api/game-engine/outcome-publications/recover", {});
  check("recovery uses persisted evidence without republishing completed outcomes",
    recovery.status === 200 && Number(await scalar(
      "select count(*) from game_engine.canonical_outcome_versions where draw_id = $1", [fixture.drawId])) === beforeRecovery,
  recovery);
  check("interrupted Settlement handoff recovers from immutable evidence",
    Number(await scalar(`select count(*) from game_engine.outcome_settlement_requests
      where outcome_version_id = $1 and settlement_input_id = $2`, [recoveryVersionId, recoveryInputId])) === 1 &&
      Number(await scalar(`select count(*) from game_engine.canonical_outcome_lifecycle_events
        where outcome_version_id = $1 and operation = 'RECOVERY' and settlement_input_id = $2`,
      [recoveryVersionId, recoveryInputId])) === 1,
  recovery);

  await stopService();
  await startService();
  const replayCommand = {
    outcomeVersionId: cancelledVersionId,
    idempotencyKey: `replay:${fixture.suffix}:cancelled`,
    actorReference: "operator:bf-4.8-replay-qa",
    reasonCode: "POST_RESTART_EVIDENCE_VERIFICATION",
    correlationId: `replay-correlation:${fixture.suffix}`,
    causationId: `replay-causation:${cancelledVersionId}`,
  };
  const replayPath = `/api/game-engine/outcome-publications/${cancelledVersionId}/replay`;
  const replay = await post(replayPath, replayCommand);
  const duplicateReplay = await post(replayPath, replayCommand);
  const conflictingReplay = await post(replayPath, {
    ...replayCommand,
    reasonCode: "CONFLICTING_REPLAY_REASON",
  });
  check("restart replay verifies hashes, certificates, provider evidence, and Settlement references",
    replay.status === 200 && replay.payload?.data?.operation === "ReplayVerified", replay);
  check("replay is idempotent and never republishes authoritative state",
    duplicateReplay.status === 200 &&
      duplicateReplay.payload?.data?.lifecycleEventId === replay.payload?.data?.lifecycleEventId &&
      Number(await scalar(
        "select count(*) from game_engine.canonical_outcome_versions where draw_id = $1",
        [fixture.drawId],
      )) === beforeRecovery,
  { replay, duplicateReplay });
  check("conflicting replay idempotency fails closed", conflictingReplay.status === 409, conflictingReplay);

  const lifecycleImmutable = await pool.query(
    "update game_engine.canonical_outcome_lifecycle_events set reason_code = 'tampered' where lifecycle_event_id = $1",
    [replay.payload?.data?.lifecycleEventId],
  ).then(() => false).catch(() => true);
  check("lifecycle audit evidence is append-only", lifecycleImmutable);
} catch (error) {
  check("Canonical Outcome Authority QA completes", false, { error: error instanceof Error ? error.message : String(error) });
} finally {
  await stopService();
  await pool.end();
}

const failed = checks.filter((entry) => entry.status !== "PASS");
console.log(JSON.stringify({ status: failed.length === 0 ? "PASS" : "FAIL", checks }, null, 2));
if (failed.length > 0) process.exitCode = 1;
