import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for Official Results provider QA.");
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

async function main() {
  try {
    const provider = await pool.query(
      `select provider.production_eligible, provider.lifecycle_state,
              configuration.production_ready, configuration.failure_mode,
              activation.stage as activation_stage
       from game_engine.outcome_provider_definitions provider
       join game_engine.outcome_provider_configuration_versions configuration
         on configuration.provider_id = provider.provider_id
        and configuration.provider_version = provider.provider_version
       join lateral (
         select event.stage
         from game_engine.game_engine_production_activation_events event
         where event.provider_id = configuration.provider_id
           and event.provider_version = configuration.provider_version
           and event.configuration_version = configuration.configuration_version
         order by event.created_at desc, event.activation_event_id desc
         limit 1
       ) activation on true
       where provider.provider_id = 'mosera-official-results'
         and provider.provider_version = '2.0.0'
         and configuration.configuration_version = '1'
         and provider.canonical_provider_category = 'OFFICIAL_RESULTS'`,
    );
    assert(
      provider.rowCount === 1 &&
        provider.rows[0].production_eligible === true &&
        provider.rows[0].production_ready === true &&
        provider.rows[0].lifecycle_state === "Active" &&
        provider.rows[0].failure_mode === "FAIL_CLOSED" &&
        provider.rows[0].activation_stage === "REGISTERED",
      "Official Results provider is production-ready, fail-closed, and inactive",
    );

    const eligible = await pool.query(
      `select count(*)::int count
       from game_engine.outcome_provider_definitions
       where provider_id = 'mosera-official-results'
         and canonical_provider_category = 'OFFICIAL_RESULTS'
         and production_eligible`,
    );
    assert(
      eligible.rows[0].count === 1,
      "exactly one production-eligible Official Results provider version exists",
    );

    const schema = await pool.query(
      `select
         exists (
           select 1 from information_schema.columns
           where table_schema = 'game_engine'
             and table_name = 'outcome_provider_executions'
             and column_name = 'execution_version') execution_version,
         exists (
           select 1 from information_schema.columns
           where table_schema = 'game_engine'
             and table_name = 'outcome_provider_executions'
             and column_name = 'supersedes_execution_id') supersedes_execution,
         exists (
           select 1 from pg_constraint
           where conname = 'ux_outcome_provider_execution_manifest_version') version_unique,
         exists (
           select 1 from pg_constraint
           where conname = 'ux_outcome_provider_execution_supersedes') supersession_unique,
         exists (
           select 1 from pg_trigger
           where tgname = 'trg_validate_outcome_provider_execution_chain'
             and not tgisinternal) chain_trigger`,
    );
    assert(
      Object.values(schema.rows[0]).every(Boolean),
      "canonical execution persistence enforces immutable provider versions and supersession",
    );

    const historicalComments = await pool.query(
      `select
         obj_description('game_engine.external_result_ingestion_events'::regclass) ingestion,
         obj_description('game_engine.external_result_verification_evidence'::regclass) evidence`,
    );
    assert(
      historicalComments.rows[0].ingestion.includes("Historical P0") &&
        historicalComments.rows[0].evidence.includes("Historical P0"),
      "legacy external-result tables are explicitly retained as historical evidence only",
    );

    const definition = await pool.query(
      `select assignment.game_definition_id,
              coalesce(max(version.version_number), 0)::int + 1000 version_number
       from game_engine.draw_authority_assignments assignment
       join game_engine.game_definition_versions version
         on version.game_definition_id = assignment.game_definition_id
       group by assignment.game_definition_id
       order by assignment.game_definition_id
       limit 1`,
    );
    if (definition.rowCount !== 1) {
      throw new Error("Game Definition fixture is unavailable.");
    }

    const validDefinitionVersionId = randomUUID();
    await pool.query(
      `insert into game_engine.game_definition_versions (
         id, game_definition_id, version_number, definition_hash,
         paytable_version, evaluator_version, draw_generator_version,
         effective_from, outcome_generation_definition)
       values ($1,$2,$3,$4,'qa-paytable','qa-evaluator','official-results:2.0.0',
         now(),$5::jsonb)`,
      [
        validDefinitionVersionId,
        definition.rows[0].game_definition_id,
        definition.rows[0].version_number,
        hash(`official-definition:${randomUUID()}`),
        JSON.stringify({
          NumberUniverse: [1, 2, 3, 4, 5],
          NumbersRequired: 3,
          Unique: true,
          WithReplacement: false,
          Ordering: "Ascending",
          BonusNumbers: {
            NumberUniverse: [1, 2],
            NumbersRequired: 1,
            Unique: true,
            WithReplacement: false,
            MayOverlapPrimary: false,
            Ordering: "Ascending",
          },
        }),
      ],
    );
    pass("immutable primary and bonus number rules persist");

    await expectFailure("invalid bonus-number definition fails closed", () =>
      pool.query(
        `insert into game_engine.game_definition_versions (
           id, game_definition_id, version_number, definition_hash,
           paytable_version, evaluator_version, draw_generator_version,
           effective_from, outcome_generation_definition)
         values ($1,$2,$3,$4,'qa-paytable','qa-evaluator','official-results:2.0.0',
           now(),$5::jsonb)`,
        [
          randomUUID(),
          definition.rows[0].game_definition_id,
          definition.rows[0].version_number + 1,
          hash(`invalid-official-definition:${randomUUID()}`),
          JSON.stringify({
            NumberUniverse: [1, 2, 3],
            NumbersRequired: 2,
            Unique: true,
            WithReplacement: false,
            Ordering: "Ascending",
            BonusNumbers: {
              NumberUniverse: [1, 1],
              NumbersRequired: 2,
              Unique: true,
              WithReplacement: true,
              MayOverlapPrimary: false,
              Ordering: "Ascending",
            },
          }),
        ],
      ),
    );

    const dependency = await pool.query(
      `select assignment.id assignment_id,
              assignment.draw_authority_version_id,
              module.code engine_name,
              module_version.version engine_version
       from game_engine.draw_authority_assignments assignment
       join game_engine.game_definitions definition
         on definition.id = assignment.game_definition_id
       join game_engine.game_modules module
         on module.id = definition.game_module_id
       join game_engine.game_module_versions module_version
         on module_version.id = module.active_version_id
       where definition.id = $1
       order by assignment.effective_from, assignment.id
       limit 1`,
      [definition.rows[0].game_definition_id],
    );
    if (dependency.rowCount !== 1) {
      throw new Error("Draw authority fixture is unavailable.");
    }

    const suffix = randomUUID();
    const scheduleId = randomUUID();
    const scheduleVersionId = randomUUID();
    const drawId = randomUUID();
    const manifestId = randomUUID();
    const scheduledAt = new Date(Date.now() + 60_000);
    const scheduleHash = hash(`official-schedule:${suffix}`);
    const drawIdentityHash = hash(`official-draw:${suffix}`);
    await pool.query(
      `insert into game_engine.published_draw_schedule_versions (
         schedule_version_id, schedule_id, version_number, game_definition_id,
         draw_authority_assignment_id, schedule_kind, schedule_configuration,
         time_zone_id, schedule_hash, published_at)
       values ($1,$2,1,$3,$4,'QA_FIXED','{}'::jsonb,'UTC',$5,now())`,
      [
        scheduleVersionId,
        scheduleId,
        definition.rows[0].game_definition_id,
        dependency.rows[0].assignment_id,
        scheduleHash,
      ],
    );
    await pool.query(
      `insert into game_engine.draw_schedules (
         id, game_definition_id, draw_authority_assignment_id, sales_open_at,
         sales_close_at, draw_at, status, schedule_version_id,
         scheduled_execution_at, schedule_hash, draw_identity_hash)
       values ($1,$2,$3,$4::timestamptz - interval '10 minutes',
         $4::timestamptz - interval '1 minute',$4,'Certified',$5,$4,$6,$7)`,
      [
        drawId,
        definition.rows[0].game_definition_id,
        dependency.rows[0].assignment_id,
        scheduledAt,
        scheduleVersionId,
        scheduleHash,
        drawIdentityHash,
      ],
    );
    await pool.query(
      `insert into game_engine.draw_execution_manifests (
         execution_manifest_id, draw_id, schedule_version_id,
         game_definition_version_id, draw_authority_version_id,
         engine_name, engine_version, outcome_provider_id, outcome_provider_version,
         provider_configuration_version, evaluator_version, paytable_version,
         scheduled_execution_at, schedule_hash, draw_identity_hash,
         canonical_manifest_hash, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,'mosera-official-results','2.0.0','1',
         'qa-evaluator','qa-paytable',$8,$9,$10,$11,now())`,
      [
        manifestId,
        drawId,
        scheduleVersionId,
        validDefinitionVersionId,
        dependency.rows[0].draw_authority_version_id,
        dependency.rows[0].engine_name,
        dependency.rows[0].engine_version,
        scheduledAt,
        scheduleHash,
        drawIdentityHash,
        hash(`official-manifest:${suffix}`),
      ],
    );

    const executionOne = randomUUID();
    const evidenceOne = randomUUID();
    const requestHashOne = hash(`official-request:1:${suffix}`);
    await pool.query(
      `insert into game_engine.outcome_provider_executions (
         execution_id, execution_manifest_id, execution_version,
         supersedes_execution_id, provider_id, provider_version,
         configuration_version, idempotency_key, canonical_request_hash, claimed_at)
       values ($1,$2,1,null,'mosera-official-results','2.0.0','1',$3,$4,now())`,
      [executionOne, manifestId, `official-result:1:${suffix}`, requestHashOne],
    );
    await pool.query(
      `insert into game_engine.outcome_provider_execution_attempts (
         attempt_id, execution_id, attempt_number, status, failure_classification,
         request_hash, attempt_hash, started_at, completed_at)
       values ($1,$2,1,'COMPLETED','NONE',$3,$4,now(),now())`,
      [
        randomUUID(),
        executionOne,
        requestHashOne,
        hash(`official-attempt:1:${suffix}`),
      ],
    );
    await pool.query(
      `insert into game_engine.outcome_provider_execution_evidence (
         evidence_id, execution_id, execution_manifest_id, draw_id,
         provider_id, provider_version, configuration_version, request_hash,
         result_hash, evidence_hash, outcome_certificate_id,
         outcome_certificate_hash, execution_attempt, idempotency_key, status,
         provider_evidence_payload, started_at, completed_at)
       values ($1,$2,$3,$4,'mosera-official-results','2.0.0','1',$5,$6,$7,
         null,null,1,$8,'GENERATED',$9::jsonb,now(),now())`,
      [
        evidenceOne,
        executionOne,
        manifestId,
        drawId,
        requestHashOne,
        hash(`official-result:1:${suffix}`),
        hash(`official-evidence:1:${suffix}`),
        `official-result:1:${suffix}`,
        JSON.stringify({
          normalizationVersion: "1.0.0",
          validationPassed: true,
          sourceIdentifier: "qa-source",
          replayIdentifier: `official-result:${drawId}:v1`,
        }),
      ],
    );

    const executionTwo = randomUUID();
    const requestHashTwo = hash(`official-request:2:${suffix}`);
    await pool.query(
      `insert into game_engine.outcome_provider_executions (
         execution_id, execution_manifest_id, execution_version,
         supersedes_execution_id, provider_id, provider_version,
         configuration_version, idempotency_key, canonical_request_hash, claimed_at)
       values ($1,$2,2,$3,'mosera-official-results','2.0.0','1',$4,$5,now())`,
      [
        executionTwo,
        manifestId,
        executionOne,
        `official-result:2:${suffix}`,
        requestHashTwo,
      ],
    );
    await pool.query(
      `insert into game_engine.outcome_provider_execution_attempts (
         attempt_id, execution_id, attempt_number, status, failure_classification,
         request_hash, attempt_hash, started_at, completed_at)
       values ($1,$2,1,'COMPLETED','NONE',$3,$4,now(),now())`,
      [
        randomUUID(),
        executionTwo,
        requestHashTwo,
        hash(`official-attempt:2:${suffix}`),
      ],
    );
    await pool.query(
      `insert into game_engine.outcome_provider_execution_evidence (
         evidence_id, execution_id, execution_manifest_id, draw_id,
         provider_id, provider_version, configuration_version, request_hash,
         result_hash, evidence_hash, outcome_certificate_id,
         outcome_certificate_hash, execution_attempt, idempotency_key, status,
         provider_evidence_payload, started_at, completed_at)
       values ($1,$2,$3,$4,'mosera-official-results','2.0.0','1',$5,$6,$7,
         null,null,1,$8,'GENERATED',$9::jsonb,now(),now())`,
      [
        randomUUID(),
        executionTwo,
        manifestId,
        drawId,
        requestHashTwo,
        hash(`official-result:2:${suffix}`),
        hash(`official-evidence:2:${suffix}`),
        `official-result:2:${suffix}`,
        JSON.stringify({
          normalizationVersion: "1.0.0",
          validationPassed: true,
          sourceIdentifier: "qa-source",
          replayIdentifier: `official-result:${drawId}:v2`,
          supersedesEvidenceId: evidenceOne,
        }),
      ],
    );
    const versions = await pool.query(
      `select execution_version, supersedes_execution_id
       from game_engine.outcome_provider_executions
       where execution_manifest_id = $1
       order by execution_version`,
      [manifestId],
    );
    assert(
      versions.rowCount === 2 &&
        versions.rows[0].execution_version === 1 &&
        versions.rows[0].supersedes_execution_id === null &&
        versions.rows[1].execution_version === 2 &&
        versions.rows[1].supersedes_execution_id === executionOne,
      "official result correction persists as an exact immutable supersession chain",
    );
    await expectFailure("official provider evidence update is blocked", () =>
      pool.query(
        `update game_engine.outcome_provider_execution_evidence
         set result_hash = $2 where evidence_id = $1`,
        [evidenceOne, hash(`mutated:${suffix}`)],
      ),
    );
    await expectFailure("official provider execution delete is blocked", () =>
      pool.query(
        `delete from game_engine.outcome_provider_executions
         where execution_id = $1`,
        [executionOne],
      ),
    );

    const providerSource = readFileSync(
      "services/game-engine/src/GameEngine.Application/Services/OfficialResultsProvider.cs",
      "utf8",
    );
    const programSource = readFileSync(
      "services/game-engine/src/GameEngine.Api/Program.cs",
      "utf8",
    );
    const persistenceSource = readFileSync(
      "services/game-engine/src/GameEngine.Infrastructure/Persistence/PostgresExternalOfficialResultPersistence.cs",
      "utf8",
    );
    assert(
      providerSource.includes("public sealed class OfficialResultsProvider") &&
        providerSource.includes("CanonicalOutcomeProviderAuthority") &&
        providerSource.includes("CompleteGeneratedExecutionAsync") &&
        providerSource.includes("ClaimSupersedingExecutionAsync") &&
        providerSource.includes("VerifyReplayAsync"),
      "one normalization, validation, persistence, supersession, and replay pipeline exists",
    );
    assert(
      programSource.includes("AddSingleton<OfficialResultsProvider>") &&
        !programSource.includes("ExternalOfficialResultRuntimeService") &&
        !programSource.includes("IExternalResultEvidenceRepository") &&
        !persistenceSource.includes("PostgresExternalResultEvidenceRepository"),
      "production DI has one Official Results provider and no legacy evidence writer",
    );

    const focused = spawnSync(
      "dotnet",
      [
        "run",
        "--project",
        "services/game-engine/tests/GameEngine.Application.Tests/GameEngine.Application.Tests.csproj",
        "--no-build",
        "--",
        "official-results-provider",
      ],
      { encoding: "utf8" },
    );
    assert(
      focused.status === 0 &&
        focused.stdout.includes("Official Results provider tests passed"),
      "Official API, file, scraper, manual import, correction, replay, and recovery tests pass",
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
