alter table game_engine.game_definition_versions
  add column outcome_generation_definition jsonb;

create or replace function game_engine.validate_number_outcome_generation_definition()
returns trigger
language plpgsql
as $$
declare
  definition jsonb;
  universe_count integer;
  distinct_count integer;
  numbers_required integer;
  unique_numbers boolean;
  with_replacement boolean;
begin
  definition := new.outcome_generation_definition;
  if definition is null then
    return new;
  end if;

  if jsonb_typeof(definition) <> 'object'
    or jsonb_typeof(definition -> 'NumberUniverse') <> 'array'
    or jsonb_typeof(definition -> 'NumbersRequired') <> 'number'
    or jsonb_typeof(definition -> 'Unique') <> 'boolean'
    or jsonb_typeof(definition -> 'WithReplacement') <> 'boolean'
    or definition ->> 'Ordering' not in ('DrawOrder', 'Ascending') then
    raise exception 'Game Definition outcome generation definition is invalid';
  end if;

  select count(*), count(distinct value)
    into universe_count, distinct_count
  from jsonb_array_elements_text(definition -> 'NumberUniverse') number(value);

  numbers_required := (definition ->> 'NumbersRequired')::integer;
  unique_numbers := (definition ->> 'Unique')::boolean;
  with_replacement := (definition ->> 'WithReplacement')::boolean;

  if universe_count = 0 or universe_count <> distinct_count then
    raise exception 'Game Definition number universe must contain distinct values';
  end if;

  if numbers_required <= 0 then
    raise exception 'Game Definition numbers required must be positive';
  end if;

  if unique_numbers and with_replacement then
    raise exception 'Unique Game Definition generation cannot use replacement';
  end if;

  if not with_replacement and numbers_required > universe_count then
    raise exception 'Game Definition requests too many numbers without replacement';
  end if;

  return new;
end;
$$;

create trigger trg_validate_number_outcome_generation_definition
before insert or update of outcome_generation_definition
on game_engine.game_definition_versions
for each row execute function game_engine.validate_number_outcome_generation_definition();

alter table game_engine.outcome_provider_execution_evidence
  drop constraint if exists outcome_provider_execution_evidence_execution_id_key,
  drop constraint if exists outcome_provider_execution_evidence_execution_manifest_id_key,
  drop constraint if exists outcome_provider_execution_evidence_status_check,
  alter column outcome_certificate_id drop not null,
  alter column outcome_certificate_hash drop not null,
  add column provider_evidence_payload jsonb not null default '{"legacyEvidence":true}'::jsonb,
  add constraint ck_outcome_provider_execution_evidence_status
    check (status in ('GENERATED', 'AUTHORITATIVE')),
  add constraint ck_outcome_provider_execution_evidence_certificate_stage
    check (
      (status = 'GENERATED'
        and outcome_certificate_id is null
        and outcome_certificate_hash is null)
      or
      (status = 'AUTHORITATIVE'
        and outcome_certificate_id is not null
        and outcome_certificate_hash is not null)
    ),
  add constraint ck_outcome_provider_execution_evidence_payload
    check (jsonb_typeof(provider_evidence_payload) = 'object');

create unique index ux_outcome_provider_generated_evidence
  on game_engine.outcome_provider_execution_evidence(execution_id)
  where status = 'GENERATED';

create unique index ux_outcome_provider_authoritative_evidence
  on game_engine.outcome_provider_execution_evidence(execution_id)
  where status = 'AUTHORITATIVE';

create unique index ux_outcome_provider_authoritative_manifest
  on game_engine.outcome_provider_execution_evidence(execution_manifest_id)
  where status = 'AUTHORITATIVE';

create or replace function game_engine.validate_outcome_provider_execution_evidence()
returns trigger
language plpgsql
as $$
declare
  execution record;
  manifest record;
  certificate record;
  generated record;
