import { createHash, randomUUID } from "node:crypto";

export function canonicalHash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function jsonbText(pool, value) {
  const result = await pool.query("select $1::jsonb::text as value", [JSON.stringify(value)]);
  return result.rows[0].value;
}

export async function createCanonicalOutcomeFixture(pool, options = {}) {
  const suffix = options.suffix ?? randomUUID();
  const category = options.category ?? "INTERNAL_CSPRNG";
  const drawId = options.drawId ?? randomUUID();
  const dependency = await pool.query(`
select
  definition.id as game_definition_id,
  version.id as game_definition_version_id,
  version.definition_hash,
  version.evaluator_version,
  version.outcome_generation_definition,
  assignment.id as assignment_id,
  assignment.draw_authority_version_id,
  module.code as engine_name,
  module_version.version as engine_version
from game_engine.draw_authority_assignments assignment
join game_engine.game_definitions definition on definition.id = assignment.game_definition_id
join game_engine.game_definition_versions version on version.game_definition_id = definition.id
join game_engine.game_modules module on module.id = definition.game_module_id
join game_engine.game_module_versions module_version on module_version.id = module.active_version_id
where version.outcome_generation_definition is not null
  and ($1::uuid is null or definition.id = $1::uuid)
  and (not $2::boolean or definition.active_version_id = version.id)
order by version.version_number desc, assignment.effective_from, assignment.id
limit 1;
`, [options.gameDefinitionId ?? null, options.requireActiveVersion ?? false]);
  if (dependency.rowCount !== 1) throw new Error("Canonical outcome fixture requires one immutable Game Definition.");
  const definition = dependency.rows[0];
  const rules = definition.outcome_generation_definition;
  const offset = options.numberOffset ?? 0;
  const bonusRules = rules.BonusNumbers;
  const primaryUniverse = bonusRules && !bonusRules.MayOverlapPrimary
    ? [...rules.NumberUniverse].sort((left, right) =>
      Number(bonusRules.NumberUniverse.includes(left)) - Number(bonusRules.NumberUniverse.includes(right)))
    : [...rules.NumberUniverse];
  const primary = primaryUniverse
    .slice(offset, offset + rules.NumbersRequired)
    .sort((left, right) => rules.Ordering === "Ascending" ? left - right : 0);
  if (primary.length !== rules.NumbersRequired) throw new Error("Fixture cannot satisfy primary number rules.");
  const bonus = bonusRules
    ? [...bonusRules.NumberUniverse]
      .filter((value) => bonusRules.MayOverlapPrimary || !primary.includes(value))
      .slice(offset, offset + bonusRules.NumbersRequired)
      .sort((left, right) => bonusRules.Ordering === "Ascending" ? left - right : 0)
    : [];
  if (bonusRules && bonus.length !== bonusRules.NumbersRequired) throw new Error("Fixture cannot satisfy bonus rules.");

  const scheduleId = randomUUID();
  const scheduleVersionId = randomUUID();
  const manifestId = randomUUID();
  const providerId = `qa-canonical-${category.toLowerCase()}:${suffix}`;
  const providerVersion = "1.0.0";
  const configurationVersion = "1";
  const providerType = category === "INTERNAL_CSPRNG" ? "CERTIFIED_CSPRNG" : "EXTERNAL_OFFICIAL_RESULT";
  const generates = category === "INTERNAL_CSPRNG";
  const drawStatus = options.drawStatus ?? "Certified";
  const scheduledAt = options.scheduledAt ?? new Date(Date.now() + 60_000);
  const salesOpenAt = drawStatus === "SalesOpen"
    ? new Date(Date.now() - 60_000)
    : new Date(scheduledAt.getTime() - 10 * 60_000);
  const salesCloseAt = drawStatus === "SalesOpen"
    ? new Date(Date.now() + 10 * 60_000)
    : new Date(scheduledAt.getTime() - 60_000);
  const drawAt = drawStatus === "SalesOpen"
    ? new Date(Date.now() + 11 * 60_000)
    : scheduledAt;
  const scheduleHash = canonicalHash(`schedule:${suffix}`);
  const identityHash = canonicalHash(`draw:${drawId}`);
  const manifestHash = canonicalHash(`manifest:${drawId}`);

  await pool.query(`
insert into game_engine.outcome_provider_definitions (
  id, provider_id, provider_version, provider_type, lifecycle_state,
  production_eligible, supported_outcome_primitive_types, evidence_requirements,
  health_readiness_capabilities, idempotency_model, custody_support,
  signing_requirements, replayability_support, failure_mode, capability_markers,
  content_hash, canonical_provider_category)
values ($1, $2, $3, $4, 'Active', true, '["UniqueNumberSet","OrderedNumberSequence"]'::jsonb,
  '{"providerEvidenceHash":true}'::jsonb, '["qa-ready"]'::jsonb, 'PerDraw',
  '["Generated","Certified"]'::jsonb, '{"signatureRequired":true}'::jsonb, true,
  'FailClosed', $5::jsonb, $6, $7);
`, [
    randomUUID(), providerId, providerVersion, providerType,
    JSON.stringify({
      generatesOutcomes: generates,
      ingestsExternalOutcomes: !generates,
      supportsPlayerVerificationReceipt: false,
      supportsDeterministicReplay: true,
      supportsProviderHealthEvidence: true,
      supportsDisputeHandling: true,
      supportsExternalSourceEvidence: !generates,
      supportsPhysicalDrawEvidence: false,
    }),
    canonicalHash(`provider:${suffix}`), category,
  ]);
  await pool.query(`
insert into game_engine.outcome_provider_configuration_versions (
  provider_id, provider_version, configuration_version, canonical_provider_category,
  configuration_hash, supported_capabilities, evidence_requirements,
  readiness_capabilities, production_ready, failure_mode)
values ($1, $2, $3, $4, $5, '["UniqueNumberSet","OrderedNumberSequence"]'::jsonb,
  '{"providerEvidenceHash":true}'::jsonb, '["qa-ready"]'::jsonb, true, 'FAIL_CLOSED');
`, [providerId, providerVersion, configurationVersion, category, canonicalHash(`provider-config:${suffix}`)]);
  for (const stage of ["REGISTERED", "READY", "APPROVED", "PRODUCTION_ACTIVE"]) {
    await pool.query(`
insert into game_engine.game_engine_production_activation_events (
  activation_event_id, provider_id, provider_version, configuration_version,
  stage, actor_reference, reason_code, approval_reference,
  signing_provider_id, signing_provider_version, signing_key_version,
  canonical_request_hash, evidence_hash, idempotency_key, created_at)
values ($1, $2, $3, $4, $5, 'qa:canonical-outcome', 'QA_PROVIDER_ACTIVATION',
  'qa:approved', 'mosera-software-signing', '1.0.0', 'key-v1', $6, $7, $8, now());
`, [
      randomUUID(), providerId, providerVersion, configurationVersion, stage,
      canonicalHash(`activation-request:${suffix}:${stage}`),
      canonicalHash(`activation-evidence:${suffix}:${stage}`),
      `qa-outcome-activation:${suffix}:${stage}`,
    ]);
  }
  await pool.query(`
insert into game_engine.published_draw_schedule_versions (
  schedule_version_id, schedule_id, version_number, game_definition_id,
  draw_authority_assignment_id, schedule_kind, schedule_configuration,
  time_zone_id, schedule_hash, published_at)
values ($1, $2, 1, $3, $4, 'QA_FIXED', '{}'::jsonb, 'UTC', $5, now());
`, [scheduleVersionId, scheduleId, definition.game_definition_id, definition.assignment_id, scheduleHash]);
  await pool.query(`
insert into game_engine.draw_schedules (
  id, game_definition_id, draw_authority_assignment_id, sales_open_at,
  sales_close_at, draw_at, status, schedule_version_id, scheduled_execution_at,
  schedule_hash, draw_identity_hash)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);
`, [
    drawId, definition.game_definition_id, definition.assignment_id,
    salesOpenAt, salesCloseAt, drawAt, drawStatus, scheduleVersionId,
    scheduledAt, scheduleHash, identityHash,
  ]);
  await pool.query(`
insert into game_engine.draw_execution_manifests (
  execution_manifest_id, draw_id, schedule_version_id, game_definition_version_id,
  draw_authority_version_id, engine_name, engine_version, outcome_provider_id,
  outcome_provider_version, provider_configuration_version, evaluator_version,
  paytable_version, scheduled_execution_at, schedule_hash, draw_identity_hash,
  canonical_manifest_hash, created_at)
select $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
  version.evaluator_version, version.paytable_version, $11, $12, $13, $14, now()
from game_engine.game_definition_versions version where version.id = $4;
`, [
    manifestId, drawId, scheduleVersionId, definition.game_definition_version_id,
    definition.draw_authority_version_id, definition.engine_name, definition.engine_version,
    providerId, providerVersion, configurationVersion, scheduledAt, scheduleHash, identityHash, manifestHash,
  ]);

  return {
    suffix, category, drawId, manifestId, manifestHash, providerId, providerVersion,
    gameDefinitionId: definition.game_definition_id,
    configurationVersion, gameDefinitionVersionId: definition.game_definition_version_id,
    gameDefinitionHash: definition.definition_hash, evaluatorVersion: definition.evaluator_version,
    engineName: definition.engine_name, engineVersion: definition.engine_version,
    primary, bonus, primaryUniverse: [...rules.NumberUniverse],
    bonusUniverse: bonusRules ? [...bonusRules.NumberUniverse] : [],
    primaryOrdering: rules.Ordering, bonusOrdering: bonusRules?.Ordering ?? null,
    executionVersion: 0, executionId: null,
  };
}

