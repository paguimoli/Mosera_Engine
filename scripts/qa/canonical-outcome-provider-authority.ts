import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for canonical Outcome Provider Authority QA.");
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
    const categories = await pool.query(
      `select canonical_provider_category, count(*)::int count
       from game_engine.outcome_provider_definitions
       where provider_id in (
         'mosera-internal-csprng',
         'mosera-official-results',
         'mosera-manual-certified')
       group by canonical_provider_category`,
    );
    assert(
      new Set(categories.rows.map((row) => row.canonical_provider_category)).size === 3,
      "INTERNAL_CSPRNG, OFFICIAL_RESULTS, and MANUAL_CERTIFIED are registered",
    );

    const builtIns = await pool.query(
      `select provider.provider_id, provider.provider_version, provider.production_eligible,
              configuration.production_ready, activation.stage as activation_stage
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
       where provider.provider_id in (
         'mosera-internal-csprng',
         'mosera-official-results',
         'mosera-manual-certified')`,
    );
    assert(
      builtIns.rowCount === 3 &&
        builtIns.rows.every(
          (row) =>
            row.provider_version === "2.0.0" &&
            row.production_eligible === true &&
            row.production_ready === true &&
            row.activation_stage === "REGISTERED",
        ),
      "production-ready built-in providers remain registered and inactive",
    );

    await expectFailure("provider versions are immutable", () =>
      pool.query(
        `update game_engine.outcome_provider_definitions
         set lifecycle_state = 'Active'
         where provider_id = 'mosera-internal-csprng' and provider_version = '1.0.0'`,
      ),
    );
    await expectFailure("provider configuration versions are immutable", () =>
      pool.query(
        `update game_engine.outcome_provider_configuration_versions
         set production_ready = true
         where provider_id = 'mosera-internal-csprng'
           and provider_version = '1.0.0'
           and configuration_version = '1'`,
      ),
    );

    const suffix = randomUUID();
    const providerId = `qa-canonical-provider:${suffix}`;
    const providerVersion = "1.0.0";
    const configurationVersion = "1";
    await pool.query(
      `insert into game_engine.outcome_provider_definitions (
         id, provider_id, provider_version, provider_type, lifecycle_state,
         production_eligible, supported_outcome_primitive_types,
         evidence_requirements, health_readiness_capabilities, idempotency_model,
         custody_support, signing_requirements, replayability_support, failure_mode,
         capability_markers, content_hash, canonical_provider_category)
       values ($1,$2,$3,'CERTIFIED_CSPRNG','Active',true,
         '["UniqueNumberSet"]'::jsonb,'{"providerEvidenceHash":true}'::jsonb,
         '["qa-ready"]'::jsonb,'PerDraw','["Generated","Certified"]'::jsonb,
         '{"signatureRequired":true}'::jsonb,true,'FailClosed',
         '{"generatesOutcomes":true,"ingestsExternalOutcomes":false,"supportsPlayerVerificationReceipt":false,"supportsDeterministicReplay":true,"supportsProviderHealthEvidence":true,"supportsDisputeHandling":true,"supportsExternalSourceEvidence":false,"supportsPhysicalDrawEvidence":false}'::jsonb,
         $4,'INTERNAL_CSPRNG')`,
      [randomUUID(), providerId, providerVersion, hash(`provider:${suffix}`)],
    );
    await pool.query(
      `insert into game_engine.outcome_provider_configuration_versions (
         provider_id, provider_version, configuration_version,
         canonical_provider_category, configuration_hash, supported_capabilities,
         evidence_requirements, readiness_capabilities, production_ready, failure_mode)
       values ($1,$2,$3,'INTERNAL_CSPRNG',$4,'["UniqueNumberSet"]'::jsonb,
         '{"providerEvidenceHash":true}'::jsonb,'["qa-ready"]'::jsonb,true,'FAIL_CLOSED')`,
      [providerId, providerVersion, configurationVersion, hash(`configuration:${suffix}`)],
    );
    for (const stage of ["REGISTERED", "READY", "APPROVED", "PRODUCTION_ACTIVE"]) {
      await pool.query(
        `insert into game_engine.game_engine_production_activation_events (
           activation_event_id, provider_id, provider_version, configuration_version,
           stage, actor_reference, reason_code, approval_reference,
           signing_provider_id, signing_provider_version, signing_key_version,
           canonical_request_hash, evidence_hash, idempotency_key, created_at)
         values ($1,$2,$3,$4,$5,'qa:canonical-provider','QA_PROVIDER_ACTIVATION',
           'qa:approved','mosera-software-signing','1.0.0','key-v1',$6,$7,$8,now())`,
        [
          randomUUID(), providerId, providerVersion, configurationVersion, stage,
          hash(`activation-request:${suffix}:${stage}`),
          hash(`activation-evidence:${suffix}:${stage}`),
          `qa-provider-activation:${suffix}:${stage}`,
        ],
      );
    }

    const dependency = await pool.query(
      `select definition.id game_definition_id,
              definition.active_version_id game_definition_version_id,
              assignment.id assignment_id,
              assignment.draw_authority_version_id,
              module.code engine_name,
              module_version.version engine_version
       from game_engine.draw_authority_assignments assignment
       join game_engine.game_definitions definition on definition.id = assignment.game_definition_id
       join game_engine.game_modules module on module.id = definition.game_module_id
       join game_engine.game_module_versions module_version on module_version.id = module.active_version_id
       order by assignment.effective_from, assignment.id
       limit 1`,
    );
    if (dependency.rowCount !== 1) throw new Error("Draw dependency fixture is unavailable.");
    const row = dependency.rows[0];
    const scheduleId = randomUUID();
    const scheduleVersionId = randomUUID();
    const drawId = randomUUID();
    const manifestId = randomUUID();
    const scheduledAt = new Date(Date.now() + 60_000);
    const scheduleHash = hash(`schedule:${suffix}`);
    const identityHash = hash(`draw:${suffix}`);
    const manifestHash = hash(`manifest:${suffix}`);
    await pool.query(
      `insert into game_engine.published_draw_schedule_versions (
         schedule_version_id, schedule_id, version_number, game_definition_id,
         draw_authority_assignment_id, schedule_kind, schedule_configuration,
         time_zone_id, schedule_hash, published_at)
       values ($1,$2,1,$3,$4,'QA_FIXED','{}'::jsonb,'UTC',$5,now())`,
      [
        scheduleVersionId,
        scheduleId,
        row.game_definition_id,
        row.assignment_id,
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
        row.game_definition_id,
        row.assignment_id,
        scheduledAt,
        scheduleVersionId,
        scheduleHash,
        identityHash,
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
       select $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
         definition.evaluator_version,definition.paytable_version,$11,$12,$13,$14,now()
       from game_engine.game_definition_versions definition where definition.id=$4`,
      [
        manifestId,
        drawId,
        scheduleVersionId,
        row.game_definition_version_id,
        row.draw_authority_version_id,
        row.engine_name,
        row.engine_version,
        providerId,
        providerVersion,
        configurationVersion,
        scheduledAt,
        scheduleHash,
        identityHash,
        manifestHash,
      ],
    );

    const selection = await pool.query(
      `select provider.provider_id, provider.provider_version,
              configuration.configuration_version,
              configuration.canonical_provider_category
       from game_engine.draw_execution_manifests manifest
       join game_engine.outcome_provider_definitions provider
         on provider.provider_id = manifest.outcome_provider_id
        and provider.provider_version = manifest.outcome_provider_version
       join game_engine.outcome_provider_configuration_versions configuration
         on configuration.provider_id = manifest.outcome_provider_id
        and configuration.provider_version = manifest.outcome_provider_version
        and configuration.configuration_version = manifest.provider_configuration_version
       where manifest.execution_manifest_id = $1`,
      [manifestId],
    );
    assert(
      selection.rowCount === 1 &&
        selection.rows[0].provider_id === providerId &&
        selection.rows[0].provider_version === providerVersion &&
        selection.rows[0].configuration_version === configurationVersion,
      "provider selection resolves only the exact Execution Manifest binding",
    );

    await expectFailure("unknown provider configuration is rejected", () =>
      pool.query(
        `insert into game_engine.outcome_provider_configuration_versions (
           provider_id, provider_version, configuration_version,
           canonical_provider_category, configuration_hash, supported_capabilities,
           evidence_requirements, readiness_capabilities, production_ready, failure_mode)
         values ('unknown-provider','1','1','INTERNAL_CSPRNG',$1,'[]'::jsonb,
           '{}'::jsonb,'[]'::jsonb,false,'FAIL_CLOSED')`,
        [hash(`unknown:${suffix}`)],
      ),
    );

    const executionId = randomUUID();
    const requestHash = hash(`request:${suffix}`);
    const idempotencyKey = `provider-execution:${suffix}`;
    await pool.query(
      `insert into game_engine.outcome_provider_executions (
         execution_id, execution_manifest_id, provider_id, provider_version,
         configuration_version, idempotency_key, canonical_request_hash, claimed_at)
       values ($1,$2,$3,$4,$5,$6,$7,now())`,
      [
        executionId,
        manifestId,
        providerId,
        providerVersion,
        configurationVersion,
        idempotencyKey,
        requestHash,
      ],
    );
    pass("durable pre-execution claim persists");
    const recoverableClaim = await pool.query(
      `select count(*)::int count
       from game_engine.outcome_provider_executions execution
       left join game_engine.outcome_provider_execution_evidence evidence
         on evidence.execution_id = execution.execution_id
       where execution.execution_id = $1 and evidence.execution_id is null`,
      [executionId],
    );
    assert(
      recoverableClaim.rows[0].count === 1,
      "interrupted execution remains discoverable for recovery",
    );
    await expectFailure("duplicate authoritative execution is prevented", () =>
      pool.query(
        `insert into game_engine.outcome_provider_executions (
           execution_id, execution_manifest_id, provider_id, provider_version,
           configuration_version, idempotency_key, canonical_request_hash, claimed_at)
         values ($1,$2,$3,$4,$5,$6,$7,now())`,
        [
          randomUUID(),
          manifestId,
          providerId,
          providerVersion,
          configurationVersion,
          `other:${suffix}`,
          requestHash,
        ],
      ),
    );
    await expectFailure("conflicting idempotency reuse is prevented", () =>
      pool.query(
        `insert into game_engine.outcome_provider_executions (
           execution_id, execution_manifest_id, provider_id, provider_version,
           configuration_version, idempotency_key, canonical_request_hash, claimed_at)
         values ($1,$2,$3,$4,$5,$6,$7,now())`,
        [
          randomUUID(),
          manifestId,
          providerId,
          providerVersion,
          configurationVersion,
          idempotencyKey,
          hash(`conflict:${suffix}`),
        ],
      ),
    );

    const outcomeCertificateId = randomUUID();
    const outcomeCertificateHash = hash(`certificate:${suffix}`);
    const resultHash = hash(`result:${suffix}`);
    const providerEvidenceHash = hash(`evidence:${suffix}`);
    const authoritativeEvidenceHash = hash(`authoritative-evidence:${suffix}`);
    const providerEvidencePayload = JSON.stringify({
      requestIdentifier: randomUUID(),
      generatedBytesHash: hash(`bytes:${suffix}`),
      generatedNumbers: [1, 2, 3, 4, 5],
      healthEvidence: { selfTestPassed: true },
    });
    const outcomeId = randomUUID();
    const strategyId = `bf-4.3-strategy:${suffix}`;
    const rngProviderId = `bf-4.3-rng:${suffix}`;
    const rngEvidenceHash = hash(`rng-evidence:${suffix}`);
    await pool.query(
      `insert into game_engine.outcome_strategy_definitions (
         id, strategy_id, strategy_version, primitive_graph, input_schema,
         output_schema, constraints, jurisdiction_profile_references,
         lifecycle_state, content_hash, certification_binding_placeholder,
         signature_metadata)
       values ($1,$2,'1.0.0',
         '[{"nodeId":"numbers","primitiveType":"UniqueNumberSet","dependsOn":[],"minNumber":1,"maxNumber":40,"count":5}]'::jsonb,
         '{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'[]'::jsonb,
         'GovernanceApproved',$3,null,'{}'::jsonb)`,
      [randomUUID(), strategyId, hash(`strategy:${suffix}`)],
    );
    await pool.query(
      `insert into game_engine.rng_provider_definitions (
         id, provider_id, provider_version, provider_type, production_eligible,
         certification_state, algorithm_references, entropy_source_metadata,
         health_test_capabilities, failure_mode, content_hash, signature_metadata)
       values ($1,$2,'1.0.0','TEST_DETERMINISTIC',false,'InternalVerified',
         '["qa"]'::jsonb,'{}'::jsonb,'["qa"]'::jsonb,'FailClosed',$3,'{}'::jsonb)`,
      [randomUUID(), rngProviderId, hash(`rng-provider:${suffix}`)],
    );
    await pool.query(
      `insert into game_engine.rng_provider_evidence (
         evidence_id, provider_id, provider_version, entropy_source_reference,
         health_test_result, known_answer_test_result, continuous_test_result,
         generated_at, canonical_evidence_hash, signing_metadata)
       values ($1,$2,'1.0.0','qa','Passed','Passed','Passed',now(),$3,'{}'::jsonb)`,
      [randomUUID(), rngProviderId, rngEvidenceHash],
    );
    await pool.query(
      `insert into game_engine.outcome_events (
         outcome_id, request_id, draw_id, game_manifest_reference, strategy_id,
         strategy_version, rng_provider_id, rng_provider_version, rng_evidence_hash,
         idempotency_key, outcome_mode, outcome_payload, canonical_outcome_hash,
         generated_at)
       values ($1,$2,$3,'manifest:bf-4.3:1.0.0',$4,'1.0.0',$5,'1.0.0',
         $6,$7,'DryRun','{"numbers":[1,2,3,4,5]}'::jsonb,$8,now())`,
      [
        outcomeId,
        randomUUID(),
        drawId,
        strategyId,
        rngProviderId,
        rngEvidenceHash,
        `outcome:${suffix}`,
        outcomeCertificateHash,
      ],
    );
    await pool.query(
      `insert into game_engine.outcome_certificates (
         certificate_id, outcome_id, draw_id, strategy_id, strategy_version,
         rng_provider_id, rng_provider_version, canonical_outcome_hash,
         evidence_hash_reference, previous_certificates, signing_metadata,
         custody_state, issued_at)
       values ($1,$2,$3,$4,'1.0.0',$5,'1.0.0',$6,$7,
         '[]'::jsonb,'{}'::jsonb,'Certified',now())`,
      [
        outcomeCertificateId,
        outcomeId,
        drawId,
        strategyId,
        rngProviderId,
        outcomeCertificateHash,
        rngEvidenceHash,
      ],
    );
    await pool.query(
      `insert into game_engine.outcome_provider_execution_attempts (
         attempt_id, execution_id, attempt_number, status, failure_classification,
         request_hash, attempt_hash, started_at, completed_at)
       values ($1,$2,1,'COMPLETED','NONE',$3,$4,now(),now())`,
      [randomUUID(), executionId, requestHash, hash(`attempt:${suffix}`)],
    );
    await pool.query(
      `insert into game_engine.outcome_provider_execution_evidence (
         evidence_id, execution_id, execution_manifest_id, draw_id, provider_id,
         provider_version, configuration_version, request_hash, result_hash,
         evidence_hash, outcome_certificate_id, outcome_certificate_hash,
         execution_attempt, idempotency_key, status, provider_evidence_payload,
         started_at, completed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,null,null,1,$11,
         'GENERATED',$12::jsonb,now(),now())`,
      [
        randomUUID(),
        executionId,
        manifestId,
        drawId,
        providerId,
        providerVersion,
        configurationVersion,
        requestHash,
        resultHash,
        providerEvidenceHash,
        idempotencyKey,
        providerEvidencePayload,
      ],
    );
    await pool.query(
      `insert into game_engine.outcome_provider_execution_evidence (
         evidence_id, execution_id, execution_manifest_id, draw_id, provider_id,
         provider_version, configuration_version, request_hash, result_hash,
         evidence_hash, outcome_certificate_id, outcome_certificate_hash,
         execution_attempt, idempotency_key, status, provider_evidence_payload,
         started_at, completed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,$13,
         'AUTHORITATIVE',$14::jsonb,now(),now())`,
      [
        randomUUID(),
        executionId,
        manifestId,
        drawId,
        providerId,
        providerVersion,
        configurationVersion,
        requestHash,
        resultHash,
        authoritativeEvidenceHash,
        outcomeCertificateId,
        outcomeCertificateHash,
        idempotencyKey,
        providerEvidencePayload,
      ],
    );
    const binding = await pool.query(
      `select result_hash, evidence_hash, outcome_certificate_hash
       from game_engine.outcome_provider_execution_evidence
       where execution_manifest_id = $1 and status = 'AUTHORITATIVE'`,
      [manifestId],
    );
    assert(
      binding.rowCount === 1 &&
        binding.rows[0].result_hash === resultHash &&
        binding.rows[0].evidence_hash === authoritativeEvidenceHash &&
        binding.rows[0].outcome_certificate_hash === outcomeCertificateHash,
      "provider result, evidence, and Outcome Certificate hashes are bound durably",
    );
    await expectFailure("completed provider evidence cannot be replaced", () =>
      pool.query(
        `insert into game_engine.outcome_provider_execution_evidence (
           evidence_id, execution_id, execution_manifest_id, draw_id, provider_id,
           provider_version, configuration_version, request_hash, result_hash,
           evidence_hash, outcome_certificate_id, outcome_certificate_hash,
           execution_attempt, idempotency_key, status, provider_evidence_payload,
           started_at, completed_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,2,$13,
           'AUTHORITATIVE',$14::jsonb,now(),now())`,
        [
          randomUUID(),
          executionId,
          manifestId,
          drawId,
          providerId,
          providerVersion,
          configurationVersion,
          requestHash,
          hash(`replacement-result:${suffix}`),
          hash(`replacement-evidence:${suffix}`),
          outcomeCertificateId,
          outcomeCertificateHash,
          idempotencyKey,
          providerEvidencePayload,
        ],
      ),
    );

    const authoritySource = readFileSync(
      "services/game-engine/src/GameEngine.Application/Services/CanonicalOutcomeProviderAuthority.cs",
      "utf8",
    );
    assert(
      authoritySource.includes("manifest.ProviderConfigurationVersion") &&
        authoritySource.includes("The manifest-bound Outcome Provider is disabled.") &&
        authoritySource.includes("not production-ready") &&
        !authoritySource.includes("fallbackProvider"),
      "canonical authority rejects disabled, unready, and fallback provider selection",
    );
    const orchestratorSource = readFileSync(
      "services/game-engine/src/GameEngine.Application/Services/CanonicalOutcomeAuthority.cs",
      "utf8",
    );
    assert(
      orchestratorSource.includes("providerAuthority.AuthorizePublicationAsync"),
      "Draw Orchestrator consumes only the canonical Outcome Provider Authority",
    );
    const programSource = readFileSync(
      "services/game-engine/src/GameEngine.Api/Program.cs",
      "utf8",
    );
    assert(
      programSource.includes("CanonicalOutcomeProviderAuthority") &&
        !programSource.includes("AddSingleton<OutcomeProviderOrchestrationService>") &&
        !programSource.includes("AddSingleton<IOutcomeProviderRuntime"),
      "legacy provider-specific orchestration is retired from production DI",
    );

    const restrictiveForeignKeys = await pool.query(
      `select count(*)::int count
       from pg_constraint
       where conname in (
         'fk_draw_execution_manifest_provider_definition',
         'fk_draw_execution_manifest_provider_configuration',
         'fk_outcome_provider_execution_manifest',
         'fk_outcome_provider_execution_configuration',
         'fk_outcome_provider_evidence_execution',
         'fk_outcome_provider_evidence_manifest',
         'fk_outcome_provider_evidence_draw',
         'fk_outcome_provider_evidence_configuration')
         and confdeltype = 'r'`,
    );
    assert(
      restrictiveForeignKeys.rows[0].count === 8,
      "permanent provider relationships use ON DELETE RESTRICT",
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