begin
  select * into execution
  from game_engine.outcome_provider_executions
  where execution_id = new.execution_id;

  select * into manifest
  from game_engine.draw_execution_manifests
  where execution_manifest_id = new.execution_manifest_id;

  if execution.execution_manifest_id <> new.execution_manifest_id
    or execution.provider_id <> new.provider_id
    or execution.provider_version <> new.provider_version
    or execution.configuration_version <> new.configuration_version
    or execution.idempotency_key <> new.idempotency_key
    or execution.canonical_request_hash <> new.request_hash then
    raise exception 'Outcome Provider evidence does not match its durable execution claim';
  end if;

  if manifest.draw_id <> new.draw_id
    or manifest.outcome_provider_id <> new.provider_id
    or manifest.outcome_provider_version <> new.provider_version
    or manifest.provider_configuration_version <> new.configuration_version then
    raise exception 'Outcome Provider evidence does not match its immutable Execution Manifest';
  end if;

  if not exists (
    select 1
    from game_engine.outcome_provider_execution_attempts attempt
    where attempt.execution_id = new.execution_id
      and attempt.attempt_number = new.execution_attempt
      and attempt.status = 'COMPLETED'
  ) then
    raise exception 'Provider evidence requires a completed execution attempt';
  end if;

  if game_engine.jsonb_has_forbidden_secret_material(new.provider_evidence_payload) then
    raise exception 'Provider evidence must never persist raw entropy, seeds, or DRBG state';
  end if;

  if new.status = 'GENERATED' then
    return new;
  end if;

  select * into certificate
  from game_engine.outcome_certificates
  where certificate_id = new.outcome_certificate_id;

  if not found
    or certificate.draw_id <> new.draw_id
    or certificate.canonical_outcome_hash <> new.outcome_certificate_hash then
    raise exception 'Outcome Provider evidence does not match its Outcome Certificate';
  end if;

  select * into generated
  from game_engine.outcome_provider_execution_evidence evidence
  where evidence.execution_id = new.execution_id
    and evidence.status = 'GENERATED';

  if not found
    or generated.request_hash <> new.request_hash
    or generated.result_hash <> new.result_hash
    or generated.provider_evidence_payload <> new.provider_evidence_payload then
    raise exception 'Authoritative provider evidence requires matching generated evidence';
  end if;

  return new;
end;
$$;

insert into game_engine.outcome_provider_definitions (
  id,
  provider_id,
  provider_version,
  provider_type,
  lifecycle_state,
  production_eligible,
  supported_outcome_primitive_types,
  evidence_requirements,
  health_readiness_capabilities,
  idempotency_model,
  custody_support,
  signing_requirements,
  replayability_support,
  failure_mode,
  capability_markers,
  content_hash,
  canonical_provider_category)
values (
  '94400000-0000-4000-8000-000000000001',
  'mosera-internal-csprng',
  '2.0.0',
  'CERTIFIED_CSPRNG',
  'Active',
  true,
  '["UniqueNumberSet","OrderedNumberSequence","ConstraintValidation"]'::jsonb,
  '{"generatedBytesHash":true,"generatedNumbers":true,"healthEvidence":true,"reseedCounter":true}'::jsonb,
  '["os-entropy","hmac-drbg-sha256","startup-self-test","known-answer-tests","continuous-test","reseed","zeroization","rejection-sampling","fisher-yates"]'::jsonb,
  'PerDraw',
  '["Requested","Generated","Sealed","Certified"]'::jsonb,
  '{"signatureRequired":true}'::jsonb,
  true,
  'FailClosed',
  '{"generatesOutcomes":true,"ingestsExternalOutcomes":false,"supportsPlayerVerificationReceipt":false,"supportsDeterministicReplay":true,"supportsProviderHealthEvidence":true,"supportsDisputeHandling":true,"supportsExternalSourceEvidence":false,"supportsPhysicalDrawEvidence":false}'::jsonb,
  'sha256:9440000000000000000000000000000000000000000000000000000000000001',
  'INTERNAL_CSPRNG'
);

insert into game_engine.rng_provider_definitions (
  id,
  provider_id,
  provider_version,
  provider_type,
  production_eligible,
  certification_state,
  algorithm_references,
  entropy_source_metadata,
  health_test_capabilities,
  failure_mode,
  content_hash,
  signature_metadata)
values (
  '94400000-0000-4000-8000-000000000002',
  'mosera-hmac-drbg',
  '2.0.0',
  'HMAC_DRBG',
  true,
  'InternalVerified',
  '["NIST SP 800-90A Rev.1 HMAC_DRBG SHA-256"]'::jsonb,
  '{"source":"operating-system"}'::jsonb,
  '["startup-self-test","known-answer-tests","continuous-test"]'::jsonb,
  'FailClosed',
  'sha256:9440000000000000000000000000000000000000000000000000000000000002',
  '{}'::jsonb
);

