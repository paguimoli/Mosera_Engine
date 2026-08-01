import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for Manual Certified provider QA.");
}

const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const checks: Array<{ name: string; status: "PASS" }> = [];

function hash(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function pass(name: string) {
  checks.push({ name, status: "PASS" });
}

function assert(condition: boolean, name: string): asserts condition {
  if (!condition) throw new Error(name);
  pass(name);
}

async function expectFailure(name: string, action: () => Promise<unknown>) {
  try {
    await action();
    throw new Error(`${name}: operation unexpectedly succeeded.`);
  } catch (error) {
    if (String(error).includes("unexpectedly succeeded")) throw error;
    pass(name);
  }
}

function providerEvidence(
  executionId: string,
  executionVersion: number,
  requestHash: string,
  resultHash: string,
  evidenceHash: string,
  drawId: string,
  manifestId: string,
  supersedesExecutionId: string | null,
  supersedesEvidenceId: string | null,
) {
  return {
    requestId: randomUUID(),
    executionId,
    executionVersion,
    supersedesExecutionId,
    supersedesEvidenceId,
    correctionReason: executionVersion > 1 ? "Certified regulator correction" : null,
    providerId: "mosera-manual-certified",
    providerVersion: "2.0.0",
    configurationVersion: "1",
    operatorIdentityReference: "operator:qa-certified-entry",
    certificationReference: `certification:${drawId}:v${executionVersion}`,
    reasonCode: executionVersion > 1 ? "CERTIFIED_CORRECTION" : "REGULATOR_AUTHORIZED_ENTRY",
    submissionTimestamp: new Date().toISOString(),
    submissionEvidenceHash: hash(`submission:${executionId}`),
    normalizedPayloadHash: resultHash,
    replayIdentifier: `manual-certified:${drawId}:v${executionVersion}`,
    canonicalRequestHash: requestHash,
    normalizedResult: {
      providerId: "mosera-manual-certified",
      providerVersion: "2.0.0",
      configurationVersion: "1",
      officialDrawIdentifier: `official-draw:${drawId}`,
      gameIdentifier: "QA-MANUAL-CERTIFIED",
      drawId,
      scheduleVersionId: "00000000-0000-0000-0000-000000000000",
      executionManifestId: manifestId,
      drawDateTime: new Date().toISOString(),
      certifiedNumbers: executionVersion > 1 ? [1, 2, 3] : [3, 4, 5],
      bonusNumbers: [],
      numberOrdering: "Ascending",
      bonusNumberOrdering: null,
      providerMetadata: { entryChannel: "REGULATOR_CONSOLE" },
      certificationReference: `certification:${drawId}:v${executionVersion}`,
      operatorIdentityReference: "operator:qa-certified-entry",
      reasonCode: executionVersion > 1 ? "CERTIFIED_CORRECTION" : "REGULATOR_AUTHORIZED_ENTRY",
      canonicalPayloadJson: "{}",
      canonicalPayloadHash: resultHash,
    },
    evidenceHash,
    completedAt: new Date().toISOString(),
  };
}

async function main() {
  try {
    const provider = await pool.query(
      `select provider.production_eligible, provider.lifecycle_state,
              configuration.production_ready, configuration.failure_mode,
              activation.activation_state
       from game_engine.outcome_provider_definitions provider
       join game_engine.outcome_provider_configuration_versions configuration
         on configuration.provider_id = provider.provider_id
        and configuration.provider_version = provider.provider_version
       join lateral (
         select event.activation_state
         from game_engine.outcome_provider_activation_events event
         where event.provider_id = configuration.provider_id
           and event.provider_version = configuration.provider_version
           and event.configuration_version = configuration.configuration_version
         order by event.effective_at desc, event.created_at desc
         limit 1
       ) activation on true
       where provider.provider_id = 'mosera-manual-certified'
         and provider.provider_version = '2.0.0'
         and configuration.configuration_version = '1'`,
    );
    assert(
      provider.rowCount === 1 &&
        provider.rows[0].production_eligible &&
        provider.rows[0].lifecycle_state === "Active" &&
        provider.rows[0].production_ready &&
        provider.rows[0].failure_mode === "FAIL_CLOSED" &&
        provider.rows[0].activation_state === "DISABLED",
      "Manual Certified provider is production-ready, fail-closed, and inactive",
    );

    const dependency = await pool.query(
      `select definition.id game_definition_id,
              definition.active_version_id game_definition_version_id,
              assignment.id assignment_id,
              assignment.draw_authority_version_id,
              module.code engine_name,
              module_version.version engine_version,
              definition_version.evaluator_version,
              definition_version.paytable_version
       from game_engine.draw_authority_assignments assignment
       join game_engine.game_definitions definition
         on definition.id = assignment.game_definition_id
       join game_engine.game_definition_versions definition_version
         on definition_version.id = definition.active_version_id
       join game_engine.game_modules module
         on module.id = definition.game_module_id
       join game_engine.game_module_versions module_version
         on module_version.id = module.active_version_id
       order by assignment.effective_from, assignment.id
       limit 1`,
    );
    if (dependency.rowCount !== 1) throw new Error("Draw dependency fixture is unavailable.");

    const suffix = randomUUID();
    const row = dependency.rows[0];
    const scheduleId = randomUUID();
    const scheduleVersionId = randomUUID();
    const drawId = randomUUID();
    const manifestId = randomUUID();
    const scheduledAt = new Date(Date.now() - 60_000);
    const scheduleHash = hash(`manual-schedule:${suffix}`);
    const identityHash = hash(`manual-draw:${suffix}`);
    await pool.query(
      `insert into game_engine.published_draw_schedule_versions (
         schedule_version_id, schedule_id, version_number, game_definition_id,
         draw_authority_assignment_id, schedule_kind, schedule_configuration,
         time_zone_id, schedule_hash, published_at)
       values ($1,$2,1,$3,$4,'QA_FIXED','{}'::jsonb,'UTC',$5,now())`,
      [scheduleVersionId, scheduleId, row.game_definition_id, row.assignment_id, scheduleHash],
    );
    await pool.query(
      `insert into game_engine.draw_schedules (
         id, game_definition_id, draw_authority_assignment_id, sales_open_at,
         sales_close_at, draw_at, status, schedule_version_id,
         scheduled_execution_at, schedule_hash, draw_identity_hash)
       values ($1,$2,$3,$4::timestamptz - interval '10 minutes',
         $4::timestamptz - interval '1 minute',$4,'Certified',$5,$4,$6,$7)`,
      [drawId, row.game_definition_id, row.assignment_id, scheduledAt, scheduleVersionId, scheduleHash, identityHash],
    );
    await pool.query(
      `insert into game_engine.draw_execution_manifests (
         execution_manifest_id, draw_id, schedule_version_id,
         game_definition_version_id, draw_authority_version_id,
         engine_name, engine_version, outcome_provider_id, outcome_provider_version,
         provider_configuration_version, evaluator_version, paytable_version,
         scheduled_execution_at, schedule_hash, draw_identity_hash,
         canonical_manifest_hash, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,'mosera-manual-certified','2.0.0','1',
         $8,$9,$10,$11,$12,$13,now())`,
      [
        manifestId,
        drawId,
        scheduleVersionId,
        row.game_definition_version_id,
        row.draw_authority_version_id,
        row.engine_name,
        row.engine_version,
        row.evaluator_version,
        row.paytable_version,
        scheduledAt,
        scheduleHash,
        identityHash,
        hash(`manual-manifest:${suffix}`),
      ],
    );

    const executionOne = randomUUID();
    const evidenceOne = randomUUID();
    const requestHashOne = hash(`manual-request:1:${suffix}`);
    const resultHashOne = hash(`manual-result:1:${suffix}`);
    const evidenceHashOne = hash(`manual-evidence:1:${suffix}`);
    await pool.query(
      `insert into game_engine.outcome_provider_executions (
         execution_id, execution_manifest_id, execution_version,
         supersedes_execution_id, provider_id, provider_version,
         configuration_version, idempotency_key, canonical_request_hash, claimed_at)
       values ($1,$2,1,null,'mosera-manual-certified','2.0.0','1',$3,$4,now())`,
      [executionOne, manifestId, `manual:1:${suffix}`, requestHashOne],
    );
    await pool.query(
      `insert into game_engine.outcome_provider_execution_attempts (
         attempt_id, execution_id, attempt_number, status, failure_classification,
         request_hash, attempt_hash, started_at, completed_at)
       values ($1,$2,1,'COMPLETED','NONE',$3,$4,now(),now())`,
      [randomUUID(), executionOne, requestHashOne, hash(`manual-attempt:1:${suffix}`)],
    );

    await expectFailure("incomplete manual evidence is rejected", () =>
      pool.query(
        `insert into game_engine.outcome_provider_execution_evidence (
           evidence_id, execution_id, execution_manifest_id, draw_id,
           provider_id, provider_version, configuration_version, request_hash,
           result_hash, evidence_hash, outcome_certificate_id,
           outcome_certificate_hash, execution_attempt, idempotency_key, status,
           provider_evidence_payload, started_at, completed_at)
         values ($1,$2,$3,$4,'mosera-manual-certified','2.0.0','1',$5,$6,$7,
           null,null,1,$8,'GENERATED','{}'::jsonb,now(),now())`,
        [randomUUID(), executionOne, manifestId, drawId, requestHashOne, resultHashOne, hash(`invalid:${suffix}`), `manual:1:${suffix}`],
      ),
    );

    await pool.query(
      `insert into game_engine.outcome_provider_execution_evidence (
         evidence_id, execution_id, execution_manifest_id, draw_id,
         provider_id, provider_version, configuration_version, request_hash,
         result_hash, evidence_hash, outcome_certificate_id,
         outcome_certificate_hash, execution_attempt, idempotency_key, status,
         provider_evidence_payload, started_at, completed_at)
       values ($1,$2,$3,$4,'mosera-manual-certified','2.0.0','1',$5,$6,$7,
         null,null,1,$8,'GENERATED',$9::jsonb,now(),now())`,
      [
        evidenceOne,
        executionOne,
        manifestId,
        drawId,
        requestHashOne,
        resultHashOne,
        evidenceHashOne,
        `manual:1:${suffix}`,
        JSON.stringify(providerEvidence(executionOne, 1, requestHashOne, resultHashOne, evidenceHashOne, drawId, manifestId, null, null)),
      ],
    );

    const executionTwo = randomUUID();
    const evidenceTwo = randomUUID();
    const requestHashTwo = hash(`manual-request:2:${suffix}`);
    const resultHashTwo = hash(`manual-result:2:${suffix}`);
    const evidenceHashTwo = hash(`manual-evidence:2:${suffix}`);
    await pool.query(
      `insert into game_engine.outcome_provider_executions (
         execution_id, execution_manifest_id, execution_version,
         supersedes_execution_id, provider_id, provider_version,
         configuration_version, idempotency_key, canonical_request_hash, claimed_at)
       values ($1,$2,2,$3,'mosera-manual-certified','2.0.0','1',$4,$5,now())`,
      [executionTwo, manifestId, executionOne, `manual:2:${suffix}`, requestHashTwo],
    );
    await pool.query(
      `insert into game_engine.outcome_provider_execution_attempts (
         attempt_id, execution_id, attempt_number, status, failure_classification,
         request_hash, attempt_hash, started_at, completed_at)
       values ($1,$2,1,'COMPLETED','NONE',$3,$4,now(),now())`,
      [randomUUID(), executionTwo, requestHashTwo, hash(`manual-attempt:2:${suffix}`)],
    );
    await pool.query(
      `insert into game_engine.outcome_provider_execution_evidence (
         evidence_id, execution_id, execution_manifest_id, draw_id,
         provider_id, provider_version, configuration_version, request_hash,
         result_hash, evidence_hash, outcome_certificate_id,
         outcome_certificate_hash, execution_attempt, idempotency_key, status,
         provider_evidence_payload, started_at, completed_at)
       values ($1,$2,$3,$4,'mosera-manual-certified','2.0.0','1',$5,$6,$7,
         null,null,1,$8,'GENERATED',$9::jsonb,now(),now())`,
      [
        evidenceTwo,
        executionTwo,
        manifestId,
        drawId,
        requestHashTwo,
        resultHashTwo,
        evidenceHashTwo,
        `manual:2:${suffix}`,
        JSON.stringify(providerEvidence(executionTwo, 2, requestHashTwo, resultHashTwo, evidenceHashTwo, drawId, manifestId, executionOne, evidenceOne)),
      ],
    );

    const versions = await pool.query(
      `select execution_version, supersedes_execution_id
       from game_engine.outcome_provider_executions
       where execution_manifest_id = $1 order by execution_version`,
      [manifestId],
    );
    assert(
      versions.rowCount === 2 &&
        versions.rows[0].supersedes_execution_id === null &&
        versions.rows[1].supersedes_execution_id === executionOne,
      "manual correction creates an exact immutable supersession chain",
    );
    await expectFailure("manual provider evidence update is blocked", () =>
      pool.query(
        `update game_engine.outcome_provider_execution_evidence
         set result_hash = $2 where evidence_id = $1`,
        [evidenceOne, hash(`mutated:${suffix}`)],
      ),
    );
    await expectFailure("manual provider execution delete is blocked", () =>
      pool.query(
        `delete from game_engine.outcome_provider_executions where execution_id = $1`,
        [executionOne],
      ),
    );

    const serviceSource = readFileSync(
      "services/game-engine/src/GameEngine.Application/Services/ManualCertifiedProvider.cs",
      "utf8",
    );
    const programSource = readFileSync(
      "services/game-engine/src/GameEngine.Api/Program.cs",
      "utf8",
    );
    const endpointsSource = readFileSync(
      "services/game-engine/src/GameEngine.Api/Controllers/GameEngineEndpoints.cs",
      "utf8",
    );
    const placeholdersSource = readFileSync(
      "services/game-engine/src/GameEngine.Application/Services/DrawProviderPlaceholders.cs",
      "utf8",
    );
    assert(
      serviceSource.includes("public sealed class ManualCertifiedProvider") &&
        serviceSource.includes("CanonicalOutcomeProviderAuthority") &&
        serviceSource.includes("ClaimSupersedingExecutionAsync") &&
        serviceSource.includes("VerifyReplayAsync") &&
        serviceSource.includes("BindOutcomeCertificateAsync"),
      "one canonical manual submission, correction, replay, and publication path exists",
    );
    assert(
      programSource.match(/AddSingleton<ManualCertifiedProvider>/g)?.length === 1 &&
        !endpointsSource.includes('MapPost("/manual-results"') &&
        !placeholdersSource.includes("class ManualCertifiedResultProvider"),
      "production DI has exactly one Manual Certified provider and no legacy submission authority",
    );

    const focused = spawnSync(
      "dotnet",
      [
        "run",
        "--project",
        "services/game-engine/tests/GameEngine.Application.Tests/GameEngine.Application.Tests.csproj",
        "--no-build",
        "--",
        "manual-certified-provider",
      ],
      { encoding: "utf8" },
    );
    assert(
      focused.status === 0 &&
        focused.stdout.includes("Manual Certified provider tests passed"),
      "immutable submission, validation, idempotency, replay, recovery, and outcome integration tests pass",
    );

    console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
  } finally {
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