export async function appendCertifiedProviderResult(pool, fixture, options = {}) {
  const executionVersion = fixture.executionVersion + 1;
  const executionId = randomUUID();
  const outcomeId = randomUUID();
  const certificateId = randomUUID();
  const payload = options.outcomePayload ?? { numbers: fixture.primary, bonusNumbers: fixture.bonus };
  const outcomePayloadJson = await jsonbText(pool, payload);
  const outcomeHash = canonicalHash(outcomePayloadJson);
  const canonicalResult = {
    schemaVersion: "mosera.canonical-provider-result.v1",
    drawId: fixture.drawId,
    executionManifestId: fixture.manifestId,
    gameDefinitionVersionId: fixture.gameDefinitionVersionId,
    gameDefinitionHash: fixture.gameDefinitionHash,
    evaluatorVersion: fixture.evaluatorVersion,
    primaryNumbers: options.primary ?? fixture.primary,
    bonusNumbers: options.bonus ?? fixture.bonus,
    primaryOrdering: fixture.primaryOrdering,
    bonusOrdering: fixture.bonusOrdering,
    derivedOutcomeData: options.derivedOutcomeData ?? {
      primaryResultHash: canonicalHash(JSON.stringify(options.primary ?? fixture.primary)),
      bonusResultHash: canonicalHash(JSON.stringify(options.bonus ?? fixture.bonus)),
    },
    sourceResultHash: outcomeHash,
  };
  const canonicalResultJson = await jsonbText(pool, canonicalResult);
  const canonicalResultHash = canonicalHash(canonicalResultJson);
  const requestHash = canonicalHash(`provider-request:${fixture.suffix}:${executionVersion}`);
  const evidenceHash = canonicalHash(`provider-evidence:${fixture.suffix}:${executionVersion}`);
  const previousCertificates = options.previousCertificateId
    ? [{ certificateId: options.previousCertificateId, certificateHash: options.previousCertificateHash }]
    : [];

  const strategyId = `strategy:${fixture.suffix}:${executionVersion}`;
  const rngProviderId = `rng:${fixture.suffix}:${executionVersion}`;
  const rngEvidenceHash = canonicalHash(`rng-evidence:${fixture.suffix}:${executionVersion}`);
  await pool.query(`
insert into game_engine.outcome_strategy_definitions (
  id, strategy_id, strategy_version, primitive_graph, input_schema, output_schema,
  constraints, jurisdiction_profile_references, lifecycle_state, content_hash,
  certification_binding_placeholder, signature_metadata)
values ($1, $2, '1.0.0', $3::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
  '[]'::jsonb, 'GovernanceApproved', $4, null, '{}'::jsonb);
`, [randomUUID(), strategyId, JSON.stringify([{
    nodeId: "numbers", primitiveType: "UniqueNumberSet", dependsOn: [],
    minNumber: Math.min(...fixture.primaryUniverse), maxNumber: Math.max(...fixture.primaryUniverse),
    count: fixture.primary.length,
  }]), canonicalHash(`strategy:${fixture.suffix}:${executionVersion}`)]);
  await pool.query(`
insert into game_engine.rng_provider_definitions (
  id, provider_id, provider_version, provider_type, production_eligible,
  certification_state, algorithm_references, entropy_source_metadata,
  health_test_capabilities, failure_mode, content_hash, signature_metadata)
values ($1, $2, '1.0.0', 'TEST_DETERMINISTIC', false, 'InternalVerified',
  '["qa"]'::jsonb, '{}'::jsonb, '["qa"]'::jsonb, 'FailClosed', $3, '{}'::jsonb);
`, [randomUUID(), rngProviderId, canonicalHash(`rng:${fixture.suffix}:${executionVersion}`)]);
  await pool.query(`
insert into game_engine.rng_provider_evidence (
  evidence_id, provider_id, provider_version, entropy_source_reference,
  health_test_result, known_answer_test_result, continuous_test_result,
  generated_at, canonical_evidence_hash, signing_metadata)
values ($1, $2, '1.0.0', 'qa', 'Passed', 'Passed', 'Passed', now(), $3, '{}'::jsonb);
`, [randomUUID(), rngProviderId, rngEvidenceHash]);
  await pool.query(`
insert into game_engine.outcome_events (
  outcome_id, request_id, draw_id, game_manifest_reference, strategy_id,
  strategy_version, rng_provider_id, rng_provider_version, rng_evidence_hash,
  idempotency_key, outcome_mode, outcome_payload, canonical_outcome_hash, generated_at)
values ($1, $2, $3, $4, $5, '1.0.0', $6, '1.0.0', $7, $8, 'DryRun', $9::jsonb, $10, now());
`, [outcomeId, randomUUID(), fixture.drawId, `manifest:${fixture.manifestId}`, strategyId, rngProviderId,
    rngEvidenceHash, `outcome:${fixture.suffix}:${executionVersion}`, outcomePayloadJson, outcomeHash]);
  await pool.query(`
insert into game_engine.outcome_certificates (
  certificate_id, outcome_id, draw_id, strategy_id, strategy_version,
  rng_provider_id, rng_provider_version, canonical_outcome_hash,
  evidence_hash_reference, previous_certificates, signing_metadata, custody_state, issued_at)
values ($1, $2, $3, $4, '1.0.0', $5, '1.0.0', $6, $7, $8::jsonb, '{}'::jsonb, 'Certified', now());
`, [certificateId, outcomeId, fixture.drawId, strategyId, rngProviderId, outcomeHash,
    rngEvidenceHash, JSON.stringify(previousCertificates)]);

  await pool.query(`
insert into game_engine.outcome_provider_executions (
  execution_id, execution_manifest_id, provider_id, provider_version,
  configuration_version, idempotency_key, canonical_request_hash, claimed_at,
  execution_version, supersedes_execution_id)
values ($1, $2, $3, $4, $5, $6, $7, now(), $8, $9);
`, [executionId, fixture.manifestId, fixture.providerId, fixture.providerVersion,
    fixture.configurationVersion, `provider:${fixture.suffix}:${executionVersion}`, requestHash,
    executionVersion, fixture.executionId]);
  await pool.query(`
insert into game_engine.outcome_provider_execution_attempts (
  attempt_id, execution_id, attempt_number, status, failure_classification,
  request_hash, attempt_hash, started_at, completed_at)
values ($1, $2, 1, 'COMPLETED', 'NONE', $3, $4, now(), now());
`, [randomUUID(), executionId, requestHash, canonicalHash(`attempt:${fixture.suffix}:${executionVersion}`)]);
  for (const status of ["GENERATED", "AUTHORITATIVE"]) {
    await pool.query(`
insert into game_engine.outcome_provider_execution_evidence (
  evidence_id, execution_id, execution_manifest_id, draw_id, provider_id,
  provider_version, configuration_version, request_hash, result_hash, evidence_hash,
  outcome_certificate_id, outcome_certificate_hash, execution_attempt, idempotency_key,
  status, started_at, completed_at, provider_evidence_payload,
  canonical_result_payload, canonical_result_hash)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
  $11, $12, 1, $13, $14, now(), now(), $15::jsonb, $16::jsonb, $17);
`, [
      randomUUID(), executionId, fixture.manifestId, fixture.drawId, fixture.providerId,
      fixture.providerVersion, fixture.configurationVersion, requestHash, outcomeHash,
      canonicalHash(`${evidenceHash}:${status}`), status === "AUTHORITATIVE" ? certificateId : null,
      status === "AUTHORITATIVE" ? outcomeHash : null,
      `provider:${fixture.suffix}:${executionVersion}`, status,
      JSON.stringify({ authority: "BF-4.7 QA", category: fixture.category }), canonicalResultJson, canonicalResultHash,
    ]);
  }
  const authoritativeEvidence = await pool.query(`
select evidence_id from game_engine.outcome_provider_execution_evidence
where execution_id = $1 and status = 'AUTHORITATIVE';
`, [executionId]);

  const signingProviderId = `signer:${fixture.suffix}:${executionVersion}`;
  const signingContentHash = canonicalHash(`signer:${fixture.suffix}:${executionVersion}`);
  const signatureId = randomUUID();
  const signatureValue = options.invalidSignature
    ? canonicalHash(`invalid-signature:${fixture.suffix}:${executionVersion}`)
    : canonicalHash(`${outcomeHash}|${signingProviderId}|1.0.0|qa-key|${signingContentHash}`);
  await pool.query(`
insert into game_engine.signing_providers (
  id, provider_id, provider_version, provider_type, production_eligible,
  algorithm, key_identifier, algorithm_version, verification_support,
  key_rotation_support, failure_mode, content_hash, lifecycle_state)
values ($1, $2, '1.0.0', 'LOCAL_TEST', false, 'HMAC-SHA256', 'qa-key', '1',
  true, false, 'FailClosed', $3, 'Active');
`, [randomUUID(), signingProviderId, signingContentHash]);
  await pool.query(`
insert into game_engine.certificate_signatures (
  signature_id, certificate_reference_type, certificate_id, provider_id,
  provider_version, algorithm, algorithm_version, canonical_payload_hash,
  signature_value, verification_status, signing_context, issued_at)
values ($1, 'OutcomeCertificate', $2, $3, '1.0.0', 'HMAC-SHA256', '1', $4, $5,
  'Verified', 'DryRun', now());
`, [signatureId, certificateId, signingProviderId, outcomeHash, signatureValue]);

  fixture.executionVersion = executionVersion;
  fixture.executionId = executionId;
  return {
    outcomeId, certificateId, outcomeHash, outcomePayload: payload,
    providerEvidenceId: authoritativeEvidence.rows[0].evidence_id,
    executionId, canonicalResult, canonicalResultHash, signatureId,
  };
}

export function publicationCommand(fixture, result, overrides = {}) {
  return {
    idempotencyKey: `publish:${fixture.suffix}:${fixture.executionVersion}`,
    drawId: fixture.drawId,
    productReference: "product:bf-4.7",
    engineName: fixture.engineName,
    engineVersion: fixture.engineVersion,
    outcomeCertificateId: result.certificateId,
    outcomeCertificateHash: result.outcomeHash,
    versionKind: "Published",
    previousOutcomeVersionId: null,
    authoritativeSource: "OutcomeProviderAuthority",
    correlationId: `correlation:${fixture.suffix}`,
    causationId: `provider-execution:${result.executionId}`,
    auditReference: `audit:${fixture.suffix}:${fixture.executionVersion}`,
    actorReference: "operator:bf-4.7-qa",
    reasonCode: "CERTIFIED_RESULT_PUBLICATION",
    lifecycleEvidenceHash: canonicalHash(`lifecycle:${fixture.suffix}:${fixture.executionVersion}`),
    ...overrides,
  };
}