insert into game_engine.entropy_provider_definitions (
  id,
  provider_id,
  provider_version,
  provider_type,
  platform_runtime_reference,
  entropy_source_metadata,
  minimum_entropy_bits,
  health_test_capabilities,
  production_eligible,
  failure_mode,
  content_hash)
values (
  '94400000-0000-4000-8000-000000000003',
  'mosera-os-entropy',
  '2.0.0',
  'OS_CSPRNG',
  'runtime-operating-system',
  '{"linux":"getrandom","windows":"BCryptGenRandom","macos":"SecRandomCopyBytes"}'::jsonb,
  256,
  '["availability-probe","nonzero-read","fail-closed"]'::jsonb,
  true,
  'FailClosed',
  'sha256:9440000000000000000000000000000000000000000000000000000000000003'
);

insert into game_engine.csprng_provider_definitions (
  id,
  provider_id,
  provider_version,
  outcome_provider_id,
  outcome_provider_version,
  linked_rng_provider_id,
  linked_rng_provider_version,
  entropy_provider_type,
  drbg_type,
  hash_algorithm,
  security_strength_bits,
  reseed_policy,
  session_isolation_policy,
  zeroization_policy,
  startup_self_test_supported,
  known_answer_test_supported,
  continuous_health_test_supported,
  production_eligible,
  lifecycle_state,
  failure_mode,
  sampling_capabilities,
  content_hash,
  certification_binding)
values (
  '94400000-0000-4000-8000-000000000004',
  'mosera-internal-csprng-runtime',
  '2.0.0',
  'mosera-internal-csprng',
  '2.0.0',
  'mosera-hmac-drbg',
  '2.0.0',
  'OS_CSPRNG',
  'HMAC_DRBG',
  'SHA_256',
  256,
  '{"perDrawSession":true,"freshEntropyBeforeGeneration":true}'::jsonb,
  '{"scope":"draw","singletonMutableState":false}'::jsonb,
  '{"dispose":true,"cryptographicZeroMemory":true}'::jsonb,
  true,
  true,
  true,
  true,
  'Active',
  'FailClosed',
  '["RejectionSampling","FisherYatesShuffle","UniqueNumberSelection","IntegerRationalWeightedSelection"]'::jsonb,
  'sha256:9440000000000000000000000000000000000000000000000000000000000004',
  null
);

insert into game_engine.outcome_provider_configuration_versions (
  provider_id,
  provider_version,
  configuration_version,
  canonical_provider_category,
  configuration_hash,
  supported_capabilities,
  evidence_requirements,
  readiness_capabilities,
  production_ready,
  failure_mode)
values (
  'mosera-internal-csprng',
  '2.0.0',
  '1',
  'INTERNAL_CSPRNG',
  'sha256:9440000000000000000000000000000000000000000000000000000000000005',
  '["UniqueNumberSet","OrderedNumberSequence","ConstraintValidation"]'::jsonb,
  '{"entropySourceIdentifier":true,"providerVersion":true,"configurationVersion":true,"drbgInstanceIdentifier":true,"seedIdentifier":true,"reseedCounter":true,"requestIdentifier":true,"generatedBytesHash":true,"generatedNumbers":true,"generationTimestamps":true,"executionDuration":true,"healthEvidence":true}'::jsonb,
  '["os-entropy","hmac-drbg-sha256","startup-self-test","known-answer-tests","continuous-test","reseed","zeroization","rejection-sampling","fisher-yates","canonical-evidence-persistence"]'::jsonb,
  true,
  'FAIL_CLOSED'
);

insert into game_engine.outcome_provider_activation_events (
  activation_event_id,
  provider_id,
  provider_version,
  configuration_version,
  activation_state,
  reason,
  evidence_hash,
  effective_at)
values (
  '94400000-0000-4000-8000-000000000006',
  'mosera-internal-csprng',
  '2.0.0',
  '1',
  'DISABLED',
  'BF-4.4 provider is production-ready but requires a separate governed activation.',
  'sha256:9440000000000000000000000000000000000000000000000000000000000006',
  now()
);

comment on column game_engine.game_definition_versions.outcome_generation_definition is
  'Immutable number universe, count, uniqueness, ordering, and replacement rules consumed by the canonical Internal CSPRNG provider.';

comment on column game_engine.outcome_provider_execution_evidence.provider_evidence_payload is
  'Replay-safe provider evidence only. Raw entropy, seed material, and DRBG state are rejected.';
